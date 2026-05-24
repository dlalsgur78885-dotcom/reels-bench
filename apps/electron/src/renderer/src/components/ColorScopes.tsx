/**
 * Phase 3.59 — preview color scopes (waveform / RGB parade / vectorscope).
 *
 * Default OFF. When the user clicks "스코프 ▾" the panel expands and
 * starts polling the first <video> element on the page (PreviewCanvas's
 * playback element) at ~5 Hz. Each tick:
 *
 *   1. drawImage(video) to a hidden capture canvas at a low working
 *      resolution (160×90) — the analyzers are O(W*H) so this keeps the
 *      cost flat regardless of the source's true resolution.
 *   2. Run the three pure analyzers from `lib/colorScopes.ts`.
 *   3. Paint each result into its own scope canvas.
 *
 * The capture / analyzer work is bounded — three 160×90 frame passes per
 * tick at 5 Hz is well under 1ms on modern hardware. The component
 * unmounts the polling loop when collapsed (no CPU cost when OFF).
 */
import { useEffect, useRef, useState } from 'react'
import {
  analyzeRgbParade,
  analyzeVectorscope,
  analyzeWaveform
} from '../lib/colorScopes'

type ScopeKind = 'waveform' | 'parade' | 'vectorscope'

const SCOPE_W = 200
const SCOPE_H = 120
const CAPTURE_W = 160
const CAPTURE_H = 90
const POLL_MS = 200 // ~5 Hz

const TOGGLE_BTN: React.CSSProperties = {
  background: '#1f2937',
  color: '#cbd5e1',
  border: '1px solid #374151',
  borderRadius: 4,
  padding: '3px 8px',
  fontSize: 10,
  cursor: 'pointer',
  fontWeight: 600
}

const PANEL: React.CSSProperties = {
  background: '#0d0d0d',
  border: '1px solid #2a2a2a',
  borderRadius: 4,
  padding: 6,
  display: 'flex',
  gap: 6,
  alignItems: 'flex-end',
  marginTop: 4
}

const SCOPE_BOX: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2
}

const SCOPE_LABEL: React.CSSProperties = {
  fontSize: 9,
  color: '#94a3b8',
  fontWeight: 600
}

function paintBinaryGrid(
  canvas: HTMLCanvasElement,
  data: Uint8Array,
  channelOffset: number,
  color: string
): void {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const img = ctx.createImageData(w, h)
  const buf = img.data
  // Parse "#rrggbb" → r/g/b ints. Stay defensive against shorthand.
  let r = 0
  let g = 0
  let b = 0
  if (color.length === 7 && color.startsWith('#')) {
    r = parseInt(color.slice(1, 3), 16)
    g = parseInt(color.slice(3, 5), 16)
    b = parseInt(color.slice(5, 7), 16)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = channelOffset + y * w + x
      const px = (y * w + x) * 4
      if (data[idx] === 1) {
        buf[px] = r
        buf[px + 1] = g
        buf[px + 2] = b
        buf[px + 3] = 255
      } else {
        buf[px + 3] = 0
      }
    }
  }
  ctx.clearRect(0, 0, w, h)
  ctx.putImageData(img, 0, 0)
}

function paintParade(
  canvas: HTMLCanvasElement,
  data: Uint8Array
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  // The analyzer packs 3 sub-grids of SCOPE_W*SCOPE_H. We blit the three
  // sub-grids side-by-side onto the parade canvas.
  const stride = SCOPE_W * SCOPE_H
  const subW = Math.floor(w / 3)
  const channels: Array<{ color: string; offset: number }> = [
    { color: '#ef4444', offset: 0 * stride },
    { color: '#22c55e', offset: 1 * stride },
    { color: '#3b82f6', offset: 2 * stride }
  ]
  channels.forEach(({ color, offset }, i) => {
    const sub = ctx.createImageData(subW, h)
    let R = 0
    let G = 0
    let B = 0
    if (color.startsWith('#') && color.length === 7) {
      R = parseInt(color.slice(1, 3), 16)
      G = parseInt(color.slice(3, 5), 16)
      B = parseInt(color.slice(5, 7), 16)
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < subW; x++) {
        // Map subcanvas col → source SCOPE_W col, same row.
        const sx = Math.min(SCOPE_W - 1, Math.floor((x / subW) * SCOPE_W))
        const sy = Math.min(
          SCOPE_H - 1,
          Math.floor((y / h) * SCOPE_H)
        )
        const idx = offset + sy * SCOPE_W + sx
        const px = (y * subW + x) * 4
        if (data[idx] === 1) {
          sub.data[px] = R
          sub.data[px + 1] = G
          sub.data[px + 2] = B
          sub.data[px + 3] = 255
        }
      }
    }
    ctx.putImageData(sub, i * subW, 0)
  })
}

