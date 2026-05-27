/**
 * AI 자동 편집 — "자동 러프컷(auto rough-cut)" dialog.
 *
 * Structure/styling mirrors `SttDialog.tsx`: a fixed backdrop, a dark modal,
 * and an absolutely-positioned multi-phase progress overlay with a cancel
 * button. One click runs the whole pipeline in `lib/autoEdit.ts`:
 *   detect silence across the primary track → remove it → ripple-close gaps →
 *   (optionally) auto-generate captions.
 *
 * The dialog never inspects IPC internals — it only awaits `runAutoEdit`,
 * which in turn awaits `audio.detectSilence` / `stt.transcribe`. An e2e mock
 * that resolves those two channels drives the whole UI.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SttLanguage } from '../../../shared/ipc'
import {
  countTracksWithMedia,
  resolvePrimaryTrack,
  runAutoEdit,
  type AutoEditPhase,
  type AutoEditSummary
} from '../lib/autoEdit'
import { useProjectStore } from '../store/project'
import { useFocusTrap } from '../lib/useFocusTrap'

interface AutoEditDialogProps {
  open: boolean
  onClose: () => void
  /** Called with the run summary once the rough-cut completes successfully. */
  onComplete: (summary: AutoEditSummary) => void
}

// ---------------------------------------------------------------------------
// Localization.
// ---------------------------------------------------------------------------

function phaseLabel(phase: AutoEditPhase): string {
  switch (phase) {
    case 'preparing':
      return '준비 중…'
    case 'detecting':
      return '무음 분석 중…'
    case 'cutting':
      return '무음 제거 중…'
    case 'transcribing':
      return '자막 생성 중…'
    case 'done':
      return '완료'
    case 'error':
      return '오류'
    case 'cancelled':
      return '취소됨'
    default:
      return '준비 중…'
  }
}

/** Phases during which the run is actively working (cancellable). */
function isBusyPhase(phase: AutoEditPhase): boolean {
  return (
    phase === 'preparing' ||
    phase === 'detecting' ||
    phase === 'cutting' ||
    phase === 'transcribing'
  )
}

const LANGUAGE_OPTIONS: ReadonlyArray<{ value: SttLanguage; label: string }> = [
  { value: 'auto', label: '자동 감지 (auto)' },
  { value: 'ko', label: '한국어 (ko)' },
  { value: 'en', label: 'English (en)' }
]

// ---------------------------------------------------------------------------
// Styles — mirror SttDialog's dark inline theme.
// ---------------------------------------------------------------------------
const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  } as React.CSSProperties,
  modal: {
    width: 'min(520px, 92vw)',
    maxHeight: '88vh',
    background: '#0f0f0f',
    border: '1px solid #2a2a2a',
    borderRadius: 12,
    color: '#f5f5f5',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    position: 'relative'
  } as React.CSSProperties,
  header: {
    padding: '16px 20px',
    borderBottom: '1px solid #2a2a2a',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0
  } as React.CSSProperties,
  title: {
    fontSize: 16,
    fontWeight: 700,
    flex: 1
  } as React.CSSProperties,
  // padding bumped 4→8 vertical so the hit area clears WCAG 2.5.5 (24×24 min).
  closeBtn: {
    background: 'transparent',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '8px 12px',
    fontSize: 12,
    cursor: 'pointer'
  } as React.CSSProperties,
  body: {
    overflow: 'auto',
    padding: 20,
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 16
  } as React.CSSProperties,
  fieldLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#cbd5e1',
    marginBottom: 8
  } as React.CSSProperties,
  toggleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '12px 14px',
    cursor: 'pointer'
  } as React.CSSProperties,
  toggleTexts: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    flex: 1
  } as React.CSSProperties,
  toggleTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#e2e8f0'
  } as React.CSSProperties,
  toggleHint: {
    fontSize: 11,
    color: '#64748b'
  } as React.CSSProperties,
  checkbox: {
    width: 16,
    height: 16,
    marginTop: 1,
    accentColor: '#6366f1',
    cursor: 'pointer'
  } as React.CSSProperties,
  select: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 13,
    width: '100%',
    marginTop: 8
  } as React.CSSProperties,
  trackLabel: {
    background: '#0d0d0d',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 13
  } as React.CSSProperties,
  warning: {
    fontSize: 11,
    color: '#fbbf24',
    background: '#231a07',
    border: '1px solid #4a3a14',
    borderRadius: 6,
    padding: '8px 10px'
  } as React.CSSProperties,
  emptyState: {
    fontSize: 12,
    color: '#94a3b8',
    background: '#1a1410',
    border: '1px solid #3a2a1a',
    borderRadius: 6,
    padding: '10px 12px'
  } as React.CSSProperties,
  error: {
    padding: '10px 12px',
    background: '#2a0d0d',
    border: '1px solid #4a1f1f',
    color: '#fca5a5',
    borderRadius: 6,
    fontSize: 12
  } as React.CSSProperties,
  details: {
    background: '#121212',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '8px 12px',
    fontSize: 12
  } as React.CSSProperties,
  summary: {
    cursor: 'pointer',
    color: '#cbd5e1',
    fontWeight: 600,
    fontSize: 12
  } as React.CSSProperties,
  sliderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 10
  } as React.CSSProperties,
  sliderLabel: {
    flex: '0 0 120px',
    color: '#9aa0a6',
    fontSize: 12
  } as React.CSSProperties,
  slider: { flex: 1 } as React.CSSProperties,
  sliderValue: {
    width: 64,
    textAlign: 'right',
    fontSize: 12,
    color: '#cbd5e1',
    fontVariantNumeric: 'tabular-nums'
  } as React.CSSProperties,
  footer: {
    padding: '14px 20px',
    borderTop: '1px solid #2a2a2a',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    flexShrink: 0
  } as React.CSSProperties,
  primaryBtn: {
    background: '#6366f1',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  primaryBtnDisabled: {
    background: '#312e54',
    color: '#7c7aa3',
    border: 'none',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'not-allowed'
  } as React.CSSProperties,
  ghostBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    cursor: 'pointer'
  } as React.CSSProperties,
  progressOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.9)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: 16,
    color: '#f5f5f5',
    fontSize: 14,
    zIndex: 10,
    padding: 24
  } as React.CSSProperties,
  progressTrack: {
    width: '80%',
    height: 8,
    background: '#1f2937',
    borderRadius: 999,
    overflow: 'hidden'
  } as React.CSSProperties,
  progressFill: {
    height: '100%',
    background: '#6366f1',
    transition: 'width 200ms ease'
  } as React.CSSProperties,
  summaryBox: {
    fontSize: 13,
    color: '#cbd5e1',
    textAlign: 'center',
    lineHeight: 1.6
  } as React.CSSProperties
}

