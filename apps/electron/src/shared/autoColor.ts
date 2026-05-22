/**
 * Auto color correction — pure pixel-statistics analysis (Phase 3.15).
 *
 * One-tap "자동 보정": analyze a few decoded frames, derive a tasteful
 * correction, and write it into the existing 4-slider `ColorAdjust`. This
 * module is PURE — it takes `ImageData` and returns plain numbers, with no
 * video/DOM dependency — so it is fully unit-testable with synthetic pixels
 * (no headless video-decode hazard). The renderer glue that decodes frames
 * lives in `renderer/src/lib/autoColorAnalysis.ts`.
 */
import type { ColorAdjust } from './project'
import { AUTO_COLOR_MAX_MAGNITUDE } from './project'

/**
 * Minimal structural shape of a decoded RGBA frame — a `canvas` `ImageData`
 * satisfies this exactly. Declared locally so this pure module has no DOM-lib
 * dependency (it is also compiled by the main-process tsconfig).
 */
export interface RgbaImage {
  width: number
  height: number
  /** Row-major RGBA bytes, length `width * height * 4`. */
  data: Uint8ClampedArray
}

/** Per-frame / averaged pixel statistics, all in normalized 0..1 space. */
export interface FrameStats {
  /** Mean luma (Rec.601) over the sampled center region. */
  meanLuma: number
  /** 1st-percentile luma (black point). */
  lumaP1: number
  /** 99th-percentile luma (white point). */
  lumaP99: number
  /** Mean per-pixel saturation (max-min)/max over color-eligible pixels. */
  meanSaturation: number
  /** Mean R channel over color-eligible pixels (0..1). */
  meanR: number
  /** Mean G channel over color-eligible pixels (0..1). */
  meanG: number
  /** Mean B channel over color-eligible pixels (0..1). */
  meanB: number
  /** Count of color-eligible pixels used (0 ⇒ degenerate frame). */
  sampleCount: number
}

// --- Tuning constants (named + exported so tests can reason about them) -----
/** Target mean luma — slightly below 0.5 (content midpoints sit lower). */
export const TARGET_LUMA = 0.46
/** Target luma histogram spread (P99-P1); below this ⇒ add contrast. */
export const TARGET_SPREAD = 0.85
/** Target mean per-pixel saturation. */
export const TARGET_SAT = 0.42
/** R/B balance magnitude below this ⇒ no temperature nudge. */
export const RB_DEADBAND = 0.012
/** Computed slider magnitudes below this snap to 0 (keeps a good clip ≈ 0). */
export const MIN_AUTO_MAGNITUDE = 3

const BRIGHTNESS_GAIN = 220
const CONTRAST_GAIN = 180
const SATURATION_GAIN = 200
const TEMPERATURE_GAIN = 320
/** Luma at/below this = black bar / no color info — excluded from color stats. */
const NEAR_BLACK = 0.04
/** Luma at/above this = blown highlight — excluded from color stats. */
const NEAR_WHITE = 0.97

/**
 * A fully-neutral FrameStats — every field set so `statsToColorAdjust` yields
 * all-zero. Returned for a degenerate frame (no center pixels, or no
 * color-eligible content e.g. an all-black / all-white frame) — you cannot
 * meaningfully color-correct a frame with no content.
 */
export function neutralFrameStats(): FrameStats {
  return {
    meanLuma: TARGET_LUMA,
    lumaP1: 0,
    lumaP99: TARGET_SPREAD,
    meanSaturation: TARGET_SAT,
    meanR: 0.5,
    meanG: 0.5,
    meanB: 0.5,
    sampleCount: 0
  }
}

/**
 * Compute `FrameStats` from one decoded frame. Pure. Samples only the central
 * 80% rectangle (drops most letterbox / pillarbox bars) and, for color stats,
 * excludes near-black / near-white pixels (bars and blown highlights carry no
 * white-balance information). A frame with no color-eligible content returns
 * `neutralFrameStats()`.
 */
