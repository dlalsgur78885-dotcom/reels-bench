import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ulid } from 'ulid'
import {
  getClipDuration,
  getClipSourceText,
  isCaptionClip,
  isMediaClip,
  MIN_CLIP_MS,
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
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  )
}
