import { ulid } from 'ulid'
import { create } from 'zustand'
import {
  ASPECT_RATIO_DIMENSIONS,
  type AspectRatio,
  type Clip,
  type MediaAsset,
  type Project,
  MIN_CLIP_SPEED,
  MAX_CLIP_SPEED
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
      { id: ulid(), kind: 'audio', name: 'Audio 1', clips: [] }
    ],
    media: {},
    createdAt: now,
    updatedAt: now
  }
}

function touch(p: Project): Project {
  return { ...p, updatedAt: Date.now() }
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
  updateClip(clipId: string, partial: Partial<Clip>): void
  removeClip(clipId: string): void
  /**
   * Split a clip at the given absolute timeline ms.
   * Returns the id of the newly created right-side clip, or null if the
   * split would produce a sub-100ms fragment or the position is out of range.
   */
  splitClipAt(clipId: string, atMs: number): string | null
  /**
   * Deep-clone a clip and place the duplicate immediately after the original
   * on the same track. Returns the new clip's id, or null on failure.
   */
  duplicateClip(clipId: string): string | null
  /**
   * Set a clip's playback speed. Recomputes endMs while keeping startMs and
   * the source in/out range (trimInMs..trimOutMs) fixed.
   */
  setClipSpeed(clipId: string, speed: number): void

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
    // Also drop clips referencing this media from every track.
    const nextTracks = project.tracks.map((t) => ({
      ...t,
      clips: t.clips.filter((c) => c.mediaId !== mediaId)
    }))
    const next = touch({ ...project, media: nextMedia, tracks: nextTracks })
    set({ project: next })
    schedulePersist(next)
  },

  addClip(clip: Clip): void {
    const project = get().project
    const trackIdx = project.tracks.findIndex((t) => t.id === clip.trackId)
    if (trackIdx === -1) return
    const tracks = [...project.tracks]
    tracks[trackIdx] = {
      ...tracks[trackIdx],
      clips: [...tracks[trackIdx].clips, clip]
    }
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  updateClip(clipId: string, partial: Partial<Clip>): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const current = t.clips[idx]
      const nextClip = { ...current, ...partial, id: current.id }
      // Light invariant: keep startMs < endMs, clamp non-negative.
      if (nextClip.startMs < 0) nextClip.startMs = 0
      if (nextClip.endMs <= nextClip.startMs) {
        nextClip.endMs = nextClip.startMs + 1
      }
      const clips = [...t.clips]
      clips[idx] = nextClip
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeClip(clipId: string): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const filtered = t.clips.filter((c) => c.id !== clipId)
      if (filtered.length !== t.clips.length) changed = true
      return filtered.length === t.clips.length ? t : { ...t, clips: filtered }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

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
    // Must be strictly inside the clip, with at least 100ms on each side.
    if (atMs <= orig.startMs + 100) return null
    if (atMs >= orig.endMs - 100) return null
    const speed = orig.speed ?? 1
    // Source-time offset from orig.trimInMs for the split point.
    const offsetSourceMs = (atMs - orig.startMs) * speed
    const splitSource = orig.trimInMs + offsetSourceMs
    const newRightId = ulid()
    const left: Clip = { ...orig, endMs: atMs, trimOutMs: splitSource }
    const right: Clip = {
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
    // Reuse the lane-overlap logic inline (same algorithm as Timeline.tsx).
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
    const newId = ulid()
    const dup: Clip = {
      ...orig,
      id: newId,
      startMs: start,
      endMs: start + duration
    }
    const tracks = project.tracks.map((t, i) => {
      if (i !== trackIdx) return t
      return { ...t, clips: [...t.clips, dup] }
    })
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return newId
  },

  setClipSpeed(clipId: string, speed: number): void {
    const project = get().project
    const clamped = Math.max(MIN_CLIP_SPEED, Math.min(MAX_CLIP_SPEED, speed))
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      const srcDur = c.trimOutMs - c.trimInMs
      const newTimelineDur = Math.max(1, Math.round(srcDur / clamped))
      const updated: Clip = {
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

  _hydrateFromDisk(project: Project): void {
    set({ project, hydrated: true })
  }
}))

// ---------------------------------------------------------------------------
// Selector helpers — pure functions; safe to call from any component.
// ---------------------------------------------------------------------------
export function getClipAt(project: Project, trackId: string, ms: number): Clip | null {
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return null
  for (const c of track.clips) {
    if (ms >= c.startMs && ms < c.endMs) return c
  }
  return null
}

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
