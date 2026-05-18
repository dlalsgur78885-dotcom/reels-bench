import { create } from 'zustand'

/**
 * Transient UI state for the timeline (selection model).
 * NOT persisted to disk — this is purely UI ephemera.
 *
 * Phase 2.3 is single-select only, but the model exposes a Set so we can
 * future-proof for multi-select (Ctrl/Shift-click) without an interface
 * break.
 */
export interface TimelineUiStore {
  /** Selected clip ids. Single-select today; Set forward-compat. */
  selectedClipIds: Set<string>

  /** Replace the selection with a single clip id (or clear if null). */
  selectClip(clipId: string | null): void
  /** Add or remove a clip id without disturbing the rest (multi-select hook). */
  toggleClipSelected(clipId: string): void
  /** Clear all selection. */
  clearSelection(): void
}

export const useTimelineUi = create<TimelineUiStore>((set, get) => ({
  selectedClipIds: new Set<string>(),

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