export function ColorScopes(): JSX.Element {
  const [open, setOpen] = useState(false)
  const captureRef = useRef<HTMLCanvasElement | null>(null)
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const paradeCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const vectorCanvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let timer = 0
    if (!captureRef.current) {
      const c = document.createElement('canvas')
      c.width = CAPTURE_W
      c.height = CAPTURE_H
      captureRef.current = c
    }
    const cap = captureRef.current
    const capCtx = cap.getContext('2d', { willReadFrequently: true })

    const tick = (): void => {
      if (cancelled || !capCtx) return
      // Find the first <video> in the page (PreviewCanvas's playback el).
      const video = document.querySelector(
        'video'
      ) as HTMLVideoElement | null
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        try {
          capCtx.drawImage(video, 0, 0, CAPTURE_W, CAPTURE_H)
          const frame = capCtx.getImageData(0, 0, CAPTURE_W, CAPTURE_H)
          const waveGrid = analyzeWaveform(frame, {
            width: SCOPE_W,
            height: SCOPE_H
          })
          const paradeGrid = analyzeRgbParade(frame, {
            width: SCOPE_W,
            height: SCOPE_H
          })
          const vectorGrid = analyzeVectorscope(frame, {
            width: SCOPE_W,
            height: SCOPE_H
          })
          if (waveCanvasRef.current) {
            paintBinaryGrid(waveCanvasRef.current, waveGrid, 0, '#cbd5e1')
          }
          if (paradeCanvasRef.current) {
            paintParade(paradeCanvasRef.current, paradeGrid)
          }
          if (vectorCanvasRef.current) {
            paintBinaryGrid(
              vectorCanvasRef.current,
              vectorGrid,
              0,
              '#fbbf24'
            )
          }
        } catch {
          // CORS-tainted canvas or transient decode race — skip this tick.
        }
      }
      timer = window.setTimeout(tick, POLL_MS)
    }
    tick()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [open])

  return (
    <div data-testid="color-scopes" style={{ display: 'inline-block' }}>
      <button
        type="button"
        style={TOGGLE_BTN}
        onClick={() => setOpen((v) => !v)}
        data-testid="color-scopes-toggle"
        aria-pressed={open}
      >
        스코프 {open ? '▴' : '▾'}
      </button>
      {open && (
        <div style={PANEL} data-testid="color-scopes-panel">
          {(['waveform', 'parade', 'vectorscope'] as ScopeKind[]).map(
            (kind) => (
              <div key={kind} style={SCOPE_BOX}>
                <canvas
                  ref={
                    kind === 'waveform'
                      ? waveCanvasRef
                      : kind === 'parade'
                        ? paradeCanvasRef
                        : vectorCanvasRef
                  }
                  width={SCOPE_W}
                  height={SCOPE_H}
                  style={{
                    background: '#000',
                    border: '1px solid #1f2937',
                    width: SCOPE_W,
                    height: SCOPE_H
                  }}
                  data-testid={`color-scope-${kind}-canvas`}
                />
                <span style={SCOPE_LABEL}>
                  {kind === 'waveform'
                    ? 'Waveform'
                    : kind === 'parade'
                      ? 'RGB Parade'
                      : 'Vectorscope'}
                </span>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
