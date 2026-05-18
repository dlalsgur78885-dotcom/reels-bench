import { useEffect, useRef, useState } from 'react'
import type { Clip } from '../../../shared/project'
import {
  MIN_CLIP_SPEED,
  MAX_CLIP_SPEED
} from '../../../shared/project'

interface ClipContextMenuProps {
  clip: Clip
  /** Absolute screen coords (clientX/clientY) where the menu should open. */
  x: number
  y: number
  /** True when the playhead is currently inside this clip (gate for split). */
  splitEnabled: boolean
  onSplit(): void
  onDuplicate(): void
  onDelete(): void
  onSpeedChange(speed: number): void
  onClose(): void
}

const styles = {
  menu: {
    position: 'fixed',
    minWidth: 200,
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
    padding: '4px 0',
    color: '#f5f5f5',
    fontSize: 12,
    zIndex: 100
  } as React.CSSProperties,
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 14px',
    cursor: 'pointer',
    userSelect: 'none'
  } as React.CSSProperties,
  itemDisabled: {
    color: '#475569',
    cursor: 'not-allowed'
  } as React.CSSProperties,
  shortcut: {
    color: '#64748b',
    fontSize: 11,
    marginLeft: 16
  } as React.CSSProperties,
  separator: {
    height: 1,
    background: '#2a2a2a',
    margin: '4px 0'
  } as React.CSSProperties,
  speedPanel: {
    padding: '8px 14px',
    borderTop: '1px solid #2a2a2a',
    background: '#0d0d0d'
  } as React.CSSProperties,
  presetRow: {
    display: 'flex',
    gap: 6,
    marginBottom: 8,
    flexWrap: 'wrap'
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
    textAlign: 'right'
  } as React.CSSProperties
}

const SPEED_PRESETS = [0.5, 1, 1.5, 2]

export function ClipContextMenu(props: ClipContextMenuProps): JSX.Element {
  const {
    clip,
    x,
    y,
    splitEnabled,
    onSplit,
    onDuplicate,
    onDelete,
    onSpeedChange,
    onClose
  } = props

  const [showSpeed, setShowSpeed] = useState(false)
  const speed = clip.speed ?? 1
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current) return
      if (e.target instanceof Node && ref.current.contains(e.target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Position: clamp to viewport so the menu stays visible near the edges.
  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 240)
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 280)

  return (
    <div
      ref={ref}
      style={{ ...styles.menu, left, top }}
      data-testid="clip-context-menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        style={{
          ...styles.item,
          ...(splitEnabled ? {} : styles.itemDisabled)
        }}
        data-testid="ctx-split"
        aria-disabled={!splitEnabled}
        onClick={() => {
          if (!splitEnabled) return
          onSplit()
        }}
      >
        <span>여기서 자르기</span>
        <span style={styles.shortcut}>S</span>
      </div>
      <div
        style={styles.item}
        data-testid="ctx-duplicate"
        onClick={onDuplicate}
      >
        <span>복제</span>
        <span style={styles.shortcut}>Ctrl+D</span>
      </div>
      <div style={styles.item} data-testid="ctx-delete" onClick={onDelete}>
        <span>삭제</span>
        <span style={styles.shortcut}>Delete</span>
      </div>
      <div style={styles.separator} />
      <div
        style={styles.item}
        data-testid="ctx-speed-toggle"
        onClick={() => setShowSpeed((v) => !v)}
      >
        <span>속도{showSpeed ? '' : '…'}</span>
        <span style={styles.shortcut}>{speed.toFixed(2)}×</span>
      </div>
      {showSpeed && (
        <div style={styles.speedPanel} data-testid="ctx-speed-panel">
          <div style={styles.presetRow}>
            {SPEED_PRESETS.map((p) => {
              const active = Math.abs(speed - p) < 0.001
              return (
                <button
                  key={p}
                  style={{
                    ...styles.preset,
                    ...(active ? styles.presetActive : {})
                  }}
                  data-testid={`ctx-speed-preset-${p}`}
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
              data-testid="ctx-speed-slider"
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
              data-testid="ctx-speed-input"
              aria-label="속도 숫자"
            />
          </div>
        </div>
      )}
    </div>
  )
}
