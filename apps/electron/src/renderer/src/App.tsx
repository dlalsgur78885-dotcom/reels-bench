import { useEffect, useRef, useState } from 'react'
import '../../shared/ipc'
import type {
  FfmpegCapabilities,
  FfmpegRunSpec,
  ProgressEvent
} from '../../shared/ipc'
import { Editor } from './pages/Editor'
import Login from './pages/Login'
import { initProjectStore } from './store/project'
import { useAuthStore } from './store/auth'
import { UpdateBanner } from './components/UpdateBanner'
import { usePrefersReducedMotion } from './lib/usePrefersReducedMotion'

const wrap: React.CSSProperties = {
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  background: '#111',
  color: '#f5f5f5',
  minHeight: '100vh',
  margin: 0,
  padding: '48px 56px',
  boxSizing: 'border-box'
}

const title: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  marginBottom: 8
}

const subtitle: React.CSSProperties = {
  fontSize: 14,
  color: '#9aa0a6',
  marginBottom: 32
}

const btnRow: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap'
}

const btn: React.CSSProperties = {
  background: '#1f2937',
  color: '#f5f5f5',
  border: '1px solid #374151',
  borderRadius: 8,
  padding: '12px 20px',
  fontSize: 14,
  cursor: 'pointer'
}

const card: React.CSSProperties = {
  marginTop: 32,
  padding: 20,
  background: '#1a1a1a',
  border: '1px solid #2a2a2a',
  borderRadius: 12
}

const codeBlock: React.CSSProperties = {
  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  color: '#cbd5e1',
  background: '#0d0d0d',
  border: '1px solid #2a2a2a',
  borderRadius: 6,
  padding: 12,
  marginTop: 8
}

const progressOuter: React.CSSProperties = {
  height: 8,
  background: '#0d0d0d',
  border: '1px solid #2a2a2a',
  borderRadius: 4,
  overflow: 'hidden',
  marginTop: 8
}

const progressInner = (pct: number, reducedMotion: boolean): React.CSSProperties => ({
  width: `${Math.min(100, Math.max(0, pct))}%`,
  height: '100%',
  background: 'linear-gradient(90deg, #34d399, #10b981)',
  transition: reducedMotion ? 'none' : 'width 120ms linear'
})

