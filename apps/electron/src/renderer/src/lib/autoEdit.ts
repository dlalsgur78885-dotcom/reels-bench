/**
 * AI 자동 편집 — one-click "자동 러프컷" (auto rough-cut) orchestrator.
 *
 * `runAutoEdit` drives the whole flow as ONE undo step:
 *   1. Resolve the PRIMARY track (first video track with media, else first
 *      audio track with media) and snapshot its media-clip ids.
 *   2. For each snapshotted clip — detect silence (memoized by source path),
 *      skip clips that are ~all-silent (no-audio guard), else cut the silence
 *      out of the clip via `removeSilencesFromClip`.
 *   3. Ripple-close every gap on the primary track once.
 *   4. Optionally transcribe the primary track's first clip into captions.
 *
 * Undo: zundo's `temporal` is `pause()`d for the whole run so the dozens of
 * intermediate `set()` calls don't each become a history entry; on `resume()`
 * we issue exactly ONE real commit so the run is a single undo delta.
 *
 * Renderer-only — no main-process / shared-type change. The only IPC it
 * touches is `window.electron.audio.detectSilence` and `window.electron.stt.*`,
 * both of which an e2e test can mock.
 */
import type { SilenceRange, SttLanguage, SttProgress } from '../../../shared/ipc'
import { isMediaClip, type VideoAudioClip } from '../../../shared/project'
import { newId, useProjectStore } from '../store/project'
import { sttCuesToClips } from './sttToClips'

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export interface AutoEditOptions {
  /** Detect + remove silence across the primary track. */
  removeSilence: boolean
  /** Run STT on the primary track's first clip and insert captions. */
  generateCaptions: boolean
  /** Silence noise floor in dB (passed to detectSilence). */
  noiseDb: number
  /** Minimum silence duration in ms (passed to detectSilence). */
  minMs: number
  /** STT language (only used when `generateCaptions`). */
  language: SttLanguage
}

export interface AutoEditSummary {
  /** Number of media clips on the primary track that were scanned. */
  clipsScanned: number
  /** Total silence ranges removed across all clips. */
  rangesRemoved: number
  /** Total milliseconds removed (silence cuts only — ripple just closes gaps). */
  msRemoved: number
  /** Number of caption clips inserted (0 when captions weren't requested). */
  captionsAdded: number
}

/** Multi-phase progress the dialog renders. */
export type AutoEditPhase =
  | 'preparing'
  | 'detecting'
  | 'cutting'
  | 'transcribing'
  | 'done'
  | 'error'
  | 'cancelled'

export interface AutoEditCallbacks {
  /** Called whenever the run enters a new phase. */
  onPhase: (phase: AutoEditPhase) => void
  /** Per-clip progress while detecting/cutting (done out of total). */
  onProgress: (done: number, total: number) => void
  /** Polled between clips — return true to abort gracefully. */
  shouldCancel: () => boolean
}

/** Thrown internally when the user cancels mid-run. */
export class AutoEditCancelled extends Error {
  constructor() {
    super('auto-edit cancelled')
    this.name = 'AutoEditCancelled'
  }
}

// ---------------------------------------------------------------------------
// Primary-track resolution.
// ---------------------------------------------------------------------------

interface PrimaryTrack {
  trackId: string
  /** Ids of the track's media clips, in startMs order, snapshotted up-front. */
  mediaClipIds: string[]
}

/** True when a track has at least one media clip. */
function trackHasMedia(clips: ReadonlyArray<{ kind: string }>): boolean {
  return clips.some((c) => c.kind === 'media')
}

/**
 * Resolve the PRIMARY track for the auto rough-cut: the first `video` track
 * that has ≥1 media clip, else the first `audio` track that has media.
 * Snapshots the media-clip ids (startMs-sorted) BEFORE any mutation so the
 * run iterates a stable set even as `removeSilencesFromClip` replaces clips.
 */
