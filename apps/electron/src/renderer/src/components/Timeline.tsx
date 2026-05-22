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
  getSpeedAt,
  hasSpeedCurve,
  hasTransformKeyframes,
  isCaptionClip,
  isIdentityTransform,
  isMediaClip,
  isOverlayClip,
  MAX_AUDIO_TRACKS,
  MAX_VIDEO_TRACKS,
  MIN_CLIP_MS,
  MIN_KEYFRAME_GAP_MS,
  MIN_SPEED_KEYFRAME_GAP_MS,
  sourceOffsetForTimelineOffset,
  type Clip,
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
import { ClipContextMenu } from './ClipContextMenu'
import { TrackContextMenu } from './TrackContextMenu'
import { MEDIA_DRAG_MIME } from './MediaLibrary'

interface TimelineProps {
  project: Project
  playheadMs: number
  onSeek: (ms: number) => void
  selectedClipId: string | null
  onSelectClip: (clipId: string | null) => void
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
  options?: { beats?: number[]; beatSnapEnabled?: boolean; snapEnabled?: boolean }
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
    onEditCaption,
    onDeleteClip
  } = props

  const updateMediaClipTrim = useProjectStore((s) => s.updateMediaClipTrim)
  const splitClipAt = useProjectStore((s) => s.splitClipAt)
  const duplicateClip = useProjectStore((s) => s.duplicateClip)
  const setClipSpeed = useProjectStore((s) => s.setClipSpeed)
  const setClipTransitionIn = useProjectStore((s) => s.setClipTransitionIn)
  const setClipFilter = useProjectStore((s) => s.setClipFilter)
  const setClipTransform = useProjectStore((s) => s.setClipTransform)
  const resetClipTransform = useProjectStore((s) => s.resetClipTransform)
  const setClipCrop = useProjectStore((s) => s.setClipCrop)
  const resetClipCrop = useProjectStore((s) => s.resetClipCrop)
  const setClipColorAdjust = useProjectStore((s) => s.setClipColorAdjust)
  const resetClipColorAdjust = useProjectStore((s) => s.resetClipColorAdjust)
  const setClipNoiseReduction = useProjectStore((s) => s.setClipNoiseReduction)
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

  // Mirror selection into the timelineUi store so keyboard shortcuts (Editor)
  // and tests can introspect via __TIMELINE_UI_FOR_TEST__.
  const selectClipInUi = useTimelineUi((s) => s.selectClip)
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
  const { undo, redo, canUndo, canRedo } = useUndoRedo()

  // Voice-recording session handle (Phase 5). Non-null while recording.
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordError, setRecordError] = useState<string | null>(null)
  // Elapsed seconds while recording — drives the toolbar timer label.
  const [recordElapsed, setRecordElapsed] = useState(0)

  const [ctx, setCtx] = useState<{ clipId: string; x: number; y: number } | null>(null)
  // Phase 3 — track header context menu (slide 11).
  const [trackCtx, setTrackCtx] = useState<{
    trackId: string
    x: number
    y: number
  } | null>(null)
  const [dropTargetTrackId, setDropTargetTrackId] = useState<string | null>(null)

  // Compute total length (max endMs across all clips, min 10s for ruler).
  const allClips = project.tracks.flatMap((t) => t.clips)
  const maxEnd = allClips.reduce((acc, c) => Math.max(acc, c.endMs), 10_000)
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

  const handleLaneClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return
    const target = e.currentTarget
    const rect = target.getBoundingClientRect()
    const x = e.clientX - rect.left
    const ms = Math.max(0, Math.round((x / pps) * 1000))
    onSeek(ms)
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
    handleSelect(clip.id)
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

  const onMenuAction = (key: string): void => {
    if (!ctxClip) return
    const clip = ctxClip
    if (key === 'edit-caption' && isCaptionClip(clip)) {
      onEditCaption(clip.id)
    } else if (key === 'change-style' && isCaptionClip(clip)) {
      onEditCaption(clip.id)
    } else if (key === 'delete') {
      onDeleteClip(clip.id)
    } else if (key === 'duplicate') {
      const newId = duplicateClip(clip.id)
      if (newId) handleSelect(newId)
    } else if (key === 'split' && isMediaClip(clip)) {
      splitClipAt(clip.id, playheadMs)
    } else if (key === 'remove-silence' && isMediaClip(clip)) {
      props.onOpenSilenceDialog?.(clip.id)
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
    if (!e.dataTransfer.types.includes(MEDIA_DRAG_MIME)) return
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
    const mediaId = e.dataTransfer.getData(MEDIA_DRAG_MIME)
    if (!mediaId) return
    const media: MediaAsset | undefined = project.media[mediaId]
    if (!media) return

    // Auto-route by MEDIA kind (not by which lane the cursor happened to be
    // over): audio → an audio track, video/image → a video track. This is the
    // slide-10 fix — an audio clip must never land on a video track.
    //   - audio  → drop lane if it is an audio track, else any audio track,
    //              else a freshly-created Voice track (ensureAudioTrack).
    //   - video  → drop lane if it is a video track, else the first video track.
    //   - image  → same as video.
    let target: Track | undefined
    if (media.kind === 'audio') {
      if (track.kind === 'audio') {
        target = track
      } else {
        const audioTrackId = ensureAudioTrack('voice')
        target = useProjectStore
          .getState()
          .project.tracks.find((t) => t.id === audioTrackId)
      }
    } else {
      // video / image → a video track.
      target =
        track.kind === 'video'
          ? track
          : project.tracks.find((t) => t.kind === 'video')
    }
    if (!target) return

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const dropMs = Math.max(0, Math.round((x / pps) * 1000))
    const durationMs =
      media.durationMs > 0 ? media.durationMs : IMAGE_DEFAULT_MS
    // Snap to nearest second unless Alt is held.
    const desired = e.altKey ? dropMs : Math.round(dropMs / 1000) * 1000
    const startMs = findFreeStart(target, desired, durationMs)
    const clip: VideoAudioClip = {
      id: ulid(),
      kind: 'media',
      mediaId,
      trackId: target.id,
      startMs,
      endMs: startMs + durationMs,
      trimInMs: 0,
      trimOutMs: media.durationMs > 0 ? media.durationMs : durationMs,
      speed: 1
    }
    addClip(clip)
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
      const liveTrack =
        useProjectStore
          .getState()
          .project.tracks.find((t) => t.id === track.id) ?? track

      if (side === 'left') {
        let desiredStart = orig.startMs + deltaMs
        desiredStart = snapMs(desiredStart, pps, liveTrack, clip.id, ev.altKey, {
          beats,
          beatSnapEnabled,
          snapEnabled
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
          snapEnabled
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
        handleSelect(clip.id)
      }
      const deltaMs = (dx / pps) * 1000
      let desired = origStart + deltaMs
      const liveTrack =
        useProjectStore
          .getState()
          .project.tracks.find((t) => t.id === track.id) ?? track
      desired = snapMs(desired, pps, liveTrack, clip.id, ev.altKey, {
        beats,
        beatSnapEnabled,
        snapEnabled
      })
      desired = clampNoOverlap(liveTrack, desired, duration, clip.id)
      desired = Math.max(0, Math.round(desired))
      if (desired === clip.startMs) return

      const newStart = desired
      const newEnd = newStart + duration
      if (isMediaClip(clip)) {
        // Reuse updateMediaClipTrim for media clips so we get the same
        // invariant clamping logic.
        updateMediaClipTrim(clip.id, { startMs: newStart, endMs: newEnd })
      } else if (isCaptionClip(clip)) {
        updateCaption(clip.id, { startMs: newStart, endMs: newEnd })
      } else if (isOverlayClip(clip)) {
        // Overlay clips reposition by body-drag too (no trim handles).
        updateOverlay(clip.id, { startMs: newStart, endMs: newEnd })
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
    return splitClipAt(clip.id, playheadMs) ?? null
  }, [findSelectedClip, splitClipAt, playheadMs])

  /** Delete the selected clip (any kind). */
  const handleDeleteSelected = useCallback((): void => {
    const clip = findSelectedClip()
    if (!clip) return
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
    selectedClipForToolbar !== null && isMediaClip(selectedClipForToolbar)
  const canDelete = selectedClipForToolbar !== null

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
        </div>
      </div>
      <div style={styles.body} ref={bodyRef}>
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
                ...(dropTargetTrackId === track.id
                  ? styles.trackLaneDropActive
                  : {}),
                width: laneWidth
              }}
              onClick={handleLaneClick}
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
            >
              {track.clips.map((clip) => {
                const left = clipLeft(clip, pps)
                const w = clipWidth(clip, pps)
                const isCap = isCaptionClip(clip)
                const isOverlay = isOverlayClip(clip)
                const isSel = clip.id === selectedClipId
                const label = isCap
                  ? getClipSourceText(clip) || '(빈 자막)'
                  : isOverlayClip(clip)
                    ? overlaySourceLabel(clip.source)
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
                    onContextMenu={(e) => handleContext(e, clip)}
                  >
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
                    <div
                      style={{
                        ...styles.clipBody,
                        left: isMediaClip(clip) ? HANDLE_PX : 0,
                        right: isMediaClip(clip) ? HANDLE_PX : 0,
                        cursor: toolMode === 'split' ? 'col-resize' : 'grab'
                      }}
                      data-testid="clip-body"
                      data-clip-id={clip.id}
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
                        handleSelect(clip.id)
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        if (toolMode === 'split') return
                        if (isCap) onEditCaption(clip.id)
                      }}
                    >
                      {label}
                      {speedLabel && (
                        <span style={{ opacity: 0.7 }}>{speedLabel}</span>
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
              <div
                style={{
                  ...styles.playhead,
                  left: (playheadMs / 1000) * pps
                }}
                data-testid="playhead"
              />
            </div>
          </div>
        ))}
      </div>

      {ctx && ctxClip && (
        <ClipContextMenu
          clip={ctxClip}
          x={ctx.x}
          y={ctx.y}
          playheadMs={playheadMs}
          onAction={onMenuAction}
          onSpeedChange={
            isMediaClip(ctxClip)
              ? (s: number): void => {
                  setClipSpeed(ctxClip.id, s)
                }
              : undefined
          }
          onTransitionChange={
            isMediaClip(ctxClip)
              ? (kind, durationMs): void => {
                  setClipTransitionIn(ctxClip.id, kind, durationMs)
                }
              : undefined
          }
          onFilterChange={
            isMediaClip(ctxClip)
              ? (preset, intensity): void => {
                  setClipFilter(ctxClip.id, preset, intensity)
                }
              : undefined
          }
          onTransformChange={
            isMediaClip(ctxClip) || isOverlayClip(ctxClip)
              ? (partial): void => {
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
                  resetClipTransform(ctxClip.id)
                }
              : undefined
          }
          onCropChange={
            isMediaClip(ctxClip)
              ? (partial): void => {
                  // Crop is STATIC — no keyframe redirect. Goes straight to
                  // the store action.
                  setClipCrop(ctxClip.id, partial)
                }
              : undefined
          }
          onCropReset={
            isMediaClip(ctxClip)
              ? (): void => {
                  resetClipCrop(ctxClip.id)
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
                  setClipColorAdjust(ctxClip.id, partial)
                }
              : undefined
          }
          onColorAdjustReset={
            isMediaClip(ctxClip)
              ? (): void => {
                  resetClipColorAdjust(ctxClip.id)
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
                  setClipNoiseReduction(ctxClip.id, s)
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
              onClose={() => setTrackCtx(null)}
            />
          )
        })()
      )}
    </div>
  )
}
