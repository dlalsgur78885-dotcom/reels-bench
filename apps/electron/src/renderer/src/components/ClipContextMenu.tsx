import { useEffect, useRef } from 'react'
import type { Clip } from '../../../shared/project'
import { isCaptionClip, isMediaClip } from '../../../shared/project'

export interface ClipContextMenuAction {
  key: string
  label: string
  /** Optional destructive flag (red text). */
  destructive?: boolean
}

interface ClipContextMenuProps {
  clip: Clip
  x: number
  y: number
  onAction: (key: string) => void
  onClose: () => void
}

const styles = {
  wrap: {
    position: 'fixed' as const,
    minWidth: 160,
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
    padding: '6px 10px',
    cursor: 'pointer',
    borderRadius: 4,
    userSelect: 'none' as const
  } as React.CSSProperties,
  destructive: {
    color: '#fca5a5'
  } as React.CSSProperties
}

/**
 * Action set per clip kind. Speed is intentionally absent for caption clips
 * (captions don't have a playback speed concept).
 */
function actionsFor(clip: Clip): ClipContextMenuAction[] {
  if (isCaptionClip(clip)) {
    return [
      { key: 'edit-caption', label: '자막 편집' },
      { key: 'duplicate', label: '복제' },
      { key: 'change-style', label: '스타일 변경' },
      { key: 'delete', label: '삭제', destructive: true }
    ]
  }
  if (isMediaClip(clip)) {
    return [
      { key: 'split', label: '분할' },
      { key: 'duplicate', label: '복제' },
      { key: 'speed', label: '속도 조정' },
      { key: 'delete', label: '삭제', destructive: true }
    ]
  }
  return [{ key: 'delete', label: '삭제', destructive: true }]
}

export function ClipContextMenu(props: ClipContextMenuProps): JSX.Element {
  const { clip, x, y, onAction, onClose } = props
  const items = actionsFor(clip)
  const ref = useRef<HTMLDivElement>(null)

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

  return (
    <div
      ref={ref}
      style={{ ...styles.wrap, left: x, top: y }}
      role="menu"
      data-testid="clip-context-menu"
      data-clip-kind={clip.kind}
    >
      {items.map((it) => (
        <div
          key={it.key}
          role="menuitem"
          data-testid={`menu-${it.key}`}
          style={{
            ...styles.item,
            ...(it.destructive ? styles.destructive : {})
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
          }}
          onClick={() => {
            onAction(it.key)
            onClose()
          }}
        >
          {it.label}
        </div>
      ))}
    </div>
  )
}
