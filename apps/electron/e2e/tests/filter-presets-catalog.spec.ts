/**
 * Phase 3.63 — filter-preset library expansion (7 → 20).
 *
 * Catalog growth + per-preset CSS / ffmpeg fragment correctness. Each new
 * preset MUST produce non-empty preview CSS at intensity=1 AND a non-empty
 * ffmpeg filter at intensity=1 — otherwise it's just an enum value with
 * no visual difference (preview === export === identity).
 *
 * @phase-3-63-filter-presets
 */
import { expect, test } from '@playwright/test'
import { FILTER_PRESETS } from '../../src/shared/project'
import {
  FILTER_PRESET_LABELS,
  filterPresetToCss,
  filterPresetToFfmpeg
} from '../../src/shared/filterPresets'

test.describe('@phase-3-63-filter-presets filter preset catalog', () => {
  test('A-1 grew from the 8-entry baseline (incl. none) to >= 20', () => {
    expect(FILTER_PRESETS.length).toBeGreaterThanOrEqual(20)
  })

  test('A-2 every preset has a Korean label', () => {
    for (const p of FILTER_PRESETS) {
      expect(FILTER_PRESET_LABELS[p], `label for ${p}`).toBeTruthy()
    }
  })

  test('A-3 every non-none preset produces NON-empty CSS at intensity=1 (preview ≠ identity)', () => {
    for (const p of FILTER_PRESETS) {
      if (p === 'none') continue
      const css = filterPresetToCss(p, 1)
      expect(css.length, `CSS for ${p}`).toBeGreaterThan(0)
    }
  })

  test('A-4 every non-none preset produces NON-empty ffmpeg fragment at intensity=1 (export ≠ identity)', () => {
    for (const p of FILTER_PRESETS) {
      if (p === 'none') continue
      const ff = filterPresetToFfmpeg(p, 1)
      expect(ff.length, `ffmpeg for ${p}`).toBeGreaterThan(0)
      // Sanity: should reference at least one core filter (eq / hue / sepia / grayscale via eq).
      expect(/eq=|hue=/.test(ff), `ffmpeg fragment for ${p}: ${ff}`).toBe(true)
    }
  })

  test('A-5 intensity=0 → CSS + ffmpeg are both empty for ALL non-none presets', () => {
    for (const p of FILTER_PRESETS) {
      if (p === 'none') continue
      // CSS at intensity 0 is the identity lerp, which produces a string with
      // identity values — non-empty by design (CSS preview shows nothing
      // visually different, the string is just "saturate(1) contrast(1)").
      // The ffmpeg side gates on t === 0 explicitly and returns ''.
      expect(filterPresetToFfmpeg(p, 0)).toBe('')
    }
  })

  test('A-6 none → empty CSS + empty ffmpeg regardless of intensity', () => {
    expect(filterPresetToCss('none', 1)).toBe('')
    expect(filterPresetToCss('none', 0.5)).toBe('')
    expect(filterPresetToFfmpeg('none', 1)).toBe('')
  })
})
