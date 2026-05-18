import { useEffect, useState } from 'react'
import { MediaLibrary } from '../components/MediaLibrary'
import { PreviewCanvas } from '../components/PreviewCanvas'
import { Timeline } from '../components/Timeline'
import { Transport } from '../components/Transport'
import { getTotalDurationMs, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import type { AspectRatio } from '../../../shared/project'

interface EditorProps {
  onBack: () => void
}

const ASPECT_OPTIONS: AspectRatio[] = ['9:16', '1:1', '16:9', '4:5']

const styles = {
  page: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#0d0d0d',
    color: '#f5f5f5',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  } as React.CSSProperties,
  topbar: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 16px',
    background: '#111',
    borderBottom: '1px solid #2a2a2a',
    minHeight: 52
  } as React.CSSProperties,
  backBtn: {
    background: 'transparent',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer'
  } as React.CSSProperties,
  nameInput: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 14,
    fontWeight: 600,
    width: 280
  } as React.CSSProperties,
  select: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer'
  } as React.CSSProperties,
  flex1: { flex: 1 } as React.CSSProperties,
  body: {
    flex: 1,
    display: 'grid',
    gridTemplateColumns: 'minmax(280px, 320px) 1fr',
    overflow: 'hidden',
    minHeight: 0
  } as React.CSSProperties,
  right: {
    display: 'grid',
    gridTemplateRows: '1fr auto minmax(220px, 280px)',
    overflow: 'hidden',
    minHeight: 0
  } as React.CSSProperties,
  hint: {
    fontSize: 11,
    color: '#475569',
    marginLeft: 12
  } as React.CSSProperties
}

export function Editor({ onBack }: EditorProps): JSX.Element {
  const project = useProjectStore((s) => s.project)
  const hydrated = useProjectStore((s) => s.hydrated)
  const setName = useProjectStore((s) => s.setName)
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio)

  // Local mirror so the input feels responsive; flush to store on blur/enter.
  const [draftName, setDraftName] = useState(project.name)
  useEffect(() => {
    setDraftName(project.name)
  }, [project.name])

  const commitName = (): void => {
    const trimmed = (draftName ?? '').trim()
    if (!trimmed) {
      setDraftName(project.name)
      return
    }
    if (trimmed !== project.name) setName(trimmed)
  }

  // Editor-wide keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return
        }
      }

      const fps = useProjectStore.getState().project.fps || 30
      const frameMs = Math.round(1000 / fps)

      // Navigation: ←/→ frame, Shift modifies to 1s. Home/End to bounds.
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const step = e.shiftKey ? 1000 : frameMs
        const cur = useTimelineUi.getState().playheadMs
        useTimelineUi.getState().setPlayheadMs(Math.max(0, cur - step))
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        const step = e.shiftKey ? 1000 : frameMs
        const cur = useTimelineUi.getState().playheadMs
        const cap = getTotalDurationMs(useProjectStore.getState().project)
        useTimelineUi
          .getState()
          .setPlayheadMs(cap > 0 ? Math.min(cap, cur + step) : cur + step)
        return
      }
      if (e.key === 'Home') {
        e.preventDefault()
        useTimelineUi.getState().setPlayheadMs(0)
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        useTimelineUi
          .getState()
          .setPlayheadMs(getTotalDurationMs(useProjectStore.getState().project))
        return
      }

      const sel = useTimelineUi.getState().selectedClipIds
      const firstSelected = sel.size > 0 ? sel.values().next().value : null

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!firstSelected) return
        e.preventDefault()
        useProjectStore.getState().removeClip(firstSelected)
        useTimelineUi.getState().clearSelection()
        return
      }
      // Ctrl+D / Cmd+D — duplicate.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        if (!firstSelected) return
        e.preventDefault()
        const newId = useProjectStore.getState().duplicateClip(firstSelected)
        if (newId) useTimelineUi.getState().selectClip(newId)
        return
      }
      // S — split selected clip at playhead.
      if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
        if (!firstSelected) return
        e.preventDefault()
        const playMs = useTimelineUi.getState().playheadMs
        useProjectStore.getState().splitClipAt(firstSelected, playMs)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div style={styles.page} data-testid="editor-page">
      <div style={styles.topbar}>
        <button
          style={styles.backBtn}
          onClick={onBack}
          data-testid="editor-back-button"
        >
          ← 홈
        </button>
        <input
          style={styles.nameInput}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              ;(e.target as HTMLInputElement).blur()
            } else if (e.key === 'Escape') {
              setDraftName(project.name)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          placeholder="프로젝트 이름"
          aria-label="프로젝트 이름"
          data-testid="project-name-input"
        />

        <label style={styles.hint} htmlFor="aspect-ratio-select">
          비율
        </label>
        <select
          id="aspect-ratio-select"
          style={styles.select}
          value={project.aspectRatio}
          onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
          data-testid="aspect-ratio-select"
        >
          {ASPECT_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <div style={styles.hint}>
          {project.width}×{project.height} · {project.fps}fps
        </div>

        <div style={styles.flex1} />

        {!hydrated && <div style={styles.hint}>프로젝트 로딩 중…</div>}
      </div>

      <div style={styles.body}>
        <MediaLibrary />
        <div style={styles.right}>
          <PreviewCanvas />
          <Transport />
          <Timeline />
        </div>
      </div>
    </div>
  )
}
