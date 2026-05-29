import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ulid } from 'ulid'
import {
  getClipBlurRegions,
  getClipColorAdjust,
  getClipCropRect,
  getClipDuration,
  getClipMotionTracks,
  getClipSourceText,
  getClipTransform,
  getAdjustmentLayerTransform,
  getClipFreezeFrames,
  getClipTimelineDuration,
  getSpeedAt,
  getVoiceEnhance,
  getVoiceChanger,
  getVolumeDbAt,
  hasFreezeFrames,
  hasSpeedCurve,
  hasVolumeEnvelope,
  hasTransformKeyframes,
  canPlaceClipOnTrack,
  CLIP_COLOR_HEX,
  isCaptionClip,
  isClipLocked,
  isClipReversed,
  canReverseClip,
  isIdentityTransform,
  isMediaClip,
  isOverlayClip,
  REVERSE_SOFT_CAP_MS,
  MAX_AUDIO_TRACKS,
  MAX_VIDEO_TRACKS,
  MIN_CLIP_MS,
  MIN_KEYFRAME_GAP_MS,
  MIN_SPEED_KEYFRAME_GAP_MS,
  MIN_VOLUME_KEYFRAME_GAP_MS,
  MIN_FREEZE_GAP_MS,
  DEFAULT_FREEZE_MS,
  DEFAULT_ADJUSTMENT_LAYER_MS,
  isNeutralAdjustmentLayer,
  sourceOffsetForTimelineOffset,
  speedOnlyTimelineOffset,
  type AdjustmentLayer,
  type Clip,
  type ClipKind,
  type MediaAsset,
  type OverlayClip,
  type Project,
  type Track,
  type VideoAudioClip
} from '../../../shared/project'
import { overlaySourceLabel } from '../lib/overlays'
import { getTotalDurationMs, useProjectStore, useUndoRedo } from '../store/project'
import {
  BEAT_SNAP_TOLERANCE_MS,
  MAX_PPS,
  MIN_PPS,
  snapToNearestBeat,
  useTimelineUi
} from '../store/timelineUi'
import { startVoiceRecording, type VoiceRecorder } from '../lib/voiceRecording'
import { useTrackingStore } from '../store/tracking'
import { AdjustmentLayerContextMenu } from './AdjustmentLayerContextMenu'
import { ClipContextMenu } from './ClipContextMenu'
import { TrackContextMenu } from './TrackContextMenu'
import { MEDIA_DRAG_MIME } from './MediaLibrary'
import {
  PENDING_MEDIA_DRAG_MIME,
  awaitPending
} from '../lib/pendingImport'

interface TimelineProps {
  project: Project
  playheadMs: number
  onSeek: (ms: number) => void
  selectedClipId: string | null
  onSelectClip: (clipId: string | null) => void
  onOpenEffectsClip?: (clipId: string) => void
  onEditCaption: (clipId: string) => void
  onDeleteClip: (clipId: string) => void
  /** Phase 2.5 — invoked when the user picks "무음 자동 제거…" on a media clip. */
  onOpenSilenceDialog?: (clipId: string) => void
}

const HANDLE_PX = 6
const SNAP_PX = 5
const CLICK_VS_DRAG_PX = 5
const IMAGE_DEFAULT_MS = 5000
const ZOOM_FACTOR = 1.2

const styles = {
  wrap: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    background: '#0f0f0f',
    color: '#cbd5e1',
    fontSize: 11,
    overflow: 'hidden',
    userSelect: 'none' as const
  } as React.CSSProperties,
  toolbar: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 10px',
    background: '#111',
    borderBottom: '1px solid #2a2a2a',
    fontSize: 11,
    color: '#9aa0a6'
  } as React.CSSProperties,
  zoomBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  // Phase 5 — square icon button used across the rebuilt toolbar.
  toolBtn: {
    background: '#1f2937',
    color: '#e5e7eb',
    border: '1px solid #374151',
    borderRadius: 4,
    width: 26,
    height: 26,
    padding: 0,
    fontSize: 13,
    lineHeight: 1,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  } as React.CSSProperties,
  toolBtnDisabled: {
    opacity: 0.35,
    cursor: 'not-allowed'
  } as React.CSSProperties,
  // Active (toggled-on) state — teal accent, matching the CapCut reference.
  toolBtnActive: {
    background: '#0e7490',
    color: '#ecfeff',
    border: '1px solid #22d3ee'
  } as React.CSSProperties,
  // Recording state — red accent.
  toolBtnRecording: {
    background: '#b91c1c',
    color: '#fff',
    border: '1px solid #ef4444'
  } as React.CSSProperties,
  toolbarGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 4
  } as React.CSSProperties,
  toolbarSep: {
    width: 1,
    height: 20,
    background: '#2a2a2a',
    margin: '0 4px',
    flexShrink: 0
  } as React.CSSProperties,
  flex1: { flex: 1, minWidth: 8 } as React.CSSProperties,
  zoomSlider: {
    width: 96,
    accentColor: '#22d3ee',
    cursor: 'pointer'
  } as React.CSSProperties,
  recTimer: {
    fontSize: 10,
    color: '#fca5a5',
    fontVariantNumeric: 'tabular-nums' as const,
    minWidth: 34
  } as React.CSSProperties,
  // Phase 5 — ruler marker pin.
  rulerMarker: {
    position: 'absolute' as const,
    top: 0,
    bottom: 0,
    width: 0,
    borderLeft: '2px solid #f59e0b',
    zIndex: 4,
    cursor: 'pointer'
  } as React.CSSProperties,
  rulerMarkerFlag: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    width: 9,
    height: 9,
    background: '#f59e0b',
    clipPath: 'polygon(0 0, 100% 0, 100% 60%, 0 100%)'
  } as React.CSSProperties,
  ruler: {
    height: 24,
    background: '#141414',
    borderBottom: '1px solid #2a2a2a',
    position: 'relative' as const,
    overflow: 'hidden',
    cursor: 'pointer'
  } as React.CSSProperties,
  // Phase 3.27 — cover / thumbnail frame marker. A small star badge, styled
  // distinctly from beat ticks (thin lines) and marker pins (amber flags).
  rulerCoverMarker: {
    position: 'absolute' as const,
    top: 1,
    transform: 'translateX(-50%)',
    width: 16,
    height: 16,
    lineHeight: '16px',
    textAlign: 'center' as const,
    fontSize: 11,
    color: '#0a0a0a',
    background: '#fbbf24',
    borderRadius: '50%',
    boxShadow: '0 0 0 1px #92400e',
    zIndex: 6,
    pointerEvents: 'none' as const
  } as React.CSSProperties,
  rulerTick: {
    position: 'absolute' as const,
    top: 0,
    bottom: 0,
    borderLeft: '1px solid #1f2937',
    paddingLeft: 4,
    color: '#475569',
    fontSize: 10
  } as React.CSSProperties,
  body: {
    flex: 1,
    overflow: 'auto',
    position: 'relative' as const
  } as React.CSSProperties,
  trackRow: {
    display: 'flex',
    alignItems: 'stretch' as const,
    minHeight: 60,
    borderBottom: '1px solid #1a1a1a'
  } as React.CSSProperties,
  trackHeader: {
    flexShrink: 0,
    width: 120,
    padding: '6px 8px',
    background: '#141414',
    borderRight: '1px solid #2a2a2a',
    fontSize: 11,
    color: '#9aa0a6',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    justifyContent: 'center'
  } as React.CSSProperties,
  trackHeaderRow: {
    display: 'flex',
    gap: 4,
    alignItems: 'center'
  } as React.CSSProperties,
  trackHeaderName: {
    fontSize: 11,
    color: '#cbd5e1',
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    flex: 1
  } as React.CSSProperties,
  trackBtn: {
    background: '#1f2937',
    color: '#9aa0a6',
    border: '1px solid #374151',
    borderRadius: 4,
    width: 22,
    height: 22,
    padding: 0,
    fontSize: 11,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  } as React.CSSProperties,
  trackBtnMuteActive: {
    background: '#facc15',
    color: '#1a1a1a',
    border: '1px solid #eab308'
  } as React.CSSProperties,
  trackBtnSoloActive: {
    background: '#3b82f6',
    color: '#fff',
    border: '1px solid #2563eb'
  } as React.CSSProperties,
  beatTick: {
    position: 'absolute' as const,
    top: 12,
    bottom: 0,
    width: 1,
    background: 'rgba(99, 102, 241, 0.55)',
    pointerEvents: 'none' as const
  } as React.CSSProperties,
  trackLane: {
    flex: 1,
    position: 'relative' as const,
    background: '#0a0a0a'
  } as React.CSSProperties,
  trackLaneDropActive: {
    background: 'rgba(16, 185, 129, 0.08)'
  } as React.CSSProperties,
  clip: {
    position: 'absolute' as const,
    top: 6,
    bottom: 6,
    background: '#1f2937',
    border: '1px solid #374151',
    borderRadius: 4,
    color: '#f5f5f5',
    fontSize: 11,
    overflow: 'hidden' as const,
    boxSizing: 'border-box' as const,
    cursor: 'pointer'
  } as React.CSSProperties,
  clipBody: {
    position: 'absolute' as const,
    top: 0,
    bottom: 0,
    padding: '4px 6px',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    cursor: 'grab'
  } as React.CSSProperties,
  clipSelected: {
    outline: '2px solid #60a5fa',
    outlineOffset: -2
  } as React.CSSProperties,
  marquee: {
    position: 'absolute' as const,
    border: '1px solid #60a5fa',
    background: 'rgba(96, 165, 250, 0.16)',
    boxShadow: '0 0 0 1px rgba(15, 23, 42, 0.4) inset',
    pointerEvents: 'none' as const,
    zIndex: 10
  } as React.CSSProperties,
  captionClip: {
    background: 'linear-gradient(180deg, #4338ca, #312e81)',
    borderColor: '#6366f1'
  } as React.CSSProperties,
  // Phase 3.8 — overlay clip block (distinct teal/cyan look).
  overlayClip: {
    background: 'linear-gradient(180deg, #0e7490, #155e75)',
    borderColor: '#22d3ee'
  } as React.CSSProperties,
  trimHandle: {
    position: 'absolute' as const,
    top: 0,
    bottom: 0,
    width: HANDLE_PX,
    background: 'rgba(0,0,0,0.35)',
    cursor: 'col-resize',
    zIndex: 2
  } as React.CSSProperties,
  trimHandleLeft: {
    left: 0,
    borderRight: '1px solid rgba(255,255,255,0.25)'
  } as React.CSSProperties,
  trimHandleRight: {
    right: 0,
    borderLeft: '1px solid rgba(255,255,255,0.25)'
  } as React.CSSProperties,
  playhead: {
    position: 'absolute' as const,
    top: 0,
    bottom: 0,
    width: 2,
    background: '#ef4444',
    pointerEvents: 'none' as const,
    zIndex: 5
  } as React.CSSProperties,
  // Phase 3.32 — adjustment-layer lane (a dedicated row below the ruler).
  // Tinted purple/violet band so it reads as a grade layer, not a clip track.
  adjustmentLaneRow: {
    display: 'flex',
    alignItems: 'stretch' as const,
    height: 34,
    borderBottom: '1px solid #1a1a1a',
    background: 'rgba(126, 34, 206, 0.06)'
  } as React.CSSProperties,
  adjustmentLaneHeader: {
    flexShrink: 0,
    width: 120,
    padding: '4px 8px',
    background: '#141414',
    borderRight: '1px solid #2a2a2a',
    fontSize: 11,
    color: '#c4b5fd',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    justifyContent: 'center'
  } as React.CSSProperties,
  adjustmentLaneTitle: {
    fontSize: 11,
    color: '#c4b5fd',
    fontWeight: 600,
    whiteSpace: 'nowrap' as const
  } as React.CSSProperties,
  adjustmentAddBtn: {
    background: '#5b21b6',
    color: '#ede9fe',
    border: '1px solid #8b5cf6',
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: 10,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const
  } as React.CSSProperties,
  adjustmentLane: {
    flex: 1,
    position: 'relative' as const,
    background:
      'repeating-linear-gradient(45deg, rgba(139,92,246,0.05) 0 6px, transparent 6px 12px)'
  } as React.CSSProperties,
  adjustmentBlock: {
    position: 'absolute' as const,
    top: 5,
    bottom: 5,
    background: 'linear-gradient(180deg, #7c3aed, #5b21b6)',
    border: '1px solid #a78bfa',
    borderRadius: 4,
    color: '#ede9fe',
    fontSize: 10,
    overflow: 'hidden' as const,
    boxSizing: 'border-box' as const,
    cursor: 'grab',
    display: 'flex',
    alignItems: 'center',
    minWidth: 8
  } as React.CSSProperties,
  adjustmentBlockSelected: {
    outline: '2px solid #f0abfc',
    outlineOffset: -2
  } as React.CSSProperties,
  adjustmentBlockNeutral: {
    background: 'linear-gradient(180deg, #4c1d95, #3b0764)',
    borderStyle: 'dashed' as const
  } as React.CSSProperties,
  adjustmentBlockLabel: {
    padding: '0 6px',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    pointerEvents: 'none' as const,
    flex: 1
  } as React.CSSProperties,
  // Phase 3.5 — keyframe marker row pinned to the bottom of a clip block.
  keyframeMarkerRow: {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    bottom: 0,
    height: 12,
    zIndex: 3
  } as React.CSSProperties,
  keyframeMarker: {
    position: 'absolute' as const,
    bottom: 1,
    width: 9,
    height: 9,
    marginLeft: -5,
    background: '#a5b4fc',
    border: '1px solid #1a1a1a',
    transform: 'rotate(45deg)',
    cursor: 'ew-resize',
    zIndex: 3
  } as React.CSSProperties
}

// ---------------------------------------------------------------------------
// Snap: 1) zero; 2) second boundaries; 3) adjacent clip edges (excluding
// the moving clip's own edges); within SNAP_PX tolerance.
// Alt-drag disables snap. The persistent toolbar snap toggle (Phase 5) also
// disables it when off — passed via `options.snapEnabled`.
// ---------------------------------------------------------------------------
function snapMs(
  desiredMs: number,
  pps: number,
  track: Track,
  ignoreClipId: string | null,
  altPressed: boolean,
  options?: {
    beats?: number[]
    beatSnapEnabled?: boolean
    snapEnabled?: boolean
    /**
     * Phase 3.78 — magnet timeline: additional clip boundaries from OTHER
     * tracks. Pre-filtered by the caller (exclude moving clip + the same-
     * track edges that this function already collects below). Empty / undef
     * = same-track snap only (legacy behavior).
     */
    crossTrackEdges?: number[]
  }
): number {
  // Persistent toggle off OR Alt held → no snapping at all.
  if (altPressed || options?.snapEnabled === false) {
    return Math.max(0, desiredMs)
  }
  const snapMsTolerance = (SNAP_PX / pps) * 1000
  let best = desiredMs
  let bestDist = Infinity
  const edges: number[] = [0]
  for (const c of track.clips) {
    if (c.id === ignoreClipId) continue
    edges.push(c.startMs, c.endMs)
  }
  // Phase 3.78 — cross-track magnet.
  if (options?.crossTrackEdges && options.crossTrackEdges.length > 0) {
    for (const e of options.crossTrackEdges) {
      if (Number.isFinite(e)) edges.push(e)
    }
  }
  edges.push(Math.round(desiredMs / 1000) * 1000)
  for (const e of edges) {
    const d = Math.abs(e - desiredMs)
    if (d < bestDist && d <= snapMsTolerance) {
      bestDist = d
      best = e
    }
  }
  // Beat snap takes an additional (looser) tolerance so an enabled "비트 스냅"
  // can pull a clip edge even when no second/edge is nearby.
  if (options?.beatSnapEnabled && options.beats && options.beats.length > 0) {
    const beatSnapped = snapToNearestBeat(
      best,
      options.beats,
      BEAT_SNAP_TOLERANCE_MS
    )
    if (beatSnapped !== best) best = beatSnapped
  }
  return Math.max(0, best)
}

// Phase 3.40 — hit-test which timeline track row the cursor's clientY is
// currently inside. Used by the cross-track clip-drag handler. We walk
// direct children of `body` so nested rows (e.g. clip pickers) don't fool
// the test. Returns null when the cursor is outside every lane row.
function hitTestTrackAtY(body: HTMLDivElement | null, clientY: number) {
  if (!body) return null
  const rows = body.querySelectorAll<HTMLDivElement>('[data-track-id]')
  for (const row of rows) {
    if (row.parentElement !== body) continue
    const r = row.getBoundingClientRect()
    if (clientY >= r.top && clientY <= r.bottom) {
      return { trackId: row.dataset.trackId ?? '', rect: r }
    }
  }
  return null
}

