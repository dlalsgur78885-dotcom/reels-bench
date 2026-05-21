import { ulid } from 'ulid'
import { create, useStore } from 'zustand'
import { temporal, type TemporalState } from 'zundo'
import {
  ASPECT_RATIO_DIMENSIONS,
  DEFAULT_DUCKING_DB,
  DEFAULT_TRANSITION_MS,
  IDENTITY_CROP,
  MAX_CLIP_SPEED,
  MAX_GAIN_DB,
  MAX_KEYFRAMES_PER_CLIP,
  MAX_TRANSFORM_OFFSET,
  MAX_TRANSFORM_ROTATION,
  MAX_TRANSFORM_SCALE,
  MAX_TRANSITION_MS,
  MAX_VIDEO_TRACKS,
  MIN_CLIP_MS,
  MIN_CLIP_SPEED,
  MIN_CROP_SIZE,
  MIN_GAIN_DB,
  MIN_KEYFRAME_GAP_MS,
  MIN_TRANSFORM_OFFSET,
  MIN_TRANSFORM_ROTATION,
  MIN_TRANSFORM_SCALE,
  MIN_TRANSITION_MS,
  type AspectRatio,
  type CaptionClip,
  type Clip,
  type ClipTransform,
  type CropRect,
  type FilterPreset,
  type MediaAsset,
  type Project,
  type TransformKeyframe,
  type TransitionKind,
  type VideoAudioClip,
  getClipDuration,
  getClipTransform,
  getTransformAt,
  hasTransformKeyframes,
  isCaptionClip,
  isIdentityCrop,
  isIdentityTransform,
  isMediaClip
} from '../../../shared/project'
import type { SilenceRange } from '../../../shared/ipc'

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function freshProject(): Project {
  const now = Date.now()
  const dims = ASPECT_RATIO_DIMENSIONS['9:16']
  return {
    id: ulid(),
    name: '제목 없는 프로젝트',
    aspectRatio: '9:16',
    width: dims.width,
    height: dims.height,
    fps: 30,
    tracks: [
      { id: ulid(), kind: 'video', name: 'Video 1', clips: [] },
      // Voice track — primary VO/dialogue lane.
      { id: ulid(), kind: 'audio', name: 'Voice 1', clips: [], role: 'voice' },
      // BGM track — ducked by the voice track when active.
      {
        id: ulid(),
        kind: 'audio',
        name: 'BGM',
        clips: [],
        role: 'bgm',
        duckTarget: 'voice',
        duckingDb: DEFAULT_DUCKING_DB
      },
      { id: ulid(), kind: 'caption', name: 'Caption 1', clips: [] }
    ],
    media: {},
    createdAt: now,
    updatedAt: now
  }
}

function touch(p: Project): Project {
  return { ...p, updatedAt: Date.now() }
}

/**
 * Range-clamp every transform field — the SAME clamp `setClipTransform` applies
 * to a static transform. Reused by the Phase 3.5 keyframe actions so a stored
 * keyframe never holds an out-of-range value.
 */
function clampClipTransform(t: ClipTransform): ClipTransform {
  return {
    x: Math.max(MIN_TRANSFORM_OFFSET, Math.min(MAX_TRANSFORM_OFFSET, t.x)),
    y: Math.max(MIN_TRANSFORM_OFFSET, Math.min(MAX_TRANSFORM_OFFSET, t.y)),
    scale: Math.max(
      MIN_TRANSFORM_SCALE,
      Math.min(MAX_TRANSFORM_SCALE, t.scale)
    ),
    rotation: Math.max(
      MIN_TRANSFORM_ROTATION,
      Math.min(MAX_TRANSFORM_ROTATION, t.rotation)
    ),
    opacity: Math.max(0, Math.min(1, t.opacity))
  }
}

/**
 * Clamp a crop rect — the SAME logic `getClipCropRect` applies defensively:
 * clamp each field to [0,1], floor w/h at MIN_CROP_SIZE, then push x/y so the
 * rect stays inside the source frame (x+w<=1, y+h<=1). Used by `setClipCrop`
 * so the stored rect is already canonical (getClipCropRect is then idempotent).
 */
function clampCropRect(c: CropRect): CropRect {
  const clamp01 = (v: number, d: number): number =>
    Math.min(1, Math.max(0, Number.isFinite(v) ? v : d))
  const w = Math.max(MIN_CROP_SIZE, clamp01(c.w, 1))
  const h = Math.max(MIN_CROP_SIZE, clamp01(c.h, 1))
  let x = clamp01(c.x, 0)
  let y = clamp01(c.y, 0)
  if (x + w > 1) x = 1 - w
  if (y + h > 1) y = 1 - h
  x = Math.max(0, x)
  y = Math.max(0, y)
  return { x, y, w, h }
}

/**
 * Normalize a keyframe list (Phase 3.5): clamp each keyframe transform, sort
 * ascending by atMs, then dedup — keyframes within MIN_KEYFRAME_GAP_MS of the
 * previously-kept one REPLACE it (last write wins). The result is the
 * canonical form the store persists; callers must still enforce the >= 2
 * invariant (a normalized list MAY collapse to length 1).
 */
function normalizeKeyframes(kfs: TransformKeyframe[]): TransformKeyframe[] {
  const sorted = kfs
    .map((kf) => ({
      atMs: Math.max(0, Math.round(kf.atMs)),
      transform: clampClipTransform(kf.transform)
    }))
    .sort((a, b) => a.atMs - b.atMs)
  const out: TransformKeyframe[] = []
  for (const kf of sorted) {
    const last = out[out.length - 1]
    if (last && kf.atMs - last.atMs < MIN_KEYFRAME_GAP_MS) {
      // Within the dedup window — replace the kept keyframe.
      out[out.length - 1] = kf
    } else {
      out.push(kf)
    }
  }
  return out
}

/**
 * Migration helper: an older persisted project may have:
 *   - clips without `kind` (assume 'media')
 *   - no caption track (add one)
 */
