import { useCallback, useEffect, useState } from 'react'
import type { SilenceRange } from '../../../shared/ipc'
import { isMediaClip, type Project } from '../../../shared/project'
import { useProjectStore } from '../store/project'

interface SilenceRemoveDialogProps {
  project: Project
  clipId: string
  onClose: () => void
}

const styles = {
  scrim: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  } as React.CSSProperties,
  modal: {
    width: 420,
    background: '#141414',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: 18,
    color: '#f5f5f5',
    fontSize: 12,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12
  } as React.CSSProperties,
  title: { fontSize: 14, fontWeight: 600 } as React.CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8
  } as React.CSSProperties,
  label: { flex: '0 0 120px', color: '#9aa0a6' } as React.CSSProperties,
  slider: { flex: 1 } as React.CSSProperties,
  value: { width: 64, textAlign: 'right' as const } as React.CSSProperties,
  btn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '6px 12px',
    cursor: 'pointer'
  } as React.CSSProperties,
  primary: {
    background: '#10b981',
    border: '1px solid #10b981',
    color: '#04231a',
    fontWeight: 600
  } as React.CSSProperties,
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8
  } as React.CSSProperties,
  meta: { color: '#94a3b8' } as React.CSSProperties,
  err: { color: '#fca5a5' } as React.CSSProperties
}

export function SilenceRemoveDialog(
  props: SilenceRemoveDialogProps
): JSX.Element {
  const { project, clipId, onClose } = props
  const removeSilencesFromClip = useProjectStore(
    (s) => s.removeSilencesFromClip
  )

  const [noiseDb, setNoiseDb] = useState(-30)
  const [minMs, setMinMs] = useState(400)
  const [ranges, setRanges] = useState<SilenceRange[] | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clip = (() => {
    for (const t of project.tracks)
      for (const c of t.clips) if (c.id === clipId) return c
    return null
  })()
  const media = clip && isMediaClip(clip) ? project.media[clip.mediaId] : null

  const onAnalyze = useCallback(async () => {
    if (!media) return
    setAnalyzing(true)
    setError(null)
    try {
      const r = await window.electron.audio.detectSilence(media.path, {
        noiseDb,
        minMs
      })
      setRanges(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAnalyzing(false)
    }
  }, [media, noiseDb, minMs])

  const onApply = useCallback(() => {
    if (!clip || !isMediaClip(clip) || !ranges) return
    removeSilencesFromClip(clip.id, ranges)
    onClose()
  }, [clip, ranges, removeSilencesFromClip, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const totalSilenceMs = ranges
    ? ranges.reduce((acc, r) => acc + r.durationMs, 0)
    : 0
  const splitCount = ranges ? Math.max(0, ranges.length) : 0

  return (
    <div style={styles.scrim} onClick={onClose} data-testid="silence-dialog">
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.title}>무음 자동 제거</div>
        <div style={styles.row}>
          <span style={styles.label}>임계값 (dB)</span>
          <input
            type="range"
            min={-50}
            max={-10}
            step={1}
            value={noiseDb}
            onChange={(e) => setNoiseDb(Number(e.target.value))}
            style={styles.slider}
            data-testid="silence-noise-slider"
          />
          <span style={styles.value} data-testid="silence-noise-value">
            {noiseDb} dB
          </span>
        </div>
        <div style={styles.row}>
          <span style={styles.label}>최소 무음 길이</span>
          <input
            type="range"
            min={200}
            max={2000}
            step={50}
            value={minMs}
            onChange={(e) => setMinMs(Number(e.target.value))}
            style={styles.slider}
            data-testid="silence-min-slider"
          />
          <span style={styles.value} data-testid="silence-min-value">
            {minMs} ms
          </span>
        </div>
        <div style={styles.row}>
          <button
            type="button"
            style={styles.btn}
            onClick={onAnalyze}
            disabled={analyzing || !media}
            data-testid="silence-analyze-btn"
          >
            {analyzing ? '분석 중…' : '분석'}
          </button>
          {ranges && (
            <div style={styles.meta} data-testid="silence-summary">
              총 {(totalSilenceMs / 1000).toFixed(2)}초 · 무음 구간 {splitCount}개
            </div>
          )}
        </div>
        {error && (
          <div style={styles.err} data-testid="silence-error">
            {error}
          </div>
        )}
        <div style={styles.footer}>
          <button
            type="button"
            style={styles.btn}
            onClick={onClose}
            data-testid="silence-cancel-btn"
          >
            취소
          </button>
          <button
            type="button"
            style={{ ...styles.btn, ...styles.primary }}
            onClick={onApply}
            disabled={!ranges || ranges.length === 0}
            data-testid="silence-apply-btn"
          >
            적용
          </button>
        </div>
      </div>
    </div>
  )
}