// Walk the lane and find the next free start position >= desired, clamping
// each iteration to the next collision's endMs. Returns desired if no clip
// overlaps. Used by drop handler and (indirectly) the body-drag clamp.
function findFreeStart(
  track: Track,
  desiredStart: number,
  durationMs: number,
  ignoreClipId?: string
): number {
  const sorted = [...track.clips]
    .filter((c) => c.id !== ignoreClipId)
    .sort((a, b) => a.startMs - b.startMs)
  let start = Math.max(0, desiredStart)
  for (let i = 0; i <= sorted.length; i++) {
    let collided = false
    for (const c of sorted) {
      if (start < c.endMs && start + durationMs > c.startMs) {
        start = c.endMs
        collided = true
        break
      }
    }
    if (!collided) return start
  }
  return start
}

// Clamp a desired startMs so [start, start+duration] does not overlap any
// other clip on the same track. Returns the largest valid startMs that's <=
// desiredStart and respects the immediate-left neighbor, OR pushes to the
// next valid slot. We pick "closest valid to desired" (left or right).
function clampNoOverlap(
  track: Track,
  desiredStart: number,
  durationMs: number,
  ignoreClipId: string
): number {
  const sorted = [...track.clips]
    .filter((c) => c.id !== ignoreClipId)
    .sort((a, b) => a.startMs - b.startMs)
  if (sorted.length === 0) return Math.max(0, desiredStart)
  const desiredEnd = desiredStart + durationMs
  // Find a clip we'd overlap.
  const collider = sorted.find((c) => desiredStart < c.endMs && desiredEnd > c.startMs)
  if (!collider) return Math.max(0, desiredStart)
  // Clamp to the collider's left edge or right edge — whichever is closer
  // to the desired start.
  const leftCandidate = collider.startMs - durationMs
  const rightCandidate = collider.endMs
  const leftValid = leftCandidate >= 0 && !sorted.some(
    (c) => c.id !== collider.id && leftCandidate < c.endMs && leftCandidate + durationMs > c.startMs
  )
  const rightValid = !sorted.some(
    (c) => c.id !== collider.id && rightCandidate < c.endMs && rightCandidate + durationMs > c.startMs
  )
  if (leftValid && rightValid) {
    return Math.abs(desiredStart - leftCandidate) <= Math.abs(desiredStart - rightCandidate)
      ? leftCandidate
      : rightCandidate
  }
  if (leftValid) return leftCandidate
  if (rightValid) return rightCandidate
  // Both invalid — fall back to the lane-walk free finder.
  return findFreeStart(track, desiredStart, durationMs, ignoreClipId)
}

function clipLeft(clip: Clip, pps: number): number {
  return (clip.startMs / 1000) * pps
}
function clipWidth(clip: Clip, pps: number): number {
  return Math.max(8, (getClipDuration(clip) / 1000) * pps)
}

