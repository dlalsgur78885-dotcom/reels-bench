/**
 * Test-only bridge: exposes the Zustand stores on window for Playwright E2E.
 *
 * Activated when import.meta.env.DEV is true (electron-vite dev) OR when the
 * built renderer is running inside the e2e harness (the launch helper sets
 * window.__REELS_E2E via the main process). This is a renderer-side
 * convenience for tests; it does NOT extend the preload bridge and never
 * touches IPC or filesystem.
 */
import { newId, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'

export function installTestBridge(): void {
  if (typeof window === 'undefined') return
  // Always install — the surface is read-mostly and these stores are already
  // present in renderer memory. Avoids fragile dev-only detection on Windows
  // CI. Cost: a few KB of references on window.
  ;(window as unknown as {
    __reelsStore: {
      state: () => ReturnType<typeof useProjectStore.getState>
      addMedia: ReturnType<typeof useProjectStore.getState>['addMedia']
      addClip: ReturnType<typeof useProjectStore.getState>['addClip']
      updateClip: ReturnType<typeof useProjectStore.getState>['updateClip']
      removeClip: ReturnType<typeof useProjectStore.getState>['removeClip']
      createNew: ReturnType<typeof useProjectStore.getState>['createNew']
      newId: () => string
    }
  }).__reelsStore = {
    state: () => useProjectStore.getState(),
    addMedia: (asset) => useProjectStore.getState().addMedia(asset),
    addClip: (clip) => useProjectStore.getState().addClip(clip),
    updateClip: (id, partial) =>
      useProjectStore.getState().updateClip(id, partial),
    removeClip: (id) => useProjectStore.getState().removeClip(id),
    createNew: () => useProjectStore.getState().createNew(),
    newId
  }
  ;(window as unknown as {
    __reelsTimelineUi: typeof useTimelineUi
  }).__reelsTimelineUi = useTimelineUi
}
