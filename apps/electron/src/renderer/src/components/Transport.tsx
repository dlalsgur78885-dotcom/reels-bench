import { useEffect, useMemo, useRef } from 'react'
import { getTotalDurationMs, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'

/**
 * Transport bar — play/pause/skip controls, current/total time, and the
 * single source of truth for the rAF playback loop.
 *
 * Mounted between the PreviewCanvas and the Timeline in Editor.tsx.
 */
function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

const styles = {
  bar: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 12px',
    background: '#0d0d0d',
    borderTop: '1px solid #2a2a2a',
    borderBottom: '1px solid #2a2a2a',
    color: '#f5f5f5',
    fontSize: 12
  } as React.CSSProperties,
  btn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    minWidth: 36
  } as React.CSSProperties,
  playBtn: {
    background: '#10b981',
    color: '#04231a',
    border: '1px solid #10b981',
    fontWeight: 700
  } as React.CSSProperties,
  time: {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    color: '#cbd5e1',
    fontSize: 12,
    minWidth: 110,
    textAlign: 'center'
  } as React.CSSProperties
}

export function Transport(): JSX.Element {
  const project = useProjectStore((s) => s.project)
  const playing = useTimelineUi((s) => s.playing)
  const playhead = useTimelineUi((s) => s.playheadMs)
  const setPlayhead = useTimelineUi((s) => s.setPlayheadMs)
  const setPlaying = useTimelineUi((s) => s.setPlaying)
  const togglePlaying = useTimelineUi((s) => s.togglePlaying)

  const totalMs = useMemo(() => getTotalDurationMs(project), [project])

  // -----------------------------------------------------------------------
  // rAF playback loop — owned by Transport. We read playhead from the store
  // each tick instead of via closure so manual scrubbing during playback
  // doesn't get clobbered by a stale value.
  // -----------------------------------------------------------------------
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number | null>(null)

  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      lastTickRef.current = null
      return
    }
    const tick = (): void => {
      const now = performance.now()
      const last = lastTickRef.current ?? now
      const dt = now - last
      lastTickRef.current = now
      const ui = useTimelineUi.getState()
      const current = ui.playheadMs
      const next = current + dt
      const cap = getTotalDurationMs(useProjectStore.getState().project)
      if (cap > 0 && next >= cap) {
        ui.setPlayheadMs(cap)
        ui.setPlaying(false)
        return
      }
      ui.setPlayheadMs(next)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      lastTickRef.current = null
    }
  }, [playing])

  // -----------------------------------------------------------------------
  // Space-bar shortcut — toggle play/pause when focus isn't in a text input.
  // -----------------------------------------------------------------------
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
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlaying()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlaying])

  const skipStart = (): void => {
    setPlayhead(0)
  }
  const skipEnd = (): void => {
    setPlayhead(totalMs)
    setPlaying(false)
  }

  return (
    <div style={styles.bar} data-testid="transport">
      <button
        style={styles.btn}
        onClick={skipStart}
        aria-label="처음으로"
        title="처음으로"
        data-testid="transport-skip-start"
      >
        ⏮ 처음
      </button>
      <button
        style={{ ...styles.btn, ...styles.playBtn }}
        onClick={togglePlaying}
        aria-label={playing ? '정지' : '재생'}
        data-testid="transport-play"
      >
        {playing ? '❚❚ 정지' : '▶ 재생'}
      </button>
      <button
        style={styles.btn}
        onClick={skipEnd}
        aria-label="끝으로"
        title="끝으로"
        data-testid="transport-skip-end"
      >
        ⏭ 끝
      </button>
      <div style={styles.time} data-testid="transport-time">
        {fmt(playhead)} / {fmt(totalMs)}
      </div>
    </div>
  )
}