function migrateLoadedProject(p: Project): Project {
  const tracks = p.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => {
      if (!('kind' in c) || !c.kind) {
        // Pre-2.4 clip — treat as a media clip.
        const legacy = c as unknown as VideoAudioClip
        return { ...legacy, kind: 'media' as const }
      }
      return c
    })
  }))
  // Phase 3 — `transform` is an optional field on media clips. No migration
  // logic is needed: a missing/partial transform is back-filled lazily by
  // `getClipTransform` (identity fallback). Multi-video-track projects also
  // load as-is — `tracks` is already a generic list, so extra video tracks
  // simply round-trip through persistence untouched.
  // Phase 3.6 — `cropRect` is likewise optional + back-filled lazily by
  // `getClipCropRect` (null = no crop). No migration step needed.
  // Ensure a caption track exists. If none, append one.
  const hasCaption = tracks.some((t) => t.kind === 'caption')
  const migratedTracks = hasCaption
    ? tracks
    : [
        ...tracks,
        { id: ulid(), kind: 'caption' as const, name: 'Caption 1', clips: [] }
      ]
  return { ...p, tracks: migratedTracks }
}

// ---------------------------------------------------------------------------
// Persistence (debounced via setTimeout). Loaded on first store consumer.
// ---------------------------------------------------------------------------
const PERSIST_DEBOUNCE_MS = 500

let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistEnabled = false

function schedulePersist(project: Project): void {
  if (!persistEnabled) return
  if (typeof window === 'undefined' || !window.electron?.fs?.writeProject) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void window.electron.fs.writeProject(project).catch((err: unknown) => {
      console.error('[store] writeProject failed', err)
    })
  }, PERSIST_DEBOUNCE_MS)
}

// ---------------------------------------------------------------------------
// Store.
// ---------------------------------------------------------------------------
export interface ProjectStore {
  project: Project
  /** True until the persisted project (if any) has been loaded. */
  hydrated: boolean

  createNew(): void
  setName(name: string): void
  setAspectRatio(ratio: AspectRatio): void

  addMedia(asset: MediaAsset): void
  removeMedia(mediaId: string): void
  updateMediaThumbnail(mediaId: string, thumbnailPath: string): void
  /** Attach a generated waveform PNG to a media asset (Phase 2.5). */
  updateMediaWaveform(mediaId: string, waveformPath: string): void

  addClip(clip: Clip): void
  removeClip(clipId: string): void
  /**
   * Partial update for a media clip's trim/timeline fields. Caption clips
   * are handled by `updateCaption` instead. Light invariants:
   *   - startMs >= 0
   *   - endMs > startMs (clamped to startMs+1 otherwise)
   */
  updateMediaClipTrim(
    clipId: string,
    partial: Partial<Pick<VideoAudioClip, 'startMs' | 'endMs' | 'trimInMs' | 'trimOutMs'>>
  ): void

  // --- Editing operations (Phase 2.3) ---
  /**
   * Split a media clip at the given absolute timeline ms.
   * Returns the id of the newly created right-side clip, or null if:
   *   - clip not found
   *   - clip is a caption (split is not supported for captions in 2.3)
   *   - split position is outside [startMs+MIN, endMs-MIN]
   */
  splitClipAt(clipId: string, atMs: number): string | null
  /**
   * Deep-clone a clip and place the duplicate at the next free slot on the
   * same track. Works for BOTH media and caption clips. Returns the new
   * clip's id, or null if the source clip can't be found.
   */
  duplicateClip(clipId: string): string | null
  /**
   * Set a media clip's playback speed (clamped to [MIN_CLIP_SPEED,
   * MAX_CLIP_SPEED]). Keeps startMs and the source in/out range
   * (trimInMs..trimOutMs) fixed and recomputes endMs.
   * No-op for caption clips.
   */
  setClipSpeed(clipId: string, speed: number): void

  // --- Audio shaping (Phase 2.5, media clips only) ---
  /** Set a media clip's gain in dB, clamped to [MIN_GAIN_DB, MAX_GAIN_DB]. */
  setClipGainDb(clipId: string, db: number): void
  /** Set per-clip fade-in / fade-out (ms). Negatives rejected; clamped to
   *  the clip's own duration so fades never overlap. */
  setClipFade(clipId: string, fadeInMs: number, fadeOutMs: number): void
  /** Set per-clip mute. */
  setClipMuted(clipId: string, muted: boolean): void
  /** Set track-wide mute. */
  setTrackMuted(trackId: string, muted: boolean): void
  /** Set track-wide solo. */
  setTrackSolo(trackId: string, solo: boolean): void
  /**
   * Remove silent sections from a media clip in one atomic step.
   * Splits the clip into the surviving voiced pieces. Returns the IDs of
   * the resulting clips (in timeline order), or [] if the clip is missing,
   * is not a media clip, or `ranges` is empty.
   */
  removeSilencesFromClip(clipId: string, ranges: SilenceRange[]): string[]

  // --- Transitions + filters (Phase 2.6, media clips only) ---
  /** Set the incoming transition on a media clip. kind='none' clears it. */
  setClipTransitionIn(
    clipId: string,
    kind: TransitionKind,
    durationMs?: number
  ): void
  /** Set the filter preset + intensity (0..1) on a media clip. */
  setClipFilter(clipId: string, preset: FilterPreset, intensity?: number): void

  // --- Transform + layer compositing (Phase 3, media clips only) ---
  /**
   * Merge a partial transform onto a media clip, clamping each field. If the
   * merged result is identity, `transform` is set to `undefined` (keeps
   * persisted JSON + undo snapshots lean). No-op for caption clips and for
   * non-finite inputs.
   */
  setClipTransform(clipId: string, partial: Partial<ClipTransform>): void
  /** Clear a media clip's transform (back to identity). */
  resetClipTransform(clipId: string): void

  // --- Static source crop (Phase 3.6, media clips only) ---
  /**
   * Merge a partial crop rect onto a media clip, clamping with the SAME logic
   * as `getClipCropRect` (clamp to [0,1], floor w/h at MIN_CROP_SIZE, push
   * x/y inside the source frame). If the clamped result is identity (full
   * frame), `cropRect` is set to `undefined` (keeps persisted JSON + undo
   * snapshots lean). No-op for caption clips and for non-finite inputs.
   */
  setClipCrop(clipId: string, partial: Partial<CropRect>): void
  /** Clear a media clip's crop (back to full frame). */
  resetClipCrop(clipId: string): void

