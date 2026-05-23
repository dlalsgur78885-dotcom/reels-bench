/**
 * Filter preset definitions — shared between renderer (CSS approximation
 * for preview) and main (ffmpeg filter chains for export).
 *
 * Preview values are deliberately cheap; the real "look" is applied at export
 * via the `toFfmpegFilter()` helper which builds eq/hue/curves chains.
 */
import type {
  AdjustmentLayer,
  ClipCurves,
  ClipHsl,
  ColorAdjust,
  CurveChannelKey,
  CurvePoint,
  FilmLook,
  FilmToneId,
  FilterPreset,
  HslBandKey,
  VoiceEnhance
} from './project'
import {
  CURVE_CHANNEL_KEYS,
  HSL_BAND_KEYS,
  isIdentityCurveChannel,
  isNeutralHslBand,
  isNeutralVoiceEnhance,
  resolveClipCurves,
  resolveClipHsl,
  resolveColorAdjust
} from './project'

/** CSS `filter` string for the preview canvas. Returns empty for 'none'. */
export function filterPresetToCss(
  preset: FilterPreset | undefined,
  intensity = 1
): string {
  if (!preset || preset === 'none') return ''
  // Clamp intensity once.
  const t = Math.max(0, Math.min(1, intensity))
  // Each filter is "blended" via the intensity by interpolating each
  // CSS-filter parameter from its identity value (1 for saturate/contrast/
  // brightness, 0 for hue-rotate/sepia/grayscale) toward the preset target.
  const lerp = (target: number, identity: number): number =>
    identity + (target - identity) * t

  switch (preset) {
    case 'cinematic':
      // contrast(1.1) saturate(0.85) brightness(0.95)
      return `contrast(${lerp(1.1, 1).toFixed(3)}) saturate(${lerp(0.85, 1).toFixed(
        3
      )}) brightness(${lerp(0.95, 1).toFixed(3)})`
    case 'vibrant':
      return `saturate(${lerp(1.4, 1).toFixed(3)}) contrast(${lerp(1.1, 1).toFixed(
        3
      )})`
    case 'bw':
      return `grayscale(${lerp(1, 0).toFixed(3)}) contrast(${lerp(1.05, 1).toFixed(
        3
      )})`
    case 'vintage':
      return `sepia(${lerp(0.4, 0).toFixed(3)}) contrast(${lerp(0.95, 1).toFixed(
        3
      )}) saturate(${lerp(0.9, 1).toFixed(3)})`
    case 'cool':
      return `hue-rotate(${(-10 * t).toFixed(2)}deg) saturate(${lerp(0.95, 1).toFixed(
        3
      )})`
    case 'warm':
      return `hue-rotate(${(10 * t).toFixed(2)}deg) saturate(${lerp(1.1, 1).toFixed(
        3
      )}) brightness(${lerp(1.02, 1).toFixed(3)})`
    case 'golden-hour':
      return `hue-rotate(${(15 * t).toFixed(2)}deg) saturate(${lerp(1.2, 1).toFixed(
        3
      )}) brightness(${lerp(1.05, 1).toFixed(3)}) contrast(${lerp(1.05, 1).toFixed(
        3
      )})`
    default:
      return ''
  }
}

/**
 * Translate a filter preset to an ffmpeg filter-chain fragment (no leading /
 * trailing comma — caller chains it).
 *
 * We use `eq=` (contrast/brightness/saturation) + `hue=` (hue rotation in deg
 * + saturation multiplier) — both are part of every standard ffmpeg build and
 * don't require external LUT files.
 *
 * `intensity` linearly interpolates between identity values (so 0 → no-op,
 * 1 → full preset). Returns empty string for 'none' / unknown / intensity=0.
 */
