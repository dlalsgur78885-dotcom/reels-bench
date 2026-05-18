import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ulid } from 'ulid'
import type { Clip, MediaAsset, Track } from '../../../shared/project'
import {
  getTotalDurationMs,
  useProjectStore
} from '../store/project'
import {
  MAX_PPS,
  MIN_PPS,
  useTimelineUi
} from '../store/timelineUi'
import { ClipContextMenu } from './ClipContextMenu'

const TRACK_HEIGHT = 60
const RULER_HEIGHT = 28
const LANE_LABEL_WIDTH = 64
const SNAP_PX = 5
const MEDIA_MIME = 'application/x-reels-media-id'
const IMAGE_DEFAULT_MS = 5000
const MIN_CLIP_MS = 100
const HANDLE_PX = 6

function fmtTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

interface RulerTick {
  ms: number
  major: boolean // labeled
}

function buildTicks(totalMs: number, pps: number): RulerTick[] {
  // Choose major-label interval based on density.
  // Aim for one label every ~70px.
  const targetPx = 70
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300]
  let majorSec = 5
  for (const c of candidates) {
    if (c * pps >= targetPx) {
      majorSec = c
      break
    }
  }
  // Minor every 1s, until that's < 8px, then every 5s.
  let minorSec = 1
  if (pps < 8) minorSec = 5
  if (pps < 4) minorSec = 10

  const endSec = Math.ceil(Math.max(totalMs, 30_000) / 1000)
  const ticks: RulerTick[] = []
  for (let s = 0; s <= endSec; s += minorSec) {
    ticks.push({ ms: s * 1000, major: s % majorSec === 0 })
  }
  return ticks
}

// ---------------------------------------------------------------------------
// Helpers — overlap & snap.
// ---------------------------------------------------------------------------
function overlaps(a: Clip, startMs: number, endMs: number): boolean {
  return startMs < a.endMs && endMs > a.startMs
}

function findFreeStart(
  track: Track,
  desiredStart: number,
  durationMs: number,
  ignoreClipId?: string
): number {
  // Walk clips sorted by startMs. If desiredStart range collides, push to the
  // end of the colliding clip and retry.
  const sorted = [...track.clips]
    .filter((c) => c.id !== ignoreClipId)
    .sort((a, b) => a.startMs - b.startMs)
  let start = Math.max(0, desiredStart)
  // Try at most clips.length+1 iterations.
  for (let i = 0; i <= sorted.length; i++) {
    let collided = false
    for (const c of sorted) {
      if (overlaps(c, start, start + durationMs)) {
        start = c.endMs
        collided = true
        break
      }
    }
    if (!collided) return start
  }
  return start
}

function snapMs(
  desiredMs: number,
  pps: number,
  track: Track,
  ignoreClipId: string | null,
  altPressed: boolean
): number {
  if (altPressed) return Math.max(0, desiredMs)
  // 1) Snap to other clip edges within SNAP_PX.
  const snapMsTolerance = (SNAP_PX / pps) * 1000
  let best = desiredMs
  let bestDist = Infinity
  const edges: number[] = [0]
  for (const c of track.clips) {
    if (c.id === ignoreClipId) continue
    edges.push(c.startMs, c.endMs)
  }
  // Second-boundary candidate.
  edges.push(Math.round(desiredMs / 1000) * 1000)
  for (const e of edges) {
    const d = Math.abs(e - desiredMs)
    if (d < bestDist && d <= snapMsTolerance) {
      bestDist = d
      best = e
    }
  }
  return Math.max(0, best)
}

