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
import {
  getReelAnalysis,
  getReelMetadata,
  getReelVideoUrl,
  listMyReels,
  authedFetch
} from './api'
import { newId, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import { emailToUserIdLabel, idToEmail } from '../store/auth'

export function installTestBridge(): void {
  if (typeof window !== 'undefined') {
    type Store = ReturnType<typeof useProjectStore.getState>
    ;(window as unknown as {
      __reelsStore: {
        state: () => Store
        addMedia: Store['addMedia']
        addClip: Store['addClip']
        removeClip: Store['removeClip']
        updateMediaClipTrim: Store['updateMediaClipTrim']
        splitClipAt: Store['splitClipAt']
        duplicateClip: Store['duplicateClip']
        setClipSpeed: Store['setClipSpeed']
        createNew: Store['createNew']
        setClipGainDb: Store['setClipGainDb']
        setClipFade: Store['setClipFade']
        setClipMuted: Store['setClipMuted']
        setTrackMuted: Store['setTrackMuted']
        setTrackSolo: Store['setTrackSolo']
        removeSilencesFromClip: Store['removeSilencesFromClip']
        updateMediaWaveform: Store['updateMediaWaveform']
        setClipTransitionIn: Store['setClipTransitionIn']
        setClipFilter: Store['setClipFilter']
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
      setClipGainDb: (id, db) =>
        useProjectStore.getState().setClipGainDb(id, db),
      setClipFade: (id, fin, fout) =>
        useProjectStore.getState().setClipFade(id, fin, fout),
      setClipMuted: (id, muted) =>
        useProjectStore.getState().setClipMuted(id, muted),
      setTrackMuted: (tid, muted) =>
        useProjectStore.getState().setTrackMuted(tid, muted),
      setTrackSolo: (tid, solo) =>
        useProjectStore.getState().setTrackSolo(tid, solo),
      removeSilencesFromClip: (id, ranges) =>
        useProjectStore.getState().removeSilencesFromClip(id, ranges),
      updateMediaWaveform: (mid, p) =>
        useProjectStore.getState().updateMediaWaveform(mid, p),
      setClipTransitionIn: (id, kind, dur) =>
        useProjectStore.getState().setClipTransitionIn(id, kind, dur),
      setClipFilter: (id, preset, intensity) =>
        useProjectStore.getState().setClipFilter(id, preset, intensity),
      newId
    }
    ;(window as unknown as {
      __reelsTimelineUi: typeof useTimelineUi
    }).__reelsTimelineUi = useTimelineUi

    // Phase 3 — expose the api client + auth helpers so tests can call
    // them without dynamic imports (which break on the bundled production
    // build). All surfaces are read-only / call-through.
    ;(window as unknown as {
      __reelsApi: {
        listMyReels: typeof listMyReels
        getReelAnalysis: typeof getReelAnalysis
        getReelMetadata: typeof getReelMetadata
        getReelVideoUrl: typeof getReelVideoUrl
        authedFetch: typeof authedFetch
      }
    }).__reelsApi = {
      listMyReels,
      getReelAnalysis,
      getReelMetadata,
      getReelVideoUrl,
      authedFetch
    }
    ;(window as unknown as {
      __reelsAuthHelpers: {
        idToEmail: typeof idToEmail
        emailToUserIdLabel: typeof emailToUserIdLabel
      }
    }).__reelsAuthHelpers = { idToEmail, emailToUserIdLabel }
  }
}
