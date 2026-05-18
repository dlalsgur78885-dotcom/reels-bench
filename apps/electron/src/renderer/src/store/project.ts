import { ulid } from 'ulid'
import { create } from 'zustand'
import {
  ASPECT_RATIO_DIMENSIONS,
  MAX_CLIP_SPEED,
  MIN_CLIP_MS,
  MIN_CLIP_SPEED,
  type AspectRatio,
  type CaptionClip,
  type Clip,
  type MediaAsset,
  type Project,
  type VideoAudioClip,
  isCaptionClip,
  isMediaClip
} from '../../../shared/project'

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
      { id: ulid(), kind: 'audio', name: 'Audio 1', clips: [] },
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

  // --- Captions (Phase 2.4) ---
  /** Append a caption clip to the caption track. */
  addCaption(caption: CaptionClip): void
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

  addCaption(caption: CaptionClip): void {
    // Delegate to addClip; addClip validates track-kind compatibility.
    get().addClip(caption)
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