export function filterPresetToFfmpeg(
  preset: FilterPreset | undefined,
  intensity = 1
): string {
  if (!preset || preset === 'none') return ''
  const t = Math.max(0, Math.min(1, intensity))
  if (t === 0) return ''
  const lerp = (target: number, identity: number): number =>
    identity + (target - identity) * t

  // ffmpeg eq=contrast=...:saturation=...:brightness=... — identity values:
  //   contrast=1, brightness=0 (range -1..1), saturation=1
  // hue=h=<deg>:s=<mult> — identity: h=0, s=1
  // Quote string is built without spaces in option values.
  switch (preset) {
    case 'cinematic': {
      const contrast = lerp(1.1, 1).toFixed(3)
      const saturation = lerp(0.85, 1).toFixed(3)
      const brightness = lerp(-0.05, 0).toFixed(3) // brightness range -1..1
      return `eq=contrast=${contrast}:saturation=${saturation}:brightness=${brightness}`
    }
    case 'vibrant': {
      const saturation = lerp(1.4, 1).toFixed(3)
      const contrast = lerp(1.1, 1).toFixed(3)
      return `eq=contrast=${contrast}:saturation=${saturation}`
    }
    case 'bw': {
      const saturation = lerp(0, 1).toFixed(3)
      const contrast = lerp(1.05, 1).toFixed(3)
      return `eq=saturation=${saturation}:contrast=${contrast}`
    }
    case 'vintage': {
      // Approximate sepia via hue rotation + reduced saturation + slight warm tint.
      // Combine: hue then eq.
      const hueDeg = (15 * t).toFixed(2)
      const saturation = lerp(0.65, 1).toFixed(3) // sepia(0.4) ≈ -35% saturation
      const contrast = lerp(0.95, 1).toFixed(3)
      return `hue=h=${hueDeg}:s=${saturation},eq=contrast=${contrast}`
    }
    case 'cool': {
      const hueDeg = (-10 * t).toFixed(2)
      const saturation = lerp(0.95, 1).toFixed(3)
      return `hue=h=${hueDeg}:s=${saturation}`
    }
    case 'warm': {
      const hueDeg = (10 * t).toFixed(2)
      const saturation = lerp(1.1, 1).toFixed(3)
      const brightness = lerp(0.02, 0).toFixed(3)
      return `hue=h=${hueDeg}:s=${saturation},eq=brightness=${brightness}`
    }
    case 'golden-hour': {
      const hueDeg = (15 * t).toFixed(2)
      const saturation = lerp(1.2, 1).toFixed(3)
      const brightness = lerp(0.05, 0).toFixed(3)
      const contrast = lerp(1.05, 1).toFixed(3)
      return `hue=h=${hueDeg}:s=${saturation},eq=brightness=${brightness}:contrast=${contrast}`
    }
    default:
      return ''
  }
}

export const FILTER_PRESET_LABELS: Record<FilterPreset, string> = {
  none: '없음',
  cinematic: '시네마틱',
  vibrant: '비비드',
  bw: '흑백',
  vintage: '빈티지',
  cool: '쿨',
  warm: '웜',
  'golden-hour': '골든 아워'
}

export const TRANSITION_LABELS: Record<string, string> = {
  none: '없음',
  crossfade: '크로스페이드',
  'slide-left': '왼쪽 슬라이드',
  'slide-right': '오른쪽 슬라이드',
  'fade-to-black': '검정으로 페이드',
  'zoom-in': '줌 인',
  glitch: '글리치'
}

/** ffmpeg xfade transition names. Maps our kind → xfade `transition=` value. */
export function transitionKindToXfade(kind: string): string {
  switch (kind) {
    case 'crossfade':
      return 'fade'
    case 'slide-left':
      return 'slideleft'
    case 'slide-right':
      return 'slideright'
    case 'fade-to-black':
      return 'fadeblack'
    case 'zoom-in':
      return 'zoomin'
    case 'glitch':
      // 'glitch' isn't a built-in xfade name; closest equivalent is 'pixelize'
      // or 'hblur' — we map to 'pixelize' for a chunky digital feel.
      return 'pixelize'
    default:
      return 'fade'
  }
}

// ---------------------------------------------------------------------------
// Manual color adjustment (Phase 3.7) — shared CSS / ffmpeg translation.
// brightness/contrast/saturation/temperature are -100..100, 0 = neutral.
// Preview (CSS) and export (ffmpeg) MUST agree — keep the maths in lockstep.
// ---------------------------------------------------------------------------

export const COLOR_ADJUST_LABELS: Record<keyof ColorAdjust, string> = {
  brightness: '밝기',
  contrast: '대비',
  saturation: '채도',
  temperature: '색온도'
}