  // --- Transform keyframe animation (Phase 3.5, media clips only) ---
  /**
   * Add a transform keyframe at a clip-relative `atMs`.
   *  - If the clip has NO active keyframe track yet: seed TWO keyframes (one
   *    at atMs 0, one at the requested atMs), both = the clip's current static
   *    transform — this satisfies the >= 2 invariant immediately.
   *  - If a track exists: insert ONE keyframe; its transform defaults to the
   *    interpolated value on the existing curve (no jump) unless `transform`
   *    overrides specific fields.
   * A keyframe within MIN_KEYFRAME_GAP_MS of an existing one REPLACES it.
   * Rejected when atMs<0, atMs>clip duration, or count>=MAX_KEYFRAMES_PER_CLIP.
   * No-op for caption clips.
   */
  addTransformKeyframe(
    clipId: string,
    atMs: number,
    transform?: Partial<ClipTransform>
  ): void
  /**
   * Merge into the keyframe at `kfIndex`: re-clamp atMs into [0, clipDuration],
   * merge + clamp the transform, then re-sort the track ascending by atMs.
   */
  updateTransformKeyframe(
    clipId: string,
    kfIndex: number,
    partial: { atMs?: number; transform?: Partial<ClipTransform> }
  ): void
  /**
   * Remove the keyframe at `kfIndex`. If removal would drop the track below 2
   * keyframes, the whole track is cleared and the surviving keyframe's
   * transform is written into the clip's static `transform` so the look holds.
   */
  removeTransformKeyframe(clipId: string, kfIndex: number): void
  /** Clear a clip's keyframe track entirely; keeps its static `transform`. */
  clearTransformKeyframes(clipId: string): void

  /**
   * Append a video track immediately after the last existing video track.
   * Returns the new track's id, or null if already at MAX_VIDEO_TRACKS.
   */
  addVideoTrack(): string | null
  /** Remove a video track. No-op if it is the only video track. */
  removeVideoTrack(trackId: string): void

  // --- Captions (Phase 2.4) ---
  /** Append a caption clip to the caption track. */
  addCaption(caption: CaptionClip): void
  /**
   * Bulk-append caption clips in a single atomic store update.
   * Phase 3.3 prefill flow may add 50+ captions — using addCaption in a
   * loop would trigger N re-renders; this method coalesces to one.
   * Caption clips with a non-caption trackId are silently filtered out.
   */
  addCaptions(captions: CaptionClip[]): void
  /** Generic partial update for a caption clip. */
  updateCaption(captionId: string, partial: Partial<Omit<CaptionClip, 'id' | 'kind' | 'trackId'>>): void
  /** Remove a caption clip (alias of removeClip with kind guard). */
  removeCaption(captionId: string): void
  /** Get the id of the (first) caption track in the project. */
  getCaptionTrackId(): string | null

  /**
   * Replace the entire project with one loaded from disk. Used at startup.
   * Does NOT trigger a re-persist.
   */
  _hydrateFromDisk(project: Project): void
}

// ---------------------------------------------------------------------------
// Undo/redo (Phase 4.3) — zundo middleware.
//
// We track ONLY `state.project` (the persistent doc). UI ephemera
// (selectedClipIds, playheadMs, bpm, etc.) lives in a separate store
// (timelineUi) and is intentionally excluded.
//
// "Noisy" async-generated fields on media (thumbnailPath, waveformPath) are
// stripped before equality comparison so that thumbnail/waveform jobs that
// land 200–800ms after import don't pollute the history stack.
// ---------------------------------------------------------------------------
const UNDO_LIMIT = 100
const UNDO_THROTTLE_MS = 200

/** Minimal throttle: leading-edge with trailing flush. Avoids pulling in lodash. */
function makeThrottle<F extends (...args: never[]) => void>(fn: F, wait: number): F {
  let last = 0
  let pending: Parameters<F> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (pending) {
      last = Date.now()
      const args = pending
      pending = null
      timer = null
      fn(...args)
    } else {
      timer = null
    }
  }
  return ((...args: Parameters<F>) => {
    const now = Date.now()
    const remaining = wait - (now - last)
    if (remaining <= 0) {
      last = now
      pending = null
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      fn(...args)
    } else {
      pending = args
      if (!timer) timer = setTimeout(flush, remaining)
    }
  }) as F
}

interface ProjectSnapshot {
  project: Project
}

/**
 * Strip noisy async-generated metadata before equality comparison. We do NOT
 * use partialize for this — partialize would PERMANENTLY drop the fields
 * (undoing would unset thumbnails/waveforms). Instead we compare normalized
 * shapes so thumbnail-only deltas don't create a history entry.
 */
function stripNoisy(s: ProjectSnapshot): unknown {
  const p = s.project
  return {
    ...p,
    // updatedAt changes on every touch() call but isn't user-visible mutation.
    updatedAt: 0,
    media: Object.fromEntries(
      Object.entries(p.media).map(([id, m]) => [
        id,
        { ...m, thumbnailPath: undefined, waveformPath: undefined }
      ])
    )
  }
}

function snapshotsEqual(a: ProjectSnapshot, b: ProjectSnapshot): boolean {
  // JSON.stringify is plenty fast at this scale (a 100-clip project
  // serializes in <2ms; we only run this on each mutating set, throttled to
  // 200ms minimum). If it ever shows up in a profile, swap in fast-deep-equal.
  return JSON.stringify(stripNoisy(a)) === JSON.stringify(stripNoisy(b))
}

