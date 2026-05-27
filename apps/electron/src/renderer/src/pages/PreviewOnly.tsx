/**
 * pptx10 슬라이드 13 (확장) — 별도 BrowserWindow 의 PreviewOnly app.
 * URL `?previewOnly=1` 으로 main.tsx 가 router 한다.
 *
 * 핵심:
 *   1. 자기 zustand store (별도 process 라 main 과 분리).
 *   2. main process IPC `preview-sync:apply` 로 main 의 store snapshot
 *      받아 hydrate. 양방향 broadcast 로 control (play/pause/seek) 도
 *      main 에 forward.
 *   3. <PreviewCanvas> 를 가운데에, 하단에 mini transport 만.
 */
import { useEffect, useState } from 'react'
import { PreviewCanvas } from '../components/PreviewCanvas'
import { useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import type { Project } from '../../../shared/project'

type ElectronExt = {
  previewWindow?: {
    onSyncApply: (cb: (payload: unknown) => void) => () => void
    broadcast: (payload: unknown) => void
    setAlwaysOnTop?: (flag: boolean) => Promise<boolean>
    minimize?: () => Promise<boolean>
    isAlwaysOnTop?: () => Promise<boolean>
    closeDetached?: () => Promise<boolean>
  }
}

interface SyncMsg {
  kind: 'project' | 'playheadMs' | 'playing'
  value: unknown
}

export function PreviewOnly(): JSX.Element {
  const project = useProjectStore((s) => s.project)
  const playheadMs = useTimelineUi((s) => s.playheadMs)
  const playing = useTimelineUi((s) => s.playing)
  const [hydrated, setHydrated] = useState(false)

  // Subscribe to main 의 broadcast — project / playhead / playing 받아 apply.
  // `applying` ref 로 echo 방지: 받은 변경을 다시 broadcast 하지 않음.
  const applyingRef = useState(() => ({ current: false }))[0]
  useEffect(() => {
    const ext = (window as unknown as { electron?: ElectronExt }).electron
    if (!ext?.previewWindow) return
    const off = ext.previewWindow.onSyncApply((payload) => {
      const msg = payload as SyncMsg
      if (!msg || typeof msg !== 'object') return
      applyingRef.current = true
      try {
        if (msg.kind === 'project') {
          useProjectStore.getState()._hydrateFromDisk(msg.value as Project)
          setHydrated(true)
        } else if (msg.kind === 'playheadMs') {
          useTimelineUi.getState().setPlayheadMs(msg.value as number)
        } else if (msg.kind === 'playing') {
          useTimelineUi.getState().setPlaying(Boolean(msg.value))
        }
      } finally {
        applyingRef.current = false
      }
    })
    // Request initial snapshot — broadcast empty signal; main responds with
    // current state via its own subscribe-and-broadcast wiring (App side).
    ext.previewWindow.broadcast({ kind: 'request-initial-state' })
    return () => off()
  }, [applyingRef])

  // 분리 window 에서 직접 일으킨 변경도 main 으로 broadcast (양방향).
  useEffect(() => {
    if (applyingRef.current) return
    const ext = (window as unknown as { electron?: ElectronExt }).electron
    ext?.previewWindow?.broadcast({ kind: 'playheadMs', value: playheadMs })
  }, [playheadMs, applyingRef])
  useEffect(() => {
    if (applyingRef.current) return
    const ext = (window as unknown as { electron?: ElectronExt }).electron
    ext?.previewWindow?.broadcast({ kind: 'playing', value: playing })
  }, [playing, applyingRef])

  if (!hydrated) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', color: '#94a3b8', fontSize: 13,
        background: '#000'
      }}>
        분리된 플레이어 — 메인 창에서 프로젝트를 로드하면 자동으로 표시됩니다…
      </div>
    )
  }
  return <PreviewOnlyWithToolbar project={project} playheadMs={playheadMs} />
}

/**
 * Reels 11 슬라이드 13 — 분리 윈도우 툴바: 항상 위 / 창 내리기 / 합치기.
 * RED 박스(in-app preview features) + BLUE 박스(OS-level controls) 를 한
 * 윈도우로 통합. in-app floating panel 은 동일 슬라이드에서 제거됨.
 */
function PreviewOnlyWithToolbar(props: {
  project: Project
  playheadMs: number
}): JSX.Element {
  const { project, playheadMs } = props
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)

  useEffect(() => {
    const ext = (window as unknown as { electron?: ElectronExt }).electron
    if (!ext?.previewWindow?.isAlwaysOnTop) return
    void ext.previewWindow.isAlwaysOnTop().then((flag) => setAlwaysOnTop(flag))
  }, [])

  const handleAlwaysOnTopToggle = (): void => {
    const ext = (window as unknown as { electron?: ElectronExt }).electron
    const next = !alwaysOnTop
    setAlwaysOnTop(next)
    void ext?.previewWindow?.setAlwaysOnTop?.(next)
  }
  const handleMinimize = (): void => {
    const ext = (window as unknown as { electron?: ElectronExt }).electron
    void ext?.previewWindow?.minimize?.()
  }
  const handleMerge = (): void => {
    const ext = (window as unknown as { electron?: ElectronExt }).electron
    // 메인 윈도우에서 같은 close 액션을 처리하고 reels-preview-detached
    // localStorage 도 0 으로 되돌리기 위해 broadcast 도 전송.
    ext?.previewWindow?.broadcast({ kind: 'request-merge-back' })
    void ext?.previewWindow?.closeDetached?.()
  }

  const btn: React.CSSProperties = {
    background: '#1f2937',
    color: '#cbd5e1',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 11,
    cursor: 'pointer'
  }
  const btnActive: React.CSSProperties = {
    ...btn,
    background: '#2563eb',
    borderColor: '#2563eb',
    color: '#fff'
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#000',
        overflow: 'hidden'
      }}
    >
      <div
        data-testid="preview-only-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          background: '#0d0d0d',
          borderBottom: '1px solid #1f2937'
        }}
      >
        <button
          type="button"
          data-testid="preview-only-aot-toggle"
          data-aot-active={alwaysOnTop ? 'true' : 'false'}
          aria-pressed={alwaysOnTop}
          style={alwaysOnTop ? btnActive : btn}
          onClick={handleAlwaysOnTopToggle}
          title="항상 위에 표시 — 다른 앱 위에 둠"
        >
          📌 항상 위
        </button>
        <button
          type="button"
          data-testid="preview-only-minimize"
          style={btn}
          onClick={handleMinimize}
          title="창 내리기 (작업 표시줄로)"
        >
          ⌄ 창 내리기
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="preview-only-merge"
          style={btn}
          onClick={handleMerge}
          title="메인 창 안 프리뷰로 합치기"
        >
          ↩ 합치기
        </button>
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            aspectRatio: `${project.width} / ${project.height}`,
            maxWidth: '100%',
            maxHeight: '100%',
            width: 'auto',
            height: '95%',
            background: '#000',
            position: 'relative'
          }}
        >
          <PreviewCanvas project={project} playheadMs={playheadMs} />
        </div>
      </div>
    </div>
  )
}