/**
 * CSS `filter` fragment for a manual color adjustment. Returns '' for a
 * neutral / null adjust. The caller concatenates this AFTER filterPresetToCss
 * output (preset look first, manual adjust second). CSS has no native colour
 * temperature — it is approximated with sepia/hue-rotate (coarse by design).
 */
export function colorAdjustToCss(adj: ColorAdjust | null | undefined): string {
  if (!adj) return ''
  const parts: string[] = []
  if (adj.brightness !== 0) {
    parts.push(`brightness(${(1 + adj.brightness / 200).toFixed(3)})`)
  }
  if (adj.contrast !== 0) {
    parts.push(`contrast(${(1 + adj.contrast / 200).toFixed(3)})`)
  }
  if (adj.saturation !== 0) {
    parts.push(`saturate(${(1 + adj.saturation / 100).toFixed(3)})`)
  }
  if (adj.temperature > 0) {
    parts.push(
      `sepia(${((adj.temperature / 100) * 0.5).toFixed(3)})`,
      `saturate(${(1 + (adj.temperature / 100) * 0.15).toFixed(3)})`
    )
  } else if (adj.temperature < 0) {
    parts.push(
      `hue-rotate(${((adj.temperature / 100) * 25).toFixed(2)}deg)`,
      `saturate(${(1 - (Math.abs(adj.temperature) / 100) * 0.1).toFixed(3)})`
    )
  }
  return parts.join(' ')
}

/**
 * ffmpeg filter-chain fragment for a manual color adjustment. No leading /
 * trailing comma — caller chains it. Returns '' for a neutral / null adjust.
 * brightness/contrast/saturation → one `eq=`; temperature → `colortemperature=`
 * (standard ffmpeg ≥ 4.3; lower Kelvin = warmer). The caller places this
 * AFTER filterPresetToFfmpeg output.
 */
export function colorAdjustToFfmpeg(
  adj: ColorAdjust | null | undefined
): string {
  if (!adj) return ''
  const chain: string[] = []
  const eqParams: string[] = []
  if (adj.brightness !== 0) {
    eqParams.push(`brightness=${(adj.brightness / 200).toFixed(4)}`)
  }
  if (adj.contrast !== 0) {
    eqParams.push(`contrast=${(1 + adj.contrast / 100).toFixed(4)}`)
  }
  if (adj.saturation !== 0) {
    eqParams.push(`saturation=${(1 + adj.saturation / 100).toFixed(4)}`)
  }
  if (eqParams.length > 0) chain.push(`eq=${eqParams.join(':')}`)
  if (adj.temperature !== 0) {
    // Map -100..100 → 9000K..4000K (neutral 6500K at 0). n>0 warmer = lower K.
    const kelvin = Math.round(6500 - (adj.temperature / 100) * 2500)
    chain.push(`colortemperature=temperature=${kelvin}`)
  }
  return chain.join(',')
}

// ---------------------------------------------------------------------------
// Curves + HSL color grading (Phase 3.12) — pure, shared.
// ---------------------------------------------------------------------------

/** Human labels for the four curve channels (UI). */
export const CURVE_CHANNEL_LABELS: Record<CurveChannelKey, string> = {
  master: 'RGB',
  red: '빨강',
  green: '초록',
  blue: '파랑'
}

/** Human labels for the six HSL bands (UI). */
export const HSL_BAND_LABELS: Record<HslBandKey, string> = {
  red: '빨강',
  yellow: '노랑',
  green: '초록',
  cyan: '청록',
  blue: '파랑',
  magenta: '자홍'
}

/** Representative swatch color (CSS) for each HSL band (UI). */
export const HSL_BAND_SWATCHES: Record<HslBandKey, string> = {
  red: '#e5484d',
  yellow: '#f5d90a',
  green: '#46a758',
  cyan: '#0bc5c5',
  blue: '#3b82f6',
  magenta: '#d946ef'
}

/** ffmpeg `curves` channel-option name for each logical channel. */
const CURVE_CHANNEL_FFMPEG: Record<CurveChannelKey, string> = {
  master: 'master',
  red: 'r',
  green: 'g',
  blue: 'b'
}

/** ffmpeg `huesaturation` `colors` flag for each HSL band. */
const HSL_BAND_FFMPEG: Record<HslBandKey, string> = {
  red: 'r',
  yellow: 'y',
  green: 'g',
  cyan: 'c',
  blue: 'b',
  magenta: 'm'
}

