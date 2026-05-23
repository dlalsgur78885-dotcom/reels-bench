import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AllowedCodec,
  ExportPresetKey,
  ExportRunResult,
  FfmpegCapabilities,
  ProgressEvent
} from '../../../shared/ipc'
import type { Project } from '../../../shared/project'
import {
  EXPORT_PRESETS,
  EXPORT_PRESET_KEYS,
  GIF_EXPORT,
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
  } as React.CSSProperties,
  hwToggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    background: '#0d1318',
    border: '1px solid #1f2937',
    borderRadius: 6,
    marginBottom: 12,
    fontSize: 12
  } as React.CSSProperties,
  hwToggleRowDisabled: {
    opacity: 0.55,
    cursor: 'not-allowed'
  } as React.CSSProperties,
  hwBadge: {
    fontSize: 10,
    background: '#0f3a2a',
    color: '#34d399',
    border: '1px solid #10b981',
    borderRadius: 4,
    padding: '1px 6px',
    marginLeft: 'auto'
  } as React.CSSProperties,
  hwHint: {
    fontSize: 10,
    color: '#9aa0a6',
    marginTop: 4
  } as React.CSSProperties,
  aspectMismatchHint: {
    fontSize: 11,
    color: '#9aa0a6',
    marginTop: -6,
    marginBottom: 12
  } as React.CSSProperties
}

/** Friendly description of a hardware encoder for the tooltip / success line. */
function encoderHumanLabel(codec: AllowedCodec | string): string {
  switch (codec) {
    case 'h264_nvenc':
      return 'NVIDIA NVENC'
    case 'h264_qsv':
      return 'Intel Quick Sync'
    case 'h264_amf':
      return 'AMD AMF'
    case 'h264_videotoolbox':
      return 'Apple VideoToolbox'
    case 'libx264':
      return 'CPU (libx264)'
    default:
      return codec
  }
}

function isHardwareEncoder(codec: AllowedCodec | string): boolean {
  return (
    codec === 'h264_nvenc' ||
    codec === 'h264_qsv' ||
    codec === 'h264_amf' ||
    codec === 'h264_videotoolbox' ||
    codec === 'hevc_nvenc' ||
    codec === 'hevc_qsv' ||
    codec === 'hevc_amf' ||
    codec === 'hevc_videotoolbox'
  )
}

function defaultOutputName(
  projectName: string,
  presetKey: ExportPresetKey
): string {
  const slug = (projectName || 'export')
    .replace(/[^\w\-]+/g, '_')
    .slice(0, 64)
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-')
  const ext = presetKey === 'gif' ? 'gif' : 'mp4'
  return `${slug}-${ts}.${ext}`
}

