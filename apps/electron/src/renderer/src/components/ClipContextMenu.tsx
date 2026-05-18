import { useEffect, useRef, useState } from 'react'
import type {
  Clip,
  FilterPreset,
  TransitionKind
} from '../../../shared/project'
import {
  DEFAULT_TRANSITION_MS,
  FILTER_PRESETS,
  isCaptionClip,
  isMediaClip,
  MAX_CLIP_SPEED,
  MAX_TRANSITION_MS,
  MIN_CLIP_SPEED,
  MIN_TRANSITION_MS,
  TRANSITION_KINDS
} from '../../../shared/project'
import {
  FILTER_PRESET_LABELS,
  TRANSITION_LABELS,
  filterPresetToCss
} from '../../../shared/filterPresets'

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
  /** Apply a transition-in (kind + duration). Media clips only. */
  onTransitionChange?: (kind: TransitionKind, durationMs: number) => void
  /** Apply a filter preset + intensity. Media clips only. */
  onFilterChange?: (preset: FilterPreset, intensity: number) => void
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
    // Phase 2.5 — opens the silence-remove dialog (handled by parent).
    { key: 'remove-silence', label: '무음 자동 제거…' },
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
  const {
    clip,
    x,
    y,
    playheadMs,
    onAction,
    onSpeedChange,
    onTransitionChange,
    onFilterChange,
    onClose
  } = props
  const ref = useRef<HTMLDivElement>(null)
  const [showSpeed, setShowSpeed] = useState(false)
  const [showTransition, setShowTransition] = useState(false)
  const [showFilter, setShowFilter] = useState(false)

  // Always recompute on each render so playhead/clip changes drive the gate.
  const rows = isCaptionClip(clip) ? captionRows() : mediaRows(clip, playheadMs)

  // Read current speed (default 1) from the media clip; captions don't have one.
  const speed = isMediaClip(clip) ? clip.speed ?? 1 : 1
  const transitionKind: TransitionKind = isMediaClip(clip)
    ? clip.transitionIn?.kind ?? 'none'
    : 'none'
  const transitionMs = isMediaClip(clip)
    ? clip.transitionIn?.durationMs ?? DEFAULT_TRANSITION_MS
    : DEFAULT_TRANSITION_MS
  const filterPreset: FilterPreset = isMediaClip(clip)
    ? clip.filterPreset ?? 'none'
    : 'none'
  const filterIntensity = isMediaClip(clip) ? clip.filterIntensity ?? 1 : 1

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

      {/* Transition sub-menu — media clips only. */}
      {isMediaClip(clip) && onTransitionChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-transition"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowTransition((v) => !v)}
          >
            <span>전환 효과{showTransition ? '' : '…'}</span>
            <span style={styles.shortcut}>
              {TRANSITION_LABELS[transitionKind] ?? transitionKind}
            </span>
          </div>
          {showTransition && (
            <div style={styles.speedPanel} data-testid="menu-transition-panel">
              <div style={styles.presetRow}>
                {TRANSITION_KINDS.map((k) => {
                  const active = transitionKind === k
                  return (
                    <button
                      key={k}
                      type="button"
                      style={{
                        ...styles.preset,
                        ...(active ? styles.presetActive : {})
                      }}
                      data-testid={`menu-transition-preset-${k}`}
                      onClick={() => onTransitionChange(k, transitionMs)}
                    >
                      {TRANSITION_LABELS[k] ?? k}
                    </button>
                  )
                })}
              </div>
              <div style={styles.speedRow}>
                <input
                  type="range"
                  min={MIN_TRANSITION_MS}
                  max={MAX_TRANSITION_MS}
                  step={50}
                  value={transitionMs}
                  onChange={(e) =>
                    onTransitionChange(transitionKind, parseInt(e.target.value, 10) || DEFAULT_TRANSITION_MS)
                  }
                  style={styles.slider}
                  data-testid="menu-transition-slider"
                  aria-label="전환 길이"
                  disabled={transitionKind === 'none'}
                />
                <input
                  type="number"
                  min={MIN_TRANSITION_MS}
                  max={MAX_TRANSITION_MS}
                  step={50}
                  value={transitionMs}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    if (!Number.isFinite(v)) return
                    onTransitionChange(transitionKind, v)
                  }}
                  style={styles.speedInput}
                  data-testid="menu-transition-input"
                  aria-label="전환 길이(ms)"
                  disabled={transitionKind === 'none'}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Filter (LUT) sub-menu — media clips only. */}
      {isMediaClip(clip) && onFilterChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-filter"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowFilter((v) => !v)}
          >
            <span>필터{showFilter ? '' : '…'}</span>
            <span style={styles.shortcut}>
              {FILTER_PRESET_LABELS[filterPreset] ?? filterPreset}
            </span>
          </div>
          {showFilter && (
            <div style={styles.speedPanel} data-testid="menu-filter-panel">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 6,
                  marginBottom: 8
                }}
              >
                {FILTER_PRESETS.map((p) => {
                  const active = filterPreset === p
                  const css = filterPresetToCss(p, filterIntensity) || 'none'
                  return (
                    <button
                      key={p}
                      type="button"
                      data-testid={`menu-filter-preset-${p}`}
                      onClick={() => onFilterChange(p, filterIntensity)}
                      style={{
                        background: '#1f2937',
                        border: active ? '2px solid #10b981' : '1px solid #374151',
                        borderRadius: 4,
                        padding: 4,
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column' as const,
                        alignItems: 'center',
                        gap: 2,
                        fontSize: 10,
                        color: '#f5f5f5'
                      }}
                    >
                      <div
                        aria-hidden
                        style={{
                          width: 48,
                          height: 28,
                          background:
                            'linear-gradient(120deg, #4b5563, #9ca3af 50%, #f59e0b)',
                          borderRadius: 2,
                          filter: css === 'none' ? '' : css
                        }}
                      />
                      <div>{FILTER_PRESET_LABELS[p] ?? p}</div>
                    </button>
                  )
                })}
              </div>
              <div style={styles.speedRow}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(filterIntensity * 100)}
                  onChange={(e) =>
                    onFilterChange(
                      filterPreset,
                      Math.max(0, Math.min(1, parseInt(e.target.value, 10) / 100))
                    )
                  }
                  style={styles.slider}
                  data-testid="menu-filter-intensity-slider"
                  aria-label="필터 강도"
                  disabled={filterPreset === 'none'}
                />
                <span style={{ ...styles.shortcut, width: 36 }}>
                  {Math.round(filterIntensity * 100)}%
                </span>
              </div>
            </div>
          )}
        </>
      )}

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
