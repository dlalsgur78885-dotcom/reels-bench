/**
 * Filter preset definitions — shared between renderer (CSS approximation
 * for preview) and main (ffmpeg filter chains for export).
 *
 * Preview values are deliberately cheap; the real "look" is applied at export
 * via the `toFfmpegFilter()` helper which builds eq/hue/curves chains.
 */
import type { FilterPreset } from './project'

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