function FfmpegSmokeTest(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const [caps, setCaps] = useState<FfmpegCapabilities | null>(null)
  const [capsError, setCapsError] = useState<string | null>(null)
  const [pickedPath, setPickedPath] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const jobIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!window.electron?.ffmpeg) return
    window.electron.ffmpeg
      .capabilities()
      .then(setCaps)
      .catch((err: unknown) =>
        setCapsError(err instanceof Error ? err.message : String(err))
      )
    const off = window.electron.ffmpeg.onProgress((ev) => {
      if (ev.jobId === jobIdRef.current) setProgress(ev)
    })
    return off
  }, [])

  const handlePick = async (): Promise<void> => {
    setError(null)
    setResult(null)
    setProgress(null)
    const path = await window.electron.fs.pickFile([
      { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm'] }
    ])
    setPickedPath(path)
  }

  const handleSave = async (): Promise<void> => {
    setError(null)
    const path = await window.electron.fs.saveFile('trim_2s.mp4')
    if (path) setResult(`Save path picked: ${path}`)
  }

  const handleTrim = async (): Promise<void> => {
    if (!pickedPath) {
      setError('Pick an input video first.')
      return
    }
    setError(null)
    setResult(null)
    setProgress(null)
    setRunning(true)

    const jobId = `smoke-${Date.now()}`
    jobIdRef.current = jobId
    // Output to OS temp via a stable filename. Main process resolves temp root.
    const output = await window.electron.fs.saveFile(`${jobId}.mp4`)
    if (!output) {
      setRunning(false)
      setError('No save path chosen.')
      return
    }

    const spec: FfmpegRunSpec = {
      jobId,
      input: pickedPath,
      output,
      durationSec: 2,
      scale: '-2:480',
      codec: 'libx264',
      preset: 'veryfast',
      crf: 23,
      audio: 'aac',
      kind: 'proxy'
    }

    try {
      const r = await window.electron.ffmpeg.run(spec)
      if (r.ok) {
        setResult(`OK ${r.output} (${r.durationMs}ms)`)
      } else {
        setError(r.error ?? 'unknown error')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleCancel = async (): Promise<void> => {
    if (!jobIdRef.current) return
    await window.electron.ffmpeg.cancel(jobIdRef.current)
  }

  return (
    <div style={card}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
        ffmpeg smoke test (dev only)
      </div>
      <div style={{ fontSize: 12, color: '#9aa0a6', marginBottom: 12 }}>
        Capabilities:{' '}
        {capsError
          ? `error — ${capsError}`
          : caps
            ? `preferred ${caps.preferred} (${caps.encoders.length} encoders)`
            : 'probing...'}
      </div>
      <div style={btnRow}>
        <button style={btn} onClick={handlePick} disabled={running}>
          Pick video
        </button>
        <button style={btn} onClick={handleSave} disabled={running}>
          Pick save path
        </button>
        <button
          style={btn}
          onClick={handleTrim}
          disabled={running || !pickedPath}
        >
          Trim first 2s @ 480p
        </button>
        <button style={btn} onClick={handleCancel} disabled={!running}>
          Cancel
        </button>
      </div>
      {pickedPath && (
        <div style={codeBlock}>
          input: {pickedPath}
        </div>
      )}
      {progress && (
        <>
          <div style={progressOuter}>
            <div style={progressInner(progress.percent, reducedMotion)} />
          </div>
          <div style={{ fontSize: 12, color: '#9aa0a6', marginTop: 6 }}>
            {progress.percent.toFixed(1)}%
            {progress.fps !== undefined ? ` · ${progress.fps.toFixed(1)} fps` : ''}
            {progress.speed !== undefined ? ` · ${progress.speed}x` : ''}
            {progress.etaMs !== undefined
              ? ` · eta ${Math.ceil(progress.etaMs / 1000)}s`
              : ''}
            {progress.done ? ' · done' : ''}
            {progress.cancelled ? ' · cancelled' : ''}
          </div>
        </>
      )}
      {result && (
        <div style={{ ...codeBlock, color: '#86efac' }}>{result}</div>
      )}
      {error && (
        <div style={{ ...codeBlock, color: '#fca5a5' }}>{error}</div>
      )}
    </div>
  )
}

type View = 'home' | 'editor'

const topbar: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  padding: '12px 16px',
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  fontSize: 12,
  color: '#9aa0a6'
}

const signOutBtn: React.CSSProperties = {
  background: '#1f2937',
  color: '#f5f5f5',
  border: '1px solid #374151',
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 12,
  cursor: 'pointer'
}

const splashSt: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#0d0d0d',
  color: '#9aa0a6',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontSize: 14
}

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('home')
  const initialized = useAuthStore((s) => s.initialized)
  const user = useAuthStore((s) => s.user)
  const userIdLabel = user?.userIdLabel ?? ''
  const signOut = useAuthStore((s) => s.signOut)

  // Kick off project hydration once at mount. Safe to call multiple times —
  // initProjectStore guards against duplicates internally.
  useEffect(() => {
    void initProjectStore()
  }, [])

  const handleAnalysis = (): void => console.log('[App] Analysis clicked')
  const handleScript = (): void => console.log('[App] Script clicked')
  const handleEditor = (): void => setView('editor')

  // Phase 3.87 — human-friendly relative time formatter.
  const formatRelativeTime = (ms: number): string => {
    const now = Date.now()
    const dt = Math.max(0, now - ms)
    const sec = Math.floor(dt / 1000)
    if (sec < 60) return '방금 전'
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}분 전`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}시간 전`
    const day = Math.floor(hr / 24)
    if (day < 7) return `${day}일 전`
    return new Date(ms).toLocaleDateString('ko-KR')
  }

  // Phase 3.87 — current-project info card. The Electron shell uses a
  // single persisted store (userData/project.json), so "recent projects"
  // collapses to "the one project you're working on". Surfacing its name +
  // clip count + last-modified relative-time on Home is a meaningful UX
  // step short of building a multi-project file manager.
  const [projectSnapshot, setProjectSnapshot] = useState<{
    name: string
    aspectRatio: string
    clipCount: number
    captionCount: number
    updatedAt: number
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    void import('./store/project').then(({ useProjectStore }) => {
      const read = (): void => {
        if (cancelled) return
        const p = useProjectStore.getState().project
        if (!p) return
        let clipCount = 0
        let captionCount = 0
        for (const t of p.tracks) {
          for (const c of t.clips) {
            if (c.kind === 'caption') captionCount += 1
            else clipCount += 1
          }
        }
        setProjectSnapshot({
          name: p.name || '제목 없음',
          aspectRatio: p.aspectRatio,
          clipCount,
          captionCount,
          updatedAt: p.updatedAt
        })
      }
      read()
      const unsub = useProjectStore.subscribe(read)
      return () => unsub()
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Phase 3.88 — preset-start. Resets the project to a blank canvas at the
  // platform's native aspect ratio, then routes into the editor. The same
  // store action the editor uses for the 비율 dropdown — single source of
  // truth, no schema duplication.
  const handleStartWithPreset = (
    ratio: '9:16' | '1:1' | '16:9' | '4:5'
  ): void => {
    void import('./store/project').then(({ useProjectStore }) => {
      const store = useProjectStore.getState()
      store.createNew()
      store.setAspectRatio(ratio)
      setView('editor')
    })
  }
  const handleSignOut = (): void => {
    void signOut().then(() => setView('home'))
  }

  const hasBridge = typeof window !== 'undefined' && Boolean(window.electron)
  const isDev = import.meta.env.DEV

  // Auth gate. Show splash while hydrating, then Login if no session.
  if (!initialized) {
    return (
      <div style={splashSt} data-testid="auth-splash">
        로딩...
      </div>
    )
  }
  if (!user) {
    return <Login />
  }

  if (view === 'editor') {
    return (
      <>
        <Editor onBack={() => setView('home')} />
        <UpdateBanner />
      </>
    )
  }

  return (
    <div style={wrap}>
      <div style={topbar} data-testid="app-topbar">
        <span data-testid="current-user">{userIdLabel}</span>
        <button
          type="button"
          style={signOutBtn}
          onClick={handleSignOut}
          data-testid="signout-button"
        >
          로그아웃
        </button>
      </div>
      <div style={title}>Reels Studio — Electron shell ready</div>
      <div style={subtitle}>
        Preload bridge: {hasBridge ? 'window.electron exposed' : 'not available'}
      </div>
      <div style={btnRow}>
        <button style={btn} onClick={handleAnalysis}>
          Analysis
        </button>
        <button style={btn} onClick={handleScript}>
          Script
        </button>
        <button style={btn} onClick={handleEditor} data-testid="open-editor-button">
          Editor
        </button>
      </div>
      {/* Phase 3.87 — current project info card ("이어서 작업"). */}
      {projectSnapshot && (
        <>
          <div
            style={{
              marginTop: 24,
              marginBottom: 8,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.8,
              textTransform: 'uppercase',
              color: '#94a3b8'
            }}
          >
            이어서 작업
          </div>
          <div
            style={{
              padding: 12,
              background: '#1a1a1a',
              border: '1px solid #2a2a2a',
              borderRadius: 8,
              color: '#cbd5e1',
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              maxWidth: 520
            }}
            data-testid="current-project-card"
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>
                📁 {projectSnapshot.name}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                {projectSnapshot.aspectRatio} · 클립 {projectSnapshot.clipCount}개
                · 자막 {projectSnapshot.captionCount}개 · 수정{' '}
                {formatRelativeTime(projectSnapshot.updatedAt)}
              </div>
            </div>
            <button
              type="button"
              style={{ ...btn, padding: '6px 14px', fontSize: 12 }}
              onClick={handleEditor}
              data-testid="continue-current-project"
            >
              Editor로 계속 →
            </button>
          </div>
        </>
      )}
      {/* Phase 3.88 — preset starts (Reels 9:16 / Square 1:1 / Long-form 16:9).
          Reels 11 슬라이드 5 — "새 프로젝트 만들기" 섹션으로 명시화하여 위의
          "이어서 작업"과 시각적으로 분리. 클릭 → 비율 적용 + Editor 진입. */}
      <div
        style={{
          marginTop: 24,
          marginBottom: 8,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          color: '#94a3b8'
        }}
        data-testid="new-project-section-heading"
      >
        + 새 프로젝트 만들기
      </div>
      <div style={{ ...btnRow, gap: 8 }} data-testid="new-project-presets">
        <button
          type="button"
          style={btn}
          onClick={() => handleStartWithPreset('9:16')}
          data-testid="start-preset-reels"
          title="9:16 세로 — Reels / Shorts / TikTok"
        >
          📱 Reels / Shorts
        </button>
        <button
          type="button"
          style={btn}
          onClick={() => handleStartWithPreset('1:1')}
          data-testid="start-preset-square"
          title="1:1 정사각 — Instagram Feed"
        >
          ⬛ 정사각 (피드)
        </button>
        <button
          type="button"
          style={btn}
          onClick={() => handleStartWithPreset('16:9')}
          data-testid="start-preset-longform"
          title="16:9 가로 — YouTube / 가로 영상"
        >
          🎬 YouTube 가로
        </button>
      </div>
      {isDev && hasBridge && <FfmpegSmokeTest />}
      <UpdateBanner />
    </div>
  )
}
