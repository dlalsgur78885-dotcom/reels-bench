import { useCallback, useMemo, useState } from 'react'
import {
  getClipDuration,
  getClipSourceText,
  isCaptionClip,
  isMediaClip,
  MIN_CLIP_MS,
  type Clip,
  type Project,
  type Track,
  type VideoAudioClip
} from '../../../shared/project'
import { useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import { ClipContextMenu } from './ClipContextMenu'

interface TimelineProps {
  project: Project
  playheadMs: number
  onSeek: (ms: number) => void
  selectedClipId: string | null
  onSelectClip: (clipId: string | null) => void
  onEditCaption: (clipId: string) => void
  onDeleteClip: (clipId: string) => void
}

const PX_PER_SECOND = 60 // 60px = 1 second @ default zoom
const HANDLE_PX = 6
const SNAP_PX = 5

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
  ruler: {
    height: 24,
    background: '#141414',
    borderBottom: '1px solid #2a2a2a',
    position: 'relative' as const,
    overflow: 'hidden'
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
    padding: '8px 10px',
    background: '#141414',
    borderRight: '1px solid #2a2a2a',
    fontSize: 11,
    color: '#9aa0a6'
  } as React.CSSProperties,
  trackLane: {
    flex: 1,
    position: 'relative' as const,
    background: '#0a0a0a'
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
    whiteSpace: 'nowrap' as const
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

function clipLeft(clip: Clip): number {
  return (clip.startMs / 1000) * PX_PER_SECOND
}

function clipWidth(clip: Clip): number {
  return Math.max(8, (getClipDuration(clip) / 1000) * PX_PER_SECOND)
}

// ---------------------------------------------------------------------------
// Snap: 1) second boundaries; 2) adjacent clip edges; within 5 px tolerance.
// Alt-drag disables snap.
// ---------------------------------------------------------------------------
function snapMs(
  desiredMs: number,
  pps: number,
  track: Track,
  ignoreClipId: string | null,
  altPressed: boolean
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
  // Mirror selection into the timelineUi store so keyboard shortcuts (Editor)
  // and tests can introspect via __TIMELINE_UI_FOR_TEST__.
  const selectClipInUi = useTimelineUi((s) => s.selectClip)

  const [ctx, setCtx] = useState<{
    clipId: string
    x: number
    y: number
  } | null>(null)

  // Compute total length (max endMs across all clips, min 10s for ruler).
  const allClips = project.tracks.flatMap((t) => t.clips)
  const maxEnd = allClips.reduce((acc, c) => Math.max(acc, c.endMs), 10_000)
  const totalSeconds = Math.ceil(maxEnd / 1000) + 5
  const laneWidth = totalSeconds * PX_PER_SECOND

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
    const ms = Math.max(0, Math.round((x / PX_PER_SECOND) * 1000))
    onSeek(ms)
    handleSelect(null)
  }

  const handleContext = (e: React.MouseEvent, clip: Clip): void => {
    e.preventDefault()
    e.stopPropagation()
    handleSelect(clip.id)
    setCtx({ clipId: clip.id, x: e.clientX, y: e.clientY })
  }

  // Resolve the menu's clip from the live project so playhead/speed changes
  // are reflected in real-time inside the menu.
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
    }
  }

  // -------------------------------------------------------------------------
  // Trim handle drag — media clips only.
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
    // Source media duration upper-bound for trimOut.
    const media = project.media[orig.mediaId]
    const mediaDuration = media?.durationMs ?? Number.POSITIVE_INFINITY

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startMouseX
      const deltaMs = (dx / PX_PER_SECOND) * 1000
      const liveTrack =
        useProjectStore
          .getState()
          .project.tracks.find((t) => t.id === track.id) ?? track

      if (side === 'left') {
        let desiredStart = orig.startMs + deltaMs
        desiredStart = snapMs(desiredStart, PX_PER_SECOND, liveTrack, clip.id, ev.altKey)
        // Right-edge constraint: keep at least MIN_CLIP_MS of clip remaining.
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
        desiredEnd = snapMs(desiredEnd, PX_PER_SECOND, liveTrack, clip.id, ev.altKey)
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

  return (
    <div style={styles.wrap} data-testid="timeline">
      <div style={styles.ruler}>
        <div style={{ position: 'absolute', left: 120, right: 0, height: '100%' }}>
          {Array.from({ length: totalSeconds + 1 }).map((_, s) => (
            <div
              key={s}
              style={{ ...styles.rulerTick, left: s * PX_PER_SECOND }}
            >
              {s}s
            </div>
          ))}
        </div>
      </div>
      <div style={styles.body}>
        {project.tracks.map((track) => (
          <div
            key={track.id}
            style={styles.trackRow}
            data-testid={`track-row-${track.kind}`}
            data-track-id={track.id}
          >
            <div style={styles.trackHeader}>{track.name}</div>
            <div
              style={{
                ...styles.trackLane,
                width: laneWidth
              }}
              onClick={handleLaneClick}
              data-testid={`track-lane-${track.kind}`}
            >
              {track.clips.map((clip) => {
                const left = clipLeft(clip)
                const w = clipWidth(clip)
                const isCap = isCaptionClip(clip)
                const isSel = clip.id === selectedClipId
                const label = isCap
                  ? getClipSourceText(clip) || '(빈 자막)'
                  : `clip ${clip.id.slice(-4)}`
                const speedLabel =
                  isMediaClip(clip) && (clip.speed ?? 1) !== 1
                    ? ` · ${(clip.speed ?? 1).toFixed(2)}×`
                    : ''
                return (
                  <div
                    key={clip.id}
                    style={{
                      ...styles.clip,
                      ...(isCap ? styles.captionClip : {}),
                      ...(isSel ? styles.clipSelected : {}),
                      left,
                      width: w
                    }}
                    title={label + speedLabel}
                    data-testid={isCap ? 'caption-clip-block' : 'media-clip-block'}
                    data-clip-id={clip.id}
                    data-clip-kind={clip.kind}
                    data-selected={isSel ? 'true' : 'false'}
                    onContextMenu={(e) => handleContext(e, clip)}
                  >
                    {/* Trim handles — media-only. Render BEFORE body so the
                        body can sit between them via left/right padding. */}
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
                        style={{ ...styles.trimHandle, ...styles.trimHandleRight }}
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
              {/* Playhead — render once per lane so it cuts through every track. */}
              <div
                style={{
                  ...styles.playhead,
                  left: (playheadMs / 1000) * PX_PER_SECOND
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
