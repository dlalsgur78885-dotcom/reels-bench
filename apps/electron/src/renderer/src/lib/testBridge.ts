/**
 * Test-only bridge: exposes editing-ops on a stable window namespace for
 * Playwright E2E. Designed to coexist with the existing per-store hooks
 * (`__PROJECT_STORE_FOR_TEST__`, `__TIMELINE_UI_FOR_TEST__`).
 *
 * This file does NOT extend the preload bridge and never touches IPC or
 * the filesystem — it's purely renderer-side ergonomics for tests. The
 * surface is read-mostly; tests that need to mutate via real user input
 * should still drive the DOM.
 */
import { newId, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'

export function installTestBridge(): void {
  if (typeof window !== 'undefined') {
    ;(window as unknown as {
      __reelsStore: {
        state: () => ReturnType<typeof useProjectStore.getState>
        addMedia: ReturnType<typeof useProjectStore.getState>['addMedia']
        addClip: ReturnType<typeof useProjectStore.getState>['addClip']
        removeClip: ReturnType<typeof useProjectStore.getState>['removeClip']
        updateMediaClipTrim: ReturnType<
          typeof useProjectStore.getState
        >['updateMediaClipTrim']
        splitClipAt: ReturnType<typeof useProjectStore.getState>['splitClipAt']
        duplicateClip: ReturnType<typeof useProjectStore.getState>['duplicateClip']
        setClipSpeed: ReturnType<typeof useProjectStore.getState>['setClipSpeed']
        createNew: ReturnType<typeof useProjectStore.getState>['createNew']
        newId: () => string
      }
    }).__reelsStore = {
      state: () => useProjectStore.getState(),
      addMedia: (asset) => useProjectStore.getState().addMedia(asset),
      addClip: (clip) => useProjectStore.getState().addClip(clip),
      removeClip: (id) => useProjectStore.getState().removeClip(id),
      updateMediaClipTrim: (id, partial) =>
        useProjectStore.getState().updateMediaClipTrim(id, partial),
      splitClipAt: (id, atMs) =>
        useProjectStore.getState().splitClipAt(id, atMs),
      duplicateClip: (id) => useProjectStore.getState().duplicateClip(id),
      setClipSpeed: (id, speed) =>
        useProjectStore.getState().setClipSpeed(id, speed),
      createNew: () => useProjectStore.getState().createNew(),
      newId
    }
    ;(window as unknown as {
      __reelsTimelineUi: typeof useTimelineUi
    }).__reelsTimelineUi = useTimelineUi
  }
}
