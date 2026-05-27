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
  analyzeRgbParade,
  analyzeVectorscope,
  analyzeWaveform
} from './colorScopes'
import { detectOnsets } from './onsetDetection'
import { markersToChapters } from './markerExport'
import { silenceToBgmKeyframes } from './autoBgmFade'
import {
  analyzeImageData,
  averageFrameStats,
  averageFrameStatsTrimmed,
  statsToColorAdjust,
  statsToColorMatch,
  neutralFrameStats,
  TARGET_LUMA,
  TARGET_SPREAD,
  TARGET_SAT,
  RB_DEADBAND,
  MIN_AUTO_MAGNITUDE,
  MIN_MATCH_MAGNITUDE
} from '../../../shared/autoColor'
import { AUTO_COLOR_MAX_MAGNITUDE } from '../../../shared/project'
import { ZOOM_PRESETS, buildZoomKeyframes } from '../../../shared/zoomPresets'
import { computeReframeTransform } from './autoReframe'
import {
  captionsToSrt,
  captionsToVtt,
  captionsToSubtitle,
  formatTimestamp
} from '../../../shared/subtitleExport'

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
        detachAudio: Store['detachAudio']
        setClipSpeed: Store['setClipSpeed']
        setClipReversed: Store['setClipReversed']
        createNew: Store['createNew']
        setClipGainDb: Store['setClipGainDb']
        setClipFade: Store['setClipFade']
        setClipMuted: Store['setClipMuted']
        // Phase 3.41 — per-clip lock.
        setClipLocked: Store['setClipLocked']
        setTrackMuted: Store['setTrackMuted']
        setTrackSolo: Store['setTrackSolo']
        setTrackDucking: Store['setTrackDucking']
        // Phase 3.57 — advanced trim modes.
        rippleTrim: Store['rippleTrim']
        rollingTrim: Store['rollingTrim']
        slipClip: Store['slipClip']
        slideClip: Store['slideClip']
        // Phase 3.60 — scene-cut split.
        splitClipAtMany: Store['splitClipAtMany']
        // Phase 3.61 — compound clip / group batch apply.
        applyToGroup: Store['applyToGroup']
        // Phase 3.74 — clip color label.
        setClipColor: Store['setClipColor']
        // Phase 3.75 — per-clip LUT (.cube) path.
        setClipLutPath: Store['setClipLutPath']
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
        // Phase 3.31 — auto-zoom / punch-in preset action.
        applyZoomPreset: Store['applyZoomPreset']
        // Phase 3.52 — auto-reframe bulk-replace action.
        applyAutoReframeKeyframes: Store['applyAutoReframeKeyframes']
        addSpeedKeyframe: Store['addSpeedKeyframe']
        updateSpeedKeyframe: Store['updateSpeedKeyframe']
        removeSpeedKeyframe: Store['removeSpeedKeyframe']
        clearSpeedKeyframes: Store['clearSpeedKeyframes']
        // Phase 3.30 — volume-envelope project-store actions.
        addVolumeKeyframe: Store['addVolumeKeyframe']
        updateVolumeKeyframe: Store['updateVolumeKeyframe']
        removeVolumeKeyframe: Store['removeVolumeKeyframe']
        clearVolumeKeyframes: Store['clearVolumeKeyframes']
        // Phase 3.16 — freeze-frame project-store actions.
        addFreezeFrame: Store['addFreezeFrame']
        updateFreezeFrame: Store['updateFreezeFrame']
        removeFreezeFrame: Store['removeFreezeFrame']
        clearFreezeFrames: Store['clearFreezeFrames']
        // Phase 3.17 — text-based editing project-store actions.
        setClipTranscript: Store['setClipTranscript']
        deleteTranscriptWords: Store['deleteTranscriptWords']
        restoreTranscriptWords: Store['restoreTranscriptWords']
        removeFillerWords: Store['removeFillerWords']
        clearTranscriptDeletions: Store['clearTranscriptDeletions']
        setCurvePoint: Store['setCurvePoint']
        addCurvePoint: Store['addCurvePoint']
        removeCurvePoint: Store['removeCurvePoint']
        resetCurves: Store['resetCurves']
        setClipHslBand: Store['setClipHslBand']
        resetClipHsl: Store['resetClipHsl']
        // Phase 3.37 — film look (vignette / grain / faded tone).
        setClipFilmLook: Store['setClipFilmLook']
        // Phase 3.39 — voice enhancement (loudnorm / compress / de-ess / EQ).
        setClipVoiceEnhance: Store['setClipVoiceEnhance']
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
        updateCaption: Store['updateCaption']
        selectClip: Store['selectClip']
        setClipChromaKey: Store['setClipChromaKey']
        addCountdownCaptions: Store['addCountdownCaptions']
        // Phase 3.13 — motion-track project-store actions.
        setMotionTrack: Store['setMotionTrack']
        removeMotionTrack: Store['removeMotionTrack']
        bindBlurRegionToTrack: Store['bindBlurRegionToTrack']
        bindOverlayToTrack: Store['bindOverlayToTrack']
        bindCaptionToTrack: Store['bindCaptionToTrack']
        // Phase 3.18 — collage / split-screen layout.
        applyLayout: Store['applyLayout']
        clearLayout: Store['clearLayout']
        // Phase 3.26 — aspect-ratio conversion.
        setAspectRatio: Store['setAspectRatio']
        // Phase 3.27 — cover / thumbnail frame picker.
        setCoverMs: Store['setCoverMs']
        clearCoverMs: Store['clearCoverMs']
        // Phase 3.35 — progress bar overlay.
        setProgressBar: Store['setProgressBar']
        toggleProgressBar: Store['toggleProgressBar']
        // Phase 3.44 — canvas backdrop fill.
        setCanvasBackground: Store['setCanvasBackground']
        // Phase 3.43 — preview-only horizontal guidelines.
        setPreviewGuides: Store['setPreviewGuides']
        addPreviewGuide: Store['addPreviewGuide']
        removePreviewGuide: Store['removePreviewGuide']
        updatePreviewGuide: Store['updatePreviewGuide']
        // Phase 3.32 — adjustment-layer project-store actions.
        addAdjustmentLayer: Store['addAdjustmentLayer']
        removeAdjustmentLayer: Store['removeAdjustmentLayer']
        updateAdjustmentLayer: Store['updateAdjustmentLayer']
        setAdjustmentLayerColorAdjust: Store['setAdjustmentLayerColorAdjust']
        setAdjustmentLayerCurvePoint: Store['setAdjustmentLayerCurvePoint']
        setAdjustmentLayerHslBand: Store['setAdjustmentLayerHslBand']
        setAdjustmentLayerFilterPreset: Store['setAdjustmentLayerFilterPreset']
        // pptx11 슬라이드 24 — 우클릭 메뉴 액션들.
        setAdjustmentLayerLocked: Store['setAdjustmentLayerLocked']
        duplicateAdjustmentLayer: Store['duplicateAdjustmentLayer']
        splitAdjustmentLayerAt: Store['splitAdjustmentLayerAt']
        // Phase 3.32 — adjustment-layer selection (timeline-UI store).
        setSelectedAdjustmentLayerId: (layerId: string | null) => void
        // Phase 3.33 — clip grouping / linking.
        groupClips: Store['groupClips']
        ungroupClips: Store['ungroupClips']
        moveClipGroup: Store['moveClipGroup']
        // Phase 3.40 — cross-track clip drag.
        moveClipToTrack: Store['moveClipToTrack']
        // Phase 3.33 — selectClip (routes through timelineUi so group-expand fires).
        selectClip: (clipId: string | null) => void
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
      detachAudio: (id) => useProjectStore.getState().detachAudio(id),
      setClipSpeed: (id, speed) =>
        useProjectStore.getState().setClipSpeed(id, speed),
      setClipReversed: (id, reversed) =>
        useProjectStore.getState().setClipReversed(id, reversed),
      createNew: () => useProjectStore.getState().createNew(),
      setClipGainDb: (id, db) =>
        useProjectStore.getState().setClipGainDb(id, db),
      setClipFade: (id, fin, fout) =>
        useProjectStore.getState().setClipFade(id, fin, fout),
      setClipMuted: (id, muted) =>
        useProjectStore.getState().setClipMuted(id, muted),
      // Phase 3.41 — per-clip lock.
      setClipLocked: (id, locked) =>
        useProjectStore.getState().setClipLocked(id, locked),
      setTrackMuted: (tid, muted) =>
        useProjectStore.getState().setTrackMuted(tid, muted),
      setTrackSolo: (tid, solo) =>
        useProjectStore.getState().setTrackSolo(tid, solo),
      setTrackDucking: (tid, target, db) =>
        useProjectStore.getState().setTrackDucking(tid, target, db),
      rippleTrim: (id, side, delta) =>
        useProjectStore.getState().rippleTrim(id, side, delta),
      rollingTrim: (id, side, delta) =>
        useProjectStore.getState().rollingTrim(id, side, delta),
      slipClip: (id, delta) =>
        useProjectStore.getState().slipClip(id, delta),
      slideClip: (id, delta) =>
        useProjectStore.getState().slideClip(id, delta),
      splitClipAtMany: (id, atMsList) =>
        useProjectStore.getState().splitClipAtMany(id, atMsList),
      applyToGroup: (groupId, patch) =>
        useProjectStore.getState().applyToGroup(groupId, patch),
      setClipColor: (id, color) =>
        useProjectStore.getState().setClipColor(id, color),
      setClipLutPath: (id, path) =>
        useProjectStore.getState().setClipLutPath(id, path),
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
      applyZoomPreset: (id, presetId) =>
        useProjectStore.getState().applyZoomPreset(id, presetId),
      applyAutoReframeKeyframes: (id, kfs) =>
        useProjectStore.getState().applyAutoReframeKeyframes(id, kfs),
      addSpeedKeyframe: (id, atMs, speed) =>
        useProjectStore.getState().addSpeedKeyframe(id, atMs, speed),
      updateSpeedKeyframe: (id, kfIndex, partial) =>
        useProjectStore.getState().updateSpeedKeyframe(id, kfIndex, partial),
      removeSpeedKeyframe: (id, kfIndex) =>
        useProjectStore.getState().removeSpeedKeyframe(id, kfIndex),
      clearSpeedKeyframes: (id) =>
        useProjectStore.getState().clearSpeedKeyframes(id),
      addVolumeKeyframe: (id, atMs, gainDb) =>
        useProjectStore.getState().addVolumeKeyframe(id, atMs, gainDb),
      updateVolumeKeyframe: (id, kfIndex, partial) =>
        useProjectStore.getState().updateVolumeKeyframe(id, kfIndex, partial),
      removeVolumeKeyframe: (id, kfIndex) =>
        useProjectStore.getState().removeVolumeKeyframe(id, kfIndex),
      clearVolumeKeyframes: (id) =>
        useProjectStore.getState().clearVolumeKeyframes(id),
      addFreezeFrame: (id, sourceMs, durationMs) =>
        useProjectStore.getState().addFreezeFrame(id, sourceMs, durationMs),
      updateFreezeFrame: (id, freezeIndex, partial) =>
        useProjectStore.getState().updateFreezeFrame(id, freezeIndex, partial),
      removeFreezeFrame: (id, freezeIndex) =>
        useProjectStore.getState().removeFreezeFrame(id, freezeIndex),
      clearFreezeFrames: (id) =>
        useProjectStore.getState().clearFreezeFrames(id),
      setClipTranscript: (id, transcript) =>
        useProjectStore.getState().setClipTranscript(id, transcript),
      deleteTranscriptWords: (id, wordIds) =>
        useProjectStore.getState().deleteTranscriptWords(id, wordIds),
      restoreTranscriptWords: (id, wordIds) =>
        useProjectStore.getState().restoreTranscriptWords(id, wordIds),
      removeFillerWords: (id) =>
        useProjectStore.getState().removeFillerWords(id),
      clearTranscriptDeletions: (id) =>
        useProjectStore.getState().clearTranscriptDeletions(id),
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
      setClipFilmLook: (id, patch) =>
        useProjectStore.getState().setClipFilmLook(id, patch),
      setClipVoiceEnhance: (id, patch) =>
        useProjectStore.getState().setClipVoiceEnhance(id, patch),
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
      updateCaption: (id, partial) =>
        useProjectStore.getState().updateCaption(id, partial),
      selectClip: (id) => useProjectStore.getState().selectClip(id),
      setClipChromaKey: (id, ck) =>
        useProjectStore.getState().setClipChromaKey(id, ck),
      addCountdownCaptions: (opts) =>
        useProjectStore.getState().addCountdownCaptions(opts),
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
      applyLayout: (presetId, clipIds, opts) =>
        useProjectStore.getState().applyLayout(presetId, clipIds, opts),
      clearLayout: (layoutGroupId) =>
        useProjectStore.getState().clearLayout(layoutGroupId),
      setAspectRatio: (ratio) =>
        useProjectStore.getState().setAspectRatio(ratio),
      setCoverMs: (ms) => useProjectStore.getState().setCoverMs(ms),
      clearCoverMs: () => useProjectStore.getState().clearCoverMs(),
      setProgressBar: (patch) =>
        useProjectStore.getState().setProgressBar(patch),
      toggleProgressBar: () =>
        useProjectStore.getState().toggleProgressBar(),
      setCanvasBackground: (bg) =>
        useProjectStore.getState().setCanvasBackground(bg),
      setPreviewGuides: (yFractions) =>
        useProjectStore.getState().setPreviewGuides(yFractions),
      addPreviewGuide: (yFrac) =>
        useProjectStore.getState().addPreviewGuide(yFrac),
      removePreviewGuide: (index) =>
        useProjectStore.getState().removePreviewGuide(index),
      updatePreviewGuide: (index, yFrac) =>
        useProjectStore.getState().updatePreviewGuide(index, yFrac),
      addAdjustmentLayer: (startMs, endMs) =>
        useProjectStore.getState().addAdjustmentLayer(startMs, endMs),
      removeAdjustmentLayer: (id) =>
        useProjectStore.getState().removeAdjustmentLayer(id),
      updateAdjustmentLayer: (id, patch) =>
        useProjectStore.getState().updateAdjustmentLayer(id, patch),
      setAdjustmentLayerColorAdjust: (id, partial) =>
        useProjectStore.getState().setAdjustmentLayerColorAdjust(id, partial),
      setAdjustmentLayerCurvePoint: (id, channel, pointIndex, p) =>
        useProjectStore
          .getState()
          .setAdjustmentLayerCurvePoint(id, channel, pointIndex, p),
      setAdjustmentLayerHslBand: (id, band, partial) =>
        useProjectStore.getState().setAdjustmentLayerHslBand(id, band, partial),
      setAdjustmentLayerFilterPreset: (id, preset, intensity) =>
        useProjectStore
          .getState()
          .setAdjustmentLayerFilterPreset(id, preset, intensity),
      // pptx11 슬라이드 24.
      setAdjustmentLayerLocked: (id, locked) =>
        useProjectStore.getState().setAdjustmentLayerLocked(id, locked),
      duplicateAdjustmentLayer: (id) =>
        useProjectStore.getState().duplicateAdjustmentLayer(id),
      splitAdjustmentLayerAt: (id, atMs) =>
        useProjectStore.getState().splitAdjustmentLayerAt(id, atMs),
      setSelectedAdjustmentLayerId: (layerId) =>
        useTimelineUi.getState().setSelectedAdjustmentLayerId(layerId),
      // Phase 3.33 — clip grouping / linking.
      groupClips: (clipIds) => useProjectStore.getState().groupClips(clipIds),
      ungroupClips: (groupIdOrClipId) =>
        useProjectStore.getState().ungroupClips(groupIdOrClipId),
      moveClipGroup: (clipId, desiredStartMs) =>
        useProjectStore.getState().moveClipGroup(clipId, desiredStartMs),
      // Phase 3.40 — cross-track clip drag.
      moveClipToTrack: (id, newTrackId) =>
        useProjectStore.getState().moveClipToTrack(id, newTrackId),
      // selectClip routes through timelineUi so the group-expand logic fires.
      selectClip: (clipId) => useTimelineUi.getState().selectClip(clipId),
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
        /** Phase 3.58 — instantaneous master meter (dBFS). */
        masterLevels: () => { peak: number; rms: number }
      }
    }).__previewAudioGraph = {
      getState: () => getPreviewAudioGraph().getState(),
      isReady: () => getPreviewAudioGraph().isReady(),
      sourceCount: () => getPreviewAudioGraph().readSourceCount(),
      trackGains: () => getPreviewAudioGraph().readTrackGains(),
      liveTrackGains: () => getPreviewAudioGraph().readLiveTrackGains(),
      resume: () => getPreviewAudioGraph().resume(),
      masterLevels: () => getPreviewAudioGraph().getMasterLevels()
    }

    // Phase 3.15 — expose pure autoColor functions + tuning constants so
    // Layer A e2e tests can call them deterministically with synthetic pixels
    // (no video decode, no rVFC) via page.evaluate.
    ;(window as unknown as {
      __reelsAutoColor: {
        analyzeImageData: typeof analyzeImageData
        averageFrameStats: typeof averageFrameStats
        averageFrameStatsTrimmed: typeof averageFrameStatsTrimmed
        statsToColorAdjust: typeof statsToColorAdjust
        statsToColorMatch: typeof statsToColorMatch
        neutralFrameStats: typeof neutralFrameStats
        TARGET_LUMA: number
        TARGET_SPREAD: number
        TARGET_SAT: number
        RB_DEADBAND: number
        MIN_AUTO_MAGNITUDE: number
        MIN_MATCH_MAGNITUDE: number
        AUTO_COLOR_MAX_MAGNITUDE: number
      }
    }).__reelsAutoColor = {
      analyzeImageData,
      averageFrameStats,
      averageFrameStatsTrimmed,
      statsToColorAdjust,
      statsToColorMatch,
      neutralFrameStats,
      TARGET_LUMA,
      TARGET_SPREAD,
      TARGET_SAT,
      RB_DEADBAND,
      MIN_AUTO_MAGNITUDE,
      MIN_MATCH_MAGNITUDE,
      AUTO_COLOR_MAX_MAGNITUDE
    }

    // Phase 3.59 — expose pure color-scope analyzers for layer-A e2e.
    ;(window as unknown as {
      __reelsColorScopes: {
        analyzeWaveform: typeof analyzeWaveform
        analyzeRgbParade: typeof analyzeRgbParade
        analyzeVectorscope: typeof analyzeVectorscope
      }
    }).__reelsColorScopes = {
      analyzeWaveform,
      analyzeRgbParade,
      analyzeVectorscope
    }

    // Phase 3.71 — expose pure onset detector for layer-A e2e.
    ;(window as unknown as {
      __reelsOnsetDetection: { detectOnsets: typeof detectOnsets }
    }).__reelsOnsetDetection = { detectOnsets }

    // Phase 3.73 — expose pure marker→chapter formatter for layer-A e2e.
    ;(window as unknown as {
      __reelsMarkerExport: { markersToChapters: typeof markersToChapters }
    }).__reelsMarkerExport = { markersToChapters }

    // Phase 3.85 — expose pure silence→BGM-keyframes helper for layer-A e2e.
    ;(window as unknown as {
      __reelsAutoBgmFade: {
        silenceToBgmKeyframes: typeof silenceToBgmKeyframes
      }
    }).__reelsAutoBgmFade = { silenceToBgmKeyframes }

    // Phase 3.31 — expose the pure zoom-preset helpers so e2e can build the
    // expected RELATIVE keyframes deterministically (no DOM) via page.evaluate.
    ;(window as unknown as {
      __reelsZoomPresets: {
        ZOOM_PRESETS: typeof ZOOM_PRESETS
        buildZoomKeyframes: typeof buildZoomKeyframes
      }
    }).__reelsZoomPresets = {
      ZOOM_PRESETS,
      buildZoomKeyframes
    }

    // Phase 3.52 — expose the pure auto-reframe math so layer-A e2e can call
    // it deterministically (no DOM, no model) via page.evaluate.
    ;(window as unknown as {
      __reelsAutoReframeMath: {
        computeReframeTransform: typeof computeReframeTransform
      }
    }).__reelsAutoReframeMath = {
      computeReframeTransform
    }

    // Phase 3.34 — expose the pure subtitle-export builders so e2e can build
    // the expected `.srt` / `.vtt` document deterministically (no DOM, no IPC)
    // via page.evaluate.
    ;(window as unknown as {
      __reelsSubtitleExport: {
        captionsToSrt: typeof captionsToSrt
        captionsToVtt: typeof captionsToVtt
        captionsToSubtitle: typeof captionsToSubtitle
        formatTimestamp: typeof formatTimestamp
      }
    }).__reelsSubtitleExport = {
      captionsToSrt,
      captionsToVtt,
      captionsToSubtitle,
      formatTimestamp
    }
  }
}
