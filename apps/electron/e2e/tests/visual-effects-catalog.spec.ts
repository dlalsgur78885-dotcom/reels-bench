/**
 * Phase 3.64 — visual-effect library expansion (7 → 15).
 *
 * Catalog growth + per-effect ffmpeg fragment correctness. Every non-none
 * id MUST produce a non-empty ffmpeg filter chain (otherwise it's an enum
 * with no actual visual difference).
 *
 * @phase-3-64-visual-effects
 */
import { expect, test } from '@playwright/test'
import { VISUAL_EFFECT_IDS } from '../../src/shared/project'
import {
  VISUAL_EFFECT_LABELS,
  visualEffectToFfmpeg
} from '../../src/shared/filterPresets'

test.describe('@phase-3-64-visual-effects visual effect catalog', () => {
  test('A-1 grew from the 8-entry baseline (incl. none) to >= 15', () => {
    expect(VISUAL_EFFECT_IDS.length).toBeGreaterThanOrEqual(15)
  })

  test('A-2 every id has a Korean label', () => {
    for (const id of VISUAL_EFFECT_IDS) {
      expect(VISUAL_EFFECT_LABELS[id], `label for ${id}`).toBeTruthy()
    }
  })

  test('A-3 every non-none id produces a NON-empty ffmpeg fragment', () => {
    for (const id of VISUAL_EFFECT_IDS) {
      if (id === 'none') continue
      const ff = visualEffectToFfmpeg(id)
      expect(ff.length, `ffmpeg for ${id}`).toBeGreaterThan(0)
    }
  })

  test('A-4 every ffmpeg fragment references at least one known core filter (sanity)', () => {
    const KNOWN_FILTERS = [
      'eq=',
      'hue=',
      'gblur',
      'pixelize',
      'edgedetect',
      'noise=',
      'rgbashift',
      'colorchannelmixer',
      'unsharp',
      'negate',
      'geq=',
      'lutyuv'
    ]
    for (const id of VISUAL_EFFECT_IDS) {
      if (id === 'none') continue
      const ff = visualEffectToFfmpeg(id)
      const hasOne = KNOWN_FILTERS.some((f) => ff.includes(f))
      expect(hasOne, `${id} → ${ff} — no recognized core filter`).toBe(true)
    }
  })

  test('A-5 none / undefined / unknown → empty fragment (BC-safe identity)', () => {
    expect(visualEffectToFfmpeg('none')).toBe('')
    expect(visualEffectToFfmpeg(null)).toBe('')
    expect(visualEffectToFfmpeg(undefined)).toBe('')
  })
})
