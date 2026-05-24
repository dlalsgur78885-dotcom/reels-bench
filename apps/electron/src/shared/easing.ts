/**
 * Phase 3.54 — keyframe easing.
 *
 * Pure (no DOM, no ffmpeg). Both the renderer's preview interpolator
 * (`getTransformAt`) and the export's expression builder (`keyframeExpr`)
 * MUST share these curves so preview === export. The easing on a keyframe
 * is OUTGOING: it shapes the curve FROM this keyframe TO the next one.
 *
 * Curves are the standard CSS cubic family:
 *   - linear:       f
 *   - ease-in:      f³                                 (slow start, fast end)
 *   - ease-out:     1 - (1 - f)³                       (fast start, slow end)
 *   - ease-in-out:  4f³ for f < 0.5, else 1 - (-2f+2)³/2  (slow-fast-slow)
 *
 * Absent / 'linear' is the byte-identical-export-with-pre-3.54-clips path —
 * `easeFraction` short-circuits to f and `easingToFfmpegFExpr` returns the
 * raw fraction expression unchanged.
 */

export type EasingKind = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

export const EASING_KINDS: readonly EasingKind[] = [
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out'
]

export const EASING_LABELS: Record<EasingKind, string> = {
  linear: '선형',
  'ease-in': '이즈 인',
  'ease-out': '이즈 아웃',
  'ease-in-out': '이즈 인-아웃'
}

/**
 * Map a raw [0,1] fraction `f` through the easing curve. Clamps out-of-range
 * inputs to the curve's start/end so caller doesn't need a defensive guard.
 * Returns linear (the identity) for 'linear' / undefined → zero overhead in
 * the absent-easing hot path.
 */
export function easeFraction(
  f: number,
  kind: EasingKind | undefined
): number {
  if (!kind || kind === 'linear') return f
  if (f <= 0) return 0
  if (f >= 1) return 1
  switch (kind) {
    case 'ease-in':
      return f * f * f
    case 'ease-out': {
      const u = 1 - f
      return 1 - u * u * u
    }
    case 'ease-in-out':
      if (f < 0.5) return 4 * f * f * f
      const u = -2 * f + 2
      return 1 - (u * u * u) / 2
    default:
      return f
  }
}

/**
 * Wrap a raw linear-fraction ffmpeg expression `fExpr` (a string that
 * evaluates to [0,1] inside an `xfade` / `geq` / `zoompan` context) in the
 * easing curve. Returns `fExpr` unchanged for 'linear' / undefined so the
 * emitted expression is byte-identical to the pre-3.54 builder.
 *
 * The expressions use ffmpeg's `pow()` and `if(lt(...))` — both core, no
 * filter probe needed.
 */
export function easingToFfmpegFExpr(
  kind: EasingKind | undefined,
  fExpr: string
): string {
  if (!kind || kind === 'linear') return fExpr
  switch (kind) {
    case 'ease-in':
      return `pow(${fExpr},3)`
    case 'ease-out':
      return `(1-pow(1-${fExpr},3))`
    case 'ease-in-out':
      return `if(lt(${fExpr},0.5),4*pow(${fExpr},3),1-pow(-2*${fExpr}+2,3)/2)`
    default:
      return fExpr
  }
}