export function ExportDialog({ project, onClose }: ExportDialogProps): JSX.Element {
  const [presetKey, setPresetKey] = useState<ExportPresetKey>('instagram-reels')
  const [outputPath, setOutputPath] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [result, setResult] = useState<ExportRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<FfmpegCapabilities | null>(null)
  const [capsLoaded, setCapsLoaded] = useState(false)
  const [useHardwareAccel, setUseHardwareAccel] = useState<boolean>(false)
  const jobIdRef = useRef<string | null>(null)

  const totalDurationMs = useMemo(() => getTotalDurationMs(project), [project])
  const sizeBytes = estimateFileSizeBytes(presetKey, totalDurationMs)

  // Advisory only: the export preset and the project's aspect ratio are
  // independent. When the selected preset's width/height ratio differs from
  // the project's, the export letterboxes — we surface a non-blocking note.
  const aspectMismatch = useMemo(() => {
    const preset = EXPORT_PRESETS[presetKey]
    if (!preset || preset.height <= 0 || project.height <= 0) return false
    const presetAspect = preset.width / preset.height
    const projectAspect = project.width / project.height
    return Math.abs(presetAspect - projectAspect) > 0.01
  }, [presetKey, project.width, project.height])

  // GIF is capped at GIF_EXPORT.durationCapMs by the main process; warn the
  // user that anything past the cap will be trimmed.
  const gifDurationOverCap =
    presetKey === 'gif' && totalDurationMs > GIF_EXPORT.durationCapMs

  const hwAvailable =
    capabilities !== null && isHardwareEncoder(capabilities.preferred)
  const preferredEncoder = capabilities?.preferred ?? 'libx264'

  useEffect(() => {
    if (!window.electron?.ffmpeg?.onProgress) return
    const off = window.electron.ffmpeg.onProgress((ev) => {
      if (ev.jobId === jobIdRef.current) setProgress(ev)
    })
    return off
  }, [])

  // Probe encoder capabilities once on mount. The toggle defaults to ON when
  // a HW encoder is available, OFF otherwise.
  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      // E2E override hook: tests can set window.__E2E_CAPABILITIES__ to bypass
      // the IPC probe (the contextBridge-exposed window.electron object is
      // frozen, so direct method stubbing isn't possible from the renderer).
      const e2eOverride = (
        window as unknown as { __E2E_CAPABILITIES__?: FfmpegCapabilities }
      ).__E2E_CAPABILITIES__
      if (e2eOverride) {
        setCapabilities(e2eOverride)
        setUseHardwareAccel(isHardwareEncoder(e2eOverride.preferred))
        setCapsLoaded(true)
        return
      }
      if (!window.electron?.ffmpeg?.capabilities) {
        if (!cancelled) setCapsLoaded(true)
        return
      }
      try {
        const caps = await window.electron.ffmpeg.capabilities()
        if (cancelled) return
        setCapabilities(caps)
        setUseHardwareAccel(isHardwareEncoder(caps.preferred))
      } catch {
        // Probe failed — leave caps null, toggle disabled, libx264 used.
      } finally {
        if (!cancelled) setCapsLoaded(true)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  const handlePickPath = async (): Promise<void> => {
    if (!window.electron?.fs?.saveFile) return
    const defaultName = defaultOutputName(project.name, presetKey)
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
        outputPath,
        useHardwareAccel: useHardwareAccel && hwAvailable
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

  // Phase 3.27 — reveal the exported cover JPG (separate main-side pass).
  const handleOpenCover = async (): Promise<void> => {
    if (!result?.coverPath || !window.electron?.exporter?.revealFile) return
    await window.electron.exporter.revealFile(result.coverPath)
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

        <div
          style={{
            ...styles.hwToggleRow,
            ...(hwAvailable ? {} : styles.hwToggleRowDisabled)
          }}
          data-testid="export-hw-toggle-row"
          data-hw-available={hwAvailable ? 'true' : 'false'}
          data-preferred-encoder={preferredEncoder}
          title={
            hwAvailable
              ? `하드웨어 가속을 사용하면 GPU(${encoderHumanLabel(preferredEncoder)})로 인코딩하여 CPU 대비 5~10배 빠르고 발열·전력 소비가 줄어듭니다. 화질은 동일한 비트레이트 기준 살짝 떨어질 수 있습니다.`
              : '이 시스템에는 하드웨어 가속 인코더가 없습니다'
          }
        >
          <input
            type="checkbox"
            id="export-hw-toggle"
            checked={hwAvailable && useHardwareAccel}
            disabled={running || !capsLoaded || !hwAvailable}
            onChange={(e) => setUseHardwareAccel(e.target.checked)}
            data-testid="export-hw-toggle"
            style={{ cursor: hwAvailable ? 'pointer' : 'not-allowed' }}
          />
          <label
            htmlFor="export-hw-toggle"
            style={{ cursor: hwAvailable ? 'pointer' : 'not-allowed' }}
            data-testid="export-hw-toggle-label"
          >
            하드웨어 가속 사용{' '}
            <span style={{ color: '#9aa0a6' }}>
              ({hwAvailable ? preferredEncoder : '사용 불가'})
            </span>
          </label>
          {hwAvailable && <span style={styles.hwBadge}>5~10× 빠름</span>}
        </div>
        {!hwAvailable && capsLoaded && (
          <div style={styles.hwHint} data-testid="export-hw-hint">
            이 시스템에는 하드웨어 가속 인코더가 없습니다
          </div>
        )}

        <div style={styles.meta} data-testid="export-meta">
          예상 길이 {formatDurationMs(totalDurationMs)} · 예상 용량{' '}
          {presetKey === 'gif' ? '크기 가변' : formatBytes(sizeBytes)}
        </div>

        {/* Phase 3.27 — cover / thumbnail frame readout. */}
        <div style={styles.meta} data-testid="export-cover-readout">
          커버 프레임:{' '}
          {project.coverMs != null
            ? formatDurationMs(project.coverMs)
            : '지정 안 함 (첫 프레임)'}
        </div>

        {aspectMismatch && (
          <div
            style={styles.aspectMismatchHint}
            data-testid="export-aspect-mismatch-hint"
          >
            프로젝트 비율과 내보내기 프리셋 비율이 다릅니다 — 레터박스로
            처리됩니다.
          </div>
        )}

        {gifDurationOverCap && (
          <div
            style={styles.aspectMismatchHint}
            data-testid="export-gif-duration-warning"
          >
            GIF는 {Math.round(GIF_EXPORT.durationCapMs / 1000)}초까지만
            내보냅니다 — 이후 구간은 잘립니다.
          </div>
        )}

        {progress && (
          <div data-testid="export-progress">
            <div style={styles.progressOuter}>
              <div style={styles.progressInner(progress.percent)} />
            </div>
            <div
              style={{ fontSize: 11, color: '#9aa0a6', marginTop: 6 }}
              data-testid="export-progress-status"
            >
              {progress.message === 'stabilize-detect' ? (
                <>손떨림 분석 중…</>
              ) : (
                <>
                  인코딩 중:{' '}
                  {useHardwareAccel && hwAvailable
                    ? preferredEncoder
                    : 'libx264'}
                </>
              )}{' '}
              · 진행률 {progress.percent.toFixed(1)}%
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
          <div
            style={styles.successBox}
            data-testid="export-success"
            data-used-encoder={result.usedEncoder ?? ''}
          >
            출력 완료
            {result.usedEncoder
              ? isHardwareEncoder(result.usedEncoder)
                ? ` (${result.usedEncoder}로 가속됨)`
                : ' (libx264 CPU 인코딩)'
              : ''}
            <br />
            {result.outputPath}
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
              {result.coverPath && (
                <button
                  type="button"
                  style={styles.secondaryBtn}
                  onClick={handleOpenCover}
                  data-testid="export-open-cover"
                >
                  커버 이미지 열기
                </button>
              )}
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