export function resolvePrimaryTrack(): PrimaryTrack | null {
  const project = useProjectStore.getState().project
  const pick = (kind: 'video' | 'audio'): PrimaryTrack | null => {
    for (const t of project.tracks) {
      if (t.kind !== kind) continue
      if (!trackHasMedia(t.clips)) continue
      const mediaClipIds = (t.clips.filter(isMediaClip) as VideoAudioClip[])
        .slice()
        .sort((a, b) => a.startMs - b.startMs)
        .map((c) => c.id)
      return { trackId: t.id, mediaClipIds }
    }
    return null
  }
  return pick('video') ?? pick('audio')
}

/** Count how many video/audio tracks carry media (for the multi-track warning). */
export function countTracksWithMedia(): number {
  const project = useProjectStore.getState().project
  let n = 0
  for (const t of project.tracks) {
    if (t.kind !== 'video' && t.kind !== 'audio') continue
    if (trackHasMedia(t.clips)) n += 1
  }
  return n
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/** Re-fetch a (possibly replaced) clip from the live store by id. */
function findClip(clipId: string): VideoAudioClip | null {
  const project = useProjectStore.getState().project
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.id === clipId && isMediaClip(c)) return c
    }
  }
  return null
}

/** Total of a SilenceRange[]'s `durationMs`. */
function totalSilenceMs(ranges: SilenceRange[]): number {
  let sum = 0
  for (const r of ranges) sum += Math.max(0, r.durationMs)
  return sum
}

// ---------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------

/**
 * Run the auto rough-cut. Resolves with an {@link AutoEditSummary}; rejects
 * only on a hard failure (no primary track, or an exception with the temporal
 * store unrecoverable). User cancellation resolves with whatever was done so
 * far — callers branch on the `cancelled` phase via `onPhase`.
 */
export async function runAutoEdit(
  opts: AutoEditOptions,
  cb: AutoEditCallbacks
): Promise<AutoEditSummary> {
  const summary: AutoEditSummary = {
    clipsScanned: 0,
    rangesRemoved: 0,
    msRemoved: 0,
    captionsAdded: 0
  }

  cb.onPhase('preparing')

  const primary = resolvePrimaryTrack()
  if (!primary) {
    cb.onPhase('error')
    throw new Error('자동 편집할 미디어 트랙을 찾지 못했습니다')
  }

  const store = useProjectStore.getState()
  const temporal = useProjectStore.temporal.getState()

  // ONE undo step: snapshot the project BEFORE pausing history, then on resume
  // manually push that single pre-run snapshot onto the zundo past stack.
  // (A plain post-resume `set()` does NOT work — zundo's equality check then
  // compares post-state vs post-state and records nothing.)
  const preRunProject = store.project
  temporal.pause()

  let cancelled = false
  try {
    // -------------------------------------------------------------------
    // §2b — silence detection + cutting.
    // -------------------------------------------------------------------
    if (opts.removeSilence) {
      cb.onPhase('detecting')
      const total = primary.mediaClipIds.length
      cb.onProgress(0, total)

      // Memoize detectSilence per source path — the same media analyzed once
      // even if it backs multiple clips.
      const silenceCache = new Map<string, Promise<SilenceRange[]>>()
      const detect = (path: string): Promise<SilenceRange[]> => {
        let p = silenceCache.get(path)
        if (!p) {
          p = window.electron.audio.detectSilence(path, {
            noiseDb: opts.noiseDb,
            minMs: opts.minMs
          })
          silenceCache.set(path, p)
        }
        return p
      }

      cb.onPhase('cutting')
      for (let i = 0; i < primary.mediaClipIds.length; i++) {
        if (cb.shouldCancel()) {
          cancelled = true
          break
        }
        const clipId = primary.mediaClipIds[i]
        const clip = findClip(clipId)
        // The clip may have been removed by an earlier step (e.g. a fully
        // silent clip dropped) — skip silently.
        if (!clip) {
          cb.onProgress(i + 1, total)
          continue
        }
        const media = useProjectStore.getState().project.media[clip.mediaId]
        if (!media || !media.path) {
          cb.onProgress(i + 1, total)
          continue
        }

        let ranges: SilenceRange[]
        try {
          ranges = await detect(media.path)
        } catch {
          // A detectSilence reject for one clip must NOT kill the run —
          // skip this clip, still count it as scanned.
          summary.clipsScanned += 1
          cb.onProgress(i + 1, total)
          continue
        }

        summary.clipsScanned += 1

        if (!Array.isArray(ranges) || ranges.length === 0) {
          cb.onProgress(i + 1, total)
          continue
        }

        // NO-AUDIO GUARD — if detected silence covers ~the whole source
        // window of this clip, it's a no-speech / music-bed clip. Cutting it
        // would destroy it, so skip entirely.
        const sourceWindowMs = Math.max(1, clip.trimOutMs - clip.trimInMs)
        if (totalSilenceMs(ranges) >= sourceWindowMs * 0.95) {
          cb.onProgress(i + 1, total)
          continue
        }

        const survivorIds = store.removeSilencesFromClip(clipId, ranges)
        summary.rangesRemoved += ranges.length
        summary.msRemoved += totalSilenceMs(ranges)

        // The auto-generated survivor pieces will butt together after the
        // ripple — any inherited `transitionIn` would render wrongly there.
        // Clear it via the store's transition action ('none' clears it).
        for (const sid of survivorIds) {
          store.setClipTransitionIn(sid, 'none')
        }

        cb.onProgress(i + 1, total)
      }
    }

    // -------------------------------------------------------------------
    // Ripple-close the primary track once (single-track by design).
    // -------------------------------------------------------------------
    if (!cancelled && opts.removeSilence) {
      store.rippleCloseTrackGaps(primary.trackId)
    }

    // -------------------------------------------------------------------
    // §2b — optional auto-captions.
    // -------------------------------------------------------------------
    if (!cancelled && opts.generateCaptions) {
      cb.onPhase('transcribing')
      const captionsAdded = await runCaptions(primary.trackId, opts.language)
      summary.captionsAdded = captionsAdded
    }
  } finally {
    // Resume history, THEN issue exactly one real commit so the whole run is
    // a single undo step. `set` here lands a new project reference; zundo's
    // equality check (snapshotsEqual) records it iff anything actually moved.
    temporal.resume()
    // Record exactly ONE history entry: the pre-run snapshot as the single
    // "past" state, redo cleared. zundo's pastStates holds ProjectSnapshot
    // ({ project }); pushing it directly makes one Ctrl+Z restore the whole
    // pre-auto-edit timeline. UNDO_LIMIT is 100 — keep the stack bounded.
    const cur = useProjectStore.getState().project
    if (cur !== preRunProject) {
      useProjectStore.temporal.setState((s) => ({
        pastStates: [...s.pastStates, { project: preRunProject }].slice(-100),
        futureStates: []
      }))
    }
  }

  cb.onPhase(cancelled ? 'cancelled' : 'done')
  return summary
}

