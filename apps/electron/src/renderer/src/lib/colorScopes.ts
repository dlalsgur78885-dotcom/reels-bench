/**
 * Phase 3.59 — pure color-scope analyzers.
 *
 * No DOM, no canvas — just ImageData in, typed Uint8 grids out. The
 * `ColorScopes` component owns the source-frame capture, scope canvas, and
 * polling. These functions are deterministic and unit-testable in isolation.
 *
 * Three scopes, mirroring the color-grading toolset every NLE ships:
 *
 *   - WAVEFORM      X = source column  →  vertical strip = luma distribution
 *   - RGB PARADE    three side-by-side waveforms, one per R/G/B channel
 *   - VECTORSCOPE   X = U chroma, Y = V chroma  →  2D point cloud of hues
 *
 * Coordinate model: scope canvas origin is top-left (HTML canvas default).
 * Luma / channel value 0 sits at the BOTTOM of the scope; 255 at the TOP.
 * Vectorscope skips fully achromatic pixels (saturation == 0) to keep the
 * scope readable on B&W input.
 */

export interface ScopeSize {
  width: number
  height: number
}

/** Luma weights (Rec.601). Mirrors ffmpeg's default for `format=yuv420p`. */
const LUMA_R = 0.299
const LUMA_G = 0.587
const LUMA_B = 0.114

/**
 * Map an ImageData → a binary occupancy grid sized `scope`. A pixel is set
 * (=1) when at least one source pixel mapped to it. Output length =
 * scope.width * scope.height, row-major (top-left origin).
 *
 * NOTE: this is intentionally binary (not a heatmap). The component layer
 * paints a single foreground color over the grid; heatmap rendering would
 * need a counter grid + log scaling, which is overkill for a 200×120 scope
 * canvas.
 */
export function analyzeWaveform(
  image: ImageData,
  scope: ScopeSize
): Uint8Array {
  const out = new Uint8Array(scope.width * scope.height)
  if (scope.width <= 0 || scope.height <= 0) return out
  const { data, width: iw, height: ih } = image
  if (iw <= 0 || ih <= 0) return out
  const sw = scope.width
  const sh = scope.height
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const i = (y * iw + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b
      const sx = Math.min(sw - 1, Math.floor((x / iw) * sw))
      const sy = Math.min(
        sh - 1,
        Math.max(0, sh - 1 - Math.floor((luma / 255) * (sh - 1)))
      )
      out[sy * sw + sx] = 1
    }
  }
  return out
}

/**
 * RGB parade — three vertically-stacked waveforms over the SAME scope size.
 * Channel layout in the returned array:
 *   index 0..sw*sh        = R
 *   index sw*sh..2*sw*sh  = G
 *   index 2*sw*sh..3*sw*sh = B
 * (each `sw*sh`-long stripe is a binary occupancy grid like waveform).
 */
export function analyzeRgbParade(
  image: ImageData,
  scope: ScopeSize
): Uint8Array {
  const sw = scope.width
  const sh = scope.height
  const out = new Uint8Array(sw * sh * 3)
  if (sw <= 0 || sh <= 0) return out
  const { data, width: iw, height: ih } = image
  if (iw <= 0 || ih <= 0) return out
  const channelStride = sw * sh
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const i = (y * iw + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const sx = Math.min(sw - 1, Math.floor((x / iw) * sw))
      const syR = Math.min(
        sh - 1,
        Math.max(0, sh - 1 - Math.floor((r / 255) * (sh - 1)))
      )
      const syG = Math.min(
        sh - 1,
        Math.max(0, sh - 1 - Math.floor((g / 255) * (sh - 1)))
      )
      const syB = Math.min(
        sh - 1,
        Math.max(0, sh - 1 - Math.floor((b / 255) * (sh - 1)))
      )
      out[0 * channelStride + syR * sw + sx] = 1
      out[1 * channelStride + syG * sw + sx] = 1
      out[2 * channelStride + syB * sw + sx] = 1
    }
  }
  return out
}

/**
 * Vectorscope — UV chroma cloud. Center = (sw/2, sh/2); R/B/G/Cyan/Mg/Yl
 * scatter outward from there. Skips achromatic pixels (R≈G≈B within EPS) so
 * a B&W input doesn't pile a single bright dot at the center.
 *
 * U/V derived via Rec.601 conversion from RGB, scaled to scope coords.
 */
export function analyzeVectorscope(
  image: ImageData,
  scope: ScopeSize
): Uint8Array {
  const sw = scope.width
  const sh = scope.height
  const out = new Uint8Array(sw * sh)
  if (sw <= 0 || sh <= 0) return out
  const { data, width: iw, height: ih } = image
  if (iw <= 0 || ih <= 0) return out
  const ACHROMA_EPS = 2
  const cx = sw / 2
  const cy = sh / 2
  // BT.601 U/V components scaled to roughly ±112 (8-bit YCbCr range).
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const i = (y * iw + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const maxC = Math.max(r, g, b)
      const minC = Math.min(r, g, b)
      if (maxC - minC <= ACHROMA_EPS) continue
      const u = -0.14713 * r - 0.28886 * g + 0.436 * b
      const v = 0.615 * r - 0.51499 * g - 0.10001 * b
      // u/v range on 0..255 RGB extremes hits ~±157 (e.g. pure red → V≈156).
      // Scale by 160 so the most-saturated colors fit at the scope edge.
      const half = Math.min(cx, cy)
      const SCALE = 160
      const rawSx = Math.round(cx + (u / SCALE) * half)
      const rawSy = Math.round(cy - (v / SCALE) * half)
      const sx = Math.max(0, Math.min(sw - 1, rawSx))
      const sy = Math.max(0, Math.min(sh - 1, rawSy))
      out[sy * sw + sx] = 1
    }
  }
  return out
}
