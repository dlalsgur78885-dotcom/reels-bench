import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ExportPresetKey,
  ExportRunResult,
  ProgressEvent
} from '../../../shared/ipc'
import type { Project } from '../../../shared/project'
import {
  EXPORT_PRESETS,
  EXPORT_PRESET_KEYS,
  estimateFileSizeBytes,
  formatBytes,
  formatDurationMs
} from '../lib/exportPresets'
import { newId, getTotalDurationMs } from '../store/project'

interface ExportDialogProps {
  project: Project
  onClose: () => void
}

const styles = {
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10000
  } as React.CSSProperties,
  dialog: {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 12,
    padding: 20,
    minWidth: 480,
    maxWidth: 560,
    color: '#f5f5f5',
    boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  } as React.CSSProperties,
  title: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 12
  } as React.CSSProperties,
  presetGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
    marginBottom: 16
  } as React.CSSProperties,
  presetBtn: {
    background: '#1f2937',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '8px 10px',
    color: '#f5f5f5',
    textAlign: 'left' as const,
    cursor: 'pointer'
  } as React.CSSProperties,
  presetBtnActive: {
    background: '#0f3a2a',
    border: '1px solid #10b981'
  } as React.CSSProperties,
  presetLabel: { fontSize: 13, fontWeight: 600 } as React.CSSProperties,
  presetDesc: { fontSize: 11, color: '#9aa0a6', marginTop: 2 } as React.CSSProperties,
  field: { marginBottom: 12 } as React.CSSProperties,
  label: {
    display: 'block',
    fontSize: 11,
    color: '#9aa0a6',
    marginBottom: 4
  } as React.CSSProperties,
  pathRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center'
  } as React.CSSProperties,
  pathInput: {
    flex: 1,
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace'
  } as React.CSSProperties,
  pathBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer'
  } as React.CSSProperties,
  meta: {
    fontSize: 11,
    color: '#9aa0a6',
    marginBottom: 12
  } as React.CSSProperties,
  progressOuter: {
    height: 8,
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    overflow: 'hidden',
    marginTop: 8
  } as React.CSSProperties,
  progressInner: (pct: number): React.CSSProperties => ({
    width: `${Math.min(100, Math.max(0, pct))}%`,
    height: '100%',
    background: 'linear-gradient(90deg, #34d399, #10b981)',
    transition: 'width 120ms linear'
  }),
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 16
  } as React.CSSProperties,
  primaryBtn: {
    background: '#10b981',
    color: '#04231a',
    border: 'none',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer'
  } as React.CSSProperties,
  secondaryBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    cursor: 'pointer'
  } as React.CSSProperties,
  errorBox: {
    marginTop: 12,
    padding: '8px 10px',
    background: '#2a0d0d',
    border: '1px solid #4a1f1f',
    color: '#fca5a5',
    borderRadius: 6,
    fontSize: 11,
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    whiteSpace: 'pre-wrap' as const,
    maxHeight: 200,
    overflow: 'auto' as const
  } as React.CSSProperties,
  successBox: {
    marginTop: 12,
    padding: '8px 10px',
    background: '#0d2a1f',
    border: '1px solid #1f4a35',
    color: '#86efac',
    borderRadius: 6,
    fontSize: 11,
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    wordBreak: 'break-all' as const
  } as React.CSSProperties
}

function defaultOutputName(projectName: string): string {
  const slug = (projectName || 'export')
    .replace(/[^\w\-]+/g, '_')
    .slice(0, 64)
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-')
  return `${slug}-${ts}.mp4`
}