/**
 * Transcribe the primary track's first media clip into caption clips.
 * Returns the number of captions inserted; on ANY STT failure returns 0 and
 * keeps the cuts intact (soft-warn — never rolls back the rough-cut).
 */
async function runCaptions(
  trackId: string,
  language: SttLanguage
): Promise<number> {
  const project = useProjectStore.getState().project
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return 0

  // First media clip post-ripple, in startMs order.
  const firstClip = (track.clips.filter(isMediaClip) as VideoAudioClip[])
    .slice()
    .sort((a, b) => a.startMs - b.startMs)[0]
  if (!firstClip) return 0
  const media = project.media[firstClip.mediaId]
  if (!media || !media.path) return 0

  const jobId = newId()
  let unsub: (() => void) | null = null
  try {
    // Subscribe so the IPC layer can stream progress; we don't surface a
    // per-percent bar for STT here — the dialog shows an indeterminate phase.
    unsub = window.electron.stt.onProgress((_e: SttProgress) => {
      /* progress is observed but not individually rendered */
    })
    const result = await window.electron.stt.transcribe({
      jobId,
      sourcePath: media.path,
      language,
      model: 'base'
    })
    if (!result.ok) return 0
    const clips = sttCuesToClips(result.cues)
    if (clips.length > 0) {
      useProjectStore.getState().addCaptions(clips)
    }
    return clips.length
  } catch {
    // STT error — keep the cuts, report 0 captions (soft-warn upstream).
    return 0
  } finally {
    if (unsub) unsub()
  }
}
