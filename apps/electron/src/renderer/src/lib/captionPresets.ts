import type { CaptionPreset, CaptionStyle } from '../../../shared/project'

/**
 * Baseline visual specs for each preset. The preset name selects:
 *   - fontSize / align / yPosition / background  (these fields)
 *   - plus preset-specific CSS quirks (neon glow, gradient fill, etc.) which
 *     live in PreviewCanvas.tsx overlay rendering and are switched on
 *     `style.preset`.
 *
 * fontSize is given in px and is scaled by overlay against the rendered
 * canvas height in PreviewCanvas.
 */
export const CAPTION_PRESETS: Record<CaptionPreset, Omit<CaptionStyle, 'preset'>> = {
  'bottom-center':   { fontSize: 56, align: 'center', yPosition: 0.85, background: 'none' },
  neon:              { fontSize: 64, align: 'center', yPosition: 0.5,  background: 'none' },
  'block-bold':      { fontSize: 60, align: 'center', yPosition: 0.85, background: 'solid' },
  'minimal-white':   { fontSize: 48, align: 'center', yPosition: 0.9,  background: 'none' },
  'youtube-yellow':  { fontSize: 52, align: 'center', yPosition: 0.85, background: 'solid' },
  'tiktok-rounded':  { fontSize: 56, align: 'center', yPosition: 0.7,  background: 'pill' },
  gradient:          { fontSize: 72, align: 'center', yPosition: 0.6,  background: 'none' }
}

/** Build a full CaptionStyle from a preset name. */
export function makeStyleFromPreset(preset: CaptionPreset): CaptionStyle {
  const base = CAPTION_PRESETS[preset]
  return { preset, ...base }
}

/** Human-readable labels for the preset dropdown (Korean UI). */
export const PRESET_LABELS: Record<CaptionPreset, string> = {
  'bottom-center': '기본 (하단 중앙)',
  neon: '네온',
  'block-bold': '블록 (배경)',
  'minimal-white': '미니멀 화이트',
  'youtube-yellow': '유튜브 옐로우',
  'tiktok-rounded': '틱톡 라운드',
  gradient: '그라데이션'
}

export const ALL_PRESETS: CaptionPreset[] = [
  'bottom-center',
  'neon',
  'block-bold',
  'minimal-white',
  'youtube-yellow',
  'tiktok-rounded',
  'gradient'
]
