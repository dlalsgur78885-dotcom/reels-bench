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

const POLL_MS = 50 // 20 Hz — smooth enough for the eye, cheap for the CPU.
const FLOOR_DB = -60 // bar scale floor

function dbToBarPercent(db: number): number {
  if (!Number.isFinite(db)) return 0
  if (db <= FLOOR_DB) return 0
  if (db >= 0) return 100
  return ((db - FLOOR_DB) / (0 - FLOOR_DB)) * 100
}

function dbToColor(db: number): string {
  if (!Number.isFinite(db)) return '#22c55e'
  if (db > -3) return '#ef4444' // red
  if (db > -12) return '#fbbf24' // amber
  return '#22c55e' // green
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
  const [levels, setLevels] = useState<{ peak: number; rms: number }>({
    peak: -Infinity,
    rms: -Infinity
  })

  useEffect(() => {
    let cancelled = false
    let timer = 0
    const tick = (): void => {
      if (cancelled) return
      const l = getPreviewAudioGraph().getMasterLevels()
      setLevels(l)
      timer = window.setTimeout(tick, POLL_MS)
    }
    tick()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [])

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
        <span style={LABEL_STYLE}>PK</span>
        <div style={TRACK_STYLE}>
          <div
            data-testid="audio-meter-peak-bar"
            style={{
              width: `${dbToBarPercent(levels.peak)}%`,
              height: '100%',
              background: dbToColor(levels.peak),
              transition: 'width 50ms linear'
            }}
          />
        </div>
        <span style={VALUE_STYLE} data-testid="audio-meter-peak-db">
          {formatDb(levels.peak)}
        </span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>RMS</span>
        <div style={TRACK_STYLE}>
          <div
            data-testid="audio-meter-rms-bar"
            style={{
              width: `${dbToBarPercent(levels.rms)}%`,
              height: '100%',
              background: dbToColor(levels.rms),
              transition: 'width 50ms linear'
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