/**
 * ffmpeg `curves=` fragment for a clip's tone curves, or '' for null / all-
 * identity. No leading/trailing comma — caller chains it AFTER
 * `colorAdjustToFfmpeg`. Only non-identity channels are emitted. Each channel's
 * point list is single-quote-wrapped (it contains spaces) — parseable inside
 * `filter_complex` since the whole graph is one argv element (no shell).
 *   curves=master='0.0000/0.0000 0.5000/0.6000 1.0000/1.0000':b='0.0000/0.0500 1.0000/0.9500'
 */
export function curvesToFfmpeg(c: ClipCurves | null | undefined): string {
  if (!c) return ''
  const segs: string[] = []
  for (const key of CURVE_CHANNEL_KEYS) {
    const pts = c[key]
    if (!Array.isArray(pts) || isIdentityCurveChannel(pts)) continue
    const list = pts
      .map((p) => `${p.x.toFixed(4)}/${p.y.toFixed(4)}`)
      .join(' ')
    segs.push(`${CURVE_CHANNEL_FFMPEG[key]}='${list}'`)
  }
  return segs.length > 0 ? `curves=${segs.join(':')}` : ''
}

/**
 * ffmpeg fragment for HSL secondary grading — one `huesaturation=` per non-
 * neutral band, comma-joined. '' for null / all-neutral. Maps the UI's signed
 * -100..100 sliders → hue ±180°, saturation/intensity ±1.0. Caller chains it
 * AFTER `curvesToFfmpeg`, and ONLY when ffmpeg has the `huesaturation` filter
 * (probe-gated in export).
 */
export function hslToFfmpeg(h: ClipHsl | null | undefined): string {
  if (!h) return ''
  const segs: string[] = []
  for (const key of HSL_BAND_KEYS) {
    const b = h[key]
    if (!b || isNeutralHslBand(b)) continue
    const hue = ((b.hue / 100) * 180).toFixed(2)
    const sat = (b.saturation / 100).toFixed(3)
    const intensity = (b.luminance / 100).toFixed(3)
    segs.push(
      `huesaturation=hue=${hue}:saturation=${sat}` +
        `:intensity=${intensity}:colors=${HSL_BAND_FFMPEG[key]}`
    )
  }
  return segs.join(',')
}

/** Piecewise-linear curve interpolation; flat extrapolation outside [first,last]. */
function interpCurve(pts: CurvePoint[], x: number): number {
  if (pts.length === 0) return x
  if (x <= pts[0].x) return pts[0].y
  const last = pts[pts.length - 1]
  if (x >= last.x) return last.y
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (x <= b.x) {
      const span = b.x - a.x
      if (span <= 1e-9) return b.y
      return a.y + ((x - a.x) / span) * (b.y - a.y)
    }
  }
  return last.y
}

/**
 * Sample an interpolated curve at `steps` evenly-spaced inputs in [0,1] →
 * output values for an SVG `<feFunc* tableValues>` attribute. Used by the live
 * preview (CSS `filter:` cannot do tone curves; SVG feComponentTransfer can).
 */
export function sampleCurveTable(pts: CurvePoint[], steps: number): number[] {
  const n = Math.max(2, Math.floor(steps))
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1)
    out.push(Math.min(1, Math.max(0, interpCurve(pts, x))))
  }
  return out
}

// ---------------------------------------------------------------------------
// Retouch / beauty (Phase 3.21) — edge-preserving skin smoothing.
// `smartblur` is applied luma-only (chroma left at ffmpeg defaults = untouched)
// so skin tone is preserved; `luma_threshold` protects edges (eyes/hair).
// ---------------------------------------------------------------------------

/**
 * ffmpeg filter-chain fragment for per-clip retouch (skin smoothing). No
 * leading/trailing comma — caller chains it. Returns '' for null / <= 0 so the
 * caller can unconditionally push the result and keep a retouch-off clip's
 * video graph byte-identical. `intensity` is the resolved 1..100 strength
 * (caller passes `getClipRetouch(clip)`). `luma_strength` is capped at 0.75 so
 * the result never goes fully plasticky.
 */