export function AutoEditDialog({
  open,
  onClose,
  onComplete
}: AutoEditDialogProps): JSX.Element | null {
  const project = useProjectStore((s) => s.project)

  const [removeSilence, setRemoveSilence] = useState(true)
  const [generateCaptions, setGenerateCaptions] = useState(false)
  const [language, setLanguage] = useState<SttLanguage>('auto')
  const [noiseDb, setNoiseDb] = useState(-30)
  const [minMs, setMinMs] = useState(400)

  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<AutoEditPhase>('preparing')
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0
  })
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<AutoEditSummary | null>(null)

  // Cancellation flag — `runAutoEdit` polls `shouldCancel()` between clips.
  const cancelRef = useRef(false)

  // -------------------------------------------------------------------------
  // Derived: primary track + multi-track warning. Recomputed each render
  // while open so the labels reflect the live project (`project` is a dep).
  // -------------------------------------------------------------------------
  const primary = useMemo(
    () => (open ? resolvePrimaryTrack() : null),
    // resolvePrimaryTrack reads the live project store on call — not from
    // the closure — so eslint can't see the dep. We list `project` so the
    // memo invalidates on any project change (clip add / remove / move).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, project]
  )
  const tracksWithMedia = useMemo(
    () => (open ? countTracksWithMedia() : 0),
    // Same reasoning as `primary` above — helper reads the live store,
    // `project` is listed so we re-derive on every store mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, project]
  )
  const primaryTrackName = useMemo(() => {
    if (!primary) return null
    const t = project.tracks.find((tt) => tt.id === primary.trackId)
    return t ? t.name : null
  }, [primary, project])

  const hasMedia = primary != null
  const multiTrack = tracksWithMedia > 1

  // Reset transient state every time the dialog opens.
  useEffect(() => {
    if (!open) return
    setBusy(false)
    setPhase('preparing')
    setProgress({ done: 0, total: 0 })
    setError(null)
    setSummary(null)
    cancelRef.current = false
  }, [open])

  // -------------------------------------------------------------------------
  // Dry-run silence preview — audit #9. Debounced so dragging the
  // noiseDb / minMs sliders doesn't fire on every tick. We probe ONLY the
  // first media clip on the primary track (full pipeline runs across N
  // clips — would be ~Nx slower). The label says "첫 클립 기준 예상" so
  // the user understands the number is a sample, not a guarantee.
  // -------------------------------------------------------------------------
  const [silencePreview, setSilencePreview] = useState<
    { count: number; totalMs: number; loading: boolean } | null
  >(null)
  useEffect(() => {
    if (!open || !removeSilence || !primary || primary.mediaClipIds.length === 0) {
      setSilencePreview(null)
      return
    }
    setSilencePreview((p) => (p ? { ...p, loading: true } : { count: 0, totalMs: 0, loading: true }))
    let cancelled = false
    const handle = window.setTimeout(async () => {
      try {
        const clipId = primary.mediaClipIds[0]
        let path: string | null = null
        for (const t of project.tracks) {
          for (const c of t.clips) {
            if (c.id === clipId && c.kind === 'media') {
              const media = project.media[c.mediaId]
              if (media) path = media.path
              break
            }
          }
          if (path) break
        }
        if (!path) {
          if (!cancelled) setSilencePreview(null)
          return
        }
        const ranges = await window.electron.audio.detectSilence(path, {
          noiseDb,
          minMs
        })
        if (cancelled) return
        const totalMs = ranges.reduce((acc, r) => acc + r.durationMs, 0)
        setSilencePreview({ count: ranges.length, totalMs, loading: false })
      } catch {
        if (!cancelled) setSilencePreview(null)
      }
    }, 400)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [open, removeSilence, primary, noiseDb, minMs, project])

  // Esc closes the dialog (but never while a run is in flight).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  const handleClose = useCallback((): void => {
    if (busy) {
      // A run is active — request cancel; the run resolves and the overlay
      // tears down. Don't slam the dialog shut mid-mutation.
      cancelRef.current = true
      return
    }
    onClose()
  }, [busy, onClose])

  const handleCancel = useCallback((): void => {
    cancelRef.current = true
  }, [])

  const handleStart = useCallback(async (): Promise<void> => {
    setError(null)
    setSummary(null)
    cancelRef.current = false
    setBusy(true)
    setPhase('preparing')
    setProgress({ done: 0, total: 0 })

    let result: AutoEditSummary
    try {
      result = await runAutoEdit(
        {
          removeSilence,
          generateCaptions,
          noiseDb,
          minMs,
          language
        },
        {
          onPhase: (p) => setPhase(p),
          onProgress: (done, total) => setProgress({ done, total }),
          shouldCancel: () => cancelRef.current
        }
      )
    } catch (err) {
      setBusy(false)
      setPhase('error')
      setError(
        err instanceof Error
          ? err.message
          : '자동 편집에 실패했습니다. 잠시 후 다시 시도해주세요'
      )
      return
    }

    setBusy(false)
    setSummary(result)

    if (cancelRef.current) {
      setPhase('cancelled')
      return
    }
    setPhase('done')
    onComplete(result)
  }, [
    removeSilence,
    generateCaptions,
    noiseDb,
    minMs,
    language,
    onComplete
  ])

  const focusTrapRef = useFocusTrap<HTMLDivElement>(open)

  if (!open) return null

  const canStart =
    hasMedia && !busy && (removeSilence || generateCaptions)

  const progressPercent =
    progress.total > 0
      ? Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)))
      : phase === 'done'
        ? 100
        : 0

  const showProgress = busy || phase === 'done' || phase === 'cancelled'

  return (
    <div
      style={styles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) handleClose()
      }}
      data-testid="autoedit-dialog"
    >
      <div
        ref={focusTrapRef}
        style={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="autoedit-dialog-title"
      >
        <div style={styles.header}>
          <div id="autoedit-dialog-title" style={styles.title}>AI 자동 편집</div>
          <button
            type="button"
            onClick={handleClose}
            style={styles.closeBtn}
            data-testid="autoedit-close"
            disabled={busy}
          >
            닫기
          </button>
        </div>

        <div style={styles.body}>
          {!hasMedia && (
            <div style={styles.emptyState} data-testid="autoedit-empty">
              타임라인에 영상이나 오디오가 없습니다. 먼저 미디어를
              추가해주세요.
            </div>
          )}

          {/* PRIMARY track — read-only. */}
          <div>
            <div style={styles.fieldLabel}>주 트랙</div>
            <div style={styles.trackLabel} data-testid="autoedit-primary-track">
              {primaryTrackName ?? '없음'}
            </div>
          </div>

          {multiTrack && (
            <div
              style={styles.warning}
              data-testid="autoedit-multitrack-warning"
            >
              여러 트랙에 미디어가 있습니다. 자동 러프컷은 주 트랙(
              {primaryTrackName})에만 적용되며 다른 트랙은 그대로 유지됩니다.
            </div>
          )}

          {/* 무음 제거 toggle. */}
          <label style={styles.toggleRow}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={removeSilence}
              onChange={(e) => setRemoveSilence(e.target.checked)}
              data-testid="autoedit-toggle-silence"
              disabled={busy}
            />
            <span style={styles.toggleTexts}>
              <span style={styles.toggleTitle}>무음 제거</span>
              <span style={styles.toggleHint}>
                주 트랙 전체에서 무음 구간을 찾아 잘라내고 빈틈을 메웁니다.
              </span>
            </span>
          </label>

          {/* 자동 자막 toggle (+ language select). */}
          <div>
            <label style={styles.toggleRow}>
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={generateCaptions}
                onChange={(e) => setGenerateCaptions(e.target.checked)}
                data-testid="autoedit-toggle-captions"
                disabled={busy}
              />
              <span style={styles.toggleTexts}>
                <span style={styles.toggleTitle}>자동 자막도 생성</span>
                <span style={styles.toggleHint}>
                  러프컷 후 주 트랙 첫 영상의 음성을 자막으로 변환합니다.
                </span>
              </span>
            </label>
            {generateCaptions && (
              <select
                style={styles.select}
                value={language}
                onChange={(e) => setLanguage(e.target.value as SttLanguage)}
                data-testid="autoedit-language-select"
                disabled={busy}
                aria-label="자막 언어"
              >
                {LANGUAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Advanced — silence detection thresholds. */}
          <details style={styles.details}>
            <summary style={styles.summary}>고급 설정</summary>
            <div style={styles.sliderRow}>
              <span style={styles.sliderLabel}>임계값 (dB)</span>
              <input
                type="range"
                min={-50}
                max={-10}
                step={1}
                value={noiseDb}
                onChange={(e) => setNoiseDb(Number(e.target.value))}
                style={styles.slider}
                data-testid="autoedit-noise-slider"
                disabled={busy}
              />
              <span
                style={styles.sliderValue}
                data-testid="autoedit-noise-value"
              >
                {noiseDb} dB
              </span>
            </div>
            <div style={styles.sliderRow}>
              <span style={styles.sliderLabel}>최소 무음 길이</span>
              <input
                type="range"
                min={200}
                max={2000}
                step={50}
                value={minMs}
                onChange={(e) => setMinMs(Number(e.target.value))}
                style={styles.slider}
                data-testid="autoedit-min-slider"
                disabled={busy}
              />
              <span style={styles.sliderValue} data-testid="autoedit-min-value">
                {minMs} ms
              </span>
            </div>
          </details>

          {error && (
            <div style={styles.error} data-testid="autoedit-error">
              {error}
            </div>
          )}
        </div>

        <div style={styles.footer}>
          <button
            type="button"
            style={styles.ghostBtn}
            onClick={handleClose}
            disabled={busy}
          >
            취소
          </button>
          {removeSilence && silencePreview && (
            <div
              data-testid="autoedit-silence-preview"
              style={{
                marginRight: 'auto',
                color: '#94a3b8',
                fontSize: 11,
                lineHeight: 1.3,
                opacity: silencePreview.loading ? 0.5 : 1
              }}
            >
              {silencePreview.loading
                ? '예상 분석 중…'
                : `예상 제거: ${silencePreview.count}구간 · 약 ${(
                    silencePreview.totalMs / 1000
                  ).toFixed(1)}초 (첫 클립 기준)`}
            </div>
          )}
          <button
            type="button"
            style={canStart ? styles.primaryBtn : styles.primaryBtnDisabled}
            onClick={() => void handleStart()}
            disabled={!canStart}
            data-testid="autoedit-start"
            title={
              hasMedia
                ? '자동 러프컷 시작'
                : '타임라인에 미디어가 필요합니다'
            }
          >
            자동 편집 시작
          </button>
        </div>

        {showProgress && (
          <div style={styles.progressOverlay} data-testid="autoedit-progress">
            <div>{phaseLabel(phase)}</div>
            {busy && progress.total > 0 && (
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {progress.done} / {progress.total} 클립
              </div>
            )}
            <div style={styles.progressTrack}>
              <div
                style={{
                  ...styles.progressFill,
                  width: `${progressPercent}%`
                }}
                data-testid="autoedit-progress-fill"
                data-percent={progressPercent}
              />
            </div>

            {busy && isBusyPhase(phase) && (
              <button
                type="button"
                style={styles.ghostBtn}
                onClick={handleCancel}
                data-testid="autoedit-cancel"
              >
                취소
              </button>
            )}

            {!busy && summary && (
              <>
                <div style={styles.summaryBox} data-testid="autoedit-summary">
                  {phase === 'cancelled' && (
                    <div style={{ color: '#fbbf24', marginBottom: 4 }}>
                      편집이 취소되었습니다 (이미 처리된 부분은 적용됨)
                    </div>
                  )}
                  {summary.rangesRemoved}개 구간 ·{' '}
                  {(summary.msRemoved / 1000).toFixed(1)}초 제거됨
                  {generateCaptions && (
                    <div>자막 {summary.captionsAdded}개 생성</div>
                  )}
                  <div
                    style={{ marginTop: 6, color: '#94a3b8', fontSize: 11 }}
                    data-testid="autoedit-undo-hint"
                  >
                    되돌릴 수 있어요 · Ctrl+Z
                  </div>
                </div>
                <button
                  type="button"
                  style={styles.primaryBtn}
                  onClick={onClose}
                  data-testid="autoedit-done-close"
                >
                  닫기
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
