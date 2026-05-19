import { ulid } from 'ulid'
import { create } from 'zustand'
import {
  ASPECT_RATIO_DIMENSIONS,
  DEFAULT_DUCKING_DB,
  DEFAULT_TRANSITION_MS,
  MAX_CLIP_SPEED,
  MAX_GAIN_DB,
  MAX_TRANSITION_MS,
  MIN_CLIP_MS,
  MIN_CLIP_SPEED,
  MIN_GAIN_DB,
  MIN_TRANSITION_MS,
  type AspectRatio,
  type CaptionClip,
  type Clip,
  type FilterPreset,
  type MediaAsset,
  type Project,
  type TransitionKind,
  type VideoAudioClip,
  isCaptionClip,
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

export const useProjectStore = create<ProjectStore>((set, get) => ({
  project: freshProject(),
  hydrated: false,

  createNew(): void {
    set({ project: freshProject() })
    schedulePersist(get().project)
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
    const left: VideoAudioClip = {
      ...orig,
      endMs: atMs,
      trimOutMs: splitSource
    }
    const right: VideoAudioClip = {
      ...orig,
      id: newRightId,
      startMs: atMs,
      trimInMs: splitSource
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
  }
}))

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
