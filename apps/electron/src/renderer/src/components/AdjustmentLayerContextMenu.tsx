import { useEffect, useRef } from 'react'
import type { AdjustmentLayer } from '../../../shared/project'
import { isAdjustmentLayerLocked, MIN_CLIP_MS } from '../../../shared/project'

/**
 * pptx11 슬라이드 24 — 조정 레이어 우클릭 메뉴.
 *
 * 일반 클립의 ClipContextMenu 와 유사한 항목들로 구성:
 *   - 🔒 잠금 / 🔓 잠금 해제
 *   - 여기서 자르기 (S) — playhead 가 layer 안에 있을 때만 활성화
 *   - 복제 (Ctrl+D)
 *   - 특성 복사 / 특성 붙여넣기
 *   - 삭제 (Delete)
 *
 * 일반 클립 메뉴와 동일한 fixed-positioning + outside-click + Esc 닫기 패턴.
 */

interface AdjustmentLayerContextMenuProps {
  layer: AdjustmentLayer
  x: number
  y: number
  /** 현재 playhead (ms) — 자르기 활성화 게이트. */
  playheadMs: number
  canPasteProperties?: boolean
  onAction: (key: string) => void
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
  itemDestructive: {
    color: '#fca5a5'
  } as React.CSSProperties,
  shortcut: {
    color: '#94a3b8',
    fontSize: 11,
    flexShrink: 0
  } as React.CSSProperties,
  separator: {
    height: 1,
    background: '#2a2a2a',
    margin: '4px 0'
  } as React.CSSProperties
}

interface Row {
  key: string
  label: string
  shortcut?: string
  enabled: boolean
  destructive?: boolean
}

export function AdjustmentLayerContextMenu(
  props: AdjustmentLayerContextMenuProps
): JSX.Element {
  const { layer, x, y, playheadMs, canPasteProperties, onAction, onClose } = props
  const ref = useRef<HTMLDivElement>(null)

  // Outside click + Esc 닫기 — TrackContextMenu / ClipContextMenu 동일.
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // 뷰포트 clamp — 메뉴가 화면 밖으로 나가지 않도록 위치 보정.
  const left = Math.max(
    4,
    Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 1024) - 220)
  )
  const top = Math.max(
    4,
    Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 768) - 220)
  )

  const locked = isAdjustmentLayerLocked(layer)
  // 자르기 게이트 — atMs 가 [startMs + MIN_CLIP_MS, endMs - MIN_CLIP_MS] 안.
  const splittable =
    !locked &&
    playheadMs > layer.startMs + MIN_CLIP_MS &&
    playheadMs < layer.endMs - MIN_CLIP_MS

  // 잠금 토글은 항상 활성 (그래야 잠금 해제 가능).
  const lockRow: Row = {
    key: 'toggle-lock',
    label: locked ? '🔓 잠금 해제' : '🔒 잠금',
    enabled: true
  }
  // 그 외 행은 locked 면 모두 비활성.
  const otherRows: Row[] = [
    { key: 'split', label: '여기서 자르기', shortcut: 'S', enabled: splittable },
    { key: 'duplicate', label: '복제', shortcut: 'Ctrl+D', enabled: !locked },
    { key: 'copy-properties', label: '특성 복사', shortcut: 'Alt+C', enabled: true },
    {
      key: 'paste-properties',
      label: '특성 붙여넣기',
      shortcut: 'Alt+V',
      enabled: !locked && canPasteProperties === true
    },
    {
      key: 'delete',
      label: '삭제',
      shortcut: 'Delete',
      enabled: !locked,
      destructive: true
    }
  ]

  const handleClick = (row: Row): void => {
    if (!row.enabled) return
    onAction(row.key)
    onClose()
  }

  const renderRow = (row: Row, idx: number): JSX.Element => (
    <div
      key={`${row.key}-${idx}`}
      data-testid={`adjustment-ctx-${row.key}`}
      data-enabled={row.enabled ? 'true' : 'false'}
      role="menuitem"
      aria-disabled={!row.enabled}
      onMouseDown={(e) => {
        // 외부 클릭 closer 가 fire 되지 않도록.
        e.stopPropagation()
      }}
      onClick={() => handleClick(row)}
      onMouseEnter={(e) => {
        if (row.enabled) (e.currentTarget as HTMLElement).style.background = '#262626'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLElement).style.background = 'transparent'
      }}
      style={{
        ...styles.item,
        ...(row.enabled ? {} : styles.itemDisabled),
        ...(row.enabled && row.destructive ? styles.itemDestructive : {})
      }}
    >
      <span>{row.label}</span>
      {row.shortcut ? <span style={styles.shortcut}>{row.shortcut}</span> : null}
    </div>
  )

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="adjustment-layer-context-menu"
      data-layer-id={layer.id}
      style={{ ...styles.wrap, left, top }}
    >
      {renderRow(lockRow, 0)}
      <div style={styles.separator} />
      {otherRows.map((r, i) => renderRow(r, i + 1))}
    </div>
  )
}
