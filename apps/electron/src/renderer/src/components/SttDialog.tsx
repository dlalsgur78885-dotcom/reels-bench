/**
 * 자동 자막 STT — transcribe a clip's (or the whole timeline's) audio into
 * timed caption clips via the main-process STT engine (Spec §3b).
 *
 * Structure/styling mirrors `PrefillDialog.tsx`: a fixed backdrop, a dark
 * modal, and an absolutely-positioned progress overlay. All styling is inline
 * (dark theme) — no CSS module dependency.
 *
 * Flow:
 *   1. On open → `stt.modelStatus()` to decide whether to surface the
 *      "first run downloads the model" notice.
 *   2. User picks a SOURCE (selected clip / whole timeline), LANGUAGE, and
 *      hits START.
 *   3. We generate a ulid jobId, subscribe `stt.onProgress`, and call
 *      `stt.transcribe`. The progress bar tracks `SttProgress.percent`.
 *   4. On success → `sttCuesToClips` + bulk `addCaptions`, then `onComplete`.
 *   5. Errors keep the dialog open for retry; CANCEL / close-while-busy both
 *      call `stt.cancel` and unsubscribe.
 *
 * Mock-friendly: the dialog never inspects IPC internals — it only awaits
 * `stt.transcribe`'s `SttResult` and reads `SttProgress` events. An e2e mock
 * that resolves `stt:transcribe` with a canned `SttResult` (and optionally
 * emits a couple of progress events) drives the whole UI.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import type {
  SttErrorCode,
  SttLanguage,
  SttPhase,
  SttProgress,
  SttResult
} from '../../../shared/ipc'
import { isMediaClip, type VideoAudioClip } from '../../../shared/project'
import { newId, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import { sttCuesToClips } from '../lib/sttToClips'

interface SttDialogProps {
  open: boolean
  onClose: () => void
  /** Called with the number of caption clips inserted on success. */
  onComplete: (count: number) => void
}

type SourceKind = 'clip' | 'timeline'

/** A resolved transcription target — what we actually pass to `stt.transcribe`. */
interface ResolvedSource {
  sourcePath: string
  startMs?: number
  endMs?: number
}

// ---------------------------------------------------------------------------
// Source resolution helpers.
// ---------------------------------------------------------------------------

/**
 * Resolve the currently-selected timeline clip to a transcribable source:
 * the first selected clip must be a media (video/audio) clip whose media has
 * a path. We transcribe the clip's trimmed sub-range (trimInMs/trimOutMs).
 */
function resolveSelectedClip(): ResolvedSource | null {
  const sel = useTimelineUi.getState().selectedClipIds
  const firstId = sel.size > 0 ? (sel.values().next().value ?? null) : null
  if (!firstId) return null

  const project = useProjectStore.getState().project
  let clip: VideoAudioClip | null = null
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.id === firstId && isMediaClip(c)) {
        clip = c
        break
      }
    }
    if (clip) break
  }
  if (!clip) return null

  const media = project.media[clip.mediaId]
  if (!media || !media.path) return null

  return {
    sourcePath: media.path,
    startMs: Math.max(0, Math.round(clip.trimInMs)),
    endMs: Math.max(0, Math.round(clip.trimOutMs))
  }
}

/**
 * Resolve the whole-timeline source: the first video track's first media
 * clip's underlying media path. Transcribe the entire file (no startMs/endMs).
 */
