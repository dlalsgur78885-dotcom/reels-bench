import { create } from 'zustand'

/**
 * Transient UI state for the timeline (selection model + playback state +
 * zoom). NOT persisted to disk — this is purely UI ephemera.
 *
 * Phase 2.3 introduced single-select; the model exposes a Set so we can
 * future-proof for multi-select (Ctrl/Shift-click) without an interface
 * break. Phase 2.2 (this milestone) adds playback (playheadMs/playing) and
 * zoom (pps).
 */
export interface TimelineUiStore {
  // ----- Selection (Phase 2.3) -----
  /** Selected clip ids. Single-select today; Set forward-compat. */
  selectedClipIds: Set<string>
  /** Replace the selection with a single clip id (or clear if null). */
  selectClip(clipId: string | null): void
  /** Add or remove a clip id without disturbing the rest (multi-select hook). */
  toggleClipSelected(clipId: string): void
  /** Clear all selection. */
  clearSelection(): void

  // ----- Playback (Phase 2.2) -----
  /** Playhead position in milliseconds (>= 0). */
  playheadMs: number
  /** True while the transport is playing (rAF loop is ticking). */
  playing: boolean
  /** Move the playhead. Floored to int ms, clamped at 0. */
  setPlayheadMs(ms: number): void
  /** Set the playing flag explicitly. */
  setPlaying(playing: boolean): void
  /** Flip the playing flag. */
  togglePlaying(): void

  // ----- Zoom (Phase 2.2) -----
  /** Pixels-per-second. Default 60. Clamped to [MIN_PPS, MAX_PPS]. */
  pps: number
  /** Update pixels-per-second; out-of-range values are clamped. */
  setPps(pps: number): void
}

/** Default pixels-per-second for the timeline ruler. */
export const DEFAULT_PPS = 60
/** Lower bound for zoom-out. */
export const MIN_PPS = 10
/** Upper bound for zoom-in. */
export const MAX_PPS = 400

export const useTimelineUi = create<TimelineUiStore>((set, get) => ({
  selectedClipIds: new Set<string>(),
  playheadMs: 0,
  playing: false,
  pps: DEFAULT_PPS,

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

  setPps(pps: number): void {
    const clamped = Math.max(MIN_PPS, Math.min(MAX_PPS, pps))
    if (clamped !== get().pps) set({ pps: clamped })
  }
}))

/** Convenience: returns the currently selected single clip id, or null. */
export function getSelectedClipId(): string | null {
  const sel = useTimelineUi.getState().selectedClipIds
  if (sel.size === 0) return null
  return sel.values().next().value ?? null
}

// ---------------------------------------------------------------------------
// E2E hook: expose the store on window so Playwright can introspect state.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  ;(window as unknown as {
    __TIMELINE_UI_FOR_TEST__: typeof useTimelineUi
  }).__TIMELINE_UI_FOR_TEST__ = useTimelineUi
}
