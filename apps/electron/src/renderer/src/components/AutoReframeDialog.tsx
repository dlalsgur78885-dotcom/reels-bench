/**
 * Phase 3.52 — Auto-Reframe dialog (faces → transform keyframes).
 *
 * Structure mirrors `AutoEditDialog.tsx`: fixed backdrop + dark modal +
 * absolutely-positioned multi-phase progress overlay with a cancel button.
 * One click runs the whole pipeline in `lib/autoReframe.ts`.
 *
 * The dialog never inspects MediaPipe internals — it only awaits
 * `runAutoReframe`. An e2e mock that injects
 * `window.__reelsAutoReframeMockDetector` drives the whole UI without
 * touching the network.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  runAutoReframe,
  type AutoReframePhase,
  type AutoReframeSummary
} from '../lib/autoReframe'

interface AutoReframeDialogProps {
  open: boolean
  onClose: () => void
  onComplete: (summary: AutoReframeSummary) => void
}

function phaseLabel(phase: AutoReframePhase): string {
  switch (phase) {
    case 'preparing':
      return '준비 중…'
    case 'loadingModel':
      return '얼굴 감지 모델 로딩 중…'
    case 'sampling':
      return '얼굴 추적 중…'
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

function isBusyPhase(p: AutoReframePhase): boolean {
  return p === 'preparing' || p === 'loadingModel' || p === 'sampling'
}

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
  closeBtn: {
    background: 'transparent',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '4px 10px',
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
  helperText: {
    fontSize: 12,
    color: '#94a3b8',
    lineHeight: 1.6
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
  numberRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10
  } as React.CSSProperties,
  numberInput: {
    width: 80,
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 13
  } as React.CSSProperties,
  error: {
    padding: '10px 12px',
    background: '#2a0d0d',
    border: '1px solid #4a1f1f',
    color: '#fca5a5',
    borderRadius: 6,
    fontSize: 12
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
  summaryBox: {
    fontSize: 13,
    color: '#cbd5e1',
    textAlign: 'center',
    lineHeight: 1.6
  } as React.CSSProperties
}

export function AutoReframeDialog({
  open,
  onClose,
  onComplete
}: AutoReframeDialogProps): JSX.Element | null {
  const [overwriteExisting, setOverwriteExisting] = useState(false)
  const [framesPerClip, setFramesPerClip] = useState(8)

  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<AutoReframePhase>('preparing')
  const [progress, setProgress] = useState<{
    done: number
    total: number
    name: string
  }>({ done: 0, total: 0, name: '' })
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<AutoReframeSummary | null>(null)
  const cancelRef = useRef(false)

  useEffect(() => {
    if (!open) return
    setBusy(false)
    setPhase('preparing')
    setProgress({ done: 0, total: 0, name: '' })
    setError(null)
    setSummary(null)
    cancelRef.current = false
  }, [open])

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
    setProgress({ done: 0, total: 0, name: '' })

    let result: AutoReframeSummary
    try {
      result = await runAutoReframe(
        {
          framesPerClip,
          preserveExisting: !overwriteExisting
        },
        {
          onPhase: (p) => setPhase(p),
          onProgress: (done, total, name) =>
            setProgress({ done, total, name }),
          shouldCancel: () => cancelRef.current
        }
      )
    } catch (err) {
      setBusy(false)
      setPhase('error')
      setError(
        err instanceof Error
          ? err.message
          : '자동 리프레임에 실패했습니다. 잠시 후 다시 시도해주세요'
      )
      return
    }

    setBusy(false)
    setSummary(result)
    if (cancelRef.current) {
      setPhase('cancelled')
      onComplete(result)
      return
    }
    setPhase('done')
    onComplete(result)
  }, [framesPerClip, overwriteExisting, onComplete])

  if (!open) return null

  const showProgress = busy || phase === 'done' || phase === 'cancelled'

  return (
    <div
      style={styles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) handleClose()
      }}
      data-testid="autoreframe-dialog-backdrop"
    >
      <div
        style={styles.modal}
        onClick={(e) => e.stopPropagation()}
        data-testid="autoreframe-dialog"
      >
        <div style={styles.header}>
          <div style={styles.title}>🎯 자동 리프레임</div>
          <button
            type="button"
            onClick={handleClose}
            style={styles.closeBtn}
            data-testid="autoreframe-close"
            disabled={busy}
          >
            닫기
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.helperText}>
            프로젝트의 영상에서 얼굴을 추적해 transform 키프레임을 자동
            생성합니다.
          </div>

          <label style={styles.toggleRow}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={overwriteExisting}
              onChange={(e) => setOverwriteExisting(e.target.checked)}
              data-testid="autoreframe-toggle-overwrite"
              disabled={busy}
            />
            <span style={styles.toggleTexts}>
              <span style={styles.toggleTitle}>기존 키프레임 덮어쓰기</span>
              <span style={styles.toggleHint}>
                이미 transform 키프레임이 있는 클립도 새로 만듭니다.
              </span>
            </span>
          </label>

          <div>
            <div style={styles.fieldLabel}>클립당 샘플 프레임 수</div>
            <div style={styles.numberRow}>
              <input
                type="number"
                min={2}
                max={24}
                step={1}
                value={framesPerClip}
                onChange={(e) =>
                  setFramesPerClip(
                    Math.max(
                      2,
                      Math.min(24, Math.floor(Number(e.target.value) || 8))
                    )
                  )
                }
                style={styles.numberInput}
                data-testid="autoreframe-frames-per-clip"
                disabled={busy}
                aria-label="클립당 샘플 프레임 수"
              />
              <span style={styles.toggleHint}>
                기본 8 · 2~24 사이로 조절 (많을수록 정확)
              </span>
            </div>
          </div>

          {error && (
            <div style={styles.error} data-testid="autoreframe-error">
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
          <button
            type="button"
            style={busy ? styles.primaryBtnDisabled : styles.primaryBtn}
            onClick={() => void handleStart()}
            disabled={busy}
            data-testid="autoreframe-start"
          >
            자동 리프레임 시작
          </button>
        </div>

        {showProgress && (
          <div style={styles.progressOverlay}>
            <div data-testid="autoreframe-phase">{phaseLabel(phase)}</div>
            {(busy || phase === 'done' || phase === 'cancelled') && (
              <div
                style={{ fontSize: 12, color: '#94a3b8' }}
                data-testid="autoreframe-progress"
              >
                {progress.done} / {progress.total}
                {progress.name ? ` · ${progress.name}` : ''}
              </div>
            )}
            {busy && isBusyPhase(phase) && (
              <button
                type="button"
                style={styles.ghostBtn}
                onClick={handleCancel}
                data-testid="autoreframe-cancel"
              >
                취소
              </button>
            )}
            {!busy && summary && (
              <>
                <div
                  style={styles.summaryBox}
                  data-testid="autoreframe-summary"
                >
                  {phase === 'cancelled' && (
                    <div style={{ color: '#fbbf24', marginBottom: 4 }}>
                      자동 리프레임이 취소되었습니다 (처리된 부분은 적용됨)
                    </div>
                  )}
                  리프레임 {summary.clipsReframed}개 · 얼굴 없음{' '}
                  {summary.clipsNoFace}개 · 보존 {summary.clipsPreserved}개
                </div>
                <button
                  type="button"
                  style={styles.primaryBtn}
                  onClick={onClose}
                  data-testid="autoreframe-done-close"
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