function resolveTimelineSource(): ResolvedSource | null {
  const project = useProjectStore.getState().project
  for (const t of project.tracks) {
    if (t.kind !== 'video') continue
    for (const c of t.clips) {
      if (isMediaClip(c)) {
        const media = project.media[c.mediaId]
        if (media && media.path) return { sourcePath: media.path }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Localization.
// ---------------------------------------------------------------------------

function phaseLabel(p: SttProgress | null): string {
  if (!p) return '준비 중…'
  switch (p.phase) {
    case 'preparing':
      return '준비 중…'
    case 'downloading-model': {
      const dl = p.modelBytesDownloaded
      const total = p.modelBytesTotal
      const pct =
        dl != null && total != null && total > 0
          ? Math.round((dl / total) * 100)
          : Math.round(p.percent)
      return `음성 모델 다운로드 중… (${pct}%)`
    }
    case 'extracting-audio':
      return '오디오 추출 중…'
    case 'transcribing':
      return `자막 생성 중… (${Math.round(p.percent)}%)`
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

function errorMessage(code: SttErrorCode): string {
  switch (code) {
    case 'no_audio':
      return '선택한 구간에 음성이 없습니다'
    case 'model_download_failed':
    case 'model_checksum_failed':
      return '음성 모델을 내려받지 못했습니다. 네트워크를 확인해주세요'
    case 'binary_missing':
    case 'unsupported_platform':
      return '이 기능은 Windows에서만 지원됩니다'
    case 'timeout':
      return '시간이 초과되었습니다'
    case 'queue_full':
      return '이미 자막 생성이 진행 중입니다'
    default:
      return '자막 생성에 실패했습니다. 잠시 후 다시 시도해주세요'
  }
}

/** Phases during which a job is actively running (cancellable). */
function isBusyPhase(phase: SttPhase): boolean {
  return (
    phase === 'preparing' ||
    phase === 'downloading-model' ||
    phase === 'extracting-audio' ||
    phase === 'transcribing'
  )
}

// ---------------------------------------------------------------------------
// Styles — mirror PrefillDialog's dark inline theme.
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
  // padding bumped 4→8 vertical — WCAG 2.5.5 (24×24 min target).
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
    gap: 18
  } as React.CSSProperties,
  fieldLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#cbd5e1',
    marginBottom: 8
  } as React.CSSProperties,
  segmented: {
    display: 'flex',
    gap: 8
  } as React.CSSProperties,
  segmentBase: {
    flex: 1,
    textAlign: 'center',
    padding: '10px 8px',
    borderRadius: 8,
    border: '1px solid #2a2a2a',
    background: '#1a1a1a',
    color: '#e2e8f0',
    fontSize: 12,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: 4
  } as React.CSSProperties,
  segmentActive: {
    border: '1px solid #6366f1',
    background: '#1e1b3a'
  } as React.CSSProperties,
  segmentDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed'
  } as React.CSSProperties,
  segmentHint: {
    fontSize: 10,
    color: '#64748b'
  } as React.CSSProperties,
  select: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 13,
    width: '100%'
  } as React.CSSProperties,
  modelLabel: {
    background: '#0d0d0d',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 13
  } as React.CSSProperties,
  notice: {
    fontSize: 11,
    color: '#94a3b8',
    background: '#0d1117',
    border: '1px solid #1f2937',
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
  } as React.CSSProperties
}

const LANGUAGE_OPTIONS: ReadonlyArray<{ value: SttLanguage; label: string }> = [
  { value: 'auto', label: '자동 감지 (auto)' },
  { value: 'ko', label: '한국어 (ko)' },
  { value: 'en', label: 'English (en)' }
]

export function SttDialog({
  open,
  onClose,
  onComplete
}: SttDialogProps): JSX.Element | null {
  const [source, setSource] = useState<SourceKind>('clip')
  const [language, setLanguage] = useState<SttLanguage>('auto')
  const [progress, setProgress] = useState<SttProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modelPresent, setModelPresent] = useState<boolean | null>(null)

  // The job is "busy" once START fires and until it resolves/cancels/errors.
  const [busy, setBusy] = useState(false)
  const jobIdRef = useRef<string | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  // Snapshot of source availability — recomputed each render while open so
  // the segmented control reflects the live selection.
  const clipSource = open ? resolveSelectedClip() : null
  const timelineSource = open ? resolveTimelineSource() : null
  const clipEnabled = clipSource != null
  const timelineEnabled = timelineSource != null
  const hasAnySource = clipEnabled || timelineEnabled

  // Reset transient state every time the dialog opens.
  useEffect(() => {
    if (!open) return
    setProgress(null)
    setError(null)
    setBusy(false)
    setModelPresent(null)
    // Prefer a usable default: clip if a media clip is selected, else timeline.
    setSource(resolveSelectedClip() != null ? 'clip' : 'timeline')

    let cancelled = false
    void window.electron.stt
      .modelStatus()
      .then((status) => {
        if (!cancelled) setModelPresent(status.present)
      })
      .catch(() => {
        // modelStatus failing is non-fatal — just skip the notice.
        if (!cancelled) setModelPresent(true)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Cleanup: unsubscribe + cancel any running job if the component unmounts
  // (or `open` flips false) while a job is in flight.
  useEffect(() => {
    return () => {
      const jid = jobIdRef.current
      if (jid) {
        void window.electron.stt.cancel(jid).catch(() => {})
        jobIdRef.current = null
      }
      if (unsubRef.current) {
        unsubRef.current()
        unsubRef.current = null
      }
    }
  }, [])

  const teardown = useCallback((): void => {
    if (unsubRef.current) {
      unsubRef.current()
      unsubRef.current = null
    }
    jobIdRef.current = null
  }, [])

  // Close handler — if a job is running, cancel it first.
  const handleClose = useCallback((): void => {
    const jid = jobIdRef.current
    if (jid) {
      void window.electron.stt.cancel(jid).catch(() => {})
    }
    teardown()
    setBusy(false)
    setProgress(null)
    onClose()
  }, [onClose, teardown])

  const handleStart = useCallback(async (): Promise<void> => {
    setError(null)

    const resolved = source === 'clip' ? clipSource : timelineSource
    if (!resolved) {
      setError('자막을 생성할 음성 소스를 찾지 못했습니다')
      return
    }

    const jobId = newId()
    jobIdRef.current = jobId
    setBusy(true)
    setProgress({ jobId, phase: 'preparing', percent: 0 })

    // Subscribe to progress for THIS job only.
    const unsub = window.electron.stt.onProgress((e: SttProgress) => {
      if (e.jobId !== jobId) return
      setProgress(e)
    })
    unsubRef.current = unsub

    let result: SttResult
    try {
      result = await window.electron.stt.transcribe({
        jobId,
        sourcePath: resolved.sourcePath,
        startMs: resolved.startMs,
        endMs: resolved.endMs,
        language,
        model: 'base',
        // Word-granularity so `result.words` is populated — enables karaoke
        // (word-level highlight) on the generated captions.
        granularity: 'word'
      })
    } catch (err) {
      teardown()
      setBusy(false)
      setProgress(null)
      setError(
        err instanceof Error
          ? err.message
          : '자막 생성에 실패했습니다. 잠시 후 다시 시도해주세요'
      )
      return
    }

    teardown()

    if (!result.ok) {
      setBusy(false)
      setProgress(null)
      if (result.code === 'cancelled') {
        // Silently return to the form — user cancelled on purpose.
        return
      }
      setError(errorMessage(result.code))
      return
    }

    // Success — convert cues → caption clips and bulk-insert (one undo step).
    // `result.words` (word granularity) threads through so STT captions get
    // per-word timing + karaoke-on by default.
    const clips = sttCuesToClips(result.cues, result.words)
    if (clips.length > 0) {
      useProjectStore.getState().addCaptions(clips)
    }
    setBusy(false)
    setProgress(null)
    onComplete(clips.length)
    onClose()
  }, [source, clipSource, timelineSource, language, teardown, onComplete, onClose])

  const handleCancel = useCallback((): void => {
    const jid = jobIdRef.current
    if (jid) {
      void window.electron.stt.cancel(jid).catch(() => {})
    }
    // The transcribe() promise will still resolve (with code:'cancelled' or a
    // rejection) — that path tears down + resets. Nothing else to do here.
  }, [])

  const focusTrapRef = useFocusTrap<HTMLDivElement>(open)

  if (!open) return null

  const showProgress = busy && progress != null
  const progressPercent = progress
    ? Math.max(0, Math.min(100, Math.round(progress.percent)))
    : 0
  const canStart = hasAnySource && !busy

  return (
    <div
      style={styles.backdrop}
      onClick={(e) => {
        // Backdrop click closes — but never while a job is running.
        if (e.target === e.currentTarget && !busy) handleClose()
      }}
      data-testid="stt-dialog"
    >
      <div
        ref={focusTrapRef}
        style={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stt-dialog-title"
      >
        <div style={styles.header}>
          <div id="stt-dialog-title" style={styles.title}>자동 자막 생성</div>
          <button
            type="button"
            onClick={handleClose}
            style={styles.closeBtn}
            data-testid="stt-close"
            disabled={busy}
          >
            닫기
          </button>
        </div>

        <div style={styles.body}>
          {!hasAnySource && (
            <div style={styles.emptyState} data-testid="stt-empty">
              타임라인에 영상이나 오디오가 없습니다. 먼저 미디어를
              추가해주세요.
            </div>
          )}

          {modelPresent === false && (
            <div style={styles.notice} data-testid="stt-model-notice">
              최초 실행 시 음성 모델(약 142MB)을 내려받습니다.
            </div>
          )}

          {/* SOURCE picker */}
          <div>
            <div style={styles.fieldLabel}>음성 소스</div>
            <div style={styles.segmented}>
              <div
                role="radio"
                aria-checked={source === 'clip'}
                aria-disabled={!clipEnabled}
                data-testid="stt-source-clip"
                style={{
                  ...styles.segmentBase,
                  ...(source === 'clip' && clipEnabled
                    ? styles.segmentActive
                    : {}),
                  ...(clipEnabled ? {} : styles.segmentDisabled)
                }}
                onClick={() => {
                  if (clipEnabled) setSource('clip')
                }}
              >
                <span>선택한 클립</span>
                <span style={styles.segmentHint}>
                  {clipEnabled
                    ? '선택한 구간만 변환'
                    : '미디어 클립을 먼저 선택하세요'}
                </span>
              </div>
              <div
                role="radio"
                aria-checked={source === 'timeline'}
                aria-disabled={!timelineEnabled}
                data-testid="stt-source-timeline"
                style={{
                  ...styles.segmentBase,
                  ...(source === 'timeline' && timelineEnabled
                    ? styles.segmentActive
                    : {}),
                  ...(timelineEnabled ? {} : styles.segmentDisabled)
                }}
                onClick={() => {
                  if (timelineEnabled) setSource('timeline')
                }}
              >
                <span>전체 타임라인</span>
                <span style={styles.segmentHint}>
                  {timelineEnabled
                    ? '첫 영상 전체를 변환'
                    : '타임라인에 영상이 없습니다'}
                </span>
              </div>
            </div>
          </div>

          {/* LANGUAGE select */}
          <div>
            <div style={styles.fieldLabel}>언어</div>
            <select
              style={styles.select}
              value={language}
              onChange={(e) => setLanguage(e.target.value as SttLanguage)}
              data-testid="stt-language-select"
              disabled={busy}
            >
              {LANGUAGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* MODEL — read-only */}
          <div>
            <div style={styles.fieldLabel}>음성 모델</div>
            <div style={styles.modelLabel}>표준 (base)</div>
          </div>

          {error && (
            <div style={styles.error} data-testid="stt-error">
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
            style={canStart ? styles.primaryBtn : styles.primaryBtnDisabled}
            onClick={() => void handleStart()}
            disabled={!canStart}
            data-testid="stt-start"
            title={
              hasAnySource
                ? '자막 생성 시작'
                : '타임라인에 미디어가 필요합니다'
            }
          >
            자막 생성 시작
          </button>
        </div>

        {showProgress && (
          <div style={styles.progressOverlay} data-testid="stt-progress">
            <div>{phaseLabel(progress)}</div>
            <div style={styles.progressTrack}>
              <div
                style={{
                  ...styles.progressFill,
                  width: `${progressPercent}%`
                }}
                data-testid="stt-progress-fill"
                data-percent={progressPercent}
              />
            </div>
            {progress && isBusyPhase(progress.phase) && (
              <button
                type="button"
                style={styles.ghostBtn}
                onClick={handleCancel}
                data-testid="stt-cancel"
              >
                취소
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
