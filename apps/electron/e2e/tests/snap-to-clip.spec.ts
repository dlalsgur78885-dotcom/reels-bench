/**
 * Phase 3.76 — magnet timeline: snapToNearestClipBoundary helper.
 *
 * Pure (no Electron launch). The Timeline drag handler integration is a
 * follow-up — this phase ships the math so the integration is a one-line
 * lookup.
 *
 * @phase-3-76-snap-to-clip
 */
import { expect, test } from '@playwright/test'
import {
  CLIP_SNAP_TOLERANCE_MS,
  snapToNearestClipBoundary
} from '../../src/renderer/src/store/timelineUi'

test.describe('@phase-3-76-snap-to-clip snapToNearestClipBoundary', () => {
  test('A-1 default tolerance is 80ms', () => {
    expect(CLIP_SNAP_TOLERANCE_MS).toBe(80)
  })

  test('A-2 empty boundaries → returns desired unchanged', () => {
    expect(snapToNearestClipBoundary(1234, [])).toBe(1234)
  })

  test('A-3 within tolerance → snaps to nearest boundary', () => {
    expect(snapToNearestClipBoundary(1030, [1000, 2000])).toBe(1000)
    expect(snapToNearestClipBoundary(1970, [1000, 2000])).toBe(2000)
  })

  test('A-4 outside tolerance → no snap (returns desired)', () => {
    // 80ms default tolerance; 1100 is 100ms past 1000 → outside.
    expect(snapToNearestClipBoundary(1100, [1000, 2000])).toBe(1100)
  })

  test('A-5 custom tolerance honored', () => {
    expect(snapToNearestClipBoundary(1100, [1000, 2000], 50)).toBe(1100)
    expect(snapToNearestClipBoundary(1100, [1000, 2000], 200)).toBe(1000)
  })

  test('A-6 picks the closer of two boundaries within tolerance', () => {
    // 1040 is 40ms from 1000 and 960 from 2000 — picks 1000.
    expect(snapToNearestClipBoundary(1040, [1000, 1075])).toBe(1075) // 35 < 40
  })

  test('A-7 non-finite desired or NaN boundaries are tolerated', () => {
    expect(snapToNearestClipBoundary(NaN, [1000])).toBeNaN()
    // NaN boundary skipped; the real one still snaps.
    expect(snapToNearestClipBoundary(1010, [Number.NaN, 1000])).toBe(1000)
  })
})