// ---------------------------------------------------------------------------
// Styles.
// ---------------------------------------------------------------------------
const styles = {
  wrap: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    background: '#0a0a0a',
    borderTop: '1px solid #2a2a2a',
    height: '100%',
    minHeight: 200,
    overflow: 'hidden',
    userSelect: 'none'
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
  scroll: {
    position: 'relative',
    flex: 1,
    overflowX: 'auto',
    overflowY: 'auto'
  } as React.CSSProperties,
  rulerArea: {
    position: 'relative',
    height: RULER_HEIGHT,
    background: '#0d0d0d',
    borderBottom: '1px solid #2a2a2a',
    cursor: 'pointer',
    flexShrink: 0
  } as React.CSSProperties,
  tickMinor: {
    position: 'absolute',
    top: 18,
    height: 6,
    width: 1,
    background: '#334155'
  } as React.CSSProperties,
  tickMajor: {
    position: 'absolute',
    top: 10,
    height: 14,
    width: 1,
    background: '#64748b'
  } as React.CSSProperties,
  tickLabel: {
    position: 'absolute',
    top: 2,
    fontSize: 10,
    color: '#9aa0a6',
    transform: 'translateX(2px)',
    pointerEvents: 'none'
  } as React.CSSProperties,
  laneRow: {
    position: 'relative',
    height: TRACK_HEIGHT,
    borderBottom: '1px solid #1e293b',
    background: '#0a0a0a'
  } as React.CSSProperties,
  laneLabel: {
    position: 'sticky',
    left: 0,
    top: 0,
    height: '100%',
    width: LANE_LABEL_WIDTH,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#111',
    borderRight: '1px solid #2a2a2a',
    fontSize: 11,
    color: '#9aa0a6',
    pointerEvents: 'none',
    zIndex: 2
  } as React.CSSProperties,
  laneInner: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: LANE_LABEL_WIDTH,
    right: 0
  } as React.CSSProperties,
  laneCanvas: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0
  } as React.CSSProperties,
  clip: {
    position: 'absolute',
    top: 6,
    bottom: 6,
    background:
      'linear-gradient(180deg, rgba(16,185,129,0.85), rgba(16,185,129,0.6))',
    border: '1px solid #10b981',
    borderRadius: 4,
    overflow: 'hidden',
    cursor: 'grab',
    color: '#04231a',
    fontSize: 11,
    fontWeight: 600,
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis'
  } as React.CSSProperties,
  clipAudio: {
    background:
      'linear-gradient(180deg, rgba(59,130,246,0.85), rgba(59,130,246,0.55))',
    border: '1px solid #3b82f6',
    color: '#0b1d3a'
  } as React.CSSProperties,
  clipSelected: {
    outline: '2px solid #60a5fa',
    outlineOffset: 0,
    boxShadow: '0 0 0 2px rgba(96,165,250,0.35)'
  } as React.CSSProperties,
  clipBody: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: HANDLE_PX,
    right: HANDLE_PX,
    cursor: 'grab',
    padding: '4px 6px',
    boxSizing: 'border-box',
    overflow: 'hidden'
  } as React.CSSProperties,
  trimHandle: {
    position: 'absolute',
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
  clipThumb: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: '100%',
    width: '100%',
    objectFit: 'cover',
    opacity: 0.45,
    pointerEvents: 'none'
  } as React.CSSProperties,
  clipLabel: {
    position: 'relative',
    zIndex: 1
  } as React.CSSProperties,
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    background: '#ef4444',
    pointerEvents: 'none',
    zIndex: 4
  } as React.CSSProperties,
  playheadHandle: {
    position: 'absolute',
    top: 0,
    width: 12,
    height: RULER_HEIGHT,
    transform: 'translateX(-5px)',
    background: '#ef4444',
    clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
    cursor: 'ew-resize',
    zIndex: 5
  } as React.CSSProperties,
  dropHighlight: {
    background: 'rgba(16, 185, 129, 0.08)'
  } as React.CSSProperties
}

interface ContextMenuState {
  clipId: string
  x: number
  y: number
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------
export function Timeline(): JSX.Element {
  const project = useProjectStore((s) => s.project)
  const addClip = useProjectStore((s) => s.addClip)
  const updateClip = useProjectStore((s) => s.updateClip)
  const removeClip = useProjectStore((s) => s.removeClip)
  const splitClipAt = useProjectStore((s) => s.splitClipAt)
  const duplicateClip = useProjectStore((s) => s.duplicateClip)
  const setClipSpeed = useProjectStore((s) => s.setClipSpeed)

  const pps = useTimelineUi((s) => s.pps)
  const setPps = useTimelineUi((s) => s.setPps)
  const playheadMs = useTimelineUi((s) => s.playheadMs)
  const setPlayheadMs = useTimelineUi((s) => s.setPlayheadMs)
  const selectedClipIds = useTimelineUi((s) => s.selectedClipIds)
  const selectClip = useTimelineUi((s) => s.selectClip)
  const clearSelection = useTimelineUi((s) => s.clearSelection)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const tracksRef = useRef<HTMLDivElement | null>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)