export function retouchToFfmpeg(
  intensity: number | null | undefined
): string {
  if (intensity == null || !Number.isFinite(intensity) || intensity <= 0) {
    return ''
  }
  const i = Math.min(100, Math.max(1, intensity))
  const t = i / 100
  const lr = (1.0 + 1.5 * t).toFixed(3)
  const ls = (0.3 + 0.45 * t).toFixed(3)
  const lt = Math.round(8 + 16 * t)
  return `smartblur=lr=${lr}:ls=${ls}:lt=${lt}`
}

// ---------------------------------------------------------------------------
// Stabilization (Phase 3.38) — per-clip video stabilization.
// Two backends, probe-gated in export.ts:
//   - vidstabtransform (libvidstab) — gold standard, requires a `.trf`
//     motion-data file written by a prior `vidstabdetect` 1st pass.
//   - deshake — single-pass core ffmpeg filter; fallback when vidstab is
//     unavailable in the bundled ffmpeg-static.
// `stabilizeToFfmpeg` returns only the 2nd-pass / single-pass filter string.
// 1st-pass orchestration (`.trf` cache + spawn) lives in export.ts because
// it needs userData paths, file mtime, and child_process spawn().
// ---------------------------------------------------------------------------

/**
 * Map a 0..100 strength to vidstabdetect's `shakiness` parameter (1..10).
 * Exported so export.ts uses the same mapping for the 1st pass that the
 * filter-string assembly uses for the 2nd pass cache key.
 */
export function stabilizeShakiness(intensity: number): number {
  const i = Math.min(100, Math.max(1, intensity))
  return Math.max(1, Math.min(10, Math.round(1 + ((i - 1) * 9) / 99)))
}

/**
 * 2nd-pass (or single-pass deshake) ffmpeg filter string. No leading/trailing
 * comma — caller chains it. Returns '' for null / non-finite / <= 0 so the
 * caller can unconditionally push the result and keep a stabilize-off clip's
 * video graph BYTE-IDENTICAL to the pre-Phase-3.38 graph.
 *
 * `vidstab` mode: `vidstabtransform=input=<trf>:smoothing=…:zoom=…:optzoom=1:
 *   interpol=bilinear:crop=keep,unsharp=…`. Unsharp follows vidstabtransform
 *   because vidstab recommends a slight sharpen to offset interpolation
 *   softness from the warp+zoom. `trfPath` is forward-slashed and `:`-escaped
 *   so a Windows drive prefix (`C:/…` → `C\:/…`) is safe in the colon-
 *   delimited filter syntax. If `trfPath` is missing, returns '' (silent
 *   no-op — caller should have ensured the 1st pass produced it).
 *
 * `deshake` mode: `deshake=rx=<r>:ry=<r>:edge=mirror` where `r` is 6..32
 *   mapped from 0..100. Single-pass, no `.trf`.
 */
export function stabilizeToFfmpeg(
  intensity: number | null | undefined,
  mode: 'vidstab' | 'deshake',
  trfPath?: string
): string {
  if (intensity == null || !Number.isFinite(intensity) || intensity <= 0) {
    return ''
  }
  const i = Math.min(100, Math.max(1, intensity))
  const t = i / 100
  if (mode === 'vidstab') {
    if (!trfPath) return ''
    // smoothing: lowpass window in frames; 1..100 → 5..30.
    const smoothing = Math.round(5 + 25 * t)
    // zoom: percent zoom-in to hide stabilization borders; 0..100 → 0..8%.
    const zoom = (t * 8).toFixed(2)
    // On Windows the drive-letter colon must be \:-escaped inside the FFmpeg
    // filter option value, AND the whole path must be single-quoted so FFmpeg
    // does not treat the colon after the drive letter as an option separator.
    const safe = "'" + trfPath.replace(/\\/g, '/').replace(/:/g, '\\:') + "'"
    return (
      `vidstabtransform=input=${safe}:smoothing=${smoothing}:zoom=${zoom}` +
      `:optzoom=1:interpol=bilinear:crop=keep,` +
      `unsharp=5:5:0.8:3:3:0.4`
    )
  }
  // deshake fallback. rx/ry: search-radius px (0..64); 1..100 → 6..32.
  const r = Math.max(4, Math.min(32, Math.round(6 + 26 * t)))
  return `deshake=rx=${r}:ry=${r}:edge=mirror`
}