export function ExportDialog({ project, onClose }: ExportDialogProps): JSX.Element {
  const [presetKey, setPresetKey] = useState<ExportPresetKey>('instagram-reels')
  const [outputPath, setOutputPath] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [result, setResult] = useState<ExportRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const jobIdRef = useRef<string | null>(null)

  const totalDurationMs = useMemo(() => getTotalDurationMs(project), [project])
  const sizeBytes = estimateFileSizeBytes(presetKey, totalDurationMs)

  useEffect(() => {
    if (!window.electron?.ffmpeg?.onProgress) return
    const off = window.electron.ffmpeg.onProgress((ev) => {
      if (ev.jobId === jobIdRef.current) setProgress(ev)
    })
    return off
  }, [])

  const handlePickPath = async (): Promise<void> => {
    if (!window.electron?.fs?.saveFile) return
    const defaultName = defaultOutputName(project.name)
    const picked = await window.electron.fs.saveFile(defaultName)
    if (picked) setOutputPath(picked)
  }

  const handleStart = async (): Promise<void> => {
    setError(null)
    setResult(null)
    setProgress(null)
    if (!outputPath) {
      // Auto-pick if user clicked Start without picking a path.
      await handlePickPath()
      return
    }
    if (!window.electron?.exporter?.run) {
      setError('exporter IPC not available')
      return
    }
    const jobId = `export-${Date.now()}-${newId().slice(-6)}`
    jobIdRef.current = jobId
    setRunning(true)
    try {
      const r = await window.electron.exporter.run(project, {
        jobId,
        presetKey,
        outputPath
      })
      setResult(r)
      if (!r.ok) {
        setError(r.error ?? 'unknown error')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleCancel = async (): Promise<void> => {
    if (!jobIdRef.current || !window.electron?.ffmpeg?.cancel) return
    await window.electron.ffmpeg.cancel(jobIdRef.current)
  }

  const handleOpenFolder = async (): Promise<void> => {
    if (!result?.outputPath || !window.electron?.exporter?.revealFile) return
    await window.electron.exporter.revealFile(result.outputPath)
  }

  const handleOpenFile = async (): Promise<void> => {
    if (!result?.outputPath || !window.electron?.exporter?.openFile) return
    await window.electron.exporter.openFile(result.outputPath)
  }

  // ESC closes when not running.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, running])

  return (
    <div
      style={styles.backdrop}
      data-testid="export-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose()
      }}
    >
      <div
        style={styles.dialog}
        role="dialog"
        aria-modal="true"
        data-testid="export-dialog"
      >
        <div style={styles.title}>내보내기</div>

        <div style={styles.field}>
          <label style={styles.label}>프리셋</label>
          <div style={styles.presetGrid}>
            {EXPORT_PRESET_KEYS.map((k) => {
              const p = EXPORT_PRESETS[k]
              const active = k === presetKey
              return (
                <button
                  key={k}
                  type="button"
                  data-testid={`export-preset-${k}`}
                  data-preset-key={k}
                  data-active={active ? 'true' : 'false'}
                  style={{
                    ...styles.presetBtn,
                    ...(active ? styles.presetBtnActive : {})
                  }}
                  onClick={() => setPresetKey(k)}
                  disabled={running}
                >
                  <div style={styles.presetLabel}>{p.label}</div>
                  <div style={styles.presetDesc}>{p.description}</div>
                </button>
              )
            })}
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>저장 경로</label>
          <div style={styles.pathRow}>
            <input
              type="text"
              style={styles.pathInput}
              value={outputPath}
              placeholder="저장 위치를 선택하세요…"
              onChange={(e) => setOutputPath(e.target.value)}
              data-testid="export-output-path"
              readOnly
            />
            <button
              type="button"
              style={styles.pathBtn}
              onClick={handlePickPath}
              disabled={running}
              data-testid="export-pick-path"
            >
              경로 선택…
            </button>
          </div>
        </div>

        <div style={styles.meta} data-testid="export-meta">
          예상 길이 {formatDurationMs(totalDurationMs)} · 예상 용량{' '}
          {formatBytes(sizeBytes)}
        </div>

        {progress && (
          <div data-testid="export-progress">
            <div style={styles.progressOuter}>
              <div style={styles.progressInner(progress.percent)} />
            </div>
            <div style={{ fontSize: 11, color: '#9aa0a6', marginTop: 6 }}>
              {progress.percent.toFixed(1)}%
              {progress.fps !== undefined ? ` · ${progress.fps.toFixed(1)} fps` : ''}
              {progress.speed !== undefined ? ` · ${progress.speed}x` : ''}
              {progress.done ? ' · 완료' : ''}
              {progress.cancelled ? ' · 취소됨' : ''}
            </div>
          </div>
        )}

        {error && (
          <div style={styles.errorBox} data-testid="export-error">
            {error}
          </div>
        )}

        {result?.ok && (
          <div style={styles.successBox} data-testid="export-success">
            완료: {result.outputPath}
            <br />
            {result.width && result.height
              ? `${result.width}×${result.height}`
              : ''}
            {result.durationMs ? ` · ${formatDurationMs(result.durationMs)}` : ''}
            {result.vBitrate ? ` · v ${result.vBitrate}kbps` : ''}
            {result.aBitrate ? ` · a ${result.aBitrate}kbps` : ''}
            <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
              <button
                type="button"
                style={styles.secondaryBtn}
                onClick={handleOpenFolder}
                data-testid="export-open-folder"
              >
                폴더 열기
              </button>
              <button
                type="button"
                style={styles.secondaryBtn}
                onClick={handleOpenFile}
                data-testid="export-open-file"
              >
                파일 열기
              </button>
            </div>
          </div>
        )}

        <div style={styles.actions}>
          {running ? (
            <button
              type="button"
              style={styles.secondaryBtn}
              onClick={handleCancel}
              data-testid="export-cancel"
            >
              취소
            </button>
          ) : (
            <button
              type="button"
              style={styles.secondaryBtn}
              onClick={onClose}
              data-testid="export-close"
            >
              닫기
            </button>
          )}
          <button
            type="button"
            style={{
              ...styles.primaryBtn,
              ...(running ? { opacity: 0.6, cursor: 'wait' } : {})
            }}
            onClick={handleStart}
            disabled={running}
            data-testid="export-start"
          >
            {running ? '내보내는 중…' : '내보내기 시작'}
          </button>
        </div>
      </div>
    </div>
  )
}
