import { ulid } from 'ulid'
import { create } from 'zustand'
import {
  ASPECT_RATIO_DIMENSIONS,
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

// ---------------------------------------------------------------------------
// E2E hook: expose the store on window so Playwright can introspect state.
// Strictly read-only via getState; tests that need to mutate go through IPC
// or DOM actions. Guarded behind the renderer's window (no-op in node).
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  ;(window as unknown as { __PROJECT_STORE_FOR_TEST__: typeof useProjectStore }).__PROJECT_STORE_FOR_TEST__ =
    useProjectStore
}
