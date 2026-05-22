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
import { prefillFromReel } from './prefillFromReel'
import { newId, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import { useTrackingStore } from '../store/tracking'
import { emailToUserIdLabel, idToEmail } from '../store/auth'
import { getPreviewAudioGraph } from './audioGraph'
import {
  analyzeImageData,
  averageFrameStats,
  statsToColorAdjust,
  neutralFrameStats,
  TARGET_LUMA,
  TARGET_SPREAD,
  TARGET_SAT,
  RB_DEADBAND,
  MIN_AUTO_MAGNITUDE
} from '../../../shared/autoColor'
import { AUTO_COLOR_MAX_MAGNITUDE } from '../../../shared/project'

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
        setClipTransform: Store['setClipTransform']
        resetClipTransform: Store['resetClipTransform']
        addTransformKeyframe: Store['addTransformKeyframe']
        updateTransformKeyframe: Store['updateTransformKeyframe']
        removeTransformKeyframe: Store['removeTransformKeyframe']
        clearTransformKeyframes: Store['clearTransformKeyframes']
        addSpeedKeyframe: Store['addSpeedKeyframe']
        updateSpeedKeyframe: Store['updateSpeedKeyframe']
        removeSpeedKeyframe: Store['removeSpeedKeyframe']
        clearSpeedKeyframes: Store['clearSpeedKeyframes']
        setCurvePoint: Store['setCurvePoint']
        addCurvePoint: Store['addCurvePoint']
        removeCurvePoint: Store['removeCurvePoint']
        resetCurves: Store['resetCurves']
        setClipHslBand: Store['setClipHslBand']
        resetClipHsl: Store['resetClipHsl']
        // Phase 3.15 — auto color correction.
        applyAutoColorAdjust: Store['applyAutoColorAdjust']
        addVideoTrack: Store['addVideoTrack']
        removeVideoTrack: Store['removeVideoTrack']
        renameTrack: Store['renameTrack']
        addTrack: Store['addTrack']
        addTracks: Store['addTracks']
        addAudioSubmixTrack: Store['addAudioSubmixTrack']
        removeTrack: Store['removeTrack']
        removeTracks: Store['removeTracks']
        addCaption: Store['addCaption']
        addCaptions: Store['addCaptions']
        // Phase 3.13 — motion-track project-store actions.
        setMotionTrack: Store['setMotionTrack']
        removeMotionTrack: Store['removeMotionTrack']
        bindBlurRegionToTrack: Store['bindBlurRegionToTrack']
        bindOverlayToTrack: Store['bindOverlayToTrack']
        bindCaptionToTrack: Store['bindCaptionToTrack']
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
      setClipTransform: (id, partial) =>
        useProjectStore.getState().setClipTransform(id, partial),
      resetClipTransform: (id) =>
        useProjectStore.getState().resetClipTransform(id),
      addTransformKeyframe: (id, atMs, transform) =>
        useProjectStore.getState().addTransformKeyframe(id, atMs, transform),
      updateTransformKeyframe: (id, kfIndex, partial) =>
        useProjectStore
          .getState()
          .updateTransformKeyframe(id, kfIndex, partial),
      removeTransformKeyframe: (id, kfIndex) =>
        useProjectStore.getState().removeTransformKeyframe(id, kfIndex),
      clearTransformKeyframes: (id) =>
        useProjectStore.getState().clearTransformKeyframes(id),
      addSpeedKeyframe: (id, atMs, speed) =>
        useProjectStore.getState().addSpeedKeyframe(id, atMs, speed),
      updateSpeedKeyframe: (id, kfIndex, partial) =>
        useProjectStore.getState().updateSpeedKeyframe(id, kfIndex, partial),
      removeSpeedKeyframe: (id, kfIndex) =>
        useProjectStore.getState().removeSpeedKeyframe(id, kfIndex),
      clearSpeedKeyframes: (id) =>
        useProjectStore.getState().clearSpeedKeyframes(id),
      setCurvePoint: (id, channel, pointIndex, p) =>
        useProjectStore.getState().setCurvePoint(id, channel, pointIndex, p),
      addCurvePoint: (id, channel, p) =>
        useProjectStore.getState().addCurvePoint(id, channel, p),
      removeCurvePoint: (id, channel, pointIndex) =>
        useProjectStore.getState().removeCurvePoint(id, channel, pointIndex),
      resetCurves: (id) => useProjectStore.getState().resetCurves(id),
      setClipHslBand: (id, band, partial) =>
        useProjectStore.getState().setClipHslBand(id, band, partial),
      resetClipHsl: (id) => useProjectStore.getState().resetClipHsl(id),
      applyAutoColorAdjust: (id, adjust) =>
        useProjectStore.getState().applyAutoColorAdjust(id, adjust),
      addVideoTrack: () => useProjectStore.getState().addVideoTrack(),
      removeVideoTrack: (tid) =>
        useProjectStore.getState().removeVideoTrack(tid),
      renameTrack: (tid, name) =>
        useProjectStore.getState().renameTrack(tid, name),
      addTrack: (kind, role) =>
        useProjectStore.getState().addTrack(kind, role),
      addTracks: (kind, count, role) =>
        useProjectStore.getState().addTracks(kind, count, role),
      addAudioSubmixTrack: () =>
        useProjectStore.getState().addAudioSubmixTrack(),
      removeTrack: (tid) => useProjectStore.getState().removeTrack(tid),
      removeTracks: (tids) => useProjectStore.getState().removeTracks(tids),
      addCaption: (cap) => useProjectStore.getState().addCaption(cap),
      addCaptions: (caps) => useProjectStore.getState().addCaptions(caps),
      setMotionTrack: (clipId, track) =>
        useProjectStore.getState().setMotionTrack(clipId, track),
      removeMotionTrack: (clipId, trackId) =>
        useProjectStore.getState().removeMotionTrack(clipId, trackId),
      bindBlurRegionToTrack: (clipId, regionId, trackId) =>
        useProjectStore
          .getState()
          .bindBlurRegionToTrack(clipId, regionId, trackId),
      bindOverlayToTrack: (overlayId, trackId) =>
        useProjectStore.getState().bindOverlayToTrack(overlayId, trackId),
      bindCaptionToTrack: (captionId, trackId) =>
        useProjectStore.getState().bindCaptionToTrack(captionId, trackId),
      newId
    }
    ;(window as unknown as {
      __reelsTimelineUi: typeof useTimelineUi
    }).__reelsTimelineUi = useTimelineUi

    // Phase 3.13 — expose the transient motion-tracking store so e2e can
    // drive beginTrackJob / cancelTrackJob / setDrawMode and read the live
    // job status + percent. Not part of the persisted project / undo history.
    ;(window as unknown as {
      __reelsTracking: typeof useTrackingStore
    }).__reelsTracking = useTrackingStore

    // Phase 3.13 — deterministic NCC tracker test hook.
    // Drives the real trackerWorker via its message protocol using synthetic
    // ImageData frames (no video decode, no rVFC). Called by tracker-worker.spec.ts
    // via page.evaluate so the Worker constructor can resolve the bundled URL.
    ;(window as unknown as {
      __runSyntheticTrackerTest: () => Promise<{
        points: Array<{ atMs: number; x: number; y: number; scale?: number }>
        status: string
        error?: string
      }>
    }).__runSyntheticTrackerTest = (): Promise<{
      points: Array<{ atMs: number; x: number; y: number; scale?: number }>
      status: string
      error?: string
    }> => {
      return new Promise((resolve) => {
        // --- Synthetic frame generator ---
        // Canvas: 320 × 568.  White 40×40 square moves linearly from
        // top-left (40,40) to (240,440) over 30 frames.
        const CANVAS_W = 320
        const CANVAS_H = 568
        const FRAMES = 30
        const SQ = 40 // square size px
        // Starting position of the square's top-left corner.
        const X0 = 40
        const Y0 = 40
        // Total displacement across all frames.
        const DX = 200 // 240 - 40
        const DY = 400 // 440 - 40

        function makeFrame(frameIdx: number): ImageData {
          const canvas = document.createElement('canvas')
          canvas.width = CANVAS_W
          canvas.height = CANVAS_H
          const ctx = canvas.getContext('2d')!
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
          const t = frameIdx / (FRAMES - 1)
          const sqX = Math.round(X0 + t * DX)
          const sqY = Math.round(Y0 + t * DY)
          ctx.fillStyle = '#fff'
          ctx.fillRect(sqX, sqY, SQ, SQ)
          return ctx.getImageData(0, 0, CANVAS_W, CANVAS_H)
        }

        // The seed box is 1.6× the square size, centred on the square.
        // This ensures the 24×24 PATCH_GRID samples cover both the white
        // square interior AND a ring of black background pixels so the patch
        // has non-zero variance and the NCC returns a meaningful score.
        // (A patch that is uniformly white has norm=0 → NCC always returns 0.)
        const SEED_SCALE = 1.6
        const seedW = SQ * SEED_SCALE
        const seedH = SQ * SEED_SCALE
        // Centre of the square at frame 0.
        const sqCx0 = X0 + SQ / 2
        const sqCy0 = Y0 + SQ / 2
        const seedRect = {
          x: (sqCx0 - seedW / 2) / CANVAS_W,
          y: (sqCy0 - seedH / 2) / CANVAS_H,
          w: seedW / CANVAS_W,
          h: seedH / CANVAS_H
        }

        let w: Worker
        try {
          w = new Worker(
            new URL('../lib/tracking/trackerWorker.ts', import.meta.url),
            { type: 'module' }
          )
        } catch (err) {
          resolve({
            points: [],
            status: 'error',
            error: `Worker construction failed: ${err instanceof Error ? err.message : String(err)}`
          })
          return
        }

        const collectedPoints: Array<{ atMs: number; x: number; y: number; scale?: number }> = []
        let finalStatus = 'pending'
        let errorMsg: string | undefined

        w.onmessage = (ev: MessageEvent): void => {
          const msg = ev.data as { type: string; point?: { atMs: number; x: number; y: number; scale?: number }; status?: string; message?: string }
          if (msg.type === 'point' && msg.point) {
            collectedPoints.push(msg.point)
          } else if (msg.type === 'done') {
            finalStatus = msg.status ?? 'done'
            w.terminate()
            resolve({ points: collectedPoints, status: finalStatus, error: errorMsg })
          } else if (msg.type === 'error') {
            errorMsg = msg.message
            finalStatus = 'error'
            w.terminate()
            resolve({ points: collectedPoints, status: finalStatus, error: errorMsg })
          }
          // 'progress' messages are ignored (not relevant to correctness check)
        }
        w.onerror = (ev): void => {
          finalStatus = 'error'
          errorMsg = ev.message ?? 'Worker error'
          resolve({ points: collectedPoints, status: finalStatus, error: errorMsg })
        }

        // Stream frames to the worker.
        try {
          const frame0 = makeFrame(0)
          w.postMessage({ type: 'init', rect: seedRect, frame: frame0, expectedFrames: FRAMES }, [frame0.data.buffer])
          for (let i = 1; i < FRAMES; i++) {
            const frame = makeFrame(i)
            const atMs = Math.round((i / (FRAMES - 1)) * 2000)
            w.postMessage({ type: 'frame', atMs, frame }, [frame.data.buffer])
          }
          w.postMessage({ type: 'finish' })
        } catch (err) {
          finalStatus = 'error'
          errorMsg = `Frame streaming failed: ${err instanceof Error ? err.message : String(err)}`
          w.terminate()
          resolve({ points: collectedPoints, status: finalStatus, error: errorMsg })
        }
      })
    }

    // Phase 3.13 — cancel mid-stream test hook.
    // Sends init + 10 frames + cancel to the real worker, then waits up to 2s.
    // Verifies the worker does not crash and the promise resolves.
    ;(window as unknown as {
      __runTrackerCancelTest: () => Promise<{ resolvedIn: number; status: string; error?: string }>
    }).__runTrackerCancelTest = (): Promise<{ resolvedIn: number; status: string; error?: string }> => {
      const CANVAS_W = 320
      const CANVAS_H = 568
      const SQ = 40

      function makeFrameB(idx: number): ImageData {
        const c = document.createElement('canvas')
        c.width = CANVAS_W; c.height = CANVAS_H
        const ctx = c.getContext('2d')!
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
        const t = idx / 29
        ctx.fillStyle = '#fff'
        ctx.fillRect(Math.round(40 + t * 200), Math.round(40 + t * 400), SQ, SQ)
        return ctx.getImageData(0, 0, CANVAS_W, CANVAS_H)
      }

      const start = Date.now()
      return new Promise<{ resolvedIn: number; status: string; error?: string }>((resolve) => {
        let w: Worker
        try {
          w = new Worker(
            new URL('../lib/tracking/trackerWorker.ts', import.meta.url),
            { type: 'module' }
          )
        } catch (err) {
          resolve({ resolvedIn: 0, status: 'worker-construction-failed', error: String(err) })
          return
        }
        let done = false
        w.onmessage = (ev: MessageEvent): void => {
          const msg = ev.data as { type: string; status?: string; message?: string }
          if (msg.type === 'done' || msg.type === 'error') {
            done = true
            w.terminate()
            resolve({ resolvedIn: Date.now() - start, status: msg.status ?? msg.type, error: msg.message })
          }
        }
        w.onerror = (ev): void => {
          w.terminate()
          resolve({ resolvedIn: Date.now() - start, status: 'worker-onerror', error: ev.message })
        }
        const f0 = makeFrameB(0)
        w.postMessage({ type: 'init', rect: { x: (60-32)/320, y: (60-32)/568, w: 64/320, h: 64/568 }, frame: f0 }, [f0.data.buffer])
        for (let i = 1; i <= 10; i++) {
          const fr = makeFrameB(i)
          w.postMessage({ type: 'frame', atMs: i * 66, frame: fr }, [fr.data.buffer])
        }
        // Cancel before finish.
        w.postMessage({ type: 'cancel' })
        // Wait 2 s; if no done/error event arrives (cancel suppressed it) → correct.
        setTimeout(() => {
          if (!done) {
            w.terminate()
            resolve({ resolvedIn: Date.now() - start, status: 'cancelled-no-done-event' })
          }
        }, 2_000)
      })
    }

    // Phase 3.13 — finish-immediately test hook.
    // Sends init then finish with no frame messages in between.
    ;(window as unknown as {
      __runTrackerFinishImmediateTest: () => Promise<{ status: string; points: number; error?: string }>
    }).__runTrackerFinishImmediateTest = (): Promise<{ status: string; points: number; error?: string }> => {
      const CANVAS_W = 320
      const CANVAS_H = 568
      const c = document.createElement('canvas')
      c.width = CANVAS_W; c.height = CANVAS_H
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
      ctx.fillStyle = '#fff'; ctx.fillRect(40, 40, 40, 40)
      const f0 = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H)

      return new Promise<{ status: string; points: number; error?: string }>((resolve) => {
        let w: Worker
        try {
          w = new Worker(
            new URL('../lib/tracking/trackerWorker.ts', import.meta.url),
            { type: 'module' }
          )
        } catch (err) {
          resolve({ status: 'worker-construction-failed', points: 0, error: String(err) })
          return
        }
        let pts = 0
        w.onmessage = (ev: MessageEvent): void => {
          const msg = ev.data as { type: string; status?: string; message?: string }
          if (msg.type === 'point') { pts++ }
          else if (msg.type === 'done' || msg.type === 'error') {
            w.terminate()
            resolve({ status: msg.status ?? msg.type, points: pts, error: msg.message })
          }
        }
        w.onerror = (ev): void => {
          w.terminate()
          resolve({ status: 'worker-onerror', points: pts, error: ev.message })
        }
        w.postMessage({ type: 'init', rect: { x: (60-32)/320, y: (60-32)/568, w: 64/320, h: 64/568 }, frame: f0 }, [f0.data.buffer])
        // Finish immediately — no frame messages.
        w.postMessage({ type: 'finish' })
      })
    }

    // Phase 4.3 — expose the temporal (undo/redo) sub-store so e2e tests can
    // call undo/redo/clear and inspect pastStates/futureStates counts.
    ;(window as unknown as {
      __reelsUndoRedo: typeof useProjectStore.temporal
    }).__reelsUndoRedo = useProjectStore.temporal

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
        prefillFromReel: typeof prefillFromReel
      }
    }).__reelsApi = {
      listMyReels,
      getReelAnalysis,
      getReelMetadata,
      getReelVideoUrl,
      authedFetch,
      prefillFromReel
    }
    ;(window as unknown as {
      __reelsAuthHelpers: {
        idToEmail: typeof idToEmail
        emailToUserIdLabel: typeof emailToUserIdLabel
      }
    }).__reelsAuthHelpers = { idToEmail, emailToUserIdLabel }

    // Phase 4-WebAudio — expose the preview audio graph for tests to read
    // current track gains, source counts, and AudioContext state without
    // having to introspect the live AudioParam nodes through DevTools.
    ;(window as unknown as {
      __previewAudioGraph: {
        getState: () => AudioContextState | 'unavailable'
        isReady: () => boolean
        sourceCount: () => number
        /** Target gains (most recent setTrackGain values). */
        trackGains: () => Record<string, number>
        /** Live AudioParam.value snapshot (for ramp-progress probing). */
        liveTrackGains: () => Record<string, number>
        resume: () => Promise<void>
      }
    }).__previewAudioGraph = {
      getState: () => getPreviewAudioGraph().getState(),
      isReady: () => getPreviewAudioGraph().isReady(),
      sourceCount: () => getPreviewAudioGraph().readSourceCount(),
      trackGains: () => getPreviewAudioGraph().readTrackGains(),
      liveTrackGains: () => getPreviewAudioGraph().readLiveTrackGains(),
      resume: () => getPreviewAudioGraph().resume()
    }

    // Phase 3.15 — expose pure autoColor functions + tuning constants so
    // Layer A e2e tests can call them deterministically with synthetic pixels
    // (no video decode, no rVFC) via page.evaluate.
    ;(window as unknown as {
      __reelsAutoColor: {
        analyzeImageData: typeof analyzeImageData
        averageFrameStats: typeof averageFrameStats
        statsToColorAdjust: typeof statsToColorAdjust
        neutralFrameStats: typeof neutralFrameStats
        TARGET_LUMA: number
        TARGET_SPREAD: number
        TARGET_SAT: number
        RB_DEADBAND: number
        MIN_AUTO_MAGNITUDE: number
        AUTO_COLOR_MAX_MAGNITUDE: number
      }
    }).__reelsAutoColor = {
      analyzeImageData,
      averageFrameStats,
      statsToColorAdjust,
      neutralFrameStats,
      TARGET_LUMA,
      TARGET_SPREAD,
      TARGET_SAT,
      RB_DEADBAND,
      MIN_AUTO_MAGNITUDE,
      AUTO_COLOR_MAX_MAGNITUDE
    }
  }
}