export const useProjectStore = create<ProjectStore>()(
  temporal(
    (set, get) => ({
  project: freshProject(),
  hydrated: false,

  createNew(): void {
    set({ project: freshProject() })
    schedulePersist(get().project)
    // A brand-new project should be the new baseline; previous history
    // shouldn't be undo-able. Defer to next tick so the just-issued
    // set() lands before clear (avoids the new project itself sneaking into
    // pastStates).
    // Push past the throttle window so any in-flight trailing-edge entry
    // for the just-issued set() lands before we wipe the stack.
    setTimeout(
      () => useProjectStore.temporal.getState().clear(),
      UNDO_THROTTLE_MS + 50
    )
  },

  setName(name: string): void {
    const trimmed = (name ?? '').slice(0, 200)
    const next = touch({ ...get().project, name: trimmed })
    set({ project: next })
    schedulePersist(next)
  },

  setAspectRatio(ratio: AspectRatio): void {
    const dims = ASPECT_RATIO_DIMENSIONS[ratio]
    if (!dims) return
    const next = touch({
      ...get().project,
      aspectRatio: ratio,
      width: dims.width,
      height: dims.height
    })
    set({ project: next })
    schedulePersist(next)
  },

  addMedia(asset: MediaAsset): void {
    const project = get().project
    const next = touch({
      ...project,
      media: { ...project.media, [asset.id]: asset }
    })
    set({ project: next })
    schedulePersist(next)
  },

  updateMediaThumbnail(mediaId: string, thumbnailPath: string): void {
    const project = get().project
    const existing = project.media[mediaId]
    if (!existing) return
    const next = touch({
      ...project,
      media: {
        ...project.media,
        [mediaId]: { ...existing, thumbnailPath }
      }
    })
    set({ project: next })
    schedulePersist(next)
  },

  updateMediaWaveform(mediaId: string, waveformPath: string): void {
    const project = get().project
    const existing = project.media[mediaId]
    if (!existing) return
    const next = touch({
      ...project,
      media: {
        ...project.media,
        [mediaId]: { ...existing, waveformPath }
      }
    })
    set({ project: next })
    schedulePersist(next)
  },

  removeMedia(mediaId: string): void {
    const project = get().project
    if (!project.media[mediaId]) return
    const nextMedia = { ...project.media }
    delete nextMedia[mediaId]
    // Also drop media-clips referencing this media. Caption clips are NEVER
    // dropped here — they have no mediaId.
    const nextTracks = project.tracks.map((t) => ({
      ...t,
      clips: t.clips.filter((c) => {
        if (isMediaClip(c)) return c.mediaId !== mediaId
        return true
      })
    }))
    const next = touch({ ...project, media: nextMedia, tracks: nextTracks })
    set({ project: next })
    schedulePersist(next)
  },

  addClip(clip: Clip): void {
    const project = get().project
    const trackIdx = project.tracks.findIndex((t) => t.id === clip.trackId)
    if (trackIdx === -1) return
    // Enforce: caption track only accepts caption clips, and media tracks
    // only accept media clips. (Belt-and-suspenders against UI bugs.)
    const track = project.tracks[trackIdx]
    if (track.kind === 'caption' && clip.kind !== 'caption') return
    if (track.kind !== 'caption' && clip.kind !== 'media') return

    const tracks = [...project.tracks]
    tracks[trackIdx] = {
      ...tracks[trackIdx],
      clips: [...tracks[trackIdx].clips, clip]
    }
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeClip(clipId: string): void {
    const project = get().project
    let touched = false
    const tracks = project.tracks.map((t) => {
      const before = t.clips.length
      const clips = t.clips.filter((c) => c.id !== clipId)
      if (clips.length !== before) touched = true
      return { ...t, clips }
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  updateMediaClipTrim(clipId, partial): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const cur = t.clips[idx]
      if (!isMediaClip(cur)) return t
      const merged: VideoAudioClip = { ...cur, ...partial }
      if (merged.startMs < 0) merged.startMs = 0
      if (merged.endMs <= merged.startMs) merged.endMs = merged.startMs + 1
      if (merged.trimInMs < 0) merged.trimInMs = 0
      const clips = [...t.clips]
      clips[idx] = merged
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --- Editing operations (Phase 2.3) ---
  splitClipAt(clipId: string, atMs: number): string | null {
    const project = get().project
    let trackIdx = -1
    let clipIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      const found = project.tracks[i].clips.findIndex((c) => c.id === clipId)
      if (found !== -1) {
        trackIdx = i
        clipIdx = found
        break
      }
    }
    if (trackIdx === -1 || clipIdx === -1) return null
    const orig = project.tracks[trackIdx].clips[clipIdx]
    // Split is only supported for media clips in Phase 2.3.
    if (!isMediaClip(orig)) return null
    // Must be strictly inside the clip, with at least MIN_CLIP_MS on each side.
    if (atMs <= orig.startMs + MIN_CLIP_MS) return null
    if (atMs >= orig.endMs - MIN_CLIP_MS) return null

    const speed = orig.speed ?? 1
    // Source-time offset from orig.trimInMs for the split point.
    const offsetSourceMs = (atMs - orig.startMs) * speed
    const splitSource = orig.trimInMs + offsetSourceMs
    const newRightId = ulid()
    // -------------------------------------------------------------------
    // Phase 3.5 — keyframe split handling. CHOSEN APPROACH: partition +
    // re-base. Keyframes are clip-relative, so on split we (1) partition by
    // the clip-relative split offset, (2) re-base the right half's atMs by
    // subtracting that offset, and (3) inject a boundary keyframe (the
    // interpolated value AT the split point) into both halves so neither
    // half jumps. If either half ends up with < 2 keyframes the track is
    // collapsed to a static transform (the value at that half's midpoint).
    // -------------------------------------------------------------------
    let leftKfs: TransformKeyframe[] | undefined
    let rightKfs: TransformKeyframe[] | undefined
    let leftStaticTransform = orig.transform
    let rightStaticTransform = orig.transform
    if (hasTransformKeyframes(orig)) {
      const splitOffsetLocalMs = atMs - orig.startMs
      const boundary = clampClipTransform(getTransformAt(orig, atMs))
      const all = orig.transformKeyframes as TransformKeyframe[]
      // Left half keeps keyframes at/before the split offset + the boundary.
      const leftRaw: TransformKeyframe[] = [
        ...all.filter((kf) => kf.atMs <= splitOffsetLocalMs),
        { atMs: splitOffsetLocalMs, transform: { ...boundary } }
      ]
      // Right half keeps keyframes at/after the split offset, re-based to 0,
      // plus a boundary keyframe at re-based 0.
      const rightRaw: TransformKeyframe[] = [
        { atMs: 0, transform: { ...boundary } },
        ...all
          .filter((kf) => kf.atMs >= splitOffsetLocalMs)
          .map((kf) => ({
            atMs: kf.atMs - splitOffsetLocalMs,
            transform: { ...kf.transform }
          }))
      ]
      const leftNorm = normalizeKeyframes(leftRaw)
      const rightNorm = normalizeKeyframes(rightRaw)
      if (leftNorm.length >= 2) {
        leftKfs = leftNorm
      } else {
        // Degenerate — bake to the left half's midpoint value.
        const baked = clampClipTransform(
          getTransformAt(orig, (orig.startMs + atMs) / 2)
        )
        leftStaticTransform = isIdentityTransform(baked) ? undefined : baked
      }
      if (rightNorm.length >= 2) {
        rightKfs = rightNorm
      } else {
        const baked = clampClipTransform(
          getTransformAt(orig, (atMs + orig.endMs) / 2)
        )
        rightStaticTransform = isIdentityTransform(baked) ? undefined : baked
      }
    }
    // Phase 3.6 — `cropRect` is a SOURCE-fraction rect, so the {...orig}
    // spread below carries it unchanged to both halves (every same-source
    // descendant samples the identical sub-region). No crop-specific handling.
    const left: VideoAudioClip = {
      ...orig,
      endMs: atMs,
      trimOutMs: splitSource,
      transform: leftStaticTransform,
      transformKeyframes: leftKfs
    }
    const right: VideoAudioClip = {
      ...orig,
      id: newRightId,
      startMs: atMs,
      trimInMs: splitSource,
      transform: rightStaticTransform,
      transformKeyframes: rightKfs
    }
    const tracks = project.tracks.map((t, i) => {
      if (i !== trackIdx) return t
      const clips = [...t.clips]
      clips.splice(clipIdx, 1, left, right)
      return { ...t, clips }
    })
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return newRightId
  },

  duplicateClip(clipId: string): string | null {
    const project = get().project
    let trackIdx = -1
    let orig: Clip | null = null
    for (let i = 0; i < project.tracks.length; i++) {
      const c = project.tracks[i].clips.find((cc) => cc.id === clipId)
      if (c) {
        trackIdx = i
        orig = c
        break
      }
    }
    if (trackIdx === -1 || !orig) return null
    const duration = orig.endMs - orig.startMs
    const desired = orig.endMs

    // Find a free slot on the same track (lane-overlap walk).
    const sorted = [...project.tracks[trackIdx].clips]
      .filter((c) => c.id !== orig!.id)
      .sort((a, b) => a.startMs - b.startMs)
    let start = Math.max(0, desired)
    for (let i = 0; i <= sorted.length; i++) {
      let collided = false
      for (const c of sorted) {
        if (start < c.endMs && start + duration > c.startMs) {
          start = c.endMs
          collided = true
          break
        }
      }
      if (!collided) break
    }
    const newClipId = ulid()
    // Deep-copy: spread covers all surface fields. For caption clips we need
    // to clone the nested spans + style so future edits to the duplicate
    // don't mutate the original. Media clips have no nested mutable refs.
    let dup: Clip
    if (isCaptionClip(orig)) {
      dup = {
        ...orig,
        id: newClipId,
        startMs: start,
        endMs: start + duration,
        spans: orig.spans.map((s) => ({ ...s })),
        style: { ...orig.style }
      }
    } else {
      dup = {
        ...orig,
        id: newClipId,
        startMs: start,
        endMs: start + duration
      }
    }
    const tracks = project.tracks.map((t, i) => {
      if (i !== trackIdx) return t
      return { ...t, clips: [...t.clips, dup] }
    })
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return newClipId
  },

  setClipSpeed(clipId: string, speed: number): void {
    const project = get().project
    const clamped = Math.max(MIN_CLIP_SPEED, Math.min(MAX_CLIP_SPEED, speed))
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Speed is a media-only concept; silently ignore captions.
      if (!isMediaClip(c)) return t
      const srcDur = c.trimOutMs - c.trimInMs
      // Guard against zero/negative source duration (defensive — shouldn't
      // normally happen, but avoids divide-by-zero / negative width).
      const newTimelineDur = Math.max(
        MIN_CLIP_MS,
        Math.round(srcDur / clamped)
      )
      const updated: VideoAudioClip = {
        ...c,
        speed: clamped,
        endMs: c.startMs + newTimelineDur
      }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Audio shaping (Phase 2.5). Media clips only — caption clips ignored.
  // --------------------------------------------------------------------
  setClipGainDb(clipId: string, db: number): void {
    const numeric = Number(db)
    if (!Number.isFinite(numeric)) return
    const clamped = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, numeric))
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if ((c.gainDb ?? 0) === clamped) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, gainDb: clamped }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipFade(clipId: string, fadeInMs: number, fadeOutMs: number): void {
    const fin = Number(fadeInMs)
    const fout = Number(fadeOutMs)
    if (!Number.isFinite(fin) || !Number.isFinite(fout)) return
    // Reject negatives — no-op rather than clamp (caller bug → loud failure mode).
    if (fin < 0 || fout < 0) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const dur = Math.max(0, c.endMs - c.startMs)
      // Clamp each fade to the clip duration; then ensure fadeIn+fadeOut <= duration.
      let a = Math.min(fin, dur)
      let b = Math.min(fout, dur)
      if (a + b > dur) {
        // Proportional shrink.
        const ratio = dur / (a + b)
        a = Math.floor(a * ratio)
        b = Math.floor(b * ratio)
      }
      if ((c.fadeInMs ?? 0) === a && (c.fadeOutMs ?? 0) === b) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, fadeInMs: a, fadeOutMs: b }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipMuted(clipId: string, muted: boolean): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if (Boolean(c.isMuted) === Boolean(muted)) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, isMuted: Boolean(muted) }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setTrackMuted(trackId: string, muted: boolean): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      if (t.id !== trackId) return t
      if (Boolean(t.muted) === Boolean(muted)) return t
      changed = true
      return { ...t, muted: Boolean(muted) }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setTrackSolo(trackId: string, solo: boolean): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      if (t.id !== trackId) return t
      if (Boolean(t.solo) === Boolean(solo)) return t
      changed = true
      return { ...t, solo: Boolean(solo) }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeSilencesFromClip(clipId: string, ranges: SilenceRange[]): string[] {
    if (!Array.isArray(ranges) || ranges.length === 0) return []
    const project = get().project
    let trackIdx = -1
    let clipIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      const idx = project.tracks[i].clips.findIndex((c) => c.id === clipId)
      if (idx !== -1) {
        trackIdx = i
        clipIdx = idx
        break
      }
    }
    if (trackIdx === -1 || clipIdx === -1) return []
    const orig = project.tracks[trackIdx].clips[clipIdx]
    if (!isMediaClip(orig)) return []

    const speed = orig.speed ?? 1
    // Translate source-time silence ranges to TIMELINE ranges relative to the
    // clip. silencedetect emits source-time seconds; we received ms here.
    // src_t = trimInMs + (timeline_t - startMs) * speed
    //      => timeline_t = startMs + (src_t - trimInMs) / speed
    const localRanges: { startMs: number; endMs: number }[] = []
    for (const r of ranges) {
      // Normalize + clamp into the clip's source window.
      const sStart = Math.max(orig.trimInMs, Math.min(orig.trimOutMs, r.startMs))
      const sEnd = Math.max(orig.trimInMs, Math.min(orig.trimOutMs, r.endMs))
      if (sEnd <= sStart) continue
      const tStart = orig.startMs + (sStart - orig.trimInMs) / speed
      const tEnd = orig.startMs + (sEnd - orig.trimInMs) / speed
      localRanges.push({
        startMs: Math.round(tStart),
        endMs: Math.round(tEnd)
      })
    }
    if (localRanges.length === 0) return []
    // Sort + merge overlapping ranges.
    localRanges.sort((a, b) => a.startMs - b.startMs)
    const merged: { startMs: number; endMs: number }[] = []
    for (const r of localRanges) {
      const last = merged[merged.length - 1]
      if (last && r.startMs <= last.endMs) {
        if (r.endMs > last.endMs) last.endMs = r.endMs
      } else {
        merged.push({ startMs: r.startMs, endMs: r.endMs })
      }
    }
    // Build the surviving (voiced) timeline segments.
    const survivors: { startMs: number; endMs: number }[] = []
    let cursor = orig.startMs
    for (const m of merged) {
      if (m.startMs > cursor) {
        survivors.push({ startMs: cursor, endMs: Math.min(orig.endMs, m.startMs) })
      }
      cursor = Math.max(cursor, m.endMs)
    }
    if (cursor < orig.endMs) {
      survivors.push({ startMs: cursor, endMs: orig.endMs })
    }
    // Drop survivors shorter than MIN_CLIP_MS.
    const usable = survivors.filter((s) => s.endMs - s.startMs >= MIN_CLIP_MS)
    if (usable.length === 0) {
      // Everything was silence — drop the clip entirely.
      const tracks = project.tracks.map((t, i) => {
        if (i !== trackIdx) return t
        const clips = [...t.clips]
        clips.splice(clipIdx, 1)
        return { ...t, clips }
      })
      const next = touch({ ...project, tracks })
      set({ project: next })
      schedulePersist(next)
      return []
    }
    // Compose new media clips. Each survivor is a fresh clip referencing the
    // same media; trimInMs/trimOutMs are derived from the timeline window.
    const ids: string[] = []
    const built: VideoAudioClip[] = usable.map((s) => {
      const id = ulid()
      ids.push(id)
      const trimIn = orig.trimInMs + (s.startMs - orig.startMs) * speed
      const trimOut = orig.trimInMs + (s.endMs - orig.startMs) * speed
      return {
        ...orig,
        id,
        startMs: s.startMs,
        endMs: s.endMs,
        trimInMs: Math.max(0, Math.round(trimIn)),
        trimOutMs: Math.max(0, Math.round(trimOut))
      }
    })
    const tracks = project.tracks.map((t, i) => {
      if (i !== trackIdx) return t
      const clips = [...t.clips]
      clips.splice(clipIdx, 1, ...built)
      return { ...t, clips }
    })
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return ids
  },

  // --------------------------------------------------------------------
  // Transitions + filters (Phase 2.6) — media clips only.
  // --------------------------------------------------------------------
  setClipTransitionIn(clipId, kind, durationMs): void {
    const project = get().project
    const dur = Math.max(
      MIN_TRANSITION_MS,
      Math.min(
        MAX_TRANSITION_MS,
        Math.round(Number(durationMs ?? DEFAULT_TRANSITION_MS))
      )
    )
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const updated: VideoAudioClip =
        kind === 'none'
          ? { ...c, transitionIn: undefined }
          : { ...c, transitionIn: { kind, durationMs: dur } }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipFilter(clipId, preset, intensity): void {
    const project = get().project
    const clamped = Math.max(0, Math.min(1, Number(intensity ?? 1)))
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const updated: VideoAudioClip =
        preset === 'none'
          ? { ...c, filterPreset: 'none', filterIntensity: 1 }
          : { ...c, filterPreset: preset, filterIntensity: clamped }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Transform + layer compositing (Phase 3) — media clips only.
  // --------------------------------------------------------------------
  setClipTransform(clipId, partial): void {
    if (!partial || typeof partial !== 'object') return
    // Reject any non-finite numeric input outright (caller bug → no-op).
    for (const v of Object.values(partial)) {
      if (v !== undefined && !Number.isFinite(v)) return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Transform is a media-only concept; silently ignore captions.
      if (!isMediaClip(c)) return t
      const merged: ClipTransform = { ...getClipTransform(c), ...partial }
      // Clamp each field to its allowed range.
      merged.scale = Math.max(
        MIN_TRANSFORM_SCALE,
        Math.min(MAX_TRANSFORM_SCALE, merged.scale)
      )
      merged.rotation = Math.max(
        MIN_TRANSFORM_ROTATION,
        Math.min(MAX_TRANSFORM_ROTATION, merged.rotation)
      )
      merged.opacity = Math.max(0, Math.min(1, merged.opacity))
      merged.x = Math.max(
        MIN_TRANSFORM_OFFSET,
        Math.min(MAX_TRANSFORM_OFFSET, merged.x)
      )
      merged.y = Math.max(
        MIN_TRANSFORM_OFFSET,
        Math.min(MAX_TRANSFORM_OFFSET, merged.y)
      )
      const updated: VideoAudioClip = isIdentityTransform(merged)
        ? { ...c, transform: undefined }
        : { ...c, transform: merged }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  resetClipTransform(clipId: string): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, transform: undefined }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Static source crop (Phase 3.6) — media clips only.
  // --------------------------------------------------------------------
  setClipCrop(clipId, partial): void {
    if (!partial || typeof partial !== 'object') return
    // Reject any non-finite numeric input outright (caller bug → no-op).
    for (const v of Object.values(partial)) {
      if (v !== undefined && !Number.isFinite(v)) return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Crop is a media-only concept; silently ignore captions.
      if (!isMediaClip(c)) return t
      const merged = clampCropRect({ ...(c.cropRect ?? IDENTITY_CROP), ...partial })
      const updated: VideoAudioClip = isIdentityCrop(merged)
        ? { ...c, cropRect: undefined }
        : { ...c, cropRect: merged }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  resetClipCrop(clipId: string): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, cropRect: undefined }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Transform keyframe animation (Phase 3.5) — media clips only.
  //
  // Invariants enforced after every mutation:
  //   - transformKeyframes is sorted ascending by atMs
  //   - keyframes closer than MIN_KEYFRAME_GAP_MS are deduped/replaced
  //   - a length-1 array is NEVER persisted (collapses to static transform)
  //   - every stored keyframe transform is range-clamped
  // --------------------------------------------------------------------
  addTransformKeyframe(clipId, atMs, transform): void {
    const at = Math.round(Number(atMs))
    if (!Number.isFinite(at) || at < 0) return
    if (transform && typeof transform === 'object') {
      for (const v of Object.values(transform)) {
        if (v !== undefined && !Number.isFinite(v)) return
      }
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const dur = getClipDuration(c)
      if (at > dur) return t
      const existing = Array.isArray(c.transformKeyframes)
        ? [...c.transformKeyframes]
        : []
      let nextKfs: TransformKeyframe[]
      if (existing.length < 2) {
        // No active track — seed two keyframes (atMs 0 + requested) both at
        // the clip's current static transform. If atMs===0 the dedup below
        // collapses them, so nudge the second to a minimal non-zero offset.
        const base = clampClipTransform(getClipTransform(c))
        const secondAt = at <= 0 ? Math.min(dur, MIN_KEYFRAME_GAP_MS) : at
        nextKfs = [
          { atMs: 0, transform: { ...base } },
          { atMs: secondAt, transform: { ...base } }
        ]
        // If the requested keyframe carried explicit field overrides, apply
        // them to the requested (second) keyframe.
        if (transform && Object.keys(transform).length > 0) {
          nextKfs[1] = {
            atMs: secondAt,
            transform: clampClipTransform({ ...base, ...transform })
          }
        }
      } else {
        if (existing.length >= MAX_KEYFRAMES_PER_CLIP) return t
        // Land on the existing curve so the insert doesn't cause a jump.
        const onCurve = getTransformAt(c, c.startMs + at)
        const merged: ClipTransform =
          transform && Object.keys(transform).length > 0
            ? clampClipTransform({ ...onCurve, ...transform })
            : clampClipTransform(onCurve)
        nextKfs = [...existing, { atMs: at, transform: merged }]
      }
      const finalKfs = normalizeKeyframes(nextKfs)
      if (finalKfs.length < 2) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, transformKeyframes: finalKfs }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  updateTransformKeyframe(clipId, kfIndex, partial): void {
    if (!partial || typeof partial !== 'object') return
    if (
      partial.transform &&
      typeof partial.transform === 'object'
    ) {
      for (const v of Object.values(partial.transform)) {
        if (v !== undefined && !Number.isFinite(v)) return
      }
    }
    if (
      partial.atMs !== undefined &&
      !Number.isFinite(Number(partial.atMs))
    ) {
      return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const existing = Array.isArray(c.transformKeyframes)
        ? [...c.transformKeyframes]
        : []
      if (kfIndex < 0 || kfIndex >= existing.length) return t
      const dur = getClipDuration(c)
      const cur = existing[kfIndex]
      const nextAt =
        partial.atMs !== undefined
          ? Math.max(0, Math.min(dur, Math.round(Number(partial.atMs))))
          : cur.atMs
      const nextTransform = partial.transform
        ? clampClipTransform({ ...cur.transform, ...partial.transform })
        : clampClipTransform(cur.transform)
      const updated = existing.map((kf, i) =>
        i === kfIndex ? { atMs: nextAt, transform: nextTransform } : kf
      )
      const finalKfs = normalizeKeyframes(updated)
      const clips = [...t.clips]
      if (finalKfs.length < 2) {
        // Collapsed below the invariant (dedup merged everything) — fall
        // back to a static transform from the surviving keyframe.
        clips[idx] = {
          ...c,
          transform: finalKfs[0] ? finalKfs[0].transform : c.transform,
          transformKeyframes: undefined
        }
      } else {
        clips[idx] = { ...c, transformKeyframes: finalKfs }
      }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeTransformKeyframe(clipId, kfIndex): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const existing = Array.isArray(c.transformKeyframes)
        ? [...c.transformKeyframes]
        : []
      if (kfIndex < 0 || kfIndex >= existing.length) return t
      const remaining = existing.filter((_, i) => i !== kfIndex)
      const clips = [...t.clips]
      if (remaining.length < 2) {
        // Track would fall below the >= 2 invariant — clear it and bake the
        // surviving keyframe's transform into the static transform so the
        // current look is kept.
        const survivor = remaining[0]
        const baked = survivor
          ? clampClipTransform(survivor.transform)
          : undefined
        clips[idx] = {
          ...c,
          transform:
            baked && !isIdentityTransform(baked) ? baked : undefined,
          transformKeyframes: undefined
        }
      } else {
        clips[idx] = {
          ...c,
          transformKeyframes: normalizeKeyframes(remaining)
        }
      }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  clearTransformKeyframes(clipId): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if (c.transformKeyframes === undefined) return t
      const clips = [...t.clips]
      // Keep the static transform untouched — only drop the animation track.
      clips[idx] = { ...c, transformKeyframes: undefined }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  addVideoTrack(): string | null {
    const project = get().project
    const videoCount = project.tracks.filter((t) => t.kind === 'video').length
    if (videoCount >= MAX_VIDEO_TRACKS) return null
    const id = ulid()
    const newTrack = {
      id,
      kind: 'video' as const,
      name: `Video ${videoCount + 1}`,
      clips: []
    }
    // Insert immediately AFTER the last existing video track — keeps video
    // tracks contiguous; a later track renders on top (higher layer).
    let lastVideoIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      if (project.tracks[i].kind === 'video') lastVideoIdx = i
    }
    const tracks = [...project.tracks]
    tracks.splice(lastVideoIdx + 1, 0, newTrack)
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return id
  },

  removeVideoTrack(trackId: string): void {
    const project = get().project
    const target = project.tracks.find((t) => t.id === trackId)
    if (!target || target.kind !== 'video') return
    // Refuse to remove the last remaining video track.
    const videoCount = project.tracks.filter((t) => t.kind === 'video').length
    if (videoCount <= 1) return
    let touched = false
    const tracks = project.tracks.filter((t) => {
      if (t.id === trackId) {
        touched = true
        return false
      }
      return true
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  addCaption(caption: CaptionClip): void {
    // Delegate to addClip; addClip validates track-kind compatibility.
    get().addClip(caption)
  },

  addCaptions(captions: CaptionClip[]): void {
    if (!Array.isArray(captions) || captions.length === 0) return
    const project = get().project
    // Find caption track once. If there's no caption track, this is a no-op
    // (matches addCaption's silent failure mode).
    const captionTrackIdx = project.tracks.findIndex((t) => t.kind === 'caption')
    if (captionTrackIdx === -1) return
    const captionTrackId = project.tracks[captionTrackIdx].id
    // Filter + reassign trackId defensively. Caller can supply any trackId,
    // but bulk insert MUST land on the caption track to match addCaption.
    const accepted: CaptionClip[] = []
    for (const c of captions) {
      if (!c || c.kind !== 'caption') continue
      accepted.push(c.trackId === captionTrackId ? c : { ...c, trackId: captionTrackId })
    }
    if (accepted.length === 0) return
    const tracks = project.tracks.map((t, i) => {
      if (i !== captionTrackIdx) return t
      return { ...t, clips: [...t.clips, ...accepted] }
    })
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  updateCaption(captionId, partial): void {
    const project = get().project
    let touched = false
    const tracks = project.tracks.map((t) => {
      if (t.kind !== 'caption') return t
      const clips = t.clips.map((c) => {
        if (!isCaptionClip(c)) return c
        if (c.id !== captionId) return c
        touched = true
        const merged: CaptionClip = {
          ...c,
          ...partial,
          // Preserve immutable fields if caller passed them in by mistake.
          id: c.id,
          kind: 'caption',
          trackId: c.trackId,
          // Merge nested style/spans shallowly.
          style: partial.style ? { ...c.style, ...partial.style } : c.style,
          spans: partial.spans ?? c.spans
        }
        return merged
      })
      return { ...t, clips }
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeCaption(captionId: string): void {
    const project = get().project
    let touched = false
    const tracks = project.tracks.map((t) => {
      if (t.kind !== 'caption') return t
      const before = t.clips.length
      const clips = t.clips.filter((c) => !(isCaptionClip(c) && c.id === captionId))
      if (clips.length !== before) touched = true
      return { ...t, clips }
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  getCaptionTrackId(): string | null {
    const track = get().project.tracks.find((t) => t.kind === 'caption')
    return track ? track.id : null
  },

  _hydrateFromDisk(project: Project): void {
    set({ project: migrateLoadedProject(project), hydrated: true })
    // A loaded project IS the new baseline — nothing before this point
    // should be undo-able. Defer to next tick so the set() above lands first.
    // Push past the throttle window so any in-flight trailing-edge entry
    // for the just-issued set() lands before we wipe the stack.
    setTimeout(
      () => useProjectStore.temporal.getState().clear(),
      UNDO_THROTTLE_MS + 50
    )
  }
    }),
    {
      limit: UNDO_LIMIT,
      // Track only the project doc. `hydrated` is bootstrap state, not user
      // mutation; everything else (UI ephemera, action refs) is excluded.
      partialize: (state): ProjectSnapshot => ({ project: state.project }),
      // Skip history entries where only the noisy fields differ (thumbnail
      // paths, waveform paths, updatedAt timestamps).
      equality: snapshotsEqual,
      // Throttle rapid mutations (drags, scrubs) into one entry per
      // UNDO_THROTTLE_MS window. The leading edge captures the first state
      // change instantly; subsequent changes within the window are coalesced
      // into a single trailing entry.
      //
      // Note: zundo internally curries `handleSet` with 4 args (past, replace,
      // current, delta), but its TS type narrows to the 1-2-arg StoreApi
      // setState shape. We pass args through opaquely.
      handleSet: (handleSet) => {
        const throttled = makeThrottle(
          (...args: unknown[]) => {
            ;(handleSet as unknown as (...a: unknown[]) => void)(...args)
          },
          UNDO_THROTTLE_MS
        )
        return throttled as unknown as typeof handleSet
      }
    }
  )
)

/**
 * Hook to subscribe a component reactively to the undo/redo state.
 * `pastStates.length` / `futureStates.length` are derived (canUndo/canRedo).
 */
export interface UndoRedoApi {
  undo: () => void
  redo: () => void
  clear: () => void
  canUndo: boolean
  canRedo: boolean
  pastCount: number
  futureCount: number
}

export function useUndoRedo(): UndoRedoApi {
  // Subscribe to scalar primitives only so each useStore call uses Object.is
  // safely. Returning an aggregated object from a single selector would
  // create a new reference each render and infinite-loop React.
  const pastCount = useStore(
    useProjectStore.temporal,
    (s: TemporalState<ProjectSnapshot>) => s.pastStates.length
  )
  const futureCount = useStore(
    useProjectStore.temporal,
    (s: TemporalState<ProjectSnapshot>) => s.futureStates.length
  )
  const undo = useStore(
    useProjectStore.temporal,
    (s: TemporalState<ProjectSnapshot>) => s.undo
  )
  const redo = useStore(
    useProjectStore.temporal,
    (s: TemporalState<ProjectSnapshot>) => s.redo
  )
  const clear = useStore(
    useProjectStore.temporal,
    (s: TemporalState<ProjectSnapshot>) => s.clear
  )
  return {
    undo,
    redo,
    clear,
    canUndo: pastCount > 0,
    canRedo: futureCount > 0,
    pastCount,
    futureCount
  }
}

// ---------------------------------------------------------------------------
// Init: try to load the persisted project once when this module is imported.
// ---------------------------------------------------------------------------
let hydrationStarted = false

export function initProjectStore(): Promise<void> {
  if (hydrationStarted) return Promise.resolve()
  hydrationStarted = true

  if (typeof window === 'undefined' || !window.electron?.fs?.readProject) {
    persistEnabled = true
    useProjectStore.setState({ hydrated: true })
    return Promise.resolve()
  }

  return window.electron.fs
    .readProject()
    .then((p) => {
      if (p) useProjectStore.getState()._hydrateFromDisk(p)
      else useProjectStore.setState({ hydrated: true })
    })
    .catch((err: unknown) => {
      console.error('[store] readProject failed', err)
      useProjectStore.setState({ hydrated: true })
    })
    .finally(() => {
      // Only enable persistence AFTER hydration so we never overwrite a
      // valid on-disk project with the default in-memory blank.
      persistEnabled = true
      // Wipe any history accumulated during the hydrate set() calls — the
      // post-hydrate state is the user's baseline, not undo-able.
      try {
        useProjectStore.temporal.getState().clear()
      } catch {
        /* defensive — temporal should always exist post-init */
      }
    })
}

/** Generates a fresh ulid (re-exported for renderer convenience). */
export function newId(): string {
  return ulid()
}

/** Compute the total timeline duration (max endMs across every clip). */
export function getTotalDurationMs(project: Project): number {
  let max = 0
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.endMs > max) max = c.endMs
    }
  }
  return max
}

// ---------------------------------------------------------------------------
// E2E hook: expose the store on window so Playwright can introspect state.
// Strictly read-only via getState; tests that need to mutate go through IPC
// or DOM actions. Guarded behind the renderer's window (no-op in node).
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  ;(window as unknown as { __PROJECT_STORE_FOR_TEST__: typeof useProjectStore }).__PROJECT_STORE_FOR_TEST__ =
    useProjectStore
}