export function analyzeImageData(img: RgbaImage): FrameStats {
  const W = img.width
  const H = img.height
  const data = img.data
  if (W <= 0 || H <= 0) return neutralFrameStats()

  const x0 = Math.floor(W * 0.1)
  const x1 = Math.max(x0 + 1, Math.ceil(W * 0.9))
  const y0 = Math.floor(H * 0.1)
  const y1 = Math.max(y0 + 1, Math.ceil(H * 0.9))

  const hist = new Uint32Array(256)
  let lumaSum = 0
  let centerCount = 0
  let satSum = 0
  let rSum = 0
  let gSum = 0
  let bSum = 0
  let colorCount = 0

  for (let y = y0; y < y1 && y < H; y++) {
    for (let x = x0; x < x1 && x < W; x++) {
      const i = (y * W + x) * 4
      const r = data[i] / 255
      const g = data[i + 1] / 255
      const b = data[i + 2] / 255
      const luma = 0.299 * r + 0.587 * g + 0.114 * b
      lumaSum += luma
      hist[Math.min(255, Math.max(0, Math.round(luma * 255)))]++
      centerCount++
      if (luma >= NEAR_BLACK && luma <= NEAR_WHITE) {
        const maxc = Math.max(r, g, b)
        const minc = Math.min(r, g, b)
        satSum += maxc > 1e-4 ? (maxc - minc) / maxc : 0
        rSum += r
        gSum += g
        bSum += b
        colorCount++
      }
    }
  }

  if (centerCount === 0 || colorCount === 0) return neutralFrameStats()

  // Luma percentiles from the histogram (over the full center region).
  const p1Target = centerCount * 0.01
  const p99Target = centerCount * 0.99
  let cum = 0
  let lumaP1 = 0
  let lumaP99 = 1
  let p1Done = false
  for (let bin = 0; bin < 256; bin++) {
    cum += hist[bin]
    if (!p1Done && cum >= p1Target) {
      lumaP1 = bin / 255
      p1Done = true
    }
    if (cum >= p99Target) {
      lumaP99 = bin / 255
      break
    }
  }

  return {
    meanLuma: lumaSum / centerCount,
    lumaP1,
    lumaP99,
    meanSaturation: satSum / colorCount,
    meanR: rSum / colorCount,
    meanG: gSum / colorCount,
    meanB: bSum / colorCount,
    sampleCount: colorCount
  }
}

/**
 * Average a list of per-frame stats into one. Raw statistics are averaged (not
 * the final slider values) so percentiles stay meaningful. An empty list
 * returns `neutralFrameStats()`.
 */
export function averageFrameStats(list: FrameStats[]): FrameStats {
  if (list.length === 0) return neutralFrameStats()
  const n = list.length
  let meanLuma = 0
  let lumaP1 = 0
  let lumaP99 = 0
  let meanSaturation = 0
  let meanR = 0
  let meanG = 0
  let meanB = 0
  let sampleCount = 0
  for (const s of list) {
    meanLuma += s.meanLuma
    lumaP1 += s.lumaP1
    lumaP99 += s.lumaP99
    meanSaturation += s.meanSaturation
    meanR += s.meanR
    meanG += s.meanG
    meanB += s.meanB
    sampleCount += s.sampleCount
  }
  return {
    meanLuma: meanLuma / n,
    lumaP1: lumaP1 / n,
    lumaP99: lumaP99 / n,
    meanSaturation: meanSaturation / n,
    meanR: meanR / n,
    meanG: meanG / n,
    meanB: meanB / n,
    sampleCount
  }
}

/** Clamp to the auto magnitude cap and round to an integer. */
function clampAuto(v: number): number {
  const n = Number.isFinite(v) ? v : 0
  return Math.round(
    Math.min(AUTO_COLOR_MAX_MAGNITUDE, Math.max(-AUTO_COLOR_MAX_MAGNITUDE, n))
  )
}

/** Snap sub-threshold magnitudes to 0 so an already-good clip yields ≈ neutral. */
function deadband(v: number): number {
  return Math.abs(v) < MIN_AUTO_MAGNITUDE ? 0 : v
}

/**
 * Map averaged frame statistics → the 4 signed `ColorAdjust` sliders, each an
 * integer auto-capped to ±`AUTO_COLOR_MAX_MAGNITUDE`. Heuristics:
 *  - brightness: pull mean luma toward `TARGET_LUMA`.
 *  - contrast: a flat luma histogram (narrow P1..P99) gets positive contrast;
 *    the negative side is held shallow (reducing contrast rarely helps).
 *  - saturation: dull → positive, oversaturated → negative.
 *  - temperature: gray-world white balance from R vs. B mean (+ = warmer);
 *    a near-neutral balance gets no nudge (dead-band).
 */
