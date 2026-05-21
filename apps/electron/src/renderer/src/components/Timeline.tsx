import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ulid } from 'ulid'
import {
  getClipCropRect,
  getClipDuration,
  getClipSourceText,
  getClipTransform,
  hasTransformKeyframes,
  isCaptionClip,
  isIdentityTransform,
  isMediaClip,
  MAX_VIDEO_TRACKS,
  MIN_CLIP_MS,
  MIN_KEYFRAME_GAP_MS,
  type Clip,
  type MediaAsset,
  type Project,
  type Track,
  type VideoAudioClip
} from '../../../shared/project'
import { useProjectStore } from '../store/project'
import {
  BEAT_SNAP_TOLERANCE_MS,
  MAX_PPS,
  MIN_PPS,
  snapToNearestBeat,
  useTimelineUi
} from '../store/timelineUi'
import { ClipContextMenu } from './ClipContextMenu'
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
// Alt-drag disables snap.
// ---------------------------------------------------------------------------
function snapMs(
  desiredMs: number,
  pps: number,
  track: Track,
  ignoreClipId: string | null,
  altPressed: boolean,
  options?: { beats?: number[]; beatSnapEnabled?: boolean }
): number {
  if (altPressed) return Math.max(0, desiredMs)
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
  const addTransformKeyframe = useProjectStore((s) => s.addTransformKeyframe)
  const updateTransformKeyframe = useProjectStore(
    (s) => s.updateTransformKeyframe
  )
  const removeTransformKeyframe = useProjectStore(
    (s) => s.removeTransformKeyframe
  )
  const addVideoTrack = useProjectStore((s) => s.addVideoTrack)
  const removeVideoTrack = useProjectStore((s) => s.removeVideoTrack)
  const addClip = useProjectStore((s) => s.addClip)
  const updateCaption = useProjectStore((s) => s.updateCaption)
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

  const [ctx, setCtx] = useState<{ clipId: string; x: number; y: number } | null>(null)
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
    if (!ctxClip || !isMediaClip(ctxClip)) return -1
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

    // Auto-route: audio media goes on the audio track, video/image on the
    // video track. Caption tracks reject media drops outright.
    if (track.kind === 'caption') return
    let target: Track | undefined = track
    if (media.kind === 'audio' && track.kind !== 'audio') {
      target = project.tracks.find((t) => t.kind === 'audio')
    } else if (
      (media.kind === 'video' || media.kind === 'image') &&
      track.kind !== 'video'
    ) {
      target = project.tracks.find((t) => t.kind === 'video')
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
          beatSnapEnabled
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
          beatSnapEnabled
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
    clip: VideoAudioClip,
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
        beatSnapEnabled
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
      }
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div style={styles.wrap} data-testid="timeline">
      <div style={styles.toolbar}>
        <div>줌</div>
        <button
          style={styles.zoomBtn}
          onClick={() => setPps(pps / ZOOM_FACTOR)}
          aria-label="축소"
          data-testid="timeline-zoom-out"
        >
          −
        </button>
        <div
          style={{ minWidth: 56, textAlign: 'center' }}
          data-testid="timeline-zoom-level"
        >
          {Math.round(pps)} px/s
        </div>
        <button
          style={styles.zoomBtn}
          onClick={() => setPps(pps * ZOOM_FACTOR)}
          aria-label="확대"
          data-testid="timeline-zoom-in"
        >
          +
        </button>
        <button
          style={{
            ...styles.zoomBtn,
            marginLeft: 16,
            opacity: videoTrackCount >= MAX_VIDEO_TRACKS ? 0.4 : 1,
            cursor:
              videoTrackCount >= MAX_VIDEO_TRACKS ? 'not-allowed' : 'pointer'
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
          + 비디오 트랙
        </button>
        <div style={{ marginLeft: 16 }}>
          Ctrl/Cmd + 휠로 확대·축소 · Alt 누르면 스냅 해제
        </div>
      </div>
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
                const isSel = clip.id === selectedClipId
                const label = isCap
                  ? getClipSourceText(clip) || '(빈 자막)'
                  : `clip ${clip.id.slice(-4)}`
                const speedLabel =
                  isMediaClip(clip) && (clip.speed ?? 1) !== 1
                    ? ` · ${(clip.speed ?? 1).toFixed(2)}×`
                    : ''
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
                      ...waveformBg,
                      ...(isSel ? styles.clipSelected : {}),
                      ...(audioMuted ? { opacity: 0.5 } : {}),
                      left,
                      width: w
                    }}
                    title={label + speedLabel}
                    data-testid={
                      isCap ? 'caption-clip-block' : 'media-clip-block'
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
                        right: isMediaClip(clip) ? HANDLE_PX : 0
                      }}
                      data-testid="clip-body"
                      data-clip-id={clip.id}
                      onMouseDown={(e) => onClipBodyMouseDown(e, clip, track)}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleSelect(clip.id)
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
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
                        clip has a non-identity static transform. */}
                    {isMediaClip(clip) &&
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
                        active (>= 2 keyframe) animation track. */}
                    {isMediaClip(clip) && hasTransformKeyframes(clip) && (
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
                    {/* Keyframe marker row (Phase 3.5) — one diamond per
                        keyframe, positioned by clip-relative atMs. Click →
                        seek; horizontal drag → re-time; right/Alt-click →
                        remove. */}
                    {isMediaClip(clip) && hasTransformKeyframes(clip) && (
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
            isMediaClip(ctxClip)
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
            isMediaClip(ctxClip)
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
          onAddKeyframe={
            isMediaClip(ctxClip)
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
            isMediaClip(ctxClip)
              ? (): void => {
                  if (ctxKeyframeIndex >= 0) {
                    removeTransformKeyframe(ctxClip.id, ctxKeyframeIndex)
                  }
                }
              : undefined
          }
          keyframeCount={
            isMediaClip(ctxClip)
              ? ctxClip.transformKeyframes?.length ?? 0
              : 0
          }
          isOnKeyframe={isMediaClip(ctxClip) && ctxKeyframeIndex >= 0}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  )
}