  const totalMs = useMemo(() => getTotalDurationMs(project), [project])
  const ticks = useMemo(() => buildTicks(totalMs, pps), [totalMs, pps])

  // Compute content width: max of "30 seconds" and totalMs + 10s tail.
  const contentWidthPx = useMemo(() => {
    const ms = Math.max(30_000, totalMs + 10_000)
    return Math.ceil((ms / 1000) * pps) + LANE_LABEL_WIDTH
  }, [totalMs, pps])

  // Ctrl/Cmd + wheel → zoom (centered on cursor when possible).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const direction = e.deltaY > 0 ? -1 : 1
      const factor = 1 + direction * 0.15
      const oldPps = useTimelineUi.getState().pps
      const newPps = Math.max(MIN_PPS, Math.min(MAX_PPS, oldPps * factor))
      if (newPps === oldPps) return

      // Maintain the time-under-cursor invariant where possible.
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left + el.scrollLeft
      const timeUnderCursor =
        Math.max(0, cursorX - LANE_LABEL_WIDTH) / oldPps // seconds
      setPps(newPps)
      requestAnimationFrame(() => {
        if (!scrollRef.current) return
        const newCursorX = timeUnderCursor * newPps + LANE_LABEL_WIDTH
        const targetScroll = newCursorX - (e.clientX - rect.left)
        scrollRef.current.scrollLeft = Math.max(0, targetScroll)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setPps])

  // Ruler click + playhead drag.
  const rulerRef = useRef<HTMLDivElement | null>(null)

  const xToMs = useCallback(
    (clientX: number, container: HTMLElement | null): number => {
      const root = container ?? scrollRef.current
      if (!root) return 0
      const rect = root.getBoundingClientRect()
      const x = clientX - rect.left + root.scrollLeft - LANE_LABEL_WIDTH
      const ms = Math.max(0, Math.round((x / pps) * 1000))
      return ms
    },
    [pps]
  )

  const onRulerMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const ms = xToMs(e.clientX, scrollRef.current)
    setPlayheadMs(ms)

    const onMove = (ev: MouseEvent): void => {
      setPlayheadMs(xToMs(ev.clientX, scrollRef.current))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Drop handler for a lane: drop a media card → create clip.
  const handleLaneDrop = (
    e: React.DragEvent<HTMLDivElement>,
    track: Track
  ): void => {
    e.preventDefault()
    e.stopPropagation()
    const mediaId = e.dataTransfer.getData(MEDIA_MIME)
    if (!mediaId) return
    const media: MediaAsset | undefined = project.media[mediaId]
    if (!media) return

    // Determine the correct track based on media kind.
    let targetTrack: Track | undefined = track
    if (media.kind === 'audio' && track.kind !== 'audio') {
      targetTrack = project.tracks.find((t) => t.kind === 'audio') ?? track
    }
    if ((media.kind === 'video' || media.kind === 'image') && track.kind !== 'video') {
      targetTrack = project.tracks.find((t) => t.kind === 'video') ?? track
    }
    if (!targetTrack) return

    const dropMs = xToMs(e.clientX, scrollRef.current)
    const durationMs = media.durationMs > 0 ? media.durationMs : IMAGE_DEFAULT_MS
    // Snap to nearest second by default.
    const altPressed = e.altKey
    const desiredStart = altPressed
      ? dropMs
      : Math.round(dropMs / 1000) * 1000
    const startMs = findFreeStart(targetTrack, desiredStart, durationMs)
    const newClip: Clip = {
      id: ulid(),
      mediaId,
      trackId: targetTrack.id,
      startMs,
      endMs: startMs + durationMs,
      trimInMs: 0,
      trimOutMs: durationMs,
      speed: 1
    }
    addClip(newClip)
  }

  // Clip drag-to-reposition (body — not the trim handles).
  const onClipBodyMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    clip: Clip,
    track: Track
  ): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    selectClip(clip.id)
    setCtxMenu(null)
    const startMouseX = e.clientX
    const origStartMs = clip.startMs
    const durationMs = clip.endMs - clip.startMs

