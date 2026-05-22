import { useEffect, useRef, useState } from 'react'
import type { Track } from '../../../shared/project'
import { MAX_BULK_TRACKS } from '../../../shared/project'

/**
 * Phase 3 — timeline track context menu (slide 11).
 *
 * Right-clicking a track header opens this menu. Six entries:
 *   1. 이름 바꾸기              — inline-rename the right-clicked track
 *   2. 트랙 하나 추가           — add one track of the same kind
 *   3. 오디오 서브믹스 트랙 추가 — add a submix audio bus track
 *   4. 트랙 하나 삭제           — delete the right-clicked track
 *   5. 여러 트랙 추가           — add N tracks of the same kind at once
 *   6. 여러 트랙 삭제           — delete N tracks of the same kind at once
 *
 * Modeled on ClipContextMenu.tsx (fixed positioning, outside-click + Esc to
 * close, viewport clamping).
 */

interface TrackContextMenuProps {
  track: Track
  x: number
  y: number
  /** True when the right-clicked track may NOT be deleted (last video/caption). */
  deleteDisabled: boolean
  /** Number of same-kind tracks that exist (drives bulk-delete bounds). */
  sameKindCount: number
  /** Remaining headroom before the same-kind cap (drives bulk-add bounds). */
  addHeadroom: number
  onRename: (name: string) => void
  onAddOne: () => void
  onAddSubmix: () => void
  onDeleteOne: () => void
  onAddMany: (count: number) => void
  onDeleteMany: (count: number) => void
  onClose: () => void
}

