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

const TRACK_HEIGHT = 60
const RULER_HEIGHT = 28
const LANE_LABEL_WIDTH = 64
const SNAP_PX = 5
const MEDIA_MIME = 'application/x-reels-media-id'
const IMAGE_DEFAULT_MS = 5000

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
    padding: '4px 6px',
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

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------
export function Timeline(): JSX.Element {
  const project = useProjectStore((s) => s.project)
  const addClip = useProjectStore((s) => s.addClip)
  const updateClip = useProjectStore((s) => s.updateClip)
  const removeClip = useProjectStore((s) => s.removeClip)

  const pps = useTimelineUi((s) => s.pps)
  const setPps = useTimelineUi((s) => s.setPps)
  const playheadMs = useTimelineUi((s) => s.playheadMs)
  const setPlayheadMs = useTimelineUi((s) => s.setPlayheadMs)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const tracksRef = useRef<HTMLDivElement | null>(null)

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
      trimOutMs: 0
    }
    addClip(newClip)
  }

  // Clip drag-to-reposition.
  const onClipMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    clip: Clip,
    track: Track
  ): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startMouseX = e.clientX
    const origStartMs = clip.startMs
    const durationMs = clip.endMs - clip.startMs

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startMouseX
      const deltaMs = (dx / pps) * 1000
      const desired = origStartMs + deltaMs
      const altPressed = ev.altKey
      const snapped = snapMs(desired, pps, track, clip.id, altPressed)
      const freeStart = findFreeStart(track, snapped, durationMs, clip.id)
      if (freeStart !== clip.startMs) {
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

  const playheadPx = LANE_LABEL_WIDTH + (playheadMs / 1000) * pps

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
          Ctrl/Cmd + 휠로 확대·축소 · Alt 누르면 스냅 해제
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
                onDrop={(e) => handleLaneDrop(e, track)}
                onClipMouseDown={onClipMouseDown}
                onClipContextMenu={(e, clip) => {
                  e.preventDefault()
                  removeClip(clip.id)
                }}
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
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void
  onClipMouseDown: (
    e: React.MouseEvent<HTMLDivElement>,
    clip: Clip,
    track: Track
  ) => void
  onClipContextMenu: (e: React.MouseEvent<HTMLDivElement>, clip: Clip) => void
}

function TrackLane(props: TrackLaneProps): JSX.Element {
  const { track, pps, project, onDrop, onClipMouseDown, onClipContextMenu } =
    props
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
        data-testid={`track-drop-${track.kind}`}
      >
        {track.clips.map((clip) => {
          const media = project.media[clip.mediaId]
          const left = (clip.startMs / 1000) * pps
          const width = ((clip.endMs - clip.startMs) / 1000) * pps
          const style: React.CSSProperties = {
            ...styles.clip,
            ...(isVideo ? {} : styles.clipAudio),
            left,
            width: Math.max(8, width)
          }
          return (
            <div
              key={clip.id}
              style={style}
              data-testid="timeline-clip"
              data-clip-id={clip.id}
              onMouseDown={(e) => onClipMouseDown(e, clip, track)}
              onContextMenu={(e) => onClipContextMenu(e, clip)}
              title={`${media?.fileName ?? clip.mediaId} · ${(
                (clip.endMs - clip.startMs) /
                1000
              ).toFixed(2)}s`}
            >
              <div style={styles.clipLabel}>
                {media?.fileName ?? '미디어'}
                <span style={{ opacity: 0.7, marginLeft: 6 }}>
                  {((clip.endMs - clip.startMs) / 1000).toFixed(1)}s
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
