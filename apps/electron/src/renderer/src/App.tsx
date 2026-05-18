import { useEffect, useRef, useState } from 'react'
import '../../shared/ipc'
import type {
  FfmpegCapabilities,
  FfmpegRunSpec,
  ProgressEvent
} from '../../shared/ipc'
import { Editor } from './pages/Editor'
import { initProjectStore } from './store/project'
import { installTestBridge } from './lib/testBridge'

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

const progressInner = (pct: number): React.CSSProperties => ({
  width: `${Math.min(100, Math.max(0, pct))}%`,
  height: '100%',
  background: 'linear-gradient(90deg, #34d399, #10b981)',
  transition: 'width 120ms linear'
})

function FfmpegSmokeTest(): JSX.Element {
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
            <div style={progressInner(progress.percent)} />
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

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('home')

  // Kick off project hydration once at mount. Safe to call multiple times —
  // initProjectStore guards against duplicates internally.
  useEffect(() => {
    installTestBridge()
    void initProjectStore()
  }, [])

  const handleAnalysis = (): void => console.log('[App] Analysis clicked')
  const handleScript = (): void => console.log('[App] Script clicked')
  const handleEditor = (): void => setView('editor')

  const hasBridge = typeof window !== 'undefined' && Boolean(window.electron)
  const isDev = import.meta.env.DEV

  if (view === 'editor') {
    return <Editor onBack={() => setView('home')} />
  }

  return (
    <div style={wrap}>
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
      {isDev && hasBridge && <FfmpegSmokeTest />}
    </div>
  )
}