const styles = {
  wrap: {
    position: 'fixed' as const,
    minWidth: 210,
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
  separator: {
    height: 1,
    background: '#2a2a2a',
    margin: '4px 0'
  } as React.CSSProperties,
  panel: {
    padding: '8px 10px',
    borderTop: '1px solid #2a2a2a',
    background: '#0d0d0d'
  } as React.CSSProperties,
  panelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8
  } as React.CSSProperties,
  textInput: {
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '4px 6px',
    fontSize: 12,
    flex: 1,
    minWidth: 0
  } as React.CSSProperties,
  numberInput: {
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '4px 6px',
    fontSize: 12,
    width: 56,
    textAlign: 'right' as const
  } as React.CSSProperties,
  okBtn: {
    background: '#312e81',
    color: '#e0e7ff',
    border: '1px solid #6366f1',
    borderRadius: 4,
    padding: '4px 12px',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  okBtnDestructive: {
    background: '#7f1d1d',
    color: '#fecaca',
    border: '1px solid #ef4444'
  } as React.CSSProperties,
  okBtnDisabled: {
    background: '#1f2937',
    color: '#475569',
    border: '1px solid #374151',
    cursor: 'not-allowed'
  } as React.CSSProperties,
  hint: {
    color: '#64748b',
    fontSize: 10,
    marginTop: 6
  } as React.CSSProperties
}

const KIND_LABEL: Record<Track['kind'], string> = {
  video: '비디오',
  audio: '오디오',
  caption: '자막',
  overlay: '오버레이'
}

export function TrackContextMenu(props: TrackContextMenuProps): JSX.Element {
  const {
    track,
    x,
    y,
    deleteDisabled,
    sameKindCount,
    addHeadroom,
    onRename,
    onAddOne,
    onAddSubmix,
    onDeleteOne,
    onAddMany,
    onDeleteMany,
    onClose
  } = props

  const ref = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [showRename, setShowRename] = useState(false)
  const [renameValue, setRenameValue] = useState(track.name)
  const [showAddMany, setShowAddMany] = useState(false)
  const [showDeleteMany, setShowDeleteMany] = useState(false)
  // Bulk-add headroom (≥0), capped at MAX_BULK_TRACKS for the UI.
  const addMax = Math.max(0, Math.min(MAX_BULK_TRACKS, addHeadroom))
  // Bulk-delete: never offer to remove every same-kind track when that kind
  // must keep at least one (video/caption). Audio/overlay can go to zero.
  const mustKeepOne = track.kind === 'video' || track.kind === 'caption'
  const deleteMax = Math.max(
    0,
    Math.min(MAX_BULK_TRACKS, mustKeepOne ? sameKindCount - 1 : sameKindCount)
  )
  const [addManyCount, setAddManyCount] = useState(Math.min(2, Math.max(1, addMax)))
  const [deleteManyCount, setDeleteManyCount] = useState(
    Math.min(2, Math.max(1, deleteMax))
  )

  // Focus the rename field when the panel opens.
  useEffect(() => {
    if (showRename) {
      const t = renameInputRef.current
      if (t) {
        t.focus()
        t.select()
      }
    }
  }, [showRename])

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

  // Clamp the menu into the viewport.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1000
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const left = Math.min(x, Math.max(0, vw - 240))
  const top = Math.min(y, Math.max(0, vh - 320))

  const kindLabel = KIND_LABEL[track.kind] ?? '트랙'

  const commitRename = (): void => {
    const v = renameValue.trim()
    if (v.length > 0 && v !== track.name) onRename(v)
    onClose()
  }

  return (
    <div
      ref={ref}
      style={{ ...styles.wrap, left, top }}
      role="menu"
      data-testid="track-context-menu"
      data-track-id={track.id}
      data-track-kind={track.kind}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 1. 이름 바꾸기 */}
      <div
        role="menuitem"
        data-testid="track-menu-rename"
        style={styles.item}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
        }}
        onClick={() => setShowRename((v) => !v)}
      >
        <span>이름 바꾸기{showRename ? '' : '…'}</span>
      </div>
      {showRename && (
        <div style={styles.panel} data-testid="track-menu-rename-panel">
          <div style={styles.panelRow}>
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitRename()
                }
              }}
              style={styles.textInput}
              data-testid="track-menu-rename-input"
              aria-label="트랙 이름"
            />
            <button
              type="button"
              style={{
                ...styles.okBtn,
                ...(renameValue.trim().length === 0
                  ? styles.okBtnDisabled
                  : {})
              }}
              data-testid="track-menu-rename-ok"
              disabled={renameValue.trim().length === 0}
              onClick={commitRename}
            >
              확인
            </button>
          </div>
        </div>
      )}

      <div style={styles.separator} />

      {/* 2. 트랙 하나 추가 */}
      <MenuItem
        testId="track-menu-add-one"
        label={`${kindLabel} 트랙 하나 추가`}
        disabled={addHeadroom <= 0}
        onClick={() => {
          onAddOne()
          onClose()
        }}
      />

      {/* 3. 오디오 서브믹스 트랙 추가 */}
      <MenuItem
        testId="track-menu-add-submix"
        label="오디오 서브믹스 트랙 추가"
        onClick={() => {
          onAddSubmix()
          onClose()
        }}
      />

      {/* 4. 트랙 하나 삭제 */}
      <MenuItem
        testId="track-menu-delete-one"
        label="이 트랙 삭제"
        destructive
        disabled={deleteDisabled}
        onClick={() => {
          if (deleteDisabled) return
          onDeleteOne()
          onClose()
        }}
      />

      <div style={styles.separator} />

      {/* 5. 여러 트랙 추가 */}
      <div
        role="menuitem"
        data-testid="track-menu-add-many"
        style={{
          ...styles.item,
          ...(addMax <= 0 ? styles.itemDisabled : {})
        }}
        aria-disabled={addMax <= 0}
        onMouseEnter={(e) => {
          if (addMax <= 0) return
          ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
        }}
        onClick={() => {
          if (addMax <= 0) return
          setShowAddMany((v) => !v)
        }}
      >
        <span>여러 트랙 추가{showAddMany ? '' : '…'}</span>
      </div>
      {showAddMany && addMax > 0 && (
        <div style={styles.panel} data-testid="track-menu-add-many-panel">
          <div style={styles.panelRow}>
            <span>{kindLabel}</span>
            <input
              type="number"
              min={1}
              max={addMax}
              step={1}
              value={addManyCount}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                if (!Number.isFinite(v)) return
                setAddManyCount(Math.max(1, Math.min(addMax, v)))
              }}
              style={styles.numberInput}
              data-testid="track-menu-add-many-input"
              aria-label="추가할 트랙 개수"
            />
            <span>개</span>
            <button
              type="button"
              style={styles.okBtn}
              data-testid="track-menu-add-many-ok"
              onClick={() => {
                onAddMany(Math.max(1, Math.min(addMax, addManyCount)))
                onClose()
              }}
            >
              추가
            </button>
          </div>
          <div style={styles.hint}>최대 {addMax}개까지 추가할 수 있습니다</div>
        </div>
      )}

      {/* 6. 여러 트랙 삭제 */}
      <div
        role="menuitem"
        data-testid="track-menu-delete-many"
        style={{
          ...styles.item,
          ...styles.destructive,
          ...(deleteMax <= 0 ? styles.itemDisabled : {})
        }}
        aria-disabled={deleteMax <= 0}
        onMouseEnter={(e) => {
          if (deleteMax <= 0) return
          ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
        }}
        onClick={() => {
          if (deleteMax <= 0) return
          setShowDeleteMany((v) => !v)
        }}
      >
        <span>여러 트랙 삭제{showDeleteMany ? '' : '…'}</span>
      </div>
      {showDeleteMany && deleteMax > 0 && (
        <div style={styles.panel} data-testid="track-menu-delete-many-panel">
          <div style={styles.panelRow}>
            <span>{kindLabel}</span>
            <input
              type="number"
              min={1}
              max={deleteMax}
              step={1}
              value={deleteManyCount}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                if (!Number.isFinite(v)) return
                setDeleteManyCount(Math.max(1, Math.min(deleteMax, v)))
              }}
              style={styles.numberInput}
              data-testid="track-menu-delete-many-input"
              aria-label="삭제할 트랙 개수"
            />
            <span>개</span>
            <button
              type="button"
              style={{ ...styles.okBtn, ...styles.okBtnDestructive }}
              data-testid="track-menu-delete-many-ok"
              onClick={() => {
                onDeleteMany(Math.max(1, Math.min(deleteMax, deleteManyCount)))
                onClose()
              }}
            >
              삭제
            </button>
          </div>
          <div style={styles.hint}>
            가장 최근 {kindLabel} 트랙부터 삭제됩니다 (최대 {deleteMax}개)
          </div>
        </div>
      )}
    </div>
  )
}

interface MenuItemProps {
  testId: string
  label: string
  destructive?: boolean
  disabled?: boolean
  onClick: () => void
}

function MenuItem(props: MenuItemProps): JSX.Element {
  const { testId, label, destructive, disabled, onClick } = props
  return (
    <div
      role="menuitem"
      data-testid={testId}
      aria-disabled={disabled}
      style={{
        ...styles.item,
        ...(destructive ? styles.destructive : {}),
        ...(disabled ? styles.itemDisabled : {})
      }}
      onMouseEnter={(e) => {
        if (disabled) return
        ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
      }}
      onClick={() => {
        if (disabled) return
        onClick()
      }}
    >
      <span>{label}</span>
    </div>
  )
}
