/**
 * Phase 3.70 — outlier-robust trimmed-mean frame stats.
 *
 * `averageFrameStatsTrimmed(list, trimFrac)` is a defensive variant of the
 * pre-existing `averageFrameStats` that absorbs one-off outlier samples
 * (a black flash, a white card) before the per-key mean. This lets the
 * 5-sample auto-color pass survive transitions without dragging the
 * resulting sliders into the void.
 *
 * @phase-3-70-auto-color-trimmed
 */
import { expect, test } from '@playwright/test'
import {
  averageFrameStats,
  averageFrameStatsTrimmed,
  neutralFrameStats,
  type FrameStats
} from '../../src/shared/autoColor'

function mkStats(luma: number): FrameStats {
  return {
    meanLuma: luma,
    lumaP1: luma,
    lumaP99: luma,
    meanSaturation: 0.4,
    meanR: luma,
    meanG: luma,
    meanB: luma,
    sampleCount: 1000
  }
}

test.describe('@phase-3-70-auto-color-trimmed averageFrameStatsTrimmed', () => {
  test('A-1 empty list → neutralFrameStats', () => {
    expect(averageFrameStatsTrimmed([])).toEqual(neutralFrameStats())
  })

  test('A-2 trimFrac=0 → byte-identical to averageFrameStats (BC-safe)', () => {
    const samples = [0.3, 0.5, 0.55, 0.6, 0.7].map(mkStats)
    const trimmed = averageFrameStatsTrimmed(samples, 0)
    const plain = averageFrameStats(samples)
    expect(trimmed.meanLuma).toBeCloseTo(plain.meanLuma, 8)
    expect(trimmed.meanR).toBeCloseTo(plain.meanR, 8)
  })

  test('A-3 outlier black flash + white card cancel after trim (5 samples, 20%)', () => {
    // 5 samples: 0.0 (black flash), 0.55, 0.55, 0.55, 1.0 (white card).
    // floor(5*0.2)=1 trimmed each end → middle three at 0.55.
    const samples = [0.0, 0.55, 0.55, 0.55, 1.0].map(mkStats)
    const trimmed = averageFrameStatsTrimmed(samples, 0.2)
    expect(trimmed.meanLuma).toBeCloseTo(0.55, 6)
  })

  test('A-4 plain mean shifts when outliers present; trimmed stays close to mid value', () => {
    const samples = [0.0, 0.55, 0.55, 0.55, 1.0].map(mkStats)
    const plain = averageFrameStats(samples)
    const trimmed = averageFrameStatsTrimmed(samples, 0.2)
    // Plain mean = 0.53; trimmed = 0.55. Differ by ~0.02 — meaningful at our
    // 0.46 target (TARGET_LUMA), where 0.02 = ~4 brightness units.
    expect(Math.abs(plain.meanLuma - trimmed.meanLuma)).toBeGreaterThan(0.005)
  })

  test('A-5 tiny pool (<3 samples after trim) falls back to plain mean', () => {
    // n=3, trimFrac=0.4 → trim=1 each → window=1 (still ≥ 1, ok).
    // n=2, trimFrac=0.4 → trim=0 (floor(2*0.4)=0) → plain mean fallback.
    const samples = [0.3, 0.7].map(mkStats)
    const trimmed = averageFrameStatsTrimmed(samples, 0.4)
    const plain = averageFrameStats(samples)
    expect(trimmed.meanLuma).toBeCloseTo(plain.meanLuma, 8)
  })

  test('A-6 sampleCount is the SUM across all input samples (not per-window)', () => {
    const samples = [0.3, 0.5, 0.7].map(mkStats)
    const trimmed = averageFrameStatsTrimmed(samples, 0.2)
    expect(trimmed.sampleCount).toBe(3 * 1000)
  })
})