export function Timeline(props: TimelineProps): JSX.Element {
  const {
    project,
    playheadMs,
    onSeek,
    selectedClipId,
    onSelectClip,
    onOpenEffectsClip,
    onEditCaption,
    onDeleteClip
  } = props

  const updateMediaClipTrim = useProjectStore((s) => s.updateMediaClipTrim)
  const splitClipAt = useProjectStore((s) => s.splitClipAt)
  const duplicateClip = useProjectStore((s) => s.duplicateClip)
  const detachAudio = useProjectStore((s) => s.detachAudio)
  const setClipSpeed = useProjectStore((s) => s.setClipSpeed)
  const setClipReversed = useProjectStore((s) => s.setClipReversed)
  const setClipTransitionIn = useProjectStore((s) => s.setClipTransitionIn)
  const setClipFilter = useProjectStore((s) => s.setClipFilter)
  const setClipTransform = useProjectStore((s) => s.setClipTransform)
  const resetClipTransform = useProjectStore((s) => s.resetClipTransform)
  const setClipCrop = useProjectStore((s) => s.setClipCrop)
  const resetClipCrop = useProjectStore((s) => s.resetClipCrop)
  const setClipColorAdjust = useProjectStore((s) => s.setClipColorAdjust)
  const resetClipColorAdjust = useProjectStore((s) => s.resetClipColorAdjust)
  const setClipNoiseReduction = useProjectStore((s) => s.setClipNoiseReduction)
  const setClipVoiceEnhance = useProjectStore((s) => s.setClipVoiceEnhance)
  const setClipVoiceChanger = useProjectStore((s) => s.setClipVoiceChanger)
  const addBlurRegion = useProjectStore((s) => s.addBlurRegion)
  const updateBlurRegion = useProjectStore((s) => s.updateBlurRegion)
  const removeBlurRegion = useProjectStore((s) => s.removeBlurRegion)
  const removeMotionTrack = useProjectStore((s) => s.removeMotionTrack)
  const bindBlurRegionToTrack = useProjectStore(
    (s) => s.bindBlurRegionToTrack
  )
  const bindOverlayToTrack = useProjectStore((s) => s.bindOverlayToTrack)
  const bindCaptionToTrack = useProjectStore((s) => s.bindCaptionToTrack)
  // Phase 3.13 — transient motion-tracking job store.
  const trackBeginJob = useTrackingStore((s) => s.beginTrackJob)
  const trackCancelJob = useTrackingStore((s) => s.cancelTrackJob)
  const trackSetDrawMode = useTrackingStore((s) => s.setDrawMode)
  const trackJobClipId = useTrackingStore((s) => s.clipId)
  const trackJobStatus = useTrackingStore((s) => s.status)
  const trackJobPercent = useTrackingStore((s) => s.percent)
  const addTransformKeyframe = useProjectStore((s) => s.addTransformKeyframe)
  const updateTransformKeyframe = useProjectStore(
    (s) => s.updateTransformKeyframe
  )
  const removeTransformKeyframe = useProjectStore(
    (s) => s.removeTransformKeyframe
  )
  const addSpeedKeyframe = useProjectStore((s) => s.addSpeedKeyframe)
  const updateSpeedKeyframe = useProjectStore((s) => s.updateSpeedKeyframe)
  const removeSpeedKeyframe = useProjectStore((s) => s.removeSpeedKeyframe)
  const clearSpeedKeyframes = useProjectStore((s) => s.clearSpeedKeyframes)
  const setClipFade = useProjectStore((s) => s.setClipFade)
  const addVolumeKeyframe = useProjectStore((s) => s.addVolumeKeyframe)
  const updateVolumeKeyframe = useProjectStore((s) => s.updateVolumeKeyframe)
  const removeVolumeKeyframe = useProjectStore((s) => s.removeVolumeKeyframe)
  const clearVolumeKeyframes = useProjectStore((s) => s.clearVolumeKeyframes)
  const addFreezeFrame = useProjectStore((s) => s.addFreezeFrame)
  const updateFreezeFrame = useProjectStore((s) => s.updateFreezeFrame)
  const removeFreezeFrame = useProjectStore((s) => s.removeFreezeFrame)
  const addVideoTrack = useProjectStore((s) => s.addVideoTrack)
  const removeVideoTrack = useProjectStore((s) => s.removeVideoTrack)
  const ensureAudioTrack = useProjectStore((s) => s.ensureAudioTrack)
  const renameTrack = useProjectStore((s) => s.renameTrack)
  const addTrack = useProjectStore((s) => s.addTrack)
  const addTracks = useProjectStore((s) => s.addTracks)
  const addAudioSubmixTrack = useProjectStore((s) => s.addAudioSubmixTrack)
  const removeTrack = useProjectStore((s) => s.removeTrack)
  const removeTracks = useProjectStore((s) => s.removeTracks)
  const addClip = useProjectStore((s) => s.addClip)
  const updateCaption = useProjectStore((s) => s.updateCaption)
  const updateOverlay = useProjectStore((s) => s.updateOverlay)
  const setTrackMuted = useProjectStore((s) => s.setTrackMuted)
  const setTrackSolo = useProjectStore((s) => s.setTrackSolo)
  const setTrackDucking = useProjectStore((s) => s.setTrackDucking)

  // Mirror selection into the timelineUi store so keyboard shortcuts (Editor)
  // and tests can introspect via __TIMELINE_UI_FOR_TEST__.
  const selectClipInUi = useTimelineUi((s) => s.selectClip)
  // Phase 3.33 — Ctrl/Cmd+click multi-select: add/remove one clip id without
  // collapsing the rest of the selection.
  const toggleClipSelectedInUi = useTimelineUi((s) => s.toggleClipSelected)
  const selectClipsInUi = useTimelineUi((s) => s.selectClips)
  // Phase 3.33 — current multi-selection (drives the 그룹 묶기 enablement).
  const selectedClipIds = useTimelineUi((s) => s.selectedClipIds)
  // pptx11 슬라이드 9 — 갭 선택.
  const selectedGap = useTimelineUi((s) => s.selectedGap)
  const setSelectedGap = useTimelineUi((s) => s.setSelectedGap)
  const pps = useTimelineUi((s) => s.pps)
  const setPps = useTimelineUi((s) => s.setPps)
  const beats = useTimelineUi((s) => s.beats)
  const beatSnapEnabled = useTimelineUi((s) => s.beatSnapEnabled)
  const waveformUris = useTimelineUi((s) => s.waveformUris)

  // Phase 5 — timeline toolbar state.
  const toolMode = useTimelineUi((s) => s.toolMode)
  const setToolMode = useTimelineUi((s) => s.setToolMode)
  const snapEnabled = useTimelineUi((s) => s.snapEnabled)
  const setSnapEnabled = useTimelineUi((s) => s.setSnapEnabled)
  const avLinkEnabled = useTimelineUi((s) => s.avLinkEnabled)
  const setAvLinkEnabled = useTimelineUi((s) => s.setAvLinkEnabled)
  const markers = useTimelineUi((s) => s.markers)
  const addMarker = useTimelineUi((s) => s.addMarker)
  const removeMarker = useTimelineUi((s) => s.removeMarker)
  const clearMarkers = useTimelineUi((s) => s.clearMarkers)

  const removeClip = useProjectStore((s) => s.removeClip)
  // Phase 3.41 — per-clip lock toggle.
  const setClipLocked = useProjectStore((s) => s.setClipLocked)
  // Phase 3.33 — clip grouping / linking.
  const groupClips = useProjectStore((s) => s.groupClips)
  const ungroupClips = useProjectStore((s) => s.ungroupClips)
  const moveClipGroup = useProjectStore((s) => s.moveClipGroup)
  // pptx11 슬라이드 8 — 다중 선택 일괄 이동.
  const moveClipsByDelta = useProjectStore((s) => s.moveClipsByDelta)
  // Phase 3.40 — cross-track clip drag.
  const moveClipToTrack = useProjectStore((s) => s.moveClipToTrack)
  // pptx11 슬라이드 10 — 트랙 stack 이동.
  const moveTrack = useProjectStore((s) => s.moveTrack)
  const { undo, redo, canUndo, canRedo } = useUndoRedo()

  // Phase 3.32 — adjustment layers (range color-grades over the composite).
  const addAdjustmentLayer = useProjectStore((s) => s.addAdjustmentLayer)
  const updateAdjustmentLayer = useProjectStore((s) => s.updateAdjustmentLayer)
  // pptx11 슬라이드 24 — 우클릭 메뉴 액션 핸들러용.
  const removeAdjustmentLayer = useProjectStore((s) => s.removeAdjustmentLayer)
  const setAdjustmentLayerLocked = useProjectStore(
    (s) => s.setAdjustmentLayerLocked
  )
  const duplicateAdjustmentLayer = useProjectStore(
    (s) => s.duplicateAdjustmentLayer
  )
  const splitAdjustmentLayerAt = useProjectStore(
    (s) => s.splitAdjustmentLayerAt
  )
  const setAdjustmentLayerTransform = useProjectStore(
    (s) => s.setAdjustmentLayerTransform
  )
  const toggleAdjustmentLayerMirror = useProjectStore(
    (s) => s.toggleAdjustmentLayerMirror
  )
  const setAdjustmentLayerProperties = useProjectStore(
    (s) => s.setAdjustmentLayerProperties
  )
  const selectedAdjustmentLayerId = useTimelineUi(
    (s) => s.selectedAdjustmentLayerId
  )
  const setSelectedAdjustmentLayerId = useTimelineUi(
    (s) => s.setSelectedAdjustmentLayerId
  )

  // Voice-recording session handle (Phase 5). Non-null while recording.
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordError, setRecordError] = useState<string | null>(null)
  // Elapsed seconds while recording — drives the toolbar timer label.
  const [recordElapsed, setRecordElapsed] = useState(0)

  const [ctx, setCtx] = useState<{ clipId: string; x: number; y: number } | null>(null)
  // pptx11 슬라이드 24 — adjustment layer 우클릭 context menu state.
  const [adjCtx, setAdjCtx] = useState<{
    layerId: string
    x: number
    y: number
  } | null>(null)
  const adjustmentPropertiesClipboardRef = useRef<
    Partial<
      Pick<
        AdjustmentLayer,
        | 'colorAdjust'
        | 'curves'
        | 'hsl'
        | 'filterPreset'
        | 'filterIntensity'
        | 'transform'
        | 'mirrorX'
        | 'mirrorY'
        | 'fadeInMs'
        | 'fadeOutMs'
      >
    > | null
  >(null)
  // Phase 3 — track header context menu (slide 11).
  const [trackCtx, setTrackCtx] = useState<{
    trackId: string
    x: number
    y: number
  } | null>(null)
  const [dropTargetTrackId, setDropTargetTrackId] = useState<string | null>(null)
  // Phase 3.40 — cross-track drag: the lane the cursor is currently HOVERING
  // while moving an existing timeline clip (distinct from `dropTargetTrackId`,
  // which is for MediaLibrary HTML5 drops). A ref shadows the state so the
  // `mouseup` handler captured at mousedown time can read the freshest value
  // without depending on a stale closure.
  const [crossTrackDropTargetId, setCrossTrackDropTargetId] = useState<string | null>(null)
  const crossTrackDropTargetIdRef = useRef<string | null>(null)
  const [marquee, setMarquee] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const suppressNextLaneClickRef = useRef(false)

  // Compute total length (max endMs across all clips, min 10s for ruler).
  // Adjustment layers extend the ruler too so a layer past the last clip
  // stays draggable.
  const allClips = project.tracks.flatMap((t) => t.clips)
  const adjustmentLayers = project.adjustmentLayers ?? []
  const maxEnd = Math.max(
    allClips.reduce((acc, c) => Math.max(acc, c.endMs), 10_000),
    adjustmentLayers.reduce((acc, l) => Math.max(acc, l.endMs), 0)
  )
  const totalSeconds = Math.ceil(maxEnd / 1000) + 5
  const laneWidth = totalSeconds * pps

  // Video-track count — gates the "+ 비디오 트랙" button and the per-track
  // "×" remove button (the last remaining video track can't be removed).
  const videoTrackCount = project.tracks.filter(
    (t) => t.kind === 'video'
  ).length

  const bodyRef = useRef<HTMLDivElement | null>(null)

  const handleSelect = useCallback(
    (clipId: string | null): void => {
      onSelectClip(clipId)
      selectClipInUi(clipId)
    },
    [onSelectClip, selectClipInUi]
  )

  const collectClipIdsInClientRect = useCallback((rect: DOMRect): string[] => {
    const body = bodyRef.current
    if (!body) return []
    const ids: string[] = []
    const seen = new Set<string>()
    const nodes = body.querySelectorAll<HTMLElement>(
      '[data-testid="media-clip-block"], [data-testid="caption-clip-block"], [data-testid="overlay-clip-block"]'
    )
    nodes.forEach((node) => {
      const id = node.dataset.clipId
      if (!id || seen.has(id)) return
      const r = node.getBoundingClientRect()
      const intersects =
        r.left < rect.right &&
        r.right > rect.left &&
        r.top < rect.bottom &&
        r.bottom > rect.top
      if (intersects) {
        seen.add(id)
        ids.push(id)
      }
    })
    return ids
  }, [])

  const getContextTargetIds = useCallback((clipId: string): string[] => {
    const sel = useTimelineUi.getState().selectedClipIds
    return sel.size > 1 && sel.has(clipId) ? [...sel] : [clipId]
  }, [])

  // Phase 3.33 — Ctrl/Cmd+click multi-select. Toggles the clicked clip in/out
  // of `selectedClipIds` without disturbing the rest, so the user can build a
  // ≥2-clip selection that enables the context menu's "그룹 묶기" row. The
  // `onSelectClip` prop (single "active" clip) follows the toggled clip when
  // it stays selected, so panels still have a sensible focused clip.
  const handleToggleSelect = useCallback(
    (clipId: string): void => {
      const wasSelected = useTimelineUi.getState().selectedClipIds.has(clipId)
      toggleClipSelectedInUi(clipId)
      // After the toggle: if the clip is now selected make it the active clip;
      // if it was just removed, fall back to any other still-selected clip.
      if (!wasSelected) {
        onSelectClip(clipId)
      } else {
        const remaining = useTimelineUi.getState().selectedClipIds
        onSelectClip(remaining.size > 0 ? (remaining.values().next().value ?? null) : null)
      }
    },
    [onSelectClip, toggleClipSelectedInUi]
  )

  const handleMarqueeMouseDown = (
    e: React.MouseEvent<HTMLDivElement>
  ): void => {
    if (e.button !== 0) return
    if (toolMode !== 'select') return
    if (e.target !== e.currentTarget) return
    const body = bodyRef.current
    if (!body) return

    const startClientX = e.clientX
    const startClientY = e.clientY
    const startScrollLeft = body.scrollLeft
    const startScrollTop = body.scrollTop
    const bodyRect = body.getBoundingClientRect()
    const startX = startClientX - bodyRect.left + startScrollLeft
    const startY = startClientY - bodyRect.top + startScrollTop
    let dragging = false

    const updateRect = (ev: MouseEvent): DOMRect => {
      const currentX = ev.clientX - bodyRect.left + body.scrollLeft
      const currentY = ev.clientY - bodyRect.top + body.scrollTop
      const left = Math.min(startX, currentX)
      const top = Math.min(startY, currentY)
      const width = Math.abs(currentX - startX)
      const height = Math.abs(currentY - startY)
      setMarquee({ left, top, width, height })
      return new DOMRect(
        Math.min(startClientX, ev.clientX),
        Math.min(startClientY, ev.clientY),
        Math.abs(ev.clientX - startClientX),
        Math.abs(ev.clientY - startClientY)
      )
    }

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startClientX
      const dy = ev.clientY - startClientY
      if (!dragging) {
        if (Math.hypot(dx, dy) < CLICK_VS_DRAG_PX) return
        dragging = true
        suppressNextLaneClickRef.current = true
        setCtx(null)
        setAdjCtx(null)
        setSelectedAdjustmentLayerId(null)
      }
      updateRect(ev)
    }

    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const clientRect = updateRect(ev)
      setMarquee(null)
      if (!dragging) return

      const ids = collectClipIdsInClientRect(clientRect)
      selectClipsInUi(ids)
      onSelectClip(ids[0] ?? null)
      setTimeout(() => {
        suppressNextLaneClickRef.current = false
      }, 0)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleLaneClick = (
    e: React.MouseEvent<HTMLDivElement>,
    track?: Track
  ): void => {
    if (e.target !== e.currentTarget) return
    if (suppressNextLaneClickRef.current) {
      suppressNextLaneClickRef.current = false
      return
    }
    const target = e.currentTarget
    const rect = target.getBoundingClientRect()
    const x = e.clientX - rect.left
    const ms = Math.max(0, Math.round((x / pps) * 1000))
    // pptx11 슬라이드 9 — 클릭한 위치가 트랙의 두 클립 사이 빈 공간(gap)
    // 안에 들어가면 selectedGap 설정 → DEL 키로 ripple 삭제 가능.
    // 트랙이 안 넘어오는 legacy 호출은 기존 동작 그대로.
    if (track) {
      const sorted = [...track.clips].sort((a, b) => a.startMs - b.startMs)
      let leftEnd = 0
      let rightStart: number | null = null
      let insideClip = false
      for (const c of sorted) {
        if (ms < c.startMs) {
          if (rightStart === null) rightStart = c.startMs
        } else if (ms >= c.endMs) {
          if (c.endMs > leftEnd) leftEnd = c.endMs
        } else {
          insideClip = true
          break
        }
      }
      if (!insideClip && rightStart !== null && rightStart > leftEnd) {
        setSelectedGap({
          trackId: track.id,
          startMs: leftEnd,
          endMs: rightStart
        })
        onSeek(ms)
        return
      }
    }
    onSeek(ms)
    setSelectedGap(null)
    handleSelect(null)
  }

  const handleRulerMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const ruler = e.currentTarget
    const rect = ruler.getBoundingClientRect()
    // The ruler scrolls together with the lanes, so subtract the header
    // offset (120px) baked into the layout.
    const HEADER = 120
    const initialX = e.clientX - rect.left - HEADER
    onSeek(Math.max(0, Math.round((initialX / pps) * 1000)))
    const onMove = (ev: MouseEvent): void => {
      const x = ev.clientX - rect.left - HEADER
      onSeek(Math.max(0, Math.round((x / pps) * 1000)))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleContext = (e: React.MouseEvent, clip: Clip): void => {
    e.preventDefault()
    e.stopPropagation()
    // Phase 3.33 — preserve a valid multi-selection: when right-clicking a clip
    // that is ALREADY part of a ≥2-clip selection, keep the selection intact so
    // the context menu's "그룹 묶기" row stays enabled. Only the normal
    // "right-click selects, then opens menu" path runs when the clicked clip is
    // not already in the current selection.
    const sel = useTimelineUi.getState().selectedClipIds
    const keepMultiSelection = sel.size >= 2 && sel.has(clip.id)
    if (!keepMultiSelection) {
      handleSelect(clip.id)
    }
    setCtx({ clipId: clip.id, x: e.clientX, y: e.clientY })
  }

  const ctxClip = useMemo<Clip | null>(() => {
    if (!ctx) return null
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => cc.id === ctx.clipId)
      if (c) return c
    }
    return null
  }, [ctx, project])

  // "오디오 분리" gate — enabled only when the context-menu target is a
  // media clip on a 'video' track whose audio hasn't already been detached
  // (i.e. isMuted !== true). Mirrors detachAudio's own bail conditions.
  const audioDetachable = useMemo<boolean>(() => {
    if (!ctx || !ctxClip || !isMediaClip(ctxClip)) return false
    if (ctxClip.isMuted === true) return false
    const track = project.tracks.find((t) =>
      t.clips.some((c) => c.id === ctxClip.id)
    )
    return track?.kind === 'video'
  }, [ctx, ctxClip, project])

  // Phase 3.33 — "그룹 묶기" enablement: ≥2 clips selected AND they don't
  // already all share one (non-empty) group.
  const groupable = useMemo<boolean>(() => {
    if (selectedClipIds.size < 2) return false
    const groupIds = new Set<string | undefined>()
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (selectedClipIds.has(c.id)) groupIds.add(c.groupId)
      }
    }
    // Already all one group → nothing to do (a single non-empty groupId).
    if (groupIds.size === 1 && !groupIds.has(undefined)) return false
    return true
  }, [selectedClipIds, project])

  // Phase 3.33 — "그룹 해제" enablement: the ctx clip belongs to a link group.
  const grouped = useMemo<boolean>(() => {
    return Boolean(ctxClip?.groupId)
  }, [ctxClip])

  // Index of the keyframe under the playhead (within MIN_KEYFRAME_GAP_MS of
  // the clip-relative playhead offset), or -1 when not on a keyframe. Drives
  // the context-menu's "키프레임 갱신/추가" labels + the onTransformChange
  // redirect.
  const ctxKeyframeIndex = useMemo<number>(() => {
    if (!ctxClip || (!isMediaClip(ctxClip) && !isOverlayClip(ctxClip))) {
      return -1
    }
    const kfs = ctxClip.transformKeyframes
    if (!kfs || kfs.length === 0) return -1
    const localMs = playheadMs - ctxClip.startMs
    let bestIdx = -1
    let bestDist = MIN_KEYFRAME_GAP_MS
    for (let i = 0; i < kfs.length; i++) {
      const d = Math.abs(kfs[i].atMs - localMs)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    return bestIdx
  }, [ctxClip, playheadMs])

  // Phase 3.10 — index of the speed keyframe under the playhead. Speed
  // keyframe atMs are SOURCE offsets, so map the playhead's TIMELINE offset
  // through `sourceOffsetForTimelineOffset` first, then find the nearest
  // keyframe within MIN_SPEED_KEYFRAME_GAP_MS. -1 when not on a keyframe.
  const ctxSpeedKeyframeIndex = useMemo<number>(() => {
    if (!ctxClip || !isMediaClip(ctxClip)) return -1
    const kfs = ctxClip.speedKeyframes
    if (!kfs || kfs.length === 0) return -1
    const sourceOffsetMs = sourceOffsetForTimelineOffset(
      ctxClip,
      playheadMs - ctxClip.startMs
    )
    let bestIdx = -1
    let bestDist = MIN_SPEED_KEYFRAME_GAP_MS
    for (let i = 0; i < kfs.length; i++) {
      const d = Math.abs(kfs[i].atMs - sourceOffsetMs)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    return bestIdx
  }, [ctxClip, playheadMs])

  // Phase 3.16 — index (into the RESOLVED freeze list `getClipFreezeFrames`)
  // of the freeze whose source position is under the playhead. Parallel to
  // `ctxSpeedKeyframeIndex`: map the playhead's TIMELINE offset through
  // `sourceOffsetForTimelineOffset` (held constant during a freeze plateau),
  // then find the nearest freeze within MIN_FREEZE_GAP_MS. -1 when not on one.
  const ctxFreezeFrameIndex = useMemo<number>(() => {
    if (!ctxClip || !isMediaClip(ctxClip)) return -1
    const freezes = getClipFreezeFrames(ctxClip)
    if (freezes.length === 0) return -1
    const sourceOffsetMs = sourceOffsetForTimelineOffset(
      ctxClip,
      playheadMs - ctxClip.startMs
    )
    let bestIdx = -1
    let bestDist = MIN_FREEZE_GAP_MS
    for (let i = 0; i < freezes.length; i++) {
      const d = Math.abs(freezes[i].sourceMs - sourceOffsetMs)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    return bestIdx
  }, [ctxClip, playheadMs])

  // Phase 3.30 — index of the volume keyframe under the playhead. Volume
  // keyframe atMs are clip-relative TIMELINE offsets (NOT source offsets — no
  // `sourceOffsetForTimelineOffset`), so this mirrors `ctxKeyframeIndex` (the
  // transform one): use the raw clip-relative playhead offset, then find the
  // nearest keyframe within MIN_VOLUME_KEYFRAME_GAP_MS. -1 when not on one.
  const ctxVolumeKeyframeIndex = useMemo<number>(() => {
    if (!ctxClip || !isMediaClip(ctxClip)) return -1
    const kfs = ctxClip.volumeKeyframes
    if (!kfs || kfs.length === 0) return -1
    const localMs = playheadMs - ctxClip.startMs
    let bestIdx = -1
    let bestDist = MIN_VOLUME_KEYFRAME_GAP_MS
    for (let i = 0; i < kfs.length; i++) {
      const d = Math.abs(kfs[i].atMs - localMs)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    return bestIdx
  }, [ctxClip, playheadMs])

  const onMenuAction = (key: string): void => {
    if (!ctxClip) return
    const clip = ctxClip
    // Phase 3.41 — lock toggle is always allowed (user must be able to unlock).
    if (key === 'toggle-lock') {
      setClipLocked(clip.id, !isClipLocked(clip))
      return
    }
    // When locked, every other menu action is blocked.
    if (isClipLocked(clip)) return
    // pptx11 슬라이드 8 — multi-select 시 일괄 적용. ctxClip 이 선택 set 에
    // 포함되어 있을 때만 multi 동작 (다른 클립 우클릭 = single-target).
    const multiTargets = getContextTargetIds(clip.id)
    if (key === 'edit-caption' && isCaptionClip(clip)) {
      onEditCaption(clip.id)
    } else if (key === 'change-style' && isCaptionClip(clip)) {
      onEditCaption(clip.id)
    } else if (key === 'delete') {
      for (const id of multiTargets) {
        try {
          onDeleteClip(id)
        } catch {
          /* locked or already gone */
        }
      }
    } else if (key === 'duplicate') {
      const newIds: string[] = []
      for (const id of multiTargets) {
        const nid = duplicateClip(id)
        if (nid) newIds.push(nid)
      }
      if (newIds.length > 0) handleSelect(newIds[newIds.length - 1])
    } else if (key === 'detach-audio' && isMediaClip(clip)) {
      // detachAudio 는 single-clip semantics 가 명확 (media clip → 새 audio
      // clip 생성). multi 일 땐 각각 시도.
      let lastNewId: string | null = null
      for (const id of multiTargets) {
        const newId = detachAudio(id)
        if (newId) lastNewId = newId
      }
      if (lastNewId) handleSelect(lastNewId)
    } else if (key === 'split' && isMediaClip(clip)) {
      // playhead 가 클립 안에 있어야 split — multi 일 땐 그 조건 만족한
      // 클립만 실제로 잘림 (store 가 verify).
      for (const id of multiTargets) {
        try {
          splitClipAt(id, playheadMs)
        } catch {
          /* skip */
        }
      }
    } else if (key === 'remove-silence' && isMediaClip(clip)) {
      props.onOpenSilenceDialog?.(clip.id)
    } else if (key === 'group') {
      // Phase 3.33 — group every currently-selected clip.
      groupClips([...selectedClipIds])
    } else if (key === 'ungroup') {
      // Phase 3.33 — dissolve the link group the ctx clip belongs to.
      ungroupClips(clip.id)
    }
  }

  // -------------------------------------------------------------------------
  // Track header context menu (Phase 3 — slide 11).
  // -------------------------------------------------------------------------
  const handleTrackHeaderContext = (
    e: React.MouseEvent,
    track: Track
  ): void => {
    e.preventDefault()
    e.stopPropagation()
    setCtx(null)
    setTrackCtx({ trackId: track.id, x: e.clientX, y: e.clientY })
  }

  // The track the menu currently targets, resolved live from the project.
  const trackCtxTrack = useMemo<Track | null>(() => {
    if (!trackCtx) return null
    return project.tracks.find((t) => t.id === trackCtx.trackId) ?? null
  }, [trackCtx, project])

  // -------------------------------------------------------------------------
  // Ctrl+wheel zoom — anchor on cursor where possible.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const direction = e.deltaY > 0 ? -1 : 1
      const oldPps = useTimelineUi.getState().pps
      const factor = direction > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR
      const target = Math.max(MIN_PPS, Math.min(MAX_PPS, oldPps * factor))
      if (target === oldPps) return

      // Anchor the time-under-cursor: compute the timeMs the cursor was on
      // BEFORE zoom (subtracting the 120px lane-header offset), then after
      // setPps adjust scrollLeft so that timeMs sits at the same screen X.
      const rect = el.getBoundingClientRect()
      const HEADER = 120
      const screenX = e.clientX - rect.left
      const contentX = el.scrollLeft + screenX - HEADER
      const timeMs = (contentX / oldPps) * 1000

      setPps(target)
      requestAnimationFrame(() => {
        if (!bodyRef.current) return
        const newContentX = (timeMs / 1000) * target
        bodyRef.current.scrollLeft = Math.max(0, newContentX - (screenX - HEADER))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setPps])

  // -------------------------------------------------------------------------
  // Drop handler — MediaLibrary card → track lane.
  // -------------------------------------------------------------------------
  const handleLaneDragOver = (
    e: React.DragEvent<HTMLDivElement>,
    track: Track
  ): void => {
    // Only intercept our own MIME so unrelated drags pass through.
    if (
      !e.dataTransfer.types.includes(MEDIA_DRAG_MIME) &&
      !e.dataTransfer.types.includes(PENDING_MEDIA_DRAG_MIME)
    ) {
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (dropTargetTrackId !== track.id) setDropTargetTrackId(track.id)
  }

  const handleLaneDragLeave = (
    e: React.DragEvent<HTMLDivElement>,
    track: Track
  ): void => {
    // Only clear if leaving to outside this lane.
    const related = e.relatedTarget as Node | null
    if (related && e.currentTarget.contains(related)) return
    if (dropTargetTrackId === track.id) setDropTargetTrackId(null)
  }

  const handleLaneDrop = (
    e: React.DragEvent<HTMLDivElement>,
    track: Track
  ): void => {
    e.preventDefault()
    e.stopPropagation()
    setDropTargetTrackId(null)
    const rect = e.currentTarget.getBoundingClientRect()
    const clientX = e.clientX
    const altKey = e.altKey
    const mediaId = e.dataTransfer.getData(MEDIA_DRAG_MIME)
    const pendingId = e.dataTransfer.getData(PENDING_MEDIA_DRAG_MIME)

    const addDroppedMedia = (media: MediaAsset): void => {
      const liveProject = useProjectStore.getState().project

      // Auto-route by MEDIA kind (not by which lane the cursor happened to be
      // over): audio → an audio track, video/image → a video track.
      let target: Track | undefined
      const liveDropTrack = liveProject.tracks.find((t) => t.id === track.id) ?? track
      if (media.kind === 'audio') {
        if (liveDropTrack.kind === 'audio') {
          target = liveDropTrack
        } else {
          const audioTrackId = ensureAudioTrack('voice')
          target = useProjectStore
            .getState()
            .project.tracks.find((t) => t.id === audioTrackId)
        }
      } else {
        target =
          liveDropTrack.kind === 'video'
            ? liveDropTrack
            : liveProject.tracks.find((t) => t.kind === 'video')
      }
      if (!target) return

      const x = clientX - rect.left
      const dropMs = Math.max(0, Math.round((x / pps) * 1000))
      const durationMs =
        media.durationMs > 0 ? media.durationMs : IMAGE_DEFAULT_MS
      // Snap to nearest second unless Alt is held.
      const desired = altKey ? dropMs : Math.round(dropMs / 1000) * 1000
      const startMs = findFreeStart(target, desired, durationMs)
      const clip: VideoAudioClip = {
        id: ulid(),
        kind: 'media',
        mediaId: media.id,
        trackId: target.id,
        startMs,
        endMs: startMs + durationMs,
        trimInMs: 0,
        trimOutMs: media.durationMs > 0 ? media.durationMs : durationMs,
        speed: 1
      }
      addClip(clip)
    }

    if (mediaId) {
      const media: MediaAsset | undefined =
        useProjectStore.getState().project.media[mediaId]
      if (media) addDroppedMedia(media)
      return
    }

    if (pendingId) {
      void awaitPending(pendingId).then((asset) => {
        if (asset) addDroppedMedia(asset)
      })
    }
  }

  // -------------------------------------------------------------------------
  // Trim handle drag — media clips only. (Unchanged from Phase 2.3.)
  // -------------------------------------------------------------------------
  const onTrimHandleMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    clip: VideoAudioClip,
    track: Track,
    side: 'left' | 'right'
  ): void => {
    if (e.button !== 0) return
    // Phase 3.41 — locked clips reject trim drags.
    if (isClipLocked(clip)) return
    e.preventDefault()
    e.stopPropagation()
    handleSelect(clip.id)
    setCtx(null)
    const startMouseX = e.clientX
    const orig: VideoAudioClip = { ...clip }
    const speed = orig.speed ?? 1
    const media = project.media[orig.mediaId]
    const mediaDuration = media?.durationMs ?? Number.POSITIVE_INFINITY

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startMouseX
      const deltaMs = (dx / pps) * 1000
      const liveProject = useProjectStore.getState().project
      const liveTrack =
        liveProject.tracks.find((t) => t.id === track.id) ?? track
      // Phase 3.78 — cross-track magnet: collect every OTHER track's clip
      // boundaries so the trim/drag also snaps to multi-track edges.
      const crossTrackEdges: number[] = []
      for (const t of liveProject.tracks) {
        if (t.id === track.id) continue
        for (const c of t.clips) {
          if (c.id === clip.id) continue
          crossTrackEdges.push(c.startMs, c.endMs)
        }
      }

      if (side === 'left') {
        let desiredStart = orig.startMs + deltaMs
        desiredStart = snapMs(desiredStart, pps, liveTrack, clip.id, ev.altKey, {
          beats,
          beatSnapEnabled,
          snapEnabled,
          crossTrackEdges
        })
        if (desiredStart > orig.endMs - MIN_CLIP_MS) {
          desiredStart = orig.endMs - MIN_CLIP_MS
        }
        for (const other of liveTrack.clips) {
          if (other.id === clip.id) continue
          if (other.endMs <= orig.startMs && other.endMs > desiredStart) {
            desiredStart = other.endMs
          }
        }
        const startShift = desiredStart - orig.startMs
        let newTrimIn = orig.trimInMs + startShift * speed
        if (newTrimIn < 0) {
          const overshoot = -newTrimIn / speed
          desiredStart = desiredStart + overshoot
          newTrimIn = 0
        }
        if (Math.round(desiredStart) === orig.startMs) return
        updateMediaClipTrim(clip.id, {
          startMs: Math.round(desiredStart),
          trimInMs: Math.round(newTrimIn)
        })
      } else {
        let desiredEnd = orig.endMs + deltaMs
        desiredEnd = snapMs(desiredEnd, pps, liveTrack, clip.id, ev.altKey, {
          beats,
          beatSnapEnabled,
          snapEnabled,
          crossTrackEdges
        })
        if (desiredEnd < orig.startMs + MIN_CLIP_MS) {
          desiredEnd = orig.startMs + MIN_CLIP_MS
        }
        for (const other of liveTrack.clips) {
          if (other.id === clip.id) continue
          if (other.startMs >= orig.endMs && other.startMs < desiredEnd) {
            desiredEnd = other.startMs
          }
        }
        const endShift = desiredEnd - orig.endMs
        let newTrimOut = orig.trimOutMs + endShift * speed
        if (newTrimOut > mediaDuration) {
          const overshoot = (newTrimOut - mediaDuration) / speed
          desiredEnd = desiredEnd - overshoot
          newTrimOut = mediaDuration
        }
        if (Math.round(desiredEnd) === orig.endMs) return
        updateMediaClipTrim(clip.id, {
          endMs: Math.round(desiredEnd),
          trimOutMs: Math.round(newTrimOut)
        })
      }
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // -------------------------------------------------------------------------
  // Keyframe marker drag — horizontal only. Mirrors the trim-handle pattern:
  // a click-vs-drag threshold distinguishes a marker click (→ seek) from a
  // drag (→ updateTransformKeyframe with a clamped clip-relative atMs). The
  // rapid updateTransformKeyframe calls are coalesced by the store's 200ms
  // undo throttle, exactly like trim-drag.
  // -------------------------------------------------------------------------
  const onKeyframeMarkerMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    clip: VideoAudioClip | OverlayClip,
    kfIndex: number,
    kfAtMs: number
  ): void => {
    // Right-click or Alt+click removes the keyframe outright.
    if (e.button === 2 || e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      removeTransformKeyframe(clip.id, kfIndex)
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    handleSelect(clip.id)
    setCtx(null)
    const startMouseX = e.clientX
    const durationMs = getClipDuration(clip)
    let dragging = false

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startMouseX
      if (!dragging) {
        if (Math.abs(dx) < CLICK_VS_DRAG_PX) return
        dragging = true
      }
      const deltaMs = (dx / pps) * 1000
      const desired = Math.max(
        0,
        Math.min(durationMs, Math.round(kfAtMs + deltaMs))
      )
      updateTransformKeyframe(clip.id, kfIndex, { atMs: desired })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // A pure click (no drag) → seek to the keyframe.
      if (!dragging) onSeek(clip.startMs + kfAtMs)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // -------------------------------------------------------------------------
  // Clip body drag-to-reposition (whole clip move). Click-vs-drag threshold
  // of CLICK_VS_DRAG_PX prevents accidental moves on simple clicks.
  // -------------------------------------------------------------------------
  const onClipBodyMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    clip: Clip,
    track: Track
  ): void => {
    if (e.button !== 0) return
    // Phase 3.41 — locked clips reject drag (same-track + cross-track).
    if (isClipLocked(clip)) return
    // Don't stopPropagation immediately — we still want a click-without-drag
    // to register as a selection click.
    const startMouseX = e.clientX
    const origStart = clip.startMs
    const duration = clip.endMs - clip.startMs
    let dragging = false

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startMouseX
      if (!dragging) {
        if (Math.abs(dx) < CLICK_VS_DRAG_PX) return
        dragging = true
        const sel = useTimelineUi.getState().selectedClipIds
        if (sel.size > 1 && sel.has(clip.id)) {
          onSelectClip(clip.id)
        } else {
          handleSelect(clip.id)
        }
      }
      const deltaMs = (dx / pps) * 1000
      let desired = origStart + deltaMs
      const liveProject = useProjectStore.getState().project
      const liveTrack =
        liveProject.tracks.find((t) => t.id === track.id) ?? track
      // Phase 3.78 — cross-track magnet edges.
      const crossTrackEdges: number[] = []
      for (const t of liveProject.tracks) {
        if (t.id === track.id) continue
        for (const c of t.clips) {
          if (c.id === clip.id) continue
          crossTrackEdges.push(c.startMs, c.endMs)
        }
      }
      desired = snapMs(desired, pps, liveTrack, clip.id, ev.altKey, {
        beats,
        beatSnapEnabled,
        snapEnabled,
        crossTrackEdges
      })
      desired = clampNoOverlap(liveTrack, desired, duration, clip.id)
      desired = Math.max(0, Math.round(desired))
      if (desired === clip.startMs) return

      const newStart = desired
      const newEnd = newStart + duration
      // pptx11 슬라이드 8 — 다중 선택 (Ctrl+클릭 / marquee) 으로 anchor
      // 외에도 다른 클립들이 같이 선택되어 있으면 일괄 이동. groupId
      // (Phase 3.33 link group) 가 있어도 multi-select 가 그것을 포함하면
      // multi-select 가 우선 (사용자 의도 명확).
      const selectedIds = useTimelineUi.getState().selectedClipIds
      const isMultiMove = selectedIds.size > 1 && selectedIds.has(clip.id)
      if (isMultiMove) {
        moveClipsByDelta([...selectedIds], clip.id, newStart)
      } else if (clip.groupId) {
        // Phase 3.33 — grouped clip: move the WHOLE link group together. The
        // snap/clamp math above stays anchored on the dragged clip; the store
        // shifts every member by the resulting delta.
        moveClipGroup(clip.id, newStart)
      } else if (isMediaClip(clip)) {
        // Reuse updateMediaClipTrim for media clips so we get the same
        // invariant clamping logic.
        updateMediaClipTrim(clip.id, { startMs: newStart, endMs: newEnd })
      } else if (isCaptionClip(clip)) {
        updateCaption(clip.id, { startMs: newStart, endMs: newEnd })
      } else if (isOverlayClip(clip)) {
        // Overlay clips reposition by body-drag too (no trim handles).
        updateOverlay(clip.id, { startMs: newStart, endMs: newEnd })
      }

      // Phase 3.40 — cross-track drop indicator. Hit-test the row under the
      // cursor's Y; if it's a DIFFERENT, compatible track, paint it as a
      // candidate drop target. Commit happens in onUp.
      const hit = hitTestTrackAtY(bodyRef.current, ev.clientY)
      let candidateId: string | null = null
      if (hit && hit.trackId && hit.trackId !== track.id) {
        const live = useProjectStore.getState().project
        const tgt = live.tracks.find((t) => t.id === hit.trackId)
        if (tgt && canPlaceClipOnTrack(clip.kind as ClipKind, tgt.kind)) {
          candidateId = hit.trackId
        }
      }
      crossTrackDropTargetIdRef.current = candidateId
      setCrossTrackDropTargetId(candidateId)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)

      // Phase 3.40 — commit the cross-track move (if any). We re-resolve the
      // clip from the LIVE project because its startMs may have shifted during
      // the drag (the per-move commit above updates the store), and clamp the
      // dropped startMs against the target lane's existing clips. The
      // ref-vs-state pair keeps both sides in sync.
      const finalTargetId = crossTrackDropTargetIdRef.current
      crossTrackDropTargetIdRef.current = null
      setCrossTrackDropTargetId(null)
      if (finalTargetId && finalTargetId !== track.id) {
        const live = useProjectStore.getState().project
        const tgt = live.tracks.find((t) => t.id === finalTargetId)
        if (tgt && canPlaceClipOnTrack(clip.kind as ClipKind, tgt.kind)) {
          let liveClip: Clip | null = null
          for (const t of live.tracks) {
            const c = t.clips.find((cc) => cc.id === clip.id)
            if (c) {
              liveClip = c
              break
            }
          }
          if (liveClip) {
            const dur = liveClip.endMs - liveClip.startMs
            const safeStart = clampNoOverlap(tgt, liveClip.startMs, dur, liveClip.id)
            if (safeStart !== liveClip.startMs) {
              if (isMediaClip(liveClip)) {
                updateMediaClipTrim(liveClip.id, {
                  startMs: safeStart,
                  endMs: safeStart + dur
                })
              } else if (isCaptionClip(liveClip)) {
                updateCaption(liveClip.id, {
                  startMs: safeStart,
                  endMs: safeStart + dur
                })
              } else if (isOverlayClip(liveClip)) {
                updateOverlay(liveClip.id, {
                  startMs: safeStart,
                  endMs: safeStart + dur
                })
              }
            }
            moveClipToTrack(liveClip.id, finalTargetId)
          }
        }
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // -------------------------------------------------------------------------
  // Phase 3.32 — adjustment-layer drag (body move + left/right edge trim).
  // Reuses the same px↔ms math as the clip drag handlers above. A click
  // without a drag selects the layer; a drag past CLICK_VS_DRAG_PX moves /
  // trims it via `updateAdjustmentLayer` (the store re-clamps the window).
  // -------------------------------------------------------------------------
  const onAdjustmentLayerMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    layer: AdjustmentLayer,
    mode: 'move' | 'left' | 'right'
  ): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSelectedAdjustmentLayerId(layer.id)
    setCtx(null)
    const startMouseX = e.clientX
    const origStart = layer.startMs
    const origEnd = layer.endMs
    let dragging = false

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startMouseX
      if (!dragging) {
        if (Math.abs(dx) < CLICK_VS_DRAG_PX) return
        dragging = true
      }
      const deltaMs = (dx / pps) * 1000
      if (mode === 'move') {
        const duration = origEnd - origStart
        const newStart = Math.max(0, Math.round(origStart + deltaMs))
        updateAdjustmentLayer(layer.id, {
          startMs: newStart,
          endMs: newStart + duration
        })
      } else if (mode === 'left') {
        let newStart = Math.round(origStart + deltaMs)
        if (newStart > origEnd - MIN_CLIP_MS) newStart = origEnd - MIN_CLIP_MS
        if (newStart < 0) newStart = 0
        updateAdjustmentLayer(layer.id, { startMs: newStart })
      } else {
        let newEnd = Math.round(origEnd + deltaMs)
        if (newEnd < origStart + MIN_CLIP_MS) newEnd = origStart + MIN_CLIP_MS
        updateAdjustmentLayer(layer.id, { endMs: newEnd })
      }
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** Add a new adjustment layer at the playhead, then select it. */
  const handleAddAdjustmentLayer = useCallback((): void => {
    const id = addAdjustmentLayer(
      playheadMs,
      playheadMs + DEFAULT_ADJUSTMENT_LAYER_MS
    )
    if (id) setSelectedAdjustmentLayerId(id)
  }, [addAdjustmentLayer, playheadMs, setSelectedAdjustmentLayerId])

  // -------------------------------------------------------------------------
  // Phase 5 — toolbar handlers.
  // -------------------------------------------------------------------------

  /** Resolve the currently-selected clip from the live project, or null. */
  const findSelectedClip = useCallback((): Clip | null => {
    if (!selectedClipId) return null
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => cc.id === selectedClipId)
      if (c) return c
    }
    return null
  }, [project, selectedClipId])

  /** Split the selected media clip at the playhead. Returns the new id. */
  const handleSplitAtPlayhead = useCallback((): string | null => {
    const clip = findSelectedClip()
    if (!clip || !isMediaClip(clip)) return null
    // Phase 3.41 — locked clips reject splits.
    if (isClipLocked(clip)) return null
    return splitClipAt(clip.id, playheadMs) ?? null
  }, [findSelectedClip, splitClipAt, playheadMs])

  /** Delete the selected clip (any kind). */
  const handleDeleteSelected = useCallback((): void => {
    const clip = findSelectedClip()
    if (!clip) return
    // Phase 3.41 — locked clips reject deletion.
    if (isClipLocked(clip)) return
    onDeleteClip(clip.id)
    handleSelect(null)
  }, [findSelectedClip, onDeleteClip, handleSelect])

  /**
   * Split the selected clip at the playhead, then delete one side.
   *   side='before' → drop the LEFT (earlier) piece, keep the right.
   *   side='after'  → drop the RIGHT (later) piece, keep the left.
   * splitClipAt returns the NEW (right) clip id; the original keeps the
   * left segment.
   */
  const handleSplitDelete = useCallback(
    (side: 'before' | 'after'): void => {
      const clip = findSelectedClip()
      if (!clip || !isMediaClip(clip)) return
      // Phase 3.41 — locked clips reject split-delete.
      if (isClipLocked(clip)) return
      const origId = clip.id
      const newRightId = splitClipAt(origId, playheadMs)
      if (!newRightId) return
      if (side === 'before') {
        // Keep the right piece (the new clip); remove the original left.
        removeClip(origId)
        handleSelect(newRightId)
      } else {
        // Keep the left piece (original); remove the new right.
        removeClip(newRightId)
        handleSelect(origId)
      }
    },
    [findSelectedClip, splitClipAt, playheadMs, removeClip, handleSelect]
  )

  /** Add a marker at the current playhead position. */
  const handleAddMarker = useCallback((): void => {
    addMarker(playheadMs)
  }, [addMarker, playheadMs])

  /** Zoom so the whole timeline content fits the visible body width. */
  const handleFit = useCallback((): void => {
    const el = bodyRef.current
    if (!el) return
    const HEADER = 120
    const avail = el.clientWidth - HEADER
    if (avail <= 0) return
    const totalMs = Math.max(1000, getTotalDurationMs(project))
    const targetPps = (avail / totalMs) * 1000
    setPps(Math.max(MIN_PPS, Math.min(MAX_PPS, targetPps)))
    el.scrollLeft = 0
  }, [project, setPps])

  // Recording elapsed-time ticker.
  useEffect(() => {
    if (!recording) return
    setRecordElapsed(0)
    const started = Date.now()
    const timer = window.setInterval(() => {
      setRecordElapsed(Math.floor((Date.now() - started) / 1000))
    }, 250)
    return () => window.clearInterval(timer)
  }, [recording])

  /** Start a microphone recording session. */
  const handleStartRecording = useCallback(async (): Promise<void> => {
    if (recording) return
    setRecordError(null)
    try {
      const rec = await startVoiceRecording()
      recorderRef.current = rec
      setRecording(true)
    } catch (err) {
      setRecordError(
        err instanceof Error ? err.message : '마이크를 시작하지 못했습니다'
      )
    }
  }, [recording])

  /** Stop the active recording, ingest the take, and add a clip. */
  const handleStopRecording = useCallback(async (): Promise<void> => {
    const rec = recorderRef.current
    if (!rec) return
    recorderRef.current = null
    setRecording(false)
    const result = await rec.stop()
    if (result.ok) {
      handleSelect(result.clipId)
    } else {
      setRecordError(result.error)
    }
  }, [handleSelect])

  // Stop + discard any in-flight recording if the timeline unmounts.
  useEffect(() => {
    return () => {
      recorderRef.current?.cancel()
      recorderRef.current = null
    }
  }, [])

  /** Split-tool: clicking inside a clip splits it at the click point. */
  const handleSplitToolClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, clip: Clip): void => {
      if (toolMode !== 'split') return
      if (!isMediaClip(clip)) return
      // Phase 3.41 — locked clips reject splits.
      if (isClipLocked(clip)) return
      // Walk up from the clicked clip-body to the track lane (the element
      // carrying a data-track-drop attribute) so the click X maps to an
      // absolute timeline position regardless of the body's own offset.
      let lane: HTMLElement | null = e.currentTarget
      while (lane && !lane.hasAttribute('data-track-drop')) {
        lane = lane.parentElement
      }
      if (!lane) return
      const rect = lane.getBoundingClientRect()
      const x = e.clientX - rect.left
      const atMs = Math.max(0, Math.round((x / pps) * 1000))
      const newId = splitClipAt(clip.id, atMs)
      if (newId) handleSelect(newId)
    },
    [toolMode, pps, splitClipAt, handleSelect]
  )

  const selectedClipForToolbar = findSelectedClip()
  const canSplit =
    selectedClipForToolbar !== null &&
    isMediaClip(selectedClipForToolbar) &&
    !isClipLocked(selectedClipForToolbar)
  const canDelete =
    selectedClipForToolbar !== null && !isClipLocked(selectedClipForToolbar)

  return (
    <div style={styles.wrap} data-testid="timeline">
      <div style={styles.toolbar} data-testid="timeline-toolbar">
        {/* ---- LEFT GROUP: add · tool · undo/redo · split · split-delete ·
                delete · marker ---- */}
        <div style={styles.toolbarGroup}>
          {/* + 비디오 트랙 (add) */}
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(videoTrackCount >= MAX_VIDEO_TRACKS
                ? styles.toolBtnDisabled
                : {})
            }}
            onClick={() => addVideoTrack()}
            disabled={videoTrackCount >= MAX_VIDEO_TRACKS}
            title={
              videoTrackCount >= MAX_VIDEO_TRACKS
                ? `비디오 트랙은 최대 ${MAX_VIDEO_TRACKS}개까지 추가할 수 있습니다`
                : '비디오 트랙 추가'
            }
            data-testid="add-video-track-button"
          >
            +
          </button>

          <div style={styles.toolbarSep} />

          {/* 선택 도구 */}
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(toolMode === 'select' ? styles.toolBtnActive : {})
            }}
            onClick={() => setToolMode('select')}
            aria-pressed={toolMode === 'select'}
            title="선택 도구 — 클립을 클릭해 선택"
            data-testid="tool-select-button"
          >
            ▦
          </button>
          {/* 분할 도구 (split mode) */}
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(toolMode === 'split' ? styles.toolBtnActive : {})
            }}
            onClick={() => setToolMode('split')}
            aria-pressed={toolMode === 'split'}
            title="분할 도구 — 레인 위 클립을 클릭한 지점에서 분할"
            data-testid="tool-split-button"
          >
            ✂
          </button>

          <div style={styles.toolbarSep} />

          {/* 실행취소 / 다시실행 */}
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(canUndo ? {} : styles.toolBtnDisabled)
            }}
            onClick={() => undo()}
            disabled={!canUndo}
            title="실행 취소 (Ctrl+Z)"
            data-testid="timeline-undo-button"
          >
            ↶
          </button>
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(canRedo ? {} : styles.toolBtnDisabled)
            }}
            onClick={() => redo()}
            disabled={!canRedo}
            title="다시 실행 (Ctrl+Shift+Z)"
            data-testid="timeline-redo-button"
          >
            ↷
          </button>

          <div style={styles.toolbarSep} />

          {/* 분할(Split) at playhead */}
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(canSplit ? {} : styles.toolBtnDisabled)
            }}
            onClick={() => handleSplitAtPlayhead()}
            disabled={!canSplit}
            title="선택 클립을 플레이헤드에서 분할 (S)"
            data-testid="timeline-split-button"
          >
            ⑂
          </button>
          {/* 앞 삭제 분할 — 분할 후 왼쪽(앞) 조각 삭제 */}
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(canSplit ? {} : styles.toolBtnDisabled)
            }}
            onClick={() => handleSplitDelete('before')}
            disabled={!canSplit}
            title="플레이헤드 앞부분 삭제 (분할 후 앞 조각 제거)"
            data-testid="timeline-split-delete-before-button"
          >
            ⇤
          </button>
          {/* 뒤 삭제 분할 — 분할 후 오른쪽(뒤) 조각 삭제 */}
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(canSplit ? {} : styles.toolBtnDisabled)
            }}
            onClick={() => handleSplitDelete('after')}
            disabled={!canSplit}
            title="플레이헤드 뒷부분 삭제 (분할 후 뒤 조각 제거)"
            data-testid="timeline-split-delete-after-button"
          >
            ⇥
          </button>
          {/* 삭제(Delete) */}
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(canDelete ? {} : styles.toolBtnDisabled)
            }}
            onClick={() => handleDeleteSelected()}
            disabled={!canDelete}
            title="선택 클립 삭제 (Delete)"
            data-testid="timeline-delete-button"
          >
            🗑
          </button>

          <div style={styles.toolbarSep} />

          {/* 마커(Marker) */}
          <button
            type="button"
            style={styles.toolBtn}
            onClick={() => handleAddMarker()}
            title="플레이헤드에 마커 추가"
            data-testid="timeline-add-marker-button"
          >
            ⚑
          </button>
          {markers.length > 0 && (
            <button
              type="button"
              style={styles.toolBtn}
              onClick={() => clearMarkers()}
              title={`마커 모두 제거 (${markers.length}개)`}
              data-testid="timeline-clear-markers-button"
            >
              ⌦
            </button>
          )}
        </div>

        <div style={styles.flex1} />

        {/* ---- RIGHT GROUP: voice record · snap · A/V link · zoom ---- */}
        <div style={styles.toolbarGroup}>
          {/* 음성 녹음 */}
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(recording ? styles.toolBtnRecording : {})
            }}
            onClick={() =>
              recording ? handleStopRecording() : handleStartRecording()
            }
            aria-pressed={recording}
            title={recording ? '녹음 중지 후 트랙에 삽입' : '음성 녹음'}
            data-testid="timeline-record-button"
          >
            {recording ? '⏹' : '🎙'}
          </button>
          {recording && (
            <span style={styles.recTimer} data-testid="timeline-record-timer">
              {Math.floor(recordElapsed / 60)}:
              {String(recordElapsed % 60).padStart(2, '0')}
            </span>
          )}

          <div style={styles.toolbarSep} />

          {/* 스냅 토글 */}
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(snapEnabled ? styles.toolBtnActive : {})
            }}
            onClick={() => setSnapEnabled(!snapEnabled)}
            aria-pressed={snapEnabled}
            title={
              snapEnabled
                ? '스냅 켜짐 — 클릭하면 끔 (Alt 드래그로 일시 해제)'
                : '스냅 꺼짐 — 클릭하면 켬'
            }
            data-testid="timeline-snap-toggle"
          >
            ⌗
          </button>
          {/* 영상-오디오 링크 토글 */}
          <button
            type="button"
            style={{
              ...styles.toolBtn,
              ...(avLinkEnabled ? styles.toolBtnActive : {})
            }}
            onClick={() => setAvLinkEnabled(!avLinkEnabled)}
            aria-pressed={avLinkEnabled}
            title="영상-오디오 링크 (링크된 클립 함께 이동) — 준비 중"
            data-testid="timeline-avlink-toggle"
          >
            🔗
          </button>

          <div style={styles.toolbarSep} />

          {/* 줌: 핏 · − · 슬라이더 · + */}
          <button
            type="button"
            style={styles.toolBtn}
            onClick={() => handleFit()}
            title="타임라인 핏 — 전체 콘텐츠를 화면에 맞춤"
            data-testid="timeline-fit-button"
          >
            ⤢
          </button>
          <button
            type="button"
            style={styles.toolBtn}
            onClick={() => setPps(pps / ZOOM_FACTOR)}
            aria-label="축소"
            title="축소"
            data-testid="timeline-zoom-out"
          >
            −
          </button>
          <input
            type="range"
            min={MIN_PPS}
            max={MAX_PPS}
            step={1}
            value={Math.round(pps)}
            onChange={(e) => setPps(Number(e.target.value))}
            style={styles.zoomSlider}
            aria-label="줌 슬라이더"
            title="줌 슬라이더"
            data-testid="timeline-zoom-slider"
          />
          <button
            type="button"
            style={styles.toolBtn}
            onClick={() => setPps(pps * ZOOM_FACTOR)}
            aria-label="확대"
            title="확대"
            data-testid="timeline-zoom-in"
          >
            +
          </button>
          <div
            style={{ minWidth: 52, textAlign: 'center' }}
            data-testid="timeline-zoom-level"
          >
            {Math.round(pps)} px/s
          </div>
        </div>
      </div>
      {recordError && (
        <div
          style={{
            flexShrink: 0,
            padding: '4px 10px',
            background: '#2a0d0d',
            borderBottom: '1px solid #4a1f1f',
            color: '#fca5a5',
            fontSize: 11,
            cursor: 'pointer'
          }}
          onClick={() => setRecordError(null)}
          role="button"
          data-testid="timeline-record-error"
        >
          녹음 오류: {recordError} (클릭하여 닫기)
        </div>
      )}
      <div
        style={styles.ruler}
        onMouseDown={handleRulerMouseDown}
        data-testid="timeline-ruler"
      >
        <div style={{ position: 'absolute', left: 120, right: 0, height: '100%' }}>
          {Array.from({ length: totalSeconds + 1 }).map((_, s) => (
            <div key={s} style={{ ...styles.rulerTick, left: s * pps }}>
              {s}s
            </div>
          ))}
          {beatSnapEnabled &&
            beats.map((b, i) => (
              <div
                key={`beat-${i}`}
                style={{ ...styles.beatTick, left: (b / 1000) * pps }}
                data-testid="ruler-beat-tick"
                data-beat-ms={b}
              />
            ))}
          {/* Phase 5 — markers. Click a pin to remove it. */}
          {markers.map((m) => (
            <div
              key={m.id}
              style={{ ...styles.rulerMarker, left: (m.atMs / 1000) * pps }}
              data-testid="ruler-marker"
              data-marker-id={m.id}
              data-marker-ms={m.atMs}
              title={`마커 · ${(m.atMs / 1000).toFixed(2)}s — 클릭하여 제거`}
              onMouseDown={(e) => {
                // Don't let the ruler scrub-seek when removing a marker.
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                removeMarker(m.id)
              }}
            >
              <div style={styles.rulerMarkerFlag} />
            </div>
          ))}
          {/* Phase 3.27 — cover / thumbnail frame marker. Rendered only when
              the project has an explicit cover; positioned with the same
              px/sec as ticks/beats/markers. */}
          {project.coverMs != null && (
            <div
              style={{
                ...styles.rulerCoverMarker,
                left: (project.coverMs / 1000) * pps
              }}
              data-testid="ruler-cover-marker"
              data-cover-ms={project.coverMs}
              title={`커버 프레임 · ${(project.coverMs / 1000).toFixed(2)}s`}
            >
              ★
            </div>
          )}
        </div>
      </div>
      {/* Phase 3.32 — adjustment-layer lane. A dedicated tinted row below the
          ruler; each block is a range color-grade over the composite. */}
      <div
        style={styles.adjustmentLaneRow}
        data-testid="adjustment-layer-lane"
      >
        <div style={styles.adjustmentLaneHeader}>
          <span style={styles.adjustmentLaneTitle}>조정 레이어</span>
          <button
            type="button"
            style={styles.adjustmentAddBtn}
            data-testid="add-adjustment-layer"
            onClick={handleAddAdjustmentLayer}
            title="플레이헤드 위치에 조정 레이어 추가"
          >
            + 조정 레이어 추가
          </button>
        </div>
        <div
          style={{ ...styles.adjustmentLane, width: laneWidth }}
          onMouseDown={() => setSelectedAdjustmentLayerId(null)}
        >
          {adjustmentLayers.map((layer) => {
            const left = (layer.startMs / 1000) * pps
            const width = Math.max(
              8,
              ((layer.endMs - layer.startMs) / 1000) * pps
            )
            const selected = layer.id === selectedAdjustmentLayerId
            const neutral = isNeutralAdjustmentLayer(layer)
            return (
              <div
                key={layer.id}
                style={{
                  ...styles.adjustmentBlock,
                  ...(neutral ? styles.adjustmentBlockNeutral : null),
                  ...(selected ? styles.adjustmentBlockSelected : null),
                  left,
                  width
                }}
                data-testid={`adjustment-layer-${layer.id}`}
                data-adjustment-layer-id={layer.id}
                data-start-ms={layer.startMs}
                data-end-ms={layer.endMs}
                data-selected={selected ? 'true' : 'false'}
                data-neutral={neutral ? 'true' : 'false'}
                title={`조정 레이어 · ${(layer.startMs / 1000).toFixed(2)}s – ${(
                  layer.endMs / 1000
                ).toFixed(2)}s`}
                onMouseDown={(e) =>
                  onAdjustmentLayerMouseDown(e, layer, 'move')
                }
                onContextMenu={(e) => {
                  // pptx11 슬라이드 24 — 우클릭 시 일반 클립처럼 메뉴 띄움.
                  e.preventDefault()
                  e.stopPropagation()
                  setSelectedAdjustmentLayerId(layer.id)
                  setAdjCtx({ layerId: layer.id, x: e.clientX, y: e.clientY })
                }}
              >
                <div
                  style={{ ...styles.trimHandle, ...styles.trimHandleLeft }}
                  data-testid="adjustment-layer-trim-left"
                  onMouseDown={(e) =>
                    onAdjustmentLayerMouseDown(e, layer, 'left')
                  }
                />
                <span style={styles.adjustmentBlockLabel}>
                  {neutral ? '조정 (비활성)' : '조정'}
                </span>
                <div
                  style={{ ...styles.trimHandle, ...styles.trimHandleRight }}
                  data-testid="adjustment-layer-trim-right"
                  onMouseDown={(e) =>
                    onAdjustmentLayerMouseDown(e, layer, 'right')
                  }
                />
              </div>
            )
          })}
        </div>
      </div>
      <div style={styles.body} ref={bodyRef}>
        {marquee && (
          <div
            style={{
              ...styles.marquee,
              left: marquee.left,
              top: marquee.top,
              width: marquee.width,
              height: marquee.height
            }}
            data-testid="timeline-marquee-selection"
          />
        )}
        {project.tracks.map((track) => (
          <div
            key={track.id}
            style={styles.trackRow}
            data-testid={`track-row-${track.kind}`}
            data-track-id={track.id}
          >
            <div
              style={styles.trackHeader}
              data-testid={`track-header-${track.kind}`}
              data-track-id={track.id}
              data-track-muted={track.muted ? 'true' : 'false'}
              data-track-solo={track.solo ? 'true' : 'false'}
              data-track-role={track.role ?? ''}
              onContextMenu={(e) => handleTrackHeaderContext(e, track)}
              title="우클릭: 트랙 메뉴"
            >
              <div style={styles.trackHeaderRow}>
                <span style={styles.trackHeaderName}>{track.name}</span>
                {track.kind === 'video' && videoTrackCount > 1 && (
                  <button
                    type="button"
                    title="비디오 트랙 삭제"
                    style={styles.trackBtn}
                    data-testid="remove-video-track-btn"
                    data-track-id={track.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      removeVideoTrack(track.id)
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              {track.kind !== 'caption' && (
                <div style={styles.trackHeaderRow}>
                  <button
                    type="button"
                    title="음소거"
                    aria-pressed={Boolean(track.muted)}
                    style={{
                      ...styles.trackBtn,
                      ...(track.muted ? styles.trackBtnMuteActive : {})
                    }}
                    data-testid="track-mute-btn"
                    data-track-id={track.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      setTrackMuted(track.id, !track.muted)
                    }}
                  >
                    M
                  </button>
                  <button
                    type="button"
                    title="솔로"
                    aria-pressed={Boolean(track.solo)}
                    style={{
                      ...styles.trackBtn,
                      ...(track.solo ? styles.trackBtnSoloActive : {})
                    }}
                    data-testid="track-solo-btn"
                    data-track-id={track.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      setTrackSolo(track.id, !track.solo)
                    }}
                  >
                    S
                  </button>
                </div>
              )}
            </div>
            <div
              style={{
                ...styles.trackLane,
                ...(dropTargetTrackId === track.id ||
                crossTrackDropTargetId === track.id
                  ? styles.trackLaneDropActive
                  : {}),
                width: laneWidth
              }}
              onMouseDown={handleMarqueeMouseDown}
              onClick={(e) => handleLaneClick(e, track)}
              onContextMenu={(e) => {
                // Right-click on the empty lane background (not a clip — clips
                // stopPropagation in their own onContextMenu) opens the track
                // menu, same as right-clicking the track header.
                if (e.target !== e.currentTarget) return
                handleTrackHeaderContext(e, track)
              }}
              onDragOver={(e) => handleLaneDragOver(e, track)}
              onDragLeave={(e) => handleLaneDragLeave(e, track)}
              onDrop={(e) => handleLaneDrop(e, track)}
              data-testid={`track-lane-${track.kind}`}
              data-track-drop={track.kind}
              data-cross-track-drop-target={
                crossTrackDropTargetId === track.id ? 'true' : 'false'
              }
            >
              {/* pptx11 슬라이드 9 — 선택된 갭 highlight. selectedGap.trackId
                  가 이 track 이고 ms 범위가 유효할 때만 표시. */}
              {selectedGap && selectedGap.trackId === track.id && (
                <div
                  data-testid="selected-gap-highlight"
                  data-gap-track-id={selectedGap.trackId}
                  data-gap-start-ms={selectedGap.startMs}
                  data-gap-end-ms={selectedGap.endMs}
                  style={{
                    position: 'absolute',
                    top: 2,
                    bottom: 2,
                    left: (selectedGap.startMs / 1000) * pps,
                    width: Math.max(
                      2,
                      ((selectedGap.endMs - selectedGap.startMs) / 1000) * pps
                    ),
                    background: 'rgba(255,255,255,0.18)',
                    border: '1px solid rgba(255,255,255,0.55)',
                    borderRadius: 3,
                    pointerEvents: 'none',
                    zIndex: 2
                  }}
                  title={`빈 공간 · ${(selectedGap.startMs / 1000).toFixed(2)}s – ${(
                    selectedGap.endMs / 1000
                  ).toFixed(2)}s · DEL 키로 ripple 삭제`}
                />
              )}
              {track.clips.map((clip) => {
                const left = clipLeft(clip, pps)
                const w = clipWidth(clip, pps)
                const isCap = isCaptionClip(clip)
                const isOverlay = isOverlayClip(clip)
                // Phase 3.33 — a clip is visually selected when it is the
                // single active clip OR a member of the multi-select set, so
                // Ctrl+click multi-selection is visible on every member.
                const isSel =
                  clip.id === selectedClipId || selectedClipIds.has(clip.id)
                const label = isCap
                  ? getClipSourceText(clip) || '(빈 자막)'
                  : isOverlayClip(clip)
                    ? overlaySourceLabel(clip.source)
                    : isMediaClip(clip)
                      ? project.media[clip.mediaId]?.fileName || `clip ${clip.id.slice(-4)}`
                      : `clip ${clip.id.slice(-4)}`
                // Phase 3.10 — a curve clip shows a min→max speed RANGE; a
                // constant clip keeps the single-value label (only when != 1).
                let speedLabel = ''
                if (isMediaClip(clip)) {
                  if (hasSpeedCurve(clip)) {
                    const speeds = (clip.speedKeyframes ?? []).map(
                      (kf) => kf.speed
                    )
                    const lo = Math.min(...speeds)
                    const hi = Math.max(...speeds)
                    speedLabel = ` · ${lo.toFixed(1)}×→${hi.toFixed(1)}×`
                  } else if ((clip.speed ?? 1) !== 1) {
                    speedLabel = ` · ${(clip.speed ?? 1).toFixed(2)}×`
                  }
                }
                // Phase 2.5 — waveform bg for audio-bearing media clips.
                // Math: the PNG covers the full source media. We map a
                // [trimInMs..trimOutMs] window onto [0..w] pixels so trimmed
                // clips show the correct slice.
                let waveformBg: React.CSSProperties = {}
                if (isMediaClip(clip)) {
                  const media = project.media[clip.mediaId]
                  const uri = waveformUris[clip.mediaId]
                  if (media && uri && media.durationMs > 0) {
                    const srcSliceMs = Math.max(1, clip.trimOutMs - clip.trimInMs)
                    const fullWidthPx = w * (media.durationMs / srcSliceMs)
                    const offsetPx = -(w * (clip.trimInMs / srcSliceMs))
                    waveformBg = {
                      backgroundImage: `url(${uri})`,
                      backgroundRepeat: 'no-repeat',
                      backgroundSize: `${fullWidthPx}px 100%`,
                      backgroundPosition: `${offsetPx}px center`,
                      backgroundColor: '#0c1322'
                    }
                  }
                }
                const audioMuted =
                  isMediaClip(clip) && Boolean(clip.isMuted)
                return (
                  <div
                    key={clip.id}
                    style={{
                      ...styles.clip,
                      ...(isCap ? styles.captionClip : {}),
                      ...(isOverlay ? styles.overlayClip : {}),
                      ...waveformBg,
                      ...(isSel ? styles.clipSelected : {}),
                      ...(audioMuted ? { opacity: 0.5 } : {}),
                      left,
                      width: w
                    }}
                    title={label + speedLabel}
                    data-testid={
                      isCap
                        ? 'caption-clip-block'
                        : isOverlay
                          ? 'overlay-clip-block'
                          : 'media-clip-block'
                    }
                    data-clip-id={clip.id}
                    data-clip-kind={clip.kind}
                    data-selected={isSel ? 'true' : 'false'}
                    data-has-waveform={
                      isMediaClip(clip) &&
                      Boolean(waveformUris[clip.mediaId])
                        ? 'true'
                        : 'false'
                    }
                    data-muted={audioMuted ? 'true' : 'false'}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (toolMode === 'split') {
                        handleSplitToolClick(e, clip)
                        return
                      }
                      if (e.ctrlKey || e.metaKey) {
                        handleToggleSelect(clip.id)
                        return
                      }
                      handleSelect(clip.id)
                    }}
                    onContextMenu={(e) => handleContext(e, clip)}
                  >
                    {/* Phase 3.77 — color label accent strip. Sits at the
                        left edge above the trim handle but is pointer-events:none
                        so clicks pass through to the body / handle. */}
                    {clip.color && clip.color !== 'none' && (
                      <div
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: 4,
                          background:
                            CLIP_COLOR_HEX[clip.color] ?? 'transparent',
                          borderRadius: '4px 0 0 4px',
                          pointerEvents: 'none',
                          zIndex: 3
                        }}
                        data-testid="clip-color-strip"
                        data-clip-id={clip.id}
                        data-clip-color={clip.color}
                      />
                    )}
                    {isMediaClip(clip) && (
                      <div
                        style={{ ...styles.trimHandle, ...styles.trimHandleLeft }}
                        data-testid="trim-handle-left"
                        data-clip-id={clip.id}
                        onMouseDown={(e) =>
                          onTrimHandleMouseDown(e, clip, track, 'left')
                        }
                      />
                    )}
                    {/* Phase 3.84 — fade handles. Two small 8px markers
                        positioned at the current fade-in/out endpoint in px.
                        Drag horizontally to set fadeInMs / fadeOutMs in real
                        time. Media clips only (overlays / captions have no
                        audio fade). */}
                    {isMediaClip(clip) && (
                      <>
                        {(() => {
                          const fadeIn = clip.fadeInMs ?? 0
                          const fadeOut = clip.fadeOutMs ?? 0
                          const clipDur = Math.max(1, clip.endMs - clip.startMs)
                          const inPx = (fadeIn / clipDur) * w
                          const outPx = (fadeOut / clipDur) * w
                          const onFadeDown = (
                            e: React.MouseEvent<HTMLDivElement>,
                            side: 'in' | 'out'
                          ): void => {
                            e.stopPropagation()
                            e.preventDefault()
                            if (isClipLocked(clip)) return
                            const startX = e.clientX
                            const startFade = side === 'in' ? fadeIn : fadeOut
                            const maxFade = clipDur
                            const onMove = (ev: MouseEvent): void => {
                              const dx = ev.clientX - startX
                              const sign = side === 'in' ? 1 : -1
                              const deltaMs = (dx / pps) * 1000 * sign
                              const next = Math.max(
                                0,
                                Math.min(maxFade, Math.round(startFade + deltaMs))
                              )
                              if (side === 'in') {
                                setClipFade(clip.id, next, fadeOut)
                              } else {
                                setClipFade(clip.id, fadeIn, next)
                              }
                            }
                            const onUp = (): void => {
                              window.removeEventListener('mousemove', onMove)
                              window.removeEventListener('mouseup', onUp)
                            }
                            window.addEventListener('mousemove', onMove)
                            window.addEventListener('mouseup', onUp)
                          }
                          const handleStyle = (left: number): React.CSSProperties => ({
                            position: 'absolute',
                            top: 2,
                            left,
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: '#fde047',
                            border: '1px solid #161616',
                            cursor: 'ew-resize',
                            zIndex: 4
                          })
                          return (
                            <>
                              <div
                                style={handleStyle(HANDLE_PX + inPx - 4)}
                                onMouseDown={(e) => onFadeDown(e, 'in')}
                                data-testid="fade-handle-left"
                                data-clip-id={clip.id}
                                data-fade-ms={fadeIn}
                                title={`페이드 인: ${fadeIn}ms`}
                              />
                              <div
                                style={handleStyle(w - HANDLE_PX - outPx - 4)}
                                onMouseDown={(e) => onFadeDown(e, 'out')}
                                data-testid="fade-handle-right"
                                data-clip-id={clip.id}
                                data-fade-ms={fadeOut}
                                title={`페이드 아웃: ${fadeOut}ms`}
                              />
                            </>
                          )
                        })()}
                      </>
                    )}
                    <div
                      style={{
                        ...styles.clipBody,
                        left: isMediaClip(clip) ? HANDLE_PX : 0,
                        right: isMediaClip(clip) ? HANDLE_PX : 0,
                        cursor: isClipLocked(clip)
                          ? 'not-allowed'
                          : toolMode === 'split'
                            ? 'col-resize'
                            : 'grab',
                        // Phase 3.33 — grouped clips get a distinct outline.
                        ...(clip.groupId
                          ? { outline: '2px solid #a855f7', outlineOffset: -2 }
                          : {}),
                        // Phase 3.41 — locked clips de-saturate + dim.
                        ...(isClipLocked(clip)
                          ? { opacity: 0.7, filter: 'saturate(0.7)' }
                          : {})
                      }}
                      data-testid="clip-body"
                      data-clip-id={clip.id}
                      data-group-id={clip.groupId}
                      data-locked={isClipLocked(clip) ? 'true' : 'false'}
                      onMouseDown={(e) => {
                        // Split tool — clicking a clip splits it; never drags.
                        if (toolMode === 'split') {
                          e.stopPropagation()
                          return
                        }
                        onClipBodyMouseDown(e, clip, track)
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (toolMode === 'split') {
                          handleSplitToolClick(e, clip)
                          return
                        }
                        // Ctrl/Cmd+click toggles this clip in the multi-select
                        // set; a plain click stays single-select. This `onClick`
                        // only fires for a click WITHOUT a drag (a drag is
                        // handled entirely via mousemove in onClipBodyMouseDown),
                        // so toggle-select never collides with drag.
                        if (e.ctrlKey || e.metaKey) {
                          handleToggleSelect(clip.id)
                          return
                        }
                        handleSelect(clip.id)
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        if (toolMode === 'split') return
                        if (isCap) onEditCaption(clip.id)
                        else onOpenEffectsClip?.(clip.id)
                      }}
                    >
                      {label}
                      {speedLabel && (
                        <span style={{ opacity: 0.7 }}>{speedLabel}</span>
                      )}
                      {/* Phase 3.33 — link badge marks a grouped clip. */}
                      {clip.groupId && (
                        <span
                          data-testid="clip-group-badge"
                          title="그룹 클립"
                          style={{
                            marginLeft: 4,
                            fontSize: 10,
                            color: '#e9d5ff',
                            pointerEvents: 'none'
                          }}
                        >
                          🔗
                        </span>
                      )}
                      {/* Phase 3.41 — lock badge marks a locked clip. */}
                      {isClipLocked(clip) && (
                        <span
                          data-testid="clip-lock-badge"
                          title="잠금된 클립"
                          style={{ marginLeft: 4, fontSize: 10, color: '#fbbf24' }}
                        >
                          🔒
                        </span>
                      )}
                    </div>
                    {isMediaClip(clip) && (
                      <div
                        style={{
                          ...styles.trimHandle,
                          ...styles.trimHandleRight
                        }}
                        data-testid="trim-handle-right"
                        data-clip-id={clip.id}
                        onMouseDown={(e) =>
                          onTrimHandleMouseDown(e, clip, track, 'right')
                        }
                      />
                    )}
                    {/* Transition indicator (Phase 2.6) — shows when this clip
                        has a transitionIn defined. Positioned at the LEFT edge
                        because the transition borrows from both adjacent
                        clips' edges, but is "owned" by the incoming clip. */}
                    {isMediaClip(clip) && clip.transitionIn && clip.transitionIn.kind !== 'none' && (
                      <div
                        data-testid="transition-indicator"
                        data-clip-id={clip.id}
                        data-transition-kind={clip.transitionIn.kind}
                        style={{
                          position: 'absolute',
                          left: -10,
                          top: -8,
                          width: 18,
                          height: 18,
                          borderRadius: '50%',
                          background: '#10b981',
                          border: '2px solid #0a0a0a',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          color: '#04231a',
                          fontWeight: 700,
                          pointerEvents: 'none',
                          zIndex: 4
                        }}
                        title={`전환: ${clip.transitionIn.kind} (${clip.transitionIn.durationMs}ms)`}
                      >
                        ⇆
                      </div>
                    )}
                    {/* Filter preset indicator (Phase 2.6) — small tag if active. */}
                    {isMediaClip(clip) && clip.filterPreset && clip.filterPreset !== 'none' && (
                      <div
                        data-testid="filter-indicator"
                        data-clip-id={clip.id}
                        data-filter-preset={clip.filterPreset}
                        style={{
                          position: 'absolute',
                          right: 4,
                          top: 4,
                          padding: '1px 5px',
                          borderRadius: 3,
                          background: 'rgba(245, 158, 11, 0.85)',
                          color: '#1a1a1a',
                          fontSize: 9,
                          fontWeight: 700,
                          pointerEvents: 'none',
                          zIndex: 4
                        }}
                        title={`필터: ${clip.filterPreset}`}
                      >
                        FX
                      </div>
                    )}
                    {/* Transform indicator (Phase 3) — small tag when the
                        clip has a non-identity static transform. Phase 3.8 —
                        overlay clips also carry a transform. */}
                    {(isMediaClip(clip) || isOverlayClip(clip)) &&
                      clip.transform &&
                      !isIdentityTransform(getClipTransform(clip)) && (
                        <div
                          data-testid="transform-indicator"
                          data-clip-id={clip.id}
                          style={{
                            position: 'absolute',
                            right: 4,
                            bottom: 4,
                            padding: '1px 5px',
                            borderRadius: 3,
                            background: 'rgba(99, 102, 241, 0.9)',
                            color: '#f5f5f5',
                            fontSize: 9,
                            fontWeight: 700,
                            pointerEvents: 'none',
                            zIndex: 4
                          }}
                          title="변형 적용됨"
                        >
                          ⤢
                        </div>
                      )}
                    {/* Keyframe indicator (Phase 3.5) — badge distinct from
                        the Phase 3 transform-indicator when the clip has an
                        active (>= 2 keyframe) animation track. Phase 3.8 —
                        overlay clips share the keyframe infra. */}
                    {(isMediaClip(clip) || isOverlayClip(clip)) &&
                      hasTransformKeyframes(clip) && (
                      <div
                        data-testid="keyframe-indicator"
                        data-clip-id={clip.id}
                        style={{
                          position: 'absolute',
                          left: 4,
                          bottom: 4,
                          padding: '1px 5px',
                          borderRadius: 3,
                          background: 'rgba(165, 180, 252, 0.95)',
                          color: '#1a1a1a',
                          fontSize: 9,
                          fontWeight: 700,
                          pointerEvents: 'none',
                          zIndex: 4
                        }}
                        title="키프레임 애니메이션"
                      >
                        ◆
                      </div>
                    )}
                    {/* Crop indicator (Phase 3.6) — teal badge in the
                        TOP-LEFT corner so it never collides with the
                        transform badge (right/bottom) or the keyframe badge
                        (left/bottom). Shown when the clip has a non-identity
                        source crop. */}
                    {isMediaClip(clip) &&
                      getClipCropRect(clip) !== null && (
                        <div
                          data-testid="crop-indicator"
                          data-clip-id={clip.id}
                          style={{
                            position: 'absolute',
                            left: 4,
                            top: 4,
                            padding: '1px 5px',
                            borderRadius: 3,
                            background: 'rgba(20, 184, 166, 0.95)',
                            color: '#04231a',
                            fontSize: 9,
                            fontWeight: 700,
                            pointerEvents: 'none',
                            zIndex: 4
                          }}
                          title="크롭 적용됨"
                        >
                          ▢
                        </div>
                      )}
                    {/* Color-adjust indicator (Phase 3.7) — pink badge just
                        below the filter FX badge (top-right). Distinct
                        position so it never collides with the transform
                        (bottom-right), keyframe (bottom-left), crop
                        (top-left) or filter FX (top-right) badges. Shown when
                        the clip has a non-neutral manual color adjustment. */}
                    {isMediaClip(clip) &&
                      getClipColorAdjust(clip) !== null && (
                        <div
                          data-testid="coloradjust-indicator"
                          data-clip-id={clip.id}
                          style={{
                            position: 'absolute',
                            right: 4,
                            top: 22,
                            padding: '1px 5px',
                            borderRadius: 3,
                            background: 'rgba(236, 72, 153, 0.95)',
                            color: '#f5f5f5',
                            fontSize: 9,
                            fontWeight: 700,
                            pointerEvents: 'none',
                            zIndex: 4
                          }}
                          title="색보정 적용됨"
                        >
                          ◐
                        </div>
                      )}
                    {/* Freeze-frame bands (Phase 3.16) — one translucent
                        ice-blue band per freeze, marking the held-still
                        window on the clip. A freeze occupies a real timeline
                        window: its timeline-start = speedOnlyTimelineOffset
                        of the freeze's sourceMs PLUS the durations of all
                        earlier freezes; its width = the freeze's durationMs.
                        Both are scaled into clip pixels via the clip's full
                        timeline duration. */}
                    {isMediaClip(clip) &&
                      hasFreezeFrames(clip) &&
                      (() => {
                        const totalDur = Math.max(
                          1,
                          getClipTimelineDuration(clip)
                        )
                        let earlier = 0
                        return getClipFreezeFrames(clip).map((fz, fzIdx) => {
                          const startTimelineMs =
                            speedOnlyTimelineOffset(clip, fz.sourceMs) +
                            earlier
                          earlier += fz.durationMs
                          const bandLeft = (startTimelineMs / totalDur) * w
                          const bandWidth = (fz.durationMs / totalDur) * w
                          return (
                            <div
                              key={`freeze-${fzIdx}`}
                              data-testid="freeze-frame-band"
                              data-clip-id={clip.id}
                              data-freeze-index={fzIdx}
                              style={{
                                position: 'absolute',
                                left: bandLeft,
                                top: 0,
                                width: bandWidth,
                                height: '100%',
                                background: 'rgba(125, 211, 252, 0.28)',
                                borderLeft: '1px solid rgba(125, 211, 252, 0.9)',
                                borderRight:
                                  '1px solid rgba(125, 211, 252, 0.9)',
                                pointerEvents: 'none',
                                zIndex: 3
                              }}
                              title={`프리즈 프레임 ${fzIdx + 1} · ${(
                                fz.durationMs / 1000
                              ).toFixed(2)}s`}
                            />
                          )
                        })
                      })()}
                    {/* Speed-curve indicator (Phase 3.10) — amber badge in
                        the TOP-LEFT corner, just below the crop badge (top
                        22) so it never collides with the crop (top 4),
                        keyframe (bottom-left), transform (bottom-right),
                        filter FX (top-right) or color-adjust (top-right 22)
                        badges. Shown when the clip has an active speed
                        curve. */}
                    {isMediaClip(clip) && hasSpeedCurve(clip) && (
                      <div
                        data-testid="speed-curve-indicator"
                        data-clip-id={clip.id}
                        style={{
                          position: 'absolute',
                          left: 4,
                          top: 22,
                          padding: '1px 5px',
                          borderRadius: 3,
                          background: 'rgba(245, 158, 11, 0.95)',
                          color: '#1a1a1a',
                          fontSize: 9,
                          fontWeight: 700,
                          pointerEvents: 'none',
                          zIndex: 4
                        }}
                        title="속도 커브"
                      >
                        ⤳
                      </div>
                    )}
                    {/* Blur-region indicator (Phase 3.11) — purple badge in
                        the TOP-LEFT corner, just below the speed-curve badge
                        (top 40) so it never collides with the crop (top 4),
                        speed-curve (top 22), keyframe (bottom-left), transform
                        (bottom-right), filter FX (top-right) or color-adjust
                        (top-right 22) badges. Shown when the clip has one or
                        more mosaic/blur regions. */}
                    {isMediaClip(clip) &&
                      getClipBlurRegions(clip).length > 0 && (
                        <div
                          data-testid="blur-region-indicator"
                          data-clip-id={clip.id}
                          style={{
                            position: 'absolute',
                            left: 4,
                            top: 40,
                            padding: '1px 5px',
                            borderRadius: 3,
                            background: 'rgba(147, 51, 234, 0.95)',
                            color: '#f5f5f5',
                            fontSize: 9,
                            fontWeight: 700,
                            pointerEvents: 'none',
                            zIndex: 4
                          }}
                          title="모자이크/블러 적용됨"
                        >
                          ▦
                        </div>
                      )}
                    {/* Freeze-frame indicator (Phase 3.16) — ice-blue badge
                        in the TOP-LEFT corner, just below the blur-region
                        badge (top 58). Shown when the clip has one or more
                        freeze frames. Follows the speed-curve / blur badge
                        pattern. */}
                    {isMediaClip(clip) && hasFreezeFrames(clip) && (
                      <div
                        data-testid="freeze-frame-indicator"
                        data-clip-id={clip.id}
                        style={{
                          position: 'absolute',
                          left: 4,
                          top: 58,
                          padding: '1px 5px',
                          borderRadius: 3,
                          background: 'rgba(125, 211, 252, 0.95)',
                          color: '#0c1322',
                          fontSize: 9,
                          fontWeight: 700,
                          pointerEvents: 'none',
                          zIndex: 4
                        }}
                        title="프리즈 프레임 적용됨"
                      >
                        ❄
                      </div>
                    )}
                    {/* Reverse indicator (역재생) — sky badge in the
                        TOP-LEFT corner, just below the freeze-frame badge
                        (top 76). Shown when the clip plays backwards.
                        Follows the speed-curve / blur / freeze badge
                        pattern. */}
                    {isMediaClip(clip) && isClipReversed(clip) && (
                      <div
                        data-testid="reverse-indicator"
                        data-clip-id={clip.id}
                        style={{
                          position: 'absolute',
                          left: 4,
                          top: 76,
                          padding: '1px 5px',
                          borderRadius: 3,
                          background: 'rgba(56, 189, 248, 0.95)',
                          color: '#0c1322',
                          fontSize: 9,
                          fontWeight: 700,
                          pointerEvents: 'none',
                          zIndex: 4
                        }}
                        title="역재생"
                      >
                        ◀◀
                      </div>
                    )}
                    {/* Volume-envelope indicator (Phase 3.30) — green badge in
                        the TOP-LEFT corner, just below the reverse badge
                        (top 94). Shown when the clip has an active (>= 2
                        keyframe) volume envelope. Follows the speed-curve /
                        blur / freeze / reverse badge pattern. */}
                    {isMediaClip(clip) && hasVolumeEnvelope(clip) && (
                      <div
                        data-testid="volume-envelope-indicator"
                        data-clip-id={clip.id}
                        style={{
                          position: 'absolute',
                          left: 4,
                          top: 94,
                          padding: '1px 5px',
                          borderRadius: 3,
                          background: 'rgba(34, 197, 94, 0.95)',
                          color: '#0c1322',
                          fontSize: 9,
                          fontWeight: 700,
                          pointerEvents: 'none',
                          zIndex: 4
                        }}
                        title="볼륨 커브"
                      >
                        ♪
                      </div>
                    )}
                    {/* Keyframe marker row (Phase 3.5) — one diamond per
                        keyframe, positioned by clip-relative atMs. Click →
                        seek; horizontal drag → re-time; right/Alt-click →
                        remove. Phase 3.8 — overlay clips too. */}
                    {(isMediaClip(clip) || isOverlayClip(clip)) &&
                      hasTransformKeyframes(clip) && (
                      <div
                        style={styles.keyframeMarkerRow}
                        data-testid="keyframe-marker-row"
                        data-clip-id={clip.id}
                      >
                        {(clip.transformKeyframes ?? []).map((kf, kfIdx) => {
                          const clipDur = Math.max(1, getClipDuration(clip))
                          const markerLeft = (kf.atMs / clipDur) * w
                          return (
                            <div
                              key={kfIdx}
                              style={{
                                ...styles.keyframeMarker,
                                left: markerLeft
                              }}
                              data-testid="keyframe-marker"
                              data-clip-id={clip.id}
                              data-kf-index={kfIdx}
                              data-kf-ms={kf.atMs}
                              title={`키프레임 ${kfIdx + 1} · ${Math.round(
                                kf.atMs
                              )}ms`}
                              onMouseDown={(ev) =>
                                onKeyframeMarkerMouseDown(
                                  ev,
                                  clip,
                                  kfIdx,
                                  kf.atMs
                                )
                              }
                              onContextMenu={(ev) => {
                                ev.preventDefault()
                                ev.stopPropagation()
                                removeTransformKeyframe(clip.id, kfIdx)
                              }}
                            />
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
              <SmoothPlayhead pps={pps} />
            </div>
          </div>
        ))}
      </div>

      {/* pptx11 슬라이드 24 — adjustment layer 우클릭 메뉴. */}
      {adjCtx && (() => {
        const layer = adjustmentLayers.find((l) => l.id === adjCtx.layerId)
        if (!layer) return null
        return (
          <AdjustmentLayerContextMenu
            layer={layer}
            x={adjCtx.x}
            y={adjCtx.y}
            playheadMs={playheadMs}
            canPasteProperties={adjustmentPropertiesClipboardRef.current !== null}
            onAction={(key) => {
              if (key === 'toggle-lock') {
                setAdjustmentLayerLocked(layer.id, !(layer.locked ?? false))
              } else if (key === 'split') {
                splitAdjustmentLayerAt(layer.id, playheadMs)
              } else if (key === 'duplicate') {
                const newId = duplicateAdjustmentLayer(layer.id)
                if (newId) setSelectedAdjustmentLayerId(newId)
              } else if (key === 'copy-properties') {
                adjustmentPropertiesClipboardRef.current = {
                  colorAdjust: layer.colorAdjust
                    ? JSON.parse(JSON.stringify(layer.colorAdjust))
                    : undefined,
                  curves: layer.curves
                    ? JSON.parse(JSON.stringify(layer.curves))
                    : undefined,
                  hsl: layer.hsl ? JSON.parse(JSON.stringify(layer.hsl)) : undefined,
                  filterPreset: layer.filterPreset,
                  filterIntensity: layer.filterIntensity,
                  transform: layer.transform
                    ? JSON.parse(JSON.stringify(layer.transform))
                    : undefined,
                  mirrorX: layer.mirrorX,
                  mirrorY: layer.mirrorY,
                  fadeInMs: layer.fadeInMs,
                  fadeOutMs: layer.fadeOutMs
                }
              } else if (key === 'paste-properties') {
                const copied = adjustmentPropertiesClipboardRef.current
                if (copied) setAdjustmentLayerProperties(layer.id, copied)
              } else if (key === 'mirror-x') {
                toggleAdjustmentLayerMirror(layer.id, 'x')
              } else if (key === 'mirror-y') {
                toggleAdjustmentLayerMirror(layer.id, 'y')
              } else if (key === 'rotate-left') {
                const t = getAdjustmentLayerTransform(layer)
                setAdjustmentLayerTransform(layer.id, { rotation: t.rotation - 90 })
              } else if (key === 'rotate-right') {
                const t = getAdjustmentLayerTransform(layer)
                setAdjustmentLayerTransform(layer.id, { rotation: t.rotation + 90 })
              } else if (key === 'delete') {
                removeAdjustmentLayer(layer.id)
                setSelectedAdjustmentLayerId(null)
              }
            }}
            onClose={() => setAdjCtx(null)}
          />
        )
      })()}
      {ctx && ctxClip && (
        <ClipContextMenu
          clip={ctxClip}
          x={ctx.x}
          y={ctx.y}
          playheadMs={playheadMs}
          audioDetachable={audioDetachable}
          groupable={groupable}
          grouped={grouped}
          onAction={onMenuAction}
          onSpeedChange={
            isMediaClip(ctxClip)
              ? (s: number): void => {
                  for (const id of getContextTargetIds(ctxClip.id)) {
                    setClipSpeed(id, s)
                  }
                }
              : undefined
          }
          onTransitionChange={
            isMediaClip(ctxClip)
              ? (kind, durationMs): void => {
                  for (const id of getContextTargetIds(ctxClip.id)) {
                    setClipTransitionIn(id, kind, durationMs)
                  }
                }
              : undefined
          }
          onFilterChange={
            isMediaClip(ctxClip)
              ? (preset, intensity): void => {
                  for (const id of getContextTargetIds(ctxClip.id)) {
                    setClipFilter(id, preset, intensity)
                  }
                }
              : undefined
          }
          onTransformChange={
            isMediaClip(ctxClip) || isOverlayClip(ctxClip)
              ? (partial): void => {
                  const targets = getContextTargetIds(ctxClip.id)
                  if (targets.length > 1) {
                    for (const id of targets) setClipTransform(id, partial)
                    return
                  }
                  // Phase 3.5 redirect:
                  //  - active keyframe track + playhead ON a keyframe →
                  //    update that keyframe.
                  //  - active track but NOT on a keyframe → insert one at the
                  //    playhead carrying the partial change.
                  //  - no track → Phase 3 static transform (unchanged).
                  if (hasTransformKeyframes(ctxClip)) {
                    if (ctxKeyframeIndex >= 0) {
                      updateTransformKeyframe(ctxClip.id, ctxKeyframeIndex, {
                        transform: partial
                      })
                    } else {
                      addTransformKeyframe(
                        ctxClip.id,
                        playheadMs - ctxClip.startMs,
                        partial
                      )
                    }
                  } else {
                    setClipTransform(ctxClip.id, partial)
                  }
                }
              : undefined
          }
          onTransformReset={
            isMediaClip(ctxClip) || isOverlayClip(ctxClip)
              ? (): void => {
                  for (const id of getContextTargetIds(ctxClip.id)) {
                    resetClipTransform(id)
                  }
                }
              : undefined
          }
          onCropChange={
            isMediaClip(ctxClip)
              ? (partial): void => {
                  // Crop is STATIC — no keyframe redirect. Goes straight to
                  // the store action.
                  for (const id of getContextTargetIds(ctxClip.id)) {
                    setClipCrop(id, partial)
                  }
                }
              : undefined
          }
          onCropReset={
            isMediaClip(ctxClip)
              ? (): void => {
                  for (const id of getContextTargetIds(ctxClip.id)) {
                    resetClipCrop(id)
                  }
                }
              : undefined
          }
          sourceAspect={
            isMediaClip(ctxClip)
              ? ((): number | undefined => {
                  const m = project.media[ctxClip.mediaId]
                  if (m && m.width > 0 && m.height > 0) {
                    return m.width / m.height
                  }
                  return undefined
                })()
              : undefined
          }
          onColorAdjustChange={
            isMediaClip(ctxClip)
              ? (partial): void => {
                  // Color adjust is STATIC — no keyframe redirect. Goes
                  // straight to the store action.
                  for (const id of getContextTargetIds(ctxClip.id)) {
                    setClipColorAdjust(id, partial)
                  }
                }
              : undefined
          }
          onColorAdjustReset={
            isMediaClip(ctxClip)
              ? (): void => {
                  for (const id of getContextTargetIds(ctxClip.id)) {
                    resetClipColorAdjust(id)
                  }
                }
              : undefined
          }
          noiseReduction={
            isMediaClip(ctxClip) ? ctxClip.noiseReduction ?? 0 : undefined
          }
          onNoiseReductionChange={
            isMediaClip(ctxClip)
              ? (s): void => {
                  // Noise reduction is EXPORT-ONLY — straight to the store
                  // action; the preview audio graph is untouched.
                  for (const id of getContextTargetIds(ctxClip.id)) {
                    setClipNoiseReduction(id, s)
                  }
                }
              : undefined
          }
          voiceEnhance={
            isMediaClip(ctxClip)
              ? getVoiceEnhance(ctxClip) ?? undefined
              : undefined
          }
          onVoiceEnhanceChange={
            isMediaClip(ctxClip)
              ? (patch): void => {
                  // Voice enhance is EXPORT-ONLY — straight to the store
                  // action; the preview audio graph is untouched.
                  for (const id of getContextTargetIds(ctxClip.id)) {
                    setClipVoiceEnhance(id, patch)
                  }
                }
              : undefined
          }
          voiceChangerId={
            isMediaClip(ctxClip) ? getVoiceChanger(ctxClip) ?? undefined : undefined
          }
          onVoiceChangerChange={
            isMediaClip(ctxClip)
              ? (voiceId): void => {
                  for (const id of getContextTargetIds(ctxClip.id)) {
                    setClipVoiceChanger(id, voiceId)
                  }
                }
              : undefined
          }
          blurRegions={
            isMediaClip(ctxClip) ? getClipBlurRegions(ctxClip) : undefined
          }
          onAddBlurRegion={
            isMediaClip(ctxClip)
              ? (): void => {
                  // Mosaic/blur regions are STATIC — no keyframe redirect.
                  addBlurRegion(ctxClip.id)
                }
              : undefined
          }
          onUpdateBlurRegion={
            isMediaClip(ctxClip)
              ? (regionId, partial): void => {
                  updateBlurRegion(ctxClip.id, regionId, partial)
                }
              : undefined
          }
          onRemoveBlurRegion={
            isMediaClip(ctxClip)
              ? (regionId): void => {
                  removeBlurRegion(ctxClip.id, regionId)
                }
              : undefined
          }
          /* --- Phase 3.13 motion tracking --- */
          motionTracks={
            isMediaClip(ctxClip)
              ? getClipMotionTracks(ctxClip)
              : undefined
          }
          onStartMotionTrackDraw={
            isMediaClip(ctxClip)
              ? (): void => {
                  // Arm the preview box-draw overlay for this clip; the
                  // tracking job starts implicitly on box-draw mouse-up.
                  trackSetDrawMode(true, ctxClip.id)
                }
              : undefined
          }
          onCancelMotionTrack={(): void => {
            trackCancelJob()
          }}
          onRetrackMotionTrack={
            isMediaClip(ctxClip)
              ? (track): void => {
                  // Re-run tracking from the existing track's source rect.
                  trackBeginJob(ctxClip.id, track.sourceRect)
                }
              : undefined
          }
          onDeleteMotionTrack={
            isMediaClip(ctxClip)
              ? (trackId): void => {
                  removeMotionTrack(ctxClip.id, trackId)
                }
              : undefined
          }
          motionTrackJobStatus={trackJobStatus}
          motionTrackJobPercent={trackJobPercent}
          motionTrackJobActive={
            (trackJobStatus === 'preparing' ||
              trackJobStatus === 'tracking') &&
            trackJobClipId === ctxClip.id
          }
          onBindBlurRegionToTrack={
            isMediaClip(ctxClip)
              ? (regionId, trackId): void => {
                  bindBlurRegionToTrack(ctxClip.id, regionId, trackId)
                }
              : undefined
          }
          onBindOverlayToTrack={
            isOverlayClip(ctxClip)
              ? (trackId): void => {
                  bindOverlayToTrack(ctxClip.id, trackId)
                }
              : undefined
          }
          onBindCaptionToTrack={
            isCaptionClip(ctxClip)
              ? (trackId): void => {
                  bindCaptionToTrack(ctxClip.id, trackId)
                }
              : undefined
          }
          allMotionTracks={
            isOverlayClip(ctxClip) || isCaptionClip(ctxClip)
              ? project.tracks.flatMap((t) =>
                  t.clips.flatMap((c) =>
                    isMediaClip(c)
                      ? getClipMotionTracks(c).map((mt) => ({
                          id: mt.id,
                          name: mt.name
                        }))
                      : []
                  )
                )
              : undefined
          }
          boundMotionTrackId={
            isOverlayClip(ctxClip) || isCaptionClip(ctxClip)
              ? ctxClip.motionTrackId
              : undefined
          }
          onAddKeyframe={
            isMediaClip(ctxClip) || isOverlayClip(ctxClip)
              ? (): void => {
                  // "키프레임 추가/갱신" — addTransformKeyframe seeds a track
                  // (two keyframes) on the first call, or inserts/replaces
                  // one within the dedup window on subsequent calls.
                  addTransformKeyframe(
                    ctxClip.id,
                    playheadMs - ctxClip.startMs
                  )
                }
              : undefined
          }
          onRemoveKeyframeAtPlayhead={
            isMediaClip(ctxClip) || isOverlayClip(ctxClip)
              ? (): void => {
                  if (ctxKeyframeIndex >= 0) {
                    removeTransformKeyframe(ctxClip.id, ctxKeyframeIndex)
                  }
                }
              : undefined
          }
          keyframeCount={
            isMediaClip(ctxClip) || isOverlayClip(ctxClip)
              ? ctxClip.transformKeyframes?.length ?? 0
              : 0
          }
          isOnKeyframe={
            (isMediaClip(ctxClip) || isOverlayClip(ctxClip)) &&
            ctxKeyframeIndex >= 0
          }
          onAddSpeedKeyframe={
            isMediaClip(ctxClip)
              ? (): void => {
                  // "속도 키프레임 추가/갱신" — addSpeedKeyframe seeds the
                  // curve (two keyframes) on the first call, or inserts/
                  // replaces one within the dedup window on later calls.
                  // atMs is a SOURCE offset → map the playhead through the
                  // inverse integral.
                  const srcOff = sourceOffsetForTimelineOffset(
                    ctxClip,
                    playheadMs - ctxClip.startMs
                  )
                  addSpeedKeyframe(ctxClip.id, srcOff)
                }
              : undefined
          }
          onUpdateSpeedKeyframeAtPlayhead={
            isMediaClip(ctxClip)
              ? (s: number): void => {
                  if (ctxSpeedKeyframeIndex >= 0) {
                    updateSpeedKeyframe(ctxClip.id, ctxSpeedKeyframeIndex, {
                      speed: s
                    })
                  }
                }
              : undefined
          }
          onRemoveSpeedKeyframeAtPlayhead={
            isMediaClip(ctxClip)
              ? (): void => {
                  if (ctxSpeedKeyframeIndex >= 0) {
                    removeSpeedKeyframe(ctxClip.id, ctxSpeedKeyframeIndex)
                  }
                }
              : undefined
          }
          onClearSpeedCurve={
            isMediaClip(ctxClip)
              ? (): void => {
                  clearSpeedKeyframes(ctxClip.id)
                }
              : undefined
          }
          speedKeyframeCount={
            isMediaClip(ctxClip) ? ctxClip.speedKeyframes?.length ?? 0 : 0
          }
          isOnSpeedKeyframe={
            isMediaClip(ctxClip) && ctxSpeedKeyframeIndex >= 0
          }
          speedAtPlayhead={
            isMediaClip(ctxClip)
              ? hasSpeedCurve(ctxClip)
                ? getSpeedAt(
                    ctxClip,
                    sourceOffsetForTimelineOffset(
                      ctxClip,
                      playheadMs - ctxClip.startMs
                    )
                  )
                : ctxClip.speed ?? 1
              : 1
          }
          reversed={isMediaClip(ctxClip) && isClipReversed(ctxClip)}
          canReverse={isMediaClip(ctxClip) && canReverseClip(ctxClip)}
          reverseWarnLong={
            isMediaClip(ctxClip) &&
            ctxClip.trimOutMs - ctxClip.trimInMs > REVERSE_SOFT_CAP_MS
          }
          onToggleReverse={(r: boolean): void => {
            if (!isMediaClip(ctxClip)) return
            setClipReversed(ctxClip.id, r)
          }}
          onAddFreezeFrame={(): void => {
            // Phase 3.16 — insert a freeze at the playhead's SOURCE position.
            // A freeze's sourceMs is a source offset → map the playhead's
            // timeline offset through the freeze-aware inverse mapping
            // (mirrors onAddSpeedKeyframe). No-op for non-media clips.
            if (!isMediaClip(ctxClip)) return
            const srcOff = sourceOffsetForTimelineOffset(
              ctxClip,
              playheadMs - ctxClip.startMs
            )
            addFreezeFrame(ctxClip.id, srcOff)
          }}
          onUpdateFreezeFrameAtPlayhead={(durationMs: number): void => {
            if (!isMediaClip(ctxClip)) return
            if (ctxFreezeFrameIndex >= 0) {
              updateFreezeFrame(ctxClip.id, ctxFreezeFrameIndex, {
                durationMs
              })
            }
          }}
          onRemoveFreezeFrameAtPlayhead={(): void => {
            if (!isMediaClip(ctxClip)) return
            if (ctxFreezeFrameIndex >= 0) {
              removeFreezeFrame(ctxClip.id, ctxFreezeFrameIndex)
            }
          }}
          freezeFrameCount={
            isMediaClip(ctxClip) ? getClipFreezeFrames(ctxClip).length : 0
          }
          isOnFreezeFrame={
            isMediaClip(ctxClip) && ctxFreezeFrameIndex >= 0
          }
          freezeDurationAtPlayhead={
            isMediaClip(ctxClip) && ctxFreezeFrameIndex >= 0
              ? getClipFreezeFrames(ctxClip)[ctxFreezeFrameIndex]
                  ?.durationMs ?? DEFAULT_FREEZE_MS
              : DEFAULT_FREEZE_MS
          }
          onAddVolumeKeyframe={
            isMediaClip(ctxClip)
              ? (): void => {
                  // Phase 3.30 — volume keyframes are clip-relative TIMELINE
                  // ms (no source mapping), so pass the raw playhead offset.
                  // The first add seeds two keyframes; later adds insert one.
                  if (!isMediaClip(ctxClip)) return
                  addVolumeKeyframe(
                    ctxClip.id,
                    playheadMs - ctxClip.startMs
                  )
                }
              : undefined
          }
          onUpdateVolumeKeyframeAtPlayhead={
            isMediaClip(ctxClip)
              ? (gainDb: number): void => {
                  if (!isMediaClip(ctxClip)) return
                  if (ctxVolumeKeyframeIndex >= 0) {
                    updateVolumeKeyframe(
                      ctxClip.id,
                      ctxVolumeKeyframeIndex,
                      { gainDb }
                    )
                  }
                }
              : undefined
          }
          onRemoveVolumeKeyframeAtPlayhead={
            isMediaClip(ctxClip)
              ? (): void => {
                  if (!isMediaClip(ctxClip)) return
                  if (ctxVolumeKeyframeIndex >= 0) {
                    removeVolumeKeyframe(ctxClip.id, ctxVolumeKeyframeIndex)
                  }
                }
              : undefined
          }
          onClearVolumeEnvelope={
            isMediaClip(ctxClip)
              ? (): void => {
                  if (!isMediaClip(ctxClip)) return
                  clearVolumeKeyframes(ctxClip.id)
                }
              : undefined
          }
          volumeKeyframeCount={
            isMediaClip(ctxClip) ? ctxClip.volumeKeyframes?.length ?? 0 : 0
          }
          isOnVolumeKeyframe={
            isMediaClip(ctxClip) && ctxVolumeKeyframeIndex >= 0
          }
          volumeDbAtPlayhead={
            isMediaClip(ctxClip)
              ? getVolumeDbAt(ctxClip, playheadMs - ctxClip.startMs)
              : 0
          }
          onOverlayStyleChange={
            isOverlayClip(ctxClip) && ctxClip.source.type === 'shape'
              ? (partial): void => {
                  // Shape-style edit — merge into source.style and persist
                  // via updateOverlay. ctxClip narrowed to a shape overlay.
                  if (!isOverlayClip(ctxClip)) return
                  if (ctxClip.source.type !== 'shape') return
                  updateOverlay(ctxClip.id, {
                    source: {
                      type: 'shape',
                      style: { ...ctxClip.source.style, ...partial }
                    }
                  })
                }
              : undefined
          }
          onOverlayShadowChange={
            isOverlayClip(ctxClip)
              ? (shadow): void => {
                  // Phase 3.36 — set/clear the overlay drop shadow. null ⇒
                  // drop the field so the byte-identical no-shadow gate holds.
                  if (!isOverlayClip(ctxClip)) return
                  updateOverlay(ctxClip.id, { shadow: shadow ?? undefined })
                }
              : undefined
          }
          onClose={() => setCtx(null)}
        />
      )}

      {trackCtx && trackCtxTrack && (
        (() => {
          const t = trackCtxTrack
          const sameKind = project.tracks.filter((x) => x.kind === t.kind)
          const sameKindCount = sameKind.length
          // Per-kind cap → headroom for adding more.
          const cap =
            t.kind === 'video'
              ? MAX_VIDEO_TRACKS
              : t.kind === 'audio'
                ? MAX_AUDIO_TRACKS
                : Number.POSITIVE_INFINITY
          const addHeadroom = cap - sameKindCount
          // Delete guard: the last video track + the last caption track
          // cannot be removed (mirrors the store's removeTracks guard).
          const deleteDisabled =
            (t.kind === 'video' && sameKindCount <= 1) ||
            (t.kind === 'caption' && sameKindCount <= 1)
          // Bulk delete picks the N most-recently-positioned same-kind
          // tracks, skipping the survivor we must keep for video/caption.
          const pickBulkDeleteIds = (count: number): string[] => {
            const mustKeepOne = t.kind === 'video' || t.kind === 'caption'
            const deletable = mustKeepOne ? sameKind.slice(1) : sameKind
            // Remove from the end (newest) first.
            return deletable.slice(-count).map((x) => x.id)
          }
          return (
            <TrackContextMenu
              track={t}
              x={trackCtx.x}
              y={trackCtx.y}
              deleteDisabled={deleteDisabled}
              sameKindCount={sameKindCount}
              addHeadroom={addHeadroom}
              onRename={(name) => renameTrack(t.id, name)}
              onAddOne={() => {
                if (t.kind === 'audio') {
                  addTrack('audio', t.role ?? 'voice')
                } else {
                  addTrack(t.kind)
                }
              }}
              onAddSubmix={() => addAudioSubmixTrack()}
              onDeleteOne={() => removeTrack(t.id)}
              onAddMany={(count) => {
                if (t.kind === 'audio') {
                  addTracks('audio', count, t.role ?? 'voice')
                } else {
                  addTracks(t.kind, count)
                }
              }}
              onDeleteMany={(count) => {
                const ids = pickBulkDeleteIds(count)
                if (ids.length > 0) removeTracks(ids)
              }}
              onSetDucking={(target, db) =>
                setTrackDucking(t.id, target, db)
              }
              onMove={(direction) => {
                // pptx11 슬라이드 10 — 트랙 stack 이동. 'top'/'bottom' 은 끝
                // 인덱스로, 'up'/'down' 은 ±1. moveTrack 의 clamp 가 음수/오버
                // 한계는 알아서 처리.
                const idx = project.tracks.findIndex((tr) => tr.id === t.id)
                if (idx === -1) return
                const last = project.tracks.length - 1
                let newIdx = idx
                if (direction === 'top') newIdx = 0
                else if (direction === 'bottom') newIdx = last
                else if (direction === 'up') newIdx = Math.max(0, idx - 1)
                else if (direction === 'down') newIdx = Math.min(last, idx + 1)
                moveTrack(t.id, newIdx)
              }}
              trackIndex={project.tracks.findIndex((tr) => tr.id === t.id)}
              trackCount={project.tracks.length}
              onClose={() => setTrackCtx(null)}
            />
          )
        })()
      )}
    </div>
  )
}

/**
 * SmoothPlayhead — 60fps 부드러운 playhead.
 *
 * 이전엔 `style.left = (playheadMs/1000)*pps` 였는데, playheadMs가 zustand
 * state라 매 rAF tick(16ms)마다 Timeline 전체(~3500 LoC)가 리렌더 + React
 * reconciliation. 큰 프로젝트나 약한 디바이스에서 stutter 원인이었음.
 *
 * 우회: 이 컴포넌트만 useTimelineUi.subscribe로 store 직접 구독, 매 변경마다
 * DOM element의 `style.transform`만 갱신 (React reconciliation 안 거침).
 * transform은 GPU compositor에서 처리되어 left보다 부드럽고, will-change로
 * 브라우저에 미리 컴포지트 레이어 promotion 힌트.
 *
 * pps(zoom 레벨)는 prop으로 받음 — zoom 변경 시 parent rerender의 자연스러운
 * 영향을 받음(자주 안 바뀜). pps가 바뀌면 effect cleanup + 새 subscriber로
 * 다시 wire.
 */
function SmoothPlayhead({ pps }: { pps: number }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // The store has no subscribeWithSelector middleware, so the subscribe
    // callback fires on EVERY state change — guard with a local last-value
    // cache so unrelated updates (selection, zoom, etc.) don't recompute
    // the transform.
    let last = -1
    const apply = (ms: number): void => {
      if (ms === last) return
      last = ms
      const x = Math.max(0, (ms / 1000) * pps)
      el.style.transform = `translate3d(${x}px, 0, 0)`
    }
    apply(useTimelineUi.getState().playheadMs)
    return useTimelineUi.subscribe((s) => {
      apply(s.playheadMs)
    })
  }, [pps])
  return (
    <div
      ref={ref}
      data-testid="playhead"
      style={{
        ...styles.playhead,
        left: 0,
        willChange: 'transform'
      }}
    />
  )
}
