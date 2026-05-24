/**
 * Phase 3.68 — speed-curve preset library (NEW, 13 presets).
 *
 * Pure data + builder correctness. Mirrors zoomPresets.ts e2e shape.
 *
 * @phase-3-68-speed-presets
 */
import { expect, test } from '@playwright/test'
import {
  buildSpeedKeyframes,
  SPEED_PRESETS
} from '../../src/shared/speedPresets'
import { MAX_CLIP_SPEED, MIN_CLIP_SPEED } from '../../src/shared/project'

test.describe('@phase-3-68-speed-presets speed preset catalog', () => {
  test('A-1 catalog has >= 13 presets', () => {
    expect(SPEED_PRESETS.length).toBeGreaterThanOrEqual(13)
  })

  test('A-2 every preset has label / description / >= 2 specs', () => {
    for (const p of SPEED_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.description.length).toBeGreaterThan(0)
      expect(p.specs.length).toBeGreaterThanOrEqual(2)
    }
  })

  test('A-3 every spec respects atFrac ∈ [0,1] and speed ∈ [MIN_CLIP_SPEED, MAX_CLIP_SPEED]', () => {
    for (const p of SPEED_PRESETS) {
      for (const s of p.specs) {
        expect(s.atFrac, `${p.id} atFrac`).toBeGreaterThanOrEqual(0)
        expect(s.atFrac, `${p.id} atFrac`).toBeLessThanOrEqual(1)
        expect(s.speed, `${p.id} speed`).toBeGreaterThanOrEqual(MIN_CLIP_SPEED)
        expect(s.speed, `${p.id} speed`).toBeLessThanOrEqual(MAX_CLIP_SPEED)
      }
    }
  })

  test('A-4 ids unique', () => {
    const seen = new Set<string>()
    for (const p of SPEED_PRESETS) {
      expect(seen.has(p.id), `duplicate ${p.id}`).toBe(false)
      seen.add(p.id)
    }
  })

  test('A-5 buildSpeedKeyframes resolves every preset to ≥ 2 kfs on a 4s clip', () => {
    for (const p of SPEED_PRESETS) {
      const kfs = buildSpeedKeyframes(p.id, 4000)
      expect(kfs.length, `${p.id} kf count`).toBeGreaterThanOrEqual(2)
      // atMs strictly ascending after build sort + dedup.
      for (let i = 1; i < kfs.length; i++) {
        expect(kfs[i].atMs).toBeGreaterThan(kfs[i - 1].atMs)
      }
    }
  })

  test('A-6 buildSpeedKeyframes: unknown preset / zero dur → []', () => {
    expect(buildSpeedKeyframes('no-such', 4000)).toEqual([])
    expect(buildSpeedKeyframes('bullet-time', 0)).toEqual([])
  })

  test('A-7 buildSpeedKeyframes clamps speed values (no preset can sneak past)', () => {
    for (const p of SPEED_PRESETS) {
      const kfs = buildSpeedKeyframes(p.id, 4000)
      for (const kf of kfs) {
        expect(kf.speed).toBeGreaterThanOrEqual(MIN_CLIP_SPEED)
        expect(kf.speed).toBeLessThanOrEqual(MAX_CLIP_SPEED)
      }
    }
  })
})