// ---------------------------------------------------------------------------
// Film look (Phase 3.37) — vignette / grain / faded tone finishing filter.
// ---------------------------------------------------------------------------

/** Human labels for the film tones (UI). */
export const FILM_TONE_LABELS: Record<FilmToneId, string> = {
  none: '없음',
  warm: '웜',
  fade: '페이드',
  cool: '쿨',
  bw: '흑백필름'
}

/**
 * One-click film-look preset — pure renderer convenience; each just sets the
 * three FilmLook values. NOT referenced by export (export only sees FilmLook).
 */
export interface FilmLookPreset {
  id: string
  label: string
  value: FilmLook
}

/** Built-in film-look presets shown as one-click buttons. */
export const FILM_LOOK_PRESETS: readonly FilmLookPreset[] = [
  { id: 'vintage', label: '빈티지', value: { vignette: 55, grain: 45, toneId: 'warm' } },
  { id: 'cinema', label: '시네마', value: { vignette: 40, grain: 18, toneId: 'fade' } },
  { id: 'vhs', label: 'VHS', value: { vignette: 30, grain: 70, toneId: 'cool' } },
  { id: 'bwfilm', label: '흑백필름', value: { vignette: 50, grain: 35, toneId: 'bw' } }
]

/**
 * Fixed ffmpeg curves/eq recipe per film tone. Returns '' for 'none' (and any
 * unknown id) so a tone-less look contributes nothing to the export graph.
 */
function filmToneToFfmpeg(toneId: FilmToneId): string {
  switch (toneId) {
    case 'warm':
      return 'colortemperature=temperature=5200,eq=saturation=1.08'
    case 'fade':
      return "curves=master='0.0000/0.0800 0.5000/0.5000 1.0000/0.9400',eq=saturation=0.92"
    case 'cool':
      return 'colortemperature=temperature=8200,eq=saturation=0.95'
    case 'bw':
      return "eq=saturation=0,curves=master='0.0000/0.0500 0.5000/0.5200 1.0000/0.9500'"
    default:
      return ''
  }
}

/**
 * Cheap CSS `filter` approximation of a film tone for the preview canvas.
 * Returns '' for 'none' so a neutral look keeps the preview byte-identical.
 */
export function filmToneToCss(toneId: FilmToneId | undefined): string {
  switch (toneId) {
    case 'warm':
      return 'sepia(0.15) saturate(1.08)'
    case 'fade':
      return 'contrast(0.92) brightness(1.04)'
    case 'cool':
      return 'hue-rotate(-8deg) saturate(0.95)'
    case 'bw':
      return 'grayscale(1) contrast(1.04)'
    default:
      return ''
  }
}

/**
 * ffmpeg filter-chain fragments for a per-clip film look. Returns [] for a
 * null / neutral look so the caller can unconditionally spread the result and
 * keep a film-look-off clip's video graph BYTE-IDENTICAL.
 *
 * Returned order is [tone, vignette, grain]: tone (color grade) first, then
 * vignette, then grain ON TOP of the graded + vignetted image (grain must be
 * last so no later filter blurs it away). `noise` uses a FIXED seed so the
 * export filter graph is a deterministic, stable string.
 */
