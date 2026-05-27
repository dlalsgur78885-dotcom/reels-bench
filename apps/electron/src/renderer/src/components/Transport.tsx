import { useEffect, useMemo, useRef } from 'react'
import { getLastVisualMs, getTotalDurationMs, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import { accent, font, radius, space, surface, text } from '../theme/tokens'

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

// `text.primary` is #e2e8f0 (slightly darker than the old #f5f5f5) — keep
// #f5f5f5 here to preserve the play-button readout's exact contrast against
// the green play bg. Everywhere else uses tokens.
const TRANSPORT_FG = '#f5f5f5'
// `#10b981` (the old hardcoded green) isn't `accent.green` (#22c55e) — they
// shift hue. Keep a transport-local alias so the play button doesn't change.
const PLAY_GREEN = '#10b981'
const PLAY_GREEN_INK = '#04231a'
const styles = {
  bar: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 12px', // legacy spacing — defer migration to spacing token sweep
    background: surface[0],
    borderTop: `1px solid ${surface.border}`,
    borderBottom: `1px solid ${surface.border}`,
    color: TRANSPORT_FG,
    fontSize: font.size.base
  } as React.CSSProperties,
  btn: {
    background: surface[1],
    color: TRANSPORT_FG,
    border: `1px solid ${surface.borderStrong}`,
    borderRadius: radius.md,
    padding: '6px 12px',
    fontSize: font.size.base,
    cursor: 'pointer',
    minWidth: 36
  } as React.CSSProperties,
  playBtn: {
    background: PLAY_GREEN,
    color: PLAY_GREEN_INK,
    border: `1px solid ${PLAY_GREEN}`,
    fontWeight: font.weight.bold
  } as React.CSSProperties,
  time: {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    color: text.secondary,
    fontSize: font.size.base,
    minWidth: 110,
    textAlign: 'center'
  } as React.CSSProperties
}
void accent // keep import live for future migrations of inline button styles


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
      // Phase 3.83 — A/B loop: when set and the playhead crosses `end`,
      // wrap back to `start` and keep playing. Tested BEFORE the cap-stop
      // so a loop range placed at the very end still cycles.
      const loop = ui.loopRangeMs
      if (loop && next >= loop[1]) {
        ui.setPlayheadMs(loop[0])
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      if (cap > 0 && next >= cap) {
        // pptx10 슬라이드 10 — 마지막 clip 의 마지막 프레임에 park (1ms
        // 안쪽). cap 정확히는 active 아님 → 빈 화면 + 사용자 혼란.
        ui.setPlayheadMs(Math.max(0, cap - 1))
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

  // pptx10 슬라이드 10 (재해석 v2) — "처음/끝" 은 **선택된 clip 기준**.
  // 사용자 의도 = clip 클릭한 상태에서 [끝] → 그 clip 의 마지막 frame,
  // [처음] → 그 clip 의 시작. 선택 없을 때만 전체 timeline 의 0 / 끝-1ms.
  const findSelectedClip = (): { startMs: number; endMs: number } | null => {
    const sel = useTimelineUi.getState().selectedClipIds
    if (sel.size === 0) return null
    const targetId = sel.values().next().value
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (c.id === targetId) return { startMs: c.startMs, endMs: c.endMs }
      }
    }
    return null
  }
  const skipStart = (): void => {
    const clip = findSelectedClip()
    setPlayhead(clip ? clip.startMs : 0)
  }
  const skipEnd = (): void => {
    const clip = findSelectedClip()
    // half-open clip 범위 (`ms < endMs`) — 1ms 안쪽 = 그 clip 의 마지막
    // frame. 선택 없으면 비디오 트랙의 마지막 프레임 (pptx11 슬라이드 7:
    // getTotalDurationMs 는 audio/caption/overlay 포함이라 BGM/자막이
    // 비디오보다 길면 playhead 가 클립 너머로 가서 검은 화면이 됨).
    const lastVisual = getLastVisualMs(project)
    const target = clip ? clip.endMs - 1 : lastVisual - 1
    setPlayhead(Math.max(0, target))
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