export function statsToColorAdjust(stats: FrameStats): ColorAdjust {
  const brightness = deadband(
    clampAuto((TARGET_LUMA - stats.meanLuma) * BRIGHTNESS_GAIN)
  )

  const spread = stats.lumaP99 - stats.lumaP1
  let contrast = clampAuto((TARGET_SPREAD - spread) * CONTRAST_GAIN)
  contrast = deadband(Math.max(contrast, -25))

  const saturation = deadband(
    clampAuto((TARGET_SAT - stats.meanSaturation) * SATURATION_GAIN)
  )

  const rbBalance = stats.meanB - stats.meanR
  const temperature =
    Math.abs(rbBalance) >= RB_DEADBAND
      ? deadband(clampAuto(rbBalance * TEMPERATURE_GAIN))
      : 0

  return { brightness, contrast, saturation, temperature }
}

// ---------------------------------------------------------------------------
// Color match (Phase 3.19) — grade a clip toward a REFERENCE clip's look.
// Same machinery as auto color, but each axis targets the reference's measured
// stat instead of a fixed neutral constant.
// ---------------------------------------------------------------------------

/** Computed match magnitudes below this snap to 0 — an already-similar clip
 *  yields ≈ neutral (no-op). */
export const MIN_MATCH_MAGNITUDE = 3

// Per-axis match gains — separate names so they tune independently from the
// auto-correct gains; seeded to the same values for parity.
const MATCH_BRIGHTNESS_GAIN = 220
const MATCH_CONTRAST_GAIN = 180
const MATCH_SATURATION_GAIN = 200
const MATCH_TEMPERATURE_GAIN = 320

/** Clamp to the auto magnitude cap and round — color match must stay tasteful. */
function clampMatch(v: number): number {
  const n = Number.isFinite(v) ? v : 0
  return Math.round(
    Math.min(AUTO_COLOR_MAX_MAGNITUDE, Math.max(-AUTO_COLOR_MAX_MAGNITUDE, n))
  )
}

/** Snap sub-threshold match magnitudes to 0. */
function deadbandMatch(v: number): number {
  return Math.abs(v) < MIN_MATCH_MAGNITUDE ? 0 : v
}

/**
 * Color match — map a target clip's frame stats toward a REFERENCE clip's
 * measured stats, producing a `ColorAdjust` that makes the target's grade
 * resemble the reference. Pure twin of `statsToColorAdjust`, but each axis
 * targets the reference's value, not a fixed neutral constant. Unlike auto
 * color, contrast is fully symmetric (matching a flatter reference legitimately
 * needs negative contrast). A degenerate reference (no color-eligible pixels)
 * yields identity — there is no grade to match. Matching identical stats yields
 * all-zero (dead-band). NOTE: matches the reference's RAW decoded footage —
 * any grade already applied to the reference clip (CSS-only preview) is not
 * reflected in its decoded pixels.
 */
export function statsToColorMatch(
  target: FrameStats,
  reference: FrameStats
): ColorAdjust {
  if (reference.sampleCount === 0) {
    return { brightness: 0, contrast: 0, saturation: 0, temperature: 0 }
  }

  const brightness = deadbandMatch(
    clampMatch((reference.meanLuma - target.meanLuma) * MATCH_BRIGHTNESS_GAIN)
  )

  const spreadT = target.lumaP99 - target.lumaP1
  const spreadR = reference.lumaP99 - reference.lumaP1
  const contrast = deadbandMatch(
    clampMatch((spreadR - spreadT) * MATCH_CONTRAST_GAIN)
  )

  const saturation = deadbandMatch(
    clampMatch(
      (reference.meanSaturation - target.meanSaturation) * MATCH_SATURATION_GAIN
    )
  )

  // Gray-world warm/cool balance: positive balance = bluer/cooler. If the
  // target is bluer than the reference it must warm UP → positive temperature.
  const balanceT = target.meanB - target.meanR
  const balanceR = reference.meanB - reference.meanR
  const balanceDelta = balanceT - balanceR
  const temperature =
    Math.abs(balanceDelta) >= RB_DEADBAND
      ? deadbandMatch(clampMatch(balanceDelta * MATCH_TEMPERATURE_GAIN))
      : 0

  return { brightness, contrast, saturation, temperature }
}
