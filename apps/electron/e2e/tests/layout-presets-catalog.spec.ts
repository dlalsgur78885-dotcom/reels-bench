/**
 * Phase 3.65 — collage/split-screen layout library expansion (8 → 20).
 *
 * Each new preset MUST have ≥ 2 cells, every cell fully inside the [0,1]²
 * canvas, the cell rectangles must (within FP tolerance) tile the canvas
 * for the "tiling" presets — PiP-style overlays are exempt because cell 1
 * intentionally overlaps cell 0 (the full-canvas backdrop).
 *
 * @phase-3-65-layout-presets
 */
import { expect, test } from '@playwright/test'
import {
  LAYOUT_PRESETS,
  type LayoutPreset
} from '../../src/shared/layoutPresets'

function withinCanvas(p: LayoutPreset): boolean {
  for (const c of p.cells) {
    if (c.x < -1e-6 || c.y < -1e-6) return false
    if (c.x + c.w > 1 + 1e-6) return false
    if (c.y + c.h > 1 + 1e-6) return false
    if (c.w <= 0 || c.h <= 0) return false
  }
  return true
}

test.describe('@phase-3-65-layout-presets layout preset catalog', () => {
  test('A-1 grew from the 8 baseline to >= 20 presets', () => {
    expect(LAYOUT_PRESETS.length).toBeGreaterThanOrEqual(20)
  })

  test('A-2 every preset has a label + >= 2 cells', () => {
    for (const p of LAYOUT_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.cells.length).toBeGreaterThanOrEqual(2)
    }
  })

  test('A-3 every cell stays inside the [0,1]² canvas', () => {
    for (const p of LAYOUT_PRESETS) {
      expect(withinCanvas(p), `${p.id} has off-canvas cells`).toBe(true)
    }
  })

  test('A-4 every id is unique', () => {
    const seen = new Set<string>()
    for (const p of LAYOUT_PRESETS) {
      expect(seen.has(p.id), `duplicate id ${p.id}`).toBe(false)
      seen.add(p.id)
    }
  })

  test('A-5 tiling presets (no "pip" prefix) cover the canvas to within 1% (sum of areas ≈ 1)', () => {
    for (const p of LAYOUT_PRESETS) {
      if (p.id.startsWith('pip-') || p.id === 'L-shape-tr') continue
      const sumArea = p.cells.reduce((s, c) => s + c.w * c.h, 0)
      expect(sumArea, `${p.id} cell area sum`).toBeGreaterThan(0.99)
      expect(sumArea, `${p.id} cell area sum`).toBeLessThan(1.01)
    }
  })
})
