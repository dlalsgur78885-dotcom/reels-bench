import { useEffect, useRef, useState } from 'react'
import type { Clip } from '../../../shared/project'
import {
  isCaptionClip,
  isMediaClip,
  MAX_CLIP_SPEED,
  MIN_CLIP_SPEED
} from '../../../shared/project'

interface ClipContextMenuProps {
  clip: Clip
  x: number
  y: number
  /**
   * Current playhead (ms) — used to gate the "여기서 자르기" entry on media
   * clips. Optional so callers that don't know/care about gating still work.
   */
  playheadMs?: number
  onAction: (key: string) => void
  /**
   * Called when the user picks a new speed in the speed sub-panel.
   * Optional — only invoked for media clips.
   */
  onSpeedChange?: (speed: number) => void
  onClose: () => void
}

const styles = {
  wrap: {
    position: 'fixed' as const,
    minWidth: 200,
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: 4,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    zIndex: 9999,
    fontSize: 12,
    color: '#f5f5f5'
  } as React.CSSProperties,
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '6px 10px',
    cursor: 'pointer',
    borderRadius: 4,
    userSelect: 'none' as const
  } as React.CSSProperties,
  itemDisabled: {
    color: '#475569',
    cursor: 'not-allowed'
  } as React.CSSProperties,
  destructive: {
    color: '#fca5a5'
  } as React.CSSProperties,
  shortcut: {
    color: '#64748b',
    fontSize: 11
  } as React.CSSProperties,
  separator: {
    height: 1,
    background: '#2a2a2a',
    margin: '4px 0'
  } as React.CSSProperties,
  speedPanel: {
    padding: '8px 10px',
    borderTop: '1px solid #2a2a2a',
    background: '#0d0d0d'
  } as React.CSSProperties,
  presetRow: {
    display: 'flex',
    gap: 6,
    marginBottom: 8,
    flexWrap: 'wrap' as const
  } as React.CSSProperties,
  preset: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  presetActive: {
    background: '#10b981',
    border: '1px solid #10b981',
    color: '#04231a',
    fontWeight: 600
  } as React.CSSProperties,
  speedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8
  } as React.CSSProperties,
  slider: {
    flex: 1
  } as React.CSSProperties,
  speedInput: {
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: 11,
    width: 56,
    textAlign: 'right' as const
  } as React.CSSProperties
}

const SPEED_PRESETS = [0.5, 1, 1.5, 2]

interface MenuRow {
  key: string
  label: string
  shortcut?: string
  destructive?: boolean
  /** When false, row is rendered but click is suppressed. */
  enabled?: boolean
}

/** Build the row list for a media clip. */
function mediaRows(clip: Clip, playheadMs: number | undefined): MenuRow[] {
  // Strict-inside gate matches splitClipAt: must have ≥100ms on each side.
  const split = isMediaClip(clip) && playheadMs !== undefined
    ? playheadMs > clip.startMs + 100 && playheadMs < clip.endMs - 100
    : false
  return [
    {
      key: 'split',
      label: '여기서 자르기',
      shortcut: 'S',
      enabled: split
    },
    { key: 'duplicate', label: '복제', shortcut: 'Ctrl+D' },
    { key: 'delete', label: '삭제', shortcut: 'Delete', destructive: true }
  ]
}

function captionRows(): MenuRow[] {
  return [
    { key: 'edit-caption', label: '자막 편집' },
    { key: 'duplicate', label: '복제', shortcut: 'Ctrl+D' },
    { key: 'change-style', label: '스타일 변경' },
    { key: 'delete', label: '삭제', shortcut: 'Delete', destructive: true }
  ]
}

export function ClipContextMenu(props: ClipContextMenuProps): JSX.Element {
  const { clip, x, y, playheadMs, onAction, onSpeedChange, onClose } = props
  const ref = useRef<HTMLDivElement>(null)
  const [showSpeed, setShowSpeed] = useState(false)

  // Always recompute on each render so playhead/clip changes drive the gate.
  const rows = isCaptionClip(clip) ? captionRows() : mediaRows(clip, playheadMs)

  // Read current speed (default 1) from the media clip; captions don't have one.
  const speed = isMediaClip(clip) ? clip.speed ?? 1 : 1

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Clamp the menu so it stays inside the viewport.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1000
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const left = Math.min(x, Math.max(0, vw - 240))
  const top = Math.min(y, Math.max(0, vh - 280))

  return (
    <div
      ref={ref}
      style={{ ...styles.wrap, left, top }}
      role="menu"
      data-testid="clip-context-menu"
      data-clip-kind={clip.kind}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rows.map((it) => {
        const enabled = it.enabled !== false
        return (
          <div
            key={it.key}
            role="menuitem"
            data-testid={`menu-${it.key}`}
            aria-disabled={!enabled}
            style={{
              ...styles.item,
              ...(it.destructive ? styles.destructive : {}),
              ...(enabled ? {} : styles.itemDisabled)
            }}
            onMouseEnter={(e) => {
              if (!enabled) return
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => {
              if (!enabled) return
              onAction(it.key)
              onClose()
            }}
          >
            <span>{it.label}</span>
            {it.shortcut && <span style={styles.shortcut}>{it.shortcut}</span>}
          </div>
        )
      })}

      {/* Speed sub-menu is media-only. */}
      {isMediaClip(clip) && onSpeedChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-speed"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowSpeed((v) => !v)}
          >
            <span>속도{showSpeed ? '' : '…'}</span>
            <span style={styles.shortcut}>{speed.toFixed(2)}×</span>
          </div>
          {showSpeed && (
            <div style={styles.speedPanel} data-testid="menu-speed-panel">
              <div style={styles.presetRow}>
                {SPEED_PRESETS.map((p) => {
                  const active = Math.abs(speed - p) < 0.001
                  return (
                    <button
                      key={p}
                      type="button"
                      style={{
                        ...styles.preset,
                        ...(active ? styles.presetActive : {})
                      }}
                      data-testid={`menu-speed-preset-${p}`}
                      onClick={() => onSpeedChange(p)}
                    >
                      {p}×
                    </button>
                  )
                })}
              </div>
              <div style={styles.speedRow}>
                <input
                  type="range"
                  min={MIN_CLIP_SPEED}
                  max={MAX_CLIP_SPEED}
                  step={0.05}
                  value={speed}
                  onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
                  style={styles.slider}
                  data-testid="menu-speed-slider"
                  aria-label="속도"
                />
                <input
                  type="number"
                  min={MIN_CLIP_SPEED}
                  max={MAX_CLIP_SPEED}
                  step={0.1}
                  value={Number(speed.toFixed(2))}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onSpeedChange(v)
                  }}
                  style={styles.speedInput}
                  data-testid="menu-speed-input"
                  aria-label="속도 숫자"
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