export function filmLookToFfmpeg(look: FilmLook | null | undefined): string[] {
  if (!look) return []
  const out: string[] = []
  const tone = filmToneToFfmpeg(look.toneId)
  if (tone) out.push(tone)
  if (look.vignette > 0) {
    // 0..100 → angle PI/8 (subtle) .. PI/3 (deep corner falloff).
    const t = Math.min(100, Math.max(0, look.vignette)) / 100
    const angle = (Math.PI / 8 + (Math.PI / 3 - Math.PI / 8) * t).toFixed(4)
    out.push(`vignette=angle=${angle}`)
  }
  if (look.grain > 0) {
    // 0..100 → alls 0..40; temporal (t) + uniform (u); FIXED seed for a
    // deterministic graph string.
    const strength = Math.round(
      (Math.min(100, Math.max(0, look.grain)) / 100) * 40
    )
    out.push(`noise=alls=${strength}:allf=t+u:all_seed=8086`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Adjustment layer (Phase 3.32) — a time-gated color grade over the composite.
// ---------------------------------------------------------------------------

/**
 * ffmpeg filter-chain fragment for ONE adjustment layer, fully time-gated.
 * Reuses `filterPresetToFfmpeg` → `colorAdjustToFfmpeg` → `curvesToFfmpeg` →
 * `hslToFfmpeg` (the same stacking order as the per-clip grade), then appends
 * `:enable='between(t,a,b)'` to EVERY emitted filter. Returns '' for a fully
 * neutral layer — so a neutral layer contributes nothing and the export graph
 * stays byte-identical. `hueSatAvailable === false` drops the HSL segment
 * (probe gate). `startSec`/`endSec` are timeline seconds.
 */
export function adjustmentLayerToFfmpeg(
  layer: AdjustmentLayer,
  startSec: number,
  endSec: number,
  hueSatAvailable: boolean
): string {
  const parts: string[] = []
  const preset = filterPresetToFfmpeg(
    layer.filterPreset ?? 'none',
    layer.filterIntensity ?? 1
  )
  if (preset) parts.push(preset)
  const ca = colorAdjustToFfmpeg(resolveColorAdjust(layer.colorAdjust))
  if (ca) parts.push(ca)
  const cv = curvesToFfmpeg(resolveClipCurves(layer.curves))
  if (cv) parts.push(cv)
  if (hueSatAvailable) {
    const hs = hslToFfmpeg(resolveClipHsl(layer.hsl))
    if (hs) parts.push(hs)
  }
  if (parts.length === 0) return ''
  // Each `parts` entry may itself be a comma-joined multi-filter string. Split
  // on the top-level commas (these color filters have no commas in their args)
  // and time-gate every individual filter.
  const enable = `:enable='between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})'`
  return parts
    .join(',')
    .split(',')
    .map((f) => f + enable)
    .join(',')
}

// ---------------------------------------------------------------------------
// Voice enhancement (Phase 3.39) — per-clip narration polish: highpass
// rumble-cut, presence EQ, de-essing, compression, and EBU R128 loudness
// normalization. Pure string-building — no spawn / no userData / no probe.
// `deEsserAvailable=false` swaps in a `firequalizer` notch as fallback.
// ---------------------------------------------------------------------------

/**
 * Single comma-joined audio filter fragment for voice enhancement. No
 * leading/trailing comma — caller chains it. Returns '' when `ve` is null,
 * undefined, or all sub-toggles are false — so the caller can unconditionally
 * push the result and a voice-enhance-OFF clip's audio graph stays
 * BYTE-IDENTICAL to the pre-Phase-3.39 graph.
 *
 * Internal order (loudnorm is ALWAYS last so it normalizes the fully
 * processed signal):
 *   highpass=f=80 → equalizer (presence) → deesser → acompressor → loudnorm
 */
export function voiceEnhanceToFfmpeg(
  ve: VoiceEnhance | null | undefined,
  capabilities?: { deEsserAvailable?: boolean }
): string {
  if (!ve) return ''
  if (isNeutralVoiceEnhance(ve)) return ''
  const parts: string[] = []
  if (ve.eqLowCut) parts.push('highpass=f=80')
  if (ve.eqPresence) parts.push('equalizer=f=3000:t=h:width=2:g=2')
  if (ve.deEss) {
    if (capabilities?.deEsserAvailable === false) {
      // Fallback: a gentle ~7 kHz notch via firequalizer (always available).
      parts.push(
        "firequalizer=gain_entry='entry(0,0);entry(6000,0);entry(7000,-3);entry(8000,0);entry(20000,0)'"
      )
    } else {
      // ffmpeg defaults: i=0 m=0.5 f=0.5 s=o — broadcast-safe narration setting.
      parts.push('deesser=i=0:m=0.5:f=0.5:s=o')
    }
  }
  if (ve.compress) {
    // 4:1 @ -18 dB threshold, fast attack, medium release + 2 dB makeup.
    parts.push(
      'acompressor=threshold=-18dB:ratio=4:attack=5:release=80:makeup=2'
    )
  }
  if (ve.loudnorm) {
    // Single-pass loudnorm. -16 LUFS / -1.5 dBTP / LRA 11 (Insta/YT standard).
    parts.push('loudnorm=I=-16:TP=-1.5:LRA=11')
  }
  return parts.join(',')
}