    let moved = false
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startMouseX
      if (Math.abs(dx) < 2 && !moved) return
      moved = true
      const deltaMs = (dx / pps) * 1000
      const desired = origStartMs + deltaMs
      const altPressed = ev.altKey
      const liveTrack =
        useProjectStore
          .getState()
          .project.tracks.find((t) => t.id === track.id) ?? track
      const snapped = snapMs(desired, pps, liveTrack, clip.id, altPressed)
      const freeStart = findFreeStart(liveTrack, snapped, durationMs, clip.id)
      const current = liveTrack.clips.find((c) => c.id === clip.id)
      if (current && freeStart !== current.startMs) {
        updateClip(clip.id, {
          startMs: freeStart,
          endMs: freeStart + durationMs
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

  // Trim handles.
  const onTrimHandleMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    clip: Clip,
    track: Track,
    side: 'left' | 'right',
    media: MediaAsset | undefined
  ): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    selectClip(clip.id)
    setCtxMenu(null)
    const startMouseX = e.clientX
    const orig = { ...clip }
    const speed = orig.speed ?? 1
    const mediaDuration = media?.durationMs ?? Infinity

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startMouseX
      const deltaMs = (dx / pps) * 1000
      const liveTrack =
        useProjectStore
          .getState()
          .project.tracks.find((t) => t.id === track.id) ?? track

      if (side === 'left') {
        // Move startMs by deltaMs (snap), keep endMs fixed.
        let desiredStart = orig.startMs + deltaMs
        desiredStart = snapMs(desiredStart, pps, liveTrack, clip.id, ev.altKey)
        // Hard limit: at least MIN_CLIP_MS remaining width.
        if (desiredStart > orig.endMs - MIN_CLIP_MS) {
          desiredStart = orig.endMs - MIN_CLIP_MS
        }
        // Don't overlap a neighbour on the left.
        for (const other of liveTrack.clips) {
          if (other.id === clip.id) continue
          if (other.endMs <= orig.startMs && other.endMs > desiredStart) {
            desiredStart = other.endMs
          }
        }
        // trimInMs corresponds to source position; can't go below 0.
        const startShift = desiredStart - orig.startMs
        let newTrimIn = orig.trimInMs + startShift * speed
        if (newTrimIn < 0) {
          // Clamp so trimIn stays >= 0; back out startShift accordingly.
          const overshoot = -newTrimIn / speed
          desiredStart = desiredStart + overshoot
          newTrimIn = 0
        }
        if (desiredStart === orig.startMs) return
        updateClip(clip.id, {
          startMs: Math.round(desiredStart),
          trimInMs: Math.round(newTrimIn)
        })
      } else {
        // Right: keep startMs fixed, move endMs.
        let desiredEnd = orig.endMs + deltaMs
        desiredEnd = snapMs(desiredEnd, pps, liveTrack, clip.id, ev.altKey)
        // Hard limits: ≥ startMs + MIN_CLIP_MS.
        if (desiredEnd < orig.startMs + MIN_CLIP_MS) {
          desiredEnd = orig.startMs + MIN_CLIP_MS
        }
        // Don't overlap a neighbour on the right.
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
        if (desiredEnd === orig.endMs) return
        updateClip(clip.id, {
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

  const onClipContextMenu = (
    e: React.MouseEvent<HTMLDivElement>,
    clip: Clip
  ): void => {
    e.preventDefault()
    e.stopPropagation()
    selectClip(clip.id)
    setCtxMenu({ clipId: clip.id, x: e.clientX, y: e.clientY })
  }

  // Background-click → deselect + close menu.
  const onBackgroundMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    // Only deselect if user clicked the empty lane background, not a clip
    // (clips stop propagation).
    if (e.target === e.currentTarget) {
      clearSelection()
      setCtxMenu(null)
    }
  }

  const playheadPx = LANE_LABEL_WIDTH + (playheadMs / 1000) * pps

  // Look up the active context-menu clip (re-resolved on every render so
  // updates flow through).
  const ctxClip = useMemo(() => {
    if (!ctxMenu) return null
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => cc.id === ctxMenu.clipId)
      if (c) return c
    }
    return null
  }, [ctxMenu, project])

  const splitEnabled =
    ctxClip !== null &&
    playheadMs > ctxClip.startMs + 100 &&
    playheadMs < ctxClip.endMs - 100

  return (
    <div style={styles.wrap} data-testid="timeline">
      <div style={styles.toolbar}>
        <div>줌</div>
        <button
          style={styles.zoomBtn}
          onClick={() => setPps(pps / 1.25)}
          aria-label="축소"
        >
          −
        </button>
        <div style={{ minWidth: 56, textAlign: 'center' }}>
          {Math.round(pps)} px/s
        </div>
        <button
          style={styles.zoomBtn}
          onClick={() => setPps(pps * 1.25)}
          aria-label="확대"
        >
          +
        </button>
        <div style={{ marginLeft: 16 }}>
          Ctrl/Cmd + 휠로 확대·축소 · Alt 누르면 스냅 해제 · S=자르기 · Ctrl+D=복제
        </div>
      </div>

      <div style={styles.scroll} ref={scrollRef} data-testid="timeline-scroll">
        <div
          style={{
            position: 'relative',
            width: contentWidthPx,
            minWidth: '100%'
          }}
        >
          {/* Ruler */}
          <div
            style={styles.rulerArea}
            ref={rulerRef}
            onMouseDown={onRulerMouseDown}
            data-testid="timeline-ruler"
          >
            {/* lane-label spacer to keep ruler aligned with lanes */}
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: LANE_LABEL_WIDTH,
                background: '#111',
                borderRight: '1px solid #2a2a2a',
                pointerEvents: 'none',
                zIndex: 1
              }}
            />
            {ticks.map((t) => {
              const x = LANE_LABEL_WIDTH + (t.ms / 1000) * pps
              return (
                <div key={`tick-${t.ms}`}>
                  <div
                    style={{
                      ...(t.major ? styles.tickMajor : styles.tickMinor),
                      left: x
                    }}
                  />
                  {t.major && (
                    <div style={{ ...styles.tickLabel, left: x }}>
                      {fmtTime(t.ms)}
                    </div>
                  )}
                </div>
              )
            })}
            {/* Playhead handle in ruler */}
            <div
              style={{
                ...styles.playheadHandle,
                left: playheadPx
              }}
              data-testid="playhead-handle"
            />
          </div>

          {/* Tracks */}
          <div ref={tracksRef} data-testid="timeline-tracks">
            {project.tracks.map((track) => (
              <TrackLane
                key={track.id}
                track={track}
                pps={pps}
                project={project}
                selectedClipIds={selectedClipIds}
                onDrop={(e) => handleLaneDrop(e, track)}
                onClipBodyMouseDown={onClipBodyMouseDown}
                onTrimHandleMouseDown={onTrimHandleMouseDown}
                onClipContextMenu={onClipContextMenu}
                onBackgroundMouseDown={onBackgroundMouseDown}
              />
            ))}
          </div>

          {/* Playhead vertical line (spans tracks; sits inside scroll content
              so it stays aligned when scrolled horizontally). */}
          <div
            style={{
              ...styles.playhead,
              left: playheadPx,
              top: RULER_HEIGHT,
              bottom: 0
            }}
            data-testid="playhead-line"
          />
        </div>
      </div>

      {ctxMenu && ctxClip && (
        <ClipContextMenu
          clip={ctxClip}
          x={ctxMenu.x}
          y={ctxMenu.y}
          splitEnabled={splitEnabled}
          onSplit={() => {
            splitClipAt(ctxClip.id, useTimelineUi.getState().playheadMs)
            setCtxMenu(null)
          }}
          onDuplicate={() => {
            duplicateClip(ctxClip.id)
            setCtxMenu(null)
          }}
          onDelete={() => {
            removeClip(ctxClip.id)
            setCtxMenu(null)
          }}
          onSpeedChange={(s) => {
            setClipSpeed(ctxClip.id, s)
            // keep menu open during slider edits
          }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TrackLane.
// ---------------------------------------------------------------------------
interface TrackLaneProps {
  track: Track
  pps: number
  project: ReturnType<typeof useProjectStore.getState>['project']
  selectedClipIds: Set<string>
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void
  onClipBodyMouseDown: (
    e: React.MouseEvent<HTMLDivElement>,
    clip: Clip,
    track: Track
  ) => void
  onTrimHandleMouseDown: (
    e: React.MouseEvent<HTMLDivElement>,
    clip: Clip,
    track: Track,
    side: 'left' | 'right',
    media: MediaAsset | undefined
  ) => void
  onClipContextMenu: (e: React.MouseEvent<HTMLDivElement>, clip: Clip) => void
  onBackgroundMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
}

function TrackLane(props: TrackLaneProps): JSX.Element {
  const {
    track,
    pps,
    project,
    selectedClipIds,
    onDrop,
    onClipBodyMouseDown,
    onTrimHandleMouseDown,
    onClipContextMenu,
    onBackgroundMouseDown
  } = props
  const [over, setOver] = useState(false)

  const isVideo = track.kind === 'video'

  return (
    <div
      style={styles.laneRow}
      data-testid={`track-lane-${track.kind}`}
      data-track-id={track.id}
    >
      <div style={styles.laneLabel}>
        {track.kind === 'video'
          ? '비디오'
          : track.kind === 'audio'
            ? '오디오'
            : '자막'}
      </div>
      <div
        style={{
          ...styles.laneInner,
          ...(over ? styles.dropHighlight : {})
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(MEDIA_MIME)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            if (!over) setOver(true)
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false)
          onDrop(e)
        }}
        onMouseDown={onBackgroundMouseDown}
        data-testid={`track-drop-${track.kind}`}
      >
        {track.clips.map((clip) => {
          const media = project.media[clip.mediaId]
          const left = (clip.startMs / 1000) * pps
          const width = ((clip.endMs - clip.startMs) / 1000) * pps
          const selected = selectedClipIds.has(clip.id)
          const wrapStyle: React.CSSProperties = {
            ...styles.clip,
            ...(isVideo ? {} : styles.clipAudio),
            ...(selected ? styles.clipSelected : {}),
            left,
            width: Math.max(8, width)
          }
          const speed = clip.speed ?? 1
          return (
            <div
              key={clip.id}
              style={wrapStyle}
              data-testid="timeline-clip"
              data-clip-id={clip.id}
              data-selected={selected ? 'true' : 'false'}
              onContextMenu={(e) => onClipContextMenu(e, clip)}
              title={`${media?.fileName ?? clip.mediaId} · ${(
                (clip.endMs - clip.startMs) /
                1000
              ).toFixed(2)}s`}
            >
              <div
                style={{ ...styles.trimHandle, ...styles.trimHandleLeft }}
                data-testid="trim-handle-left"
                data-clip-id={clip.id}
                onMouseDown={(e) =>
                  onTrimHandleMouseDown(e, clip, track, 'left', media)
                }
              />
              <div
                style={styles.clipBody}
                data-testid="clip-body"
                data-clip-id={clip.id}
                onMouseDown={(e) => onClipBodyMouseDown(e, clip, track)}
              >
                <div style={styles.clipLabel}>
                  {media?.fileName ?? '미디어'}
                  <span style={{ opacity: 0.7, marginLeft: 6 }}>
                    {((clip.endMs - clip.startMs) / 1000).toFixed(1)}s
                    {speed !== 1 ? ` · ${speed.toFixed(2)}×` : ''}
                  </span>
                </div>
              </div>
              <div
                style={{ ...styles.trimHandle, ...styles.trimHandleRight }}
                data-testid="trim-handle-right"
                data-clip-id={clip.id}
                onMouseDown={(e) =>
                  onTrimHandleMouseDown(e, clip, track, 'right', media)
                }
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
