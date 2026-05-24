/**
 * Phase 3.66 — auto-zoom / punch-in preset library expansion (6 → 15).
 *
 * Each new preset MUST: have ≥ 2 specs, every scaleFactor ≥ 1 (zoom never
 * reveals gutters), atFrac in [0,1], `buildZoomKeyframes` returns ≥ 2 kfs
 * at a reasonable clip duration.
 *
 * @phase-3-66-zoom-presets
 */
import { expect, test } from '@playwright/test'
import {
  ZOOM_PRESETS,
  buildZoomKeyframes
} from '../../src/shared/zoomPresets'

test.describe('@phase-3-66-zoom-presets zoom preset catalog', () => {
  test('A-1 grew from the 6 baseline to >= 15 presets', () => {
    expect(ZOOM_PRESETS.length).toBeGreaterThanOrEqual(15)
  })

  test('A-2 every preset has label, description, and >= 2 specs', () => {
    for (const p of ZOOM_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.description.length).toBeGreaterThan(0)
      expect(p.specs.length).toBeGreaterThanOrEqual(2)
    }
  })

  test('A-3 every spec respects atFrac ∈ [0,1] and scaleFactor >= 1 (zoom-only)', () => {
    for (const p of ZOOM_PRESETS) {
      for (const s of p.specs) {
        expect(s.atFrac, `${p.id} atFrac`).toBeGreaterThanOrEqual(0)
        expect(s.atFrac, `${p.id} atFrac`).toBeLessThanOrEqual(1)
        expect(s.scaleFactor, `${p.id} scaleFactor`).toBeGreaterThanOrEqual(1)
      }
    }
  })

  test('A-4 every id is unique', () => {
    const seen = new Set<string>()
    for (const p of ZOOM_PRESETS) {
      expect(seen.has(p.id), `duplicate id ${p.id}`).toBe(false)
      seen.add(p.id)
    }
  })

  test('A-5 buildZoomKeyframes resolves every preset to ≥ 2 keyframes on a 4s clip', () => {
    for (const p of ZOOM_PRESETS) {
      const kfs = buildZoomKeyframes(p.id, 4000)
      expect(kfs.length, `${p.id} kf count`).toBeGreaterThanOrEqual(2)
    }
  })
})
