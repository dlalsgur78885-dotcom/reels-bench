import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AllowedCodec,
  BatchExportItemResult,
  BatchExportResult,
  ExportPresetKey,
  FfmpegCapabilities
} from '../../../shared/ipc'
import type { Project } from '../../../shared/project'
import {
  EXPORT_PRESETS,
  EXPORT_PRESET_KEYS,
  PRESET_SUFFIX,
  projectSlug
} from '../lib/exportPresets'
import { newId } from '../store/project'

interface BatchExportDialogProps {
  project: Project
  open: boolean
  onClose: () => void
}

// Styling mirrors ExportDialog's `styles` object. Duplicated on purpose so the
// single-export path stays zero-diff.
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
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    maxHeight: '88vh',
    overflowY: 'auto' as const
  } as React.CSSProperties,
  title: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 12
  } as React.CSSProperties,
  field: { marginBottom: 12 } as React.CSSProperties,
  label: {
    display: 'block',
    fontSize: 11,
    color: '#9aa0a6',
    marginBottom: 4
  } as React.CSSProperties,
  checkRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    background: '#1f2937',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '8px 10px',
    marginBottom: 6
  } as React.CSSProperties,
  checkRowActive: {
    background: '#0f3a2a',
    border: '1px solid #10b981'
  } as React.CSSProperties,
  presetLabel: { fontSize: 13, fontWeight: 600 } as React.CSSProperties,
  presetDesc: {
    fontSize: 11,
    color: '#9aa0a6',
    marginTop: 2
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
  previewBox: {
    fontSize: 11,
    color: '#9aa0a6',
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '8px 10px',
    marginBottom: 12,
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    wordBreak: 'break-all' as const
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
  resultList: {
    marginTop: 12,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6
  } as React.CSSProperties,
  resultRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    borderRadius: 6,
    fontSize: 12,
    border: '1px solid #2a2a2a',
    background: '#0d0d0d'
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
  } as React.CSSProperties
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

/** Per-preset status colors for the result-row borders. */
function statusColor(status: BatchExportItemResult['status']): string {
  switch (status) {
    case 'success':
      return '#10b981'
    case 'failed':
      return '#ef4444'
    case 'cancelled':
      return '#f59e0b'
    default:
      return '#475569'
  }
}

function statusLabel(status: BatchExportItemResult['status']): string {
  switch (status) {
    case 'success':
      return '✓ 완료'
    case 'failed':
      return '✗ 실패'
    case 'cancelled':
      return '취소됨'
    default:
      return '건너뜀'
  }
}

export function BatchExportDialog({
  project,
  open,
  onClose
}: BatchExportDialogProps): JSX.Element | null {
  // Default: only instagram-reels checked.
  const [selected, setSelected] = useState<Set<ExportPresetKey>>(
    () => new Set<ExportPresetKey>(['instagram-reels'])
  )
  const [outputDir, setOutputDir] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [batchIndex, setBatchIndex] = useState(0)
  const [percent, setPercent] = useState(0)
  const [batchResult, setBatchResult] = useState<BatchExportResult | null>(null)
  const [capabilities, setCapabilities] = useState<FfmpegCapabilities | null>(
    null
  )
  const [capsLoaded, setCapsLoaded] = useState(false)
  const [useHardwareAccel, setUseHardwareAccel] = useState<boolean>(false)

  const activeJobIdRef = useRef<string | null>(null)
  const cancelledRef = useRef(false)

  const hwAvailable =
    capabilities !== null && isHardwareEncoder(capabilities.preferred)
  const preferredEncoder = capabilities?.preferred ?? 'libx264'

  const slug = useMemo(() => projectSlug(project.name), [project.name])

  // The ordered list of checked presets (stable preset order).
  const selectedKeys = useMemo<ExportPresetKey[]>(
    () => EXPORT_PRESET_KEYS.filter((k) => selected.has(k)),
    [selected]
  )

  const sep = outputDir.includes('\\') ? '\\' : '/'
  // GIF writes a `.gif`; every mp4 preset keeps `.mp4`.
  const extFor = (key: ExportPresetKey): string => (key === 'gif' ? 'gif' : 'mp4')
  const outputPathFor = (key: ExportPresetKey): string =>
    `${outputDir}${sep}${slug}_${PRESET_SUFFIX[key]}.${extFor(key)}`

  const batchState: 'idle' | 'running' | 'done' = running
    ? 'running'
    : batchResult
      ? 'done'
      : 'idle'

  // Subscribe to ffmpeg progress once; only react to the active job's events.
  useEffect(() => {
    if (!window.electron?.ffmpeg?.onProgress) return
    const off = window.electron.ffmpeg.onProgress((ev) => {
      if (ev.jobId === activeJobIdRef.current) setPercent(ev.percent)
    })
    return off
  }, [])

  // Probe encoder capabilities once when the dialog opens. Mirrors ExportDialog.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const run = async (): Promise<void> => {
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
  }, [open])

  // ESC closes when not running.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, running])

  if (!open) return null

  const togglePreset = (key: ExportPresetKey): void => {
    if (running) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handlePickDir = async (): Promise<void> => {
    if (running || !window.electron?.fs?.pickDirectory) return
    const picked = await window.electron.fs.pickDirectory()
    if (picked) setOutputDir(picked)
  }

  const handleStart = async (): Promise<void> => {
    if (running) return
    if (selectedKeys.length === 0 || !outputDir) return
    if (!window.electron?.exporter?.run) return

    cancelledRef.current = false
    setBatchResult(null)
    setPercent(0)
    setBatchIndex(0)
    setRunning(true)

    const items: BatchExportItemResult[] = []
    const hwAccel = useHardwareAccel && hwAvailable

    try {
      for (let i = 0; i < selectedKeys.length; i++) {
        const key = selectedKeys[i]
        const outputPath = outputPathFor(key)

        // Cancelled before this preset → mark this + the rest as skipped.
        if (cancelledRef.current) {
          for (let j = i; j < selectedKeys.length; j++) {
            items.push({
              presetKey: selectedKeys[j],
              outputPath: outputPathFor(selectedKeys[j]),
              status: 'skipped'
            })
          }
          break
        }

        const jobId = `batch-${Date.now()}-${i}-${newId().slice(-6)}`
        activeJobIdRef.current = jobId
        setBatchIndex(i)
        setPercent(0)

        let item: BatchExportItemResult
        try {
          const r = await window.electron.exporter.run(project, {
            jobId,
            presetKey: key,
            outputPath,
            useHardwareAccel: hwAccel
          })
          item = {
            presetKey: key,
            outputPath: r.outputPath ?? outputPath,
            status: r.ok
              ? 'success'
              : cancelledRef.current
                ? 'cancelled'
                : 'failed',
            error: r.ok ? undefined : (r.error ?? 'unknown error'),
            durationMs: r.durationMs,
            usedEncoder: r.usedEncoder
          }
        } catch (err) {
          // Failure does NOT stop the batch — record and continue.
          item = {
            presetKey: key,
            outputPath,
            status: cancelledRef.current ? 'cancelled' : 'failed',
            error: err instanceof Error ? err.message : String(err)
          }
        }
        items.push(item)
      }
    } finally {
      activeJobIdRef.current = null
      const successCount = items.filter((it) => it.status === 'success').length
      const failedCount = items.filter((it) => it.status === 'failed').length
      setBatchResult({
        items,
        successCount,
        failedCount,
        cancelled: cancelledRef.current
      })
      setRunning(false)
    }
  }

  const handleCancelAll = async (): Promise<void> => {
    cancelledRef.current = true
    const jobId = activeJobIdRef.current
    if (jobId && window.electron?.ffmpeg?.cancel) {
      await window.electron.ffmpeg.cancel(jobId)
    }
  }

  const handleOpenFolder = async (filePath: string): Promise<void> => {
    if (!window.electron?.exporter?.revealFile) return
    await window.electron.exporter.revealFile(filePath)
  }

  const canStart = selectedKeys.length > 0 && !!outputDir && !running

  return (
    <div
      style={styles.backdrop}
      data-testid="batch-export-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose()
      }}
    >
      <div
        style={styles.dialog}
        role="dialog"
        aria-modal="true"
        data-testid="batch-export-dialog"
        data-batch-state={batchState}
      >
        <div style={styles.title}>일괄 내보내기</div>

        <div style={styles.field}>
          <label style={styles.label}>프리셋 선택</label>
          {EXPORT_PRESET_KEYS.map((k) => {
            const p = EXPORT_PRESETS[k]
            const checked = selected.has(k)
            return (
              <label
                key={k}
                style={{
                  ...styles.checkRow,
                  ...(checked ? styles.checkRowActive : {}),
                  cursor: running ? 'not-allowed' : 'pointer'
                }}
              >
                <input
                  type="checkbox"
                  data-testid={`batch-preset-${k}`}
                  checked={checked}
                  disabled={running}
                  onChange={() => togglePreset(k)}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <div style={styles.presetLabel}>{p.label}</div>
                  <div style={styles.presetDesc}>{p.description}</div>
                </span>
              </label>
            )
          })}
        </div>

        <div style={styles.field}>
          <label style={styles.label}>저장 폴더</label>
          <div style={styles.pathRow}>
            <input
              type="text"
              style={styles.pathInput}
              value={outputDir}
              placeholder="저장할 폴더를 선택하세요…"
              data-testid="batch-output-dir"
              readOnly
            />
            <button
              type="button"
              style={styles.pathBtn}
              onClick={handlePickDir}
              disabled={running}
              data-testid="batch-pick-dir"
            >
              폴더 선택…
            </button>
          </div>
        </div>

        <div
          style={{
            ...styles.hwToggleRow,
            ...(hwAvailable ? {} : styles.hwToggleRowDisabled)
          }}
          data-testid="batch-hw-toggle-row"
          data-hw-available={hwAvailable ? 'true' : 'false'}
          data-preferred-encoder={preferredEncoder}
        >
          <input
            type="checkbox"
            id="batch-hw-toggle"
            checked={hwAvailable && useHardwareAccel}
            disabled={running || !capsLoaded || !hwAvailable}
            onChange={(e) => setUseHardwareAccel(e.target.checked)}
            data-testid="batch-hw-toggle"
            style={{ cursor: hwAvailable ? 'pointer' : 'not-allowed' }}
          />
          <label
            htmlFor="batch-hw-toggle"
            style={{ cursor: hwAvailable ? 'pointer' : 'not-allowed' }}
            data-testid="batch-hw-toggle-label"
          >
            하드웨어 가속 사용{' '}
            <span style={{ color: '#9aa0a6' }}>
              ({hwAvailable ? preferredEncoder : '사용 불가'})
            </span>
          </label>
          {hwAvailable && <span style={styles.hwBadge}>5~10× 빠름</span>}
        </div>
        {!hwAvailable && capsLoaded && (
          <div style={styles.hwHint} data-testid="batch-hw-hint">
            이 시스템에는 하드웨어 가속 인코더가 없습니다
          </div>
        )}

        {selectedKeys.length > 0 && (
          <div style={styles.previewBox} data-testid="batch-filename-preview">
            <div style={{ ...styles.label, marginBottom: 6 }}>
              파일명 미리보기 ({selectedKeys.length}개)
            </div>
            {selectedKeys.map((k) => (
              <div key={k} data-testid={`batch-filename-${k}`}>
                {slug}_{PRESET_SUFFIX[k]}.{extFor(k)}
              </div>
            ))}
          </div>
        )}

        {running && (
          <div data-testid="batch-progress">
            <div style={{ fontSize: 12, color: '#9aa0a6' }}>
              내보내기 {batchIndex + 1}/{selectedKeys.length} —{' '}
              {percent.toFixed(0)}%
            </div>
            <div style={styles.progressOuter}>
              <div style={styles.progressInner(percent)} />
            </div>
          </div>
        )}

        {batchResult && (
          <div style={styles.resultList} data-testid="batch-result">
            <div style={{ fontSize: 12, color: '#9aa0a6' }}>
              완료 — 성공 {batchResult.successCount}개 · 실패{' '}
              {batchResult.failedCount}개
              {batchResult.cancelled ? ' · 취소됨' : ''}
            </div>
            {batchResult.items.map((it) => (
              <div
                key={it.presetKey}
                data-testid={`batch-result-${it.presetKey}`}
                data-status={it.status}
                style={{
                  ...styles.resultRow,
                  borderColor: statusColor(it.status)
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {EXPORT_PRESETS[it.presetKey].label}
                </span>
                <span style={{ color: statusColor(it.status) }}>
                  {statusLabel(it.status)}
                </span>
                {it.status === 'failed' && it.error && (
                  <span
                    style={{ color: '#fca5a5', fontSize: 11 }}
                    data-testid={`batch-result-error-${it.presetKey}`}
                  >
                    {it.error}
                  </span>
                )}
                {it.status === 'success' && (
                  <button
                    type="button"
                    style={{
                      ...styles.secondaryBtn,
                      padding: '4px 10px',
                      fontSize: 11,
                      marginLeft: 'auto'
                    }}
                    onClick={() => handleOpenFolder(it.outputPath)}
                    data-testid={`batch-open-folder-${it.presetKey}`}
                  >
                    폴더 열기
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={styles.actions}>
          {running ? (
            <button
              type="button"
              style={styles.secondaryBtn}
              onClick={handleCancelAll}
              data-testid="batch-cancel"
            >
              전체 취소
            </button>
          ) : (
            <button
              type="button"
              style={styles.secondaryBtn}
              onClick={onClose}
              data-testid="batch-close"
            >
              닫기
            </button>
          )}
          <button
            type="button"
            style={{
              ...styles.primaryBtn,
              ...(canStart ? {} : { opacity: 0.6, cursor: 'not-allowed' })
            }}
            onClick={handleStart}
            disabled={!canStart}
            data-testid="batch-start"
          >
            {running ? '내보내는 중…' : '시작'}
          </button>
        </div>
      </div>
    </div>
  )
}
