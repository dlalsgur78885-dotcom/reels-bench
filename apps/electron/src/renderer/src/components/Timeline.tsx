import { useState } from 'react'
import {
  getClipDuration,
  getClipSourceText,
  isCaptionClip,
  type Clip,
  type Project
} from '../../../shared/project'
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

const styles = {
  wrap: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    background: '#0f0f0f',
    color: '#cbd5e1',
    fontSize: 11,
    overflow: 'hidden'
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
    padding: '4px 6px',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    cursor: 'pointer'
  } as React.CSSProperties,
  clipSelected: {
    outline: '2px solid #10b981',
    outlineOffset: -2
  } as React.CSSProperties,
  captionClip: {
    background: 'linear-gradient(180deg, #4338ca, #312e81)',
    borderColor: '#6366f1'
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

function trackLabel(kind: string, name: string): string {
  return `${name}`
}

function clipLeft(clip: Clip): number {
  return (clip.startMs / 1000) * PX_PER_SECOND
}

function clipWidth(clip: Clip): number {
  return Math.max(8, (getClipDuration(clip) / 1000) * PX_PER_SECOND)
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

  const [ctx, setCtx] = useState<{
    clip: Clip
    x: number
    y: number
  } | null>(null)

  // Compute total length (max endMs across all clips, min 10s for ruler).
  const allClips = project.tracks.flatMap((t) => t.clips)
  const maxEnd = allClips.reduce((acc, c) => Math.max(acc, c.endMs), 10_000)
  const totalSeconds = Math.ceil(maxEnd / 1000) + 5
  const laneWidth = totalSeconds * PX_PER_SECOND

  const handleLaneClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const target = e.currentTarget
    const rect = target.getBoundingClientRect()
    const x = e.clientX - rect.left
    const ms = Math.max(0, Math.round((x / PX_PER_SECOND) * 1000))
    onSeek(ms)
    onSelectClip(null)
  }

  const handleContext = (e: React.MouseEvent, clip: Clip): void => {
    e.preventDefault()
    e.stopPropagation()
    onSelectClip(clip.id)
    setCtx({ clip, x: e.clientX, y: e.clientY })
  }

  const onMenuAction = (key: string): void => {
    if (!ctx) return
    const { clip } = ctx
    if (key === 'edit-caption' && isCaptionClip(clip)) {
      onEditCaption(clip.id)
    } else if (key === 'change-style' && isCaptionClip(clip)) {
      onEditCaption(clip.id)
    } else if (key === 'delete') {
      onDeleteClip(clip.id)
    }
    // Note: duplicate / split / speed are out of scope for Phase 2.4; the menu
    // entries exist for future phases. We close the menu either way.
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
            <div style={styles.trackHeader}>
              {trackLabel(track.kind, track.name)}
            </div>
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
                    title={label}
                    data-testid={isCap ? 'caption-clip-block' : 'media-clip-block'}
                    data-clip-id={clip.id}
                    data-clip-kind={clip.kind}
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectClip(clip.id)
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      if (isCap) onEditCaption(clip.id)
                    }}
                    onContextMenu={(e) => handleContext(e, clip)}
                  >
                    {label}
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

      {ctx && (
        <ClipContextMenu
          clip={ctx.clip}
          x={ctx.x}
          y={ctx.y}
          onAction={onMenuAction}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  )
}
