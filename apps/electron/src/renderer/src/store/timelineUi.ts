import { create } from 'zustand'

/**
 * Transient UI state for the timeline + preview. NOT persisted to disk.
 */
export interface TimelineUiStore {
  /** Pixels-per-second zoom. */
  pps: number
  /** Playhead position in milliseconds. */
  playheadMs: number
  /** Is the transport playing? */
  playing: boolean
  /**
   * Selected clip ids. Phase 2.3 is single-select only, but we use a Set so
   * the model is forward-compatible with multi-select.
   */
  selectedClipIds: Set<string>

  setPps(pps: number): void
  setPlayheadMs(ms: number): void
  setPlaying(playing: boolean): void
  togglePlaying(): void

  /** Replace the selection with a single clip id (or clear if null). */
  selectClip(clipId: string | null): void
  /** Add or remove a clip id without disturbing the rest (future multi-select). */
  toggleClipSelected(clipId: string): void
  /** Clear all selection. */
  clearSelection(): void
}

export const DEFAULT_PPS = 50
export const MIN_PPS = 10
export const MAX_PPS = 400

export const useTimelineUi = create<TimelineUiStore>((set, get) => ({
  pps: DEFAULT_PPS,
  playheadMs: 0,
  playing: false,
  selectedClipIds: new Set<string>(),

  setPps(pps: number): void {
    const clamped = Math.max(MIN_PPS, Math.min(MAX_PPS, pps))
    if (clamped !== get().pps) set({ pps: clamped })
  },
  setPlayheadMs(ms: number): void {
    const v = Math.max(0, Math.floor(ms))
    if (v !== get().playheadMs) set({ playheadMs: v })
  },
  setPlaying(playing: boolean): void {
    if (playing !== get().playing) set({ playing })
  },
  togglePlaying(): void {
    set({ playing: !get().playing })
  },

  selectClip(clipId: string | null): void {
    const current = get().selectedClipIds
    if (clipId === null) {
      if (current.size === 0) return
      set({ selectedClipIds: new Set() })
      return
    }
    if (current.size === 1 && current.has(clipId)) return
    set({ selectedClipIds: new Set([clipId]) })
  },
  toggleClipSelected(clipId: string): void {
    const next = new Set(get().selectedClipIds)
    if (next.has(clipId)) next.delete(clipId)
    else next.add(clipId)
    set({ selectedClipIds: next })
  },
  clearSelection(): void {
    if (get().selectedClipIds.size === 0) return
    set({ selectedClipIds: new Set() })
  }
}))

/** Convenience helper — returns the currently selected single clip id, or null. */
export function getSelectedClipId(): string | null {
  const sel = useTimelineUi.getState().selectedClipIds
  if (sel.size === 0) return null
  // Set iteration order matches insertion; first is fine for single-select.
  return sel.values().next().value ?? null
}
