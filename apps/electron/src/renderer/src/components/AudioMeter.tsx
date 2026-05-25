/**
 * Phase 3.58 — preview master audio meter.
 *
 * Polls `PreviewAudioGraph.getMasterLevels()` at ~20 Hz and renders two
 * horizontal bars (peak + RMS) in dBFS. Color encodes risk:
 *   - > -3 dBFS: red (clipping imminent)
 *   - -3..-12 dBFS: amber
 *   - <= -12 dBFS: green
 *
 * The meter is non-interactive — it's a passive monitor. When WebAudio
 * isn't ready (suspended context before user gesture / failed graph), both
 * bars render empty and the dB readout shows "−∞".
 */
import { useEffect, useState } from 'react'
import { getPreviewAudioGraph } from '../lib/audioGraph'
import { usePrefersReducedMotion } from '../lib/usePrefersReducedMotion'

const POLL_MS = 50 // 20 Hz — smooth enough for the eye, cheap for the CPU.
// When the user prefers reduced motion we drop to 5 Hz — the numeric dB
// readout is still accurate, just doesn't flicker every 50ms.
const POLL_MS_REDUCED = 200
const FLOOR_DB = -60 // bar scale floor
const CLIP_THRESHOLD_DB = -3 // > this = ⚠ shape indicator + hatched fill

function dbToBarPercent(db: number): number {
  if (!Number.isFinite(db)) return 0
  if (db <= FLOOR_DB) return 0
  if (db >= 0) return 100
  return ((db - FLOOR_DB) / (0 - FLOOR_DB)) * 100
}

function dbToColor(db: number): string {
  if (!Number.isFinite(db)) return '#22c55e'
  if (db > CLIP_THRESHOLD_DB) return '#ef4444' // red
  if (db > -12) return '#fbbf24' // amber
  return '#22c55e' // green
}

/**
 * Fill the meter bar with a diagonal hatched gradient ON TOP OF the base
 * color when clipping. The hatch is what color-blind users perceive as
 * "danger" — the red hue alone isn't enough (WCAG 1.4.1 forbids using
 * color as the only channel of information).
 */
function dbToBarBackground(db: number): string {
  const base = dbToColor(db)
  if (Number.isFinite(db) && db > CLIP_THRESHOLD_DB) {
    return `repeating-linear-gradient(45deg, ${base} 0 4px, #7f1d1d 4px 6px)`
  }
  return base
}

function formatDb(db: number): string {
  if (!Number.isFinite(db)) return '−∞'
  return db.toFixed(1)
}

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4
}
const TRACK_STYLE: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  height: 6,
  background: '#1f2937',
  borderRadius: 2,
  overflow: 'hidden'
}
const LABEL_STYLE: React.CSSProperties = {
  width: 24,
  textAlign: 'right',
  color: '#94a3b8'
}
const VALUE_STYLE: React.CSSProperties = {
  width: 36,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums'
}

export function AudioMeter(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const [levels, setLevels] = useState<{ peak: number; rms: number }>({
    peak: -Infinity,
    rms: -Infinity
  })

  useEffect(() => {
    let cancelled = false
    let timer = 0
    const pollMs = reducedMotion ? POLL_MS_REDUCED : POLL_MS
    const tick = (): void => {
      if (cancelled) return
      const l = getPreviewAudioGraph().getMasterLevels()
      setLevels(l)
      timer = window.setTimeout(tick, pollMs)
    }
    tick()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [reducedMotion])

  // When reduced is on the bar snaps to its new width instead of sliding.
  const barTransition = reducedMotion ? 'none' : 'width 50ms linear'
  const peakClipping =
    Number.isFinite(levels.peak) && levels.peak > CLIP_THRESHOLD_DB

  return (
    <div
      data-testid="audio-meter"
      title={`피크 ${formatDb(levels.peak)} dB · RMS ${formatDb(levels.rms)} dB`}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        gap: 2,
        padding: '4px 8px',
        background: '#0d0d0d',
        border: '1px solid #2a2a2a',
        borderRadius: 4,
        fontSize: 10,
        color: '#cbd5e1',
        minWidth: 132
      }}
    >
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE} aria-hidden="true">
          PK
        </span>
        <div
          style={TRACK_STYLE}
          role="meter"
          aria-label="피크 레벨 dBFS"
          aria-valuemin={FLOOR_DB}
          aria-valuemax={0}
          aria-valuenow={Number.isFinite(levels.peak) ? Math.round(levels.peak) : FLOOR_DB}
          aria-valuetext={`${formatDb(levels.peak)} dB${peakClipping ? ', 클리핑 위험' : ''}`}
        >
          <div
            data-testid="audio-meter-peak-bar"
            data-clipping={peakClipping ? 'true' : 'false'}
            style={{
              width: `${dbToBarPercent(levels.peak)}%`,
              height: '100%',
              background: dbToBarBackground(levels.peak),
              transition: barTransition
            }}
          />
        </div>
        <span
          style={{
            ...VALUE_STYLE,
            display: 'inline-flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 2
          }}
          data-testid="audio-meter-peak-db"
        >
          {peakClipping && (
            <span data-testid="audio-meter-clip-icon" aria-hidden="true">
              ⚠
            </span>
          )}
          {formatDb(levels.peak)}
        </span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE} aria-hidden="true">
          RMS
        </span>
        <div
          style={TRACK_STYLE}
          role="meter"
          aria-label="RMS 레벨 dBFS"
          aria-valuemin={FLOOR_DB}
          aria-valuemax={0}
          aria-valuenow={Number.isFinite(levels.rms) ? Math.round(levels.rms) : FLOOR_DB}
          aria-valuetext={`${formatDb(levels.rms)} dB`}
        >
          <div
            data-testid="audio-meter-rms-bar"
            style={{
              width: `${dbToBarPercent(levels.rms)}%`,
              height: '100%',
              background: dbToBarBackground(levels.rms),
              transition: barTransition
            }}
          />
        </div>
        <span style={VALUE_STYLE} data-testid="audio-meter-rms-db">
          {formatDb(levels.rms)}
        </span>
      </div>
    </div>
  )
}
