/**
 * Phase 3.85 — silence → BGM volume keyframes.
 *
 * Pure helper test (no Electron launch). Wiring into a "BGM 자동 페이드"
 * UI action is a follow-up.
 *
 * @phase-3-85-auto-bgm-fade
 */
import { expect, test } from '@playwright/test'
import { silenceToBgmKeyframes } from '../../src/renderer/src/lib/autoBgmFade'
import type { SilenceRange } from '../../src/shared/ipc'

function sr(s: number, e: number): SilenceRange {
  return { startMs: s, endMs: e, durationMs: e - s }
}

test.describe('@phase-3-85-auto-bgm-fade silenceToBgmKeyframes', () => {
  test('A-1 totalMs <= 0 → []', () => {
    expect(silenceToBgmKeyframes([], 0)).toEqual([])
    expect(silenceToBgmKeyframes([sr(0, 100)], -1)).toEqual([])
  })

  test('A-2 no silences → entire clip ducked at duckDb (flat curve)', () => {
    const kfs = silenceToBgmKeyframes([], 5000, { duckDb: -12 })
    expect(kfs.length).toBe(2)
    expect(kfs[0]).toEqual({ atMs: 0, gainDb: -12 })
    expect(kfs[1]).toEqual({ atMs: 5000, gainDb: -12 })
  })

  test('A-3 silences below minSilenceMs are dropped', () => {
    const kfs = silenceToBgmKeyframes(
      [sr(1000, 1100)], // 100ms — below default 250ms
      5000,
      { minSilenceMs: 250 }
    )
    // Treated as no usable silence → flat ducked curve.
    expect(kfs.length).toBe(2)
    expect(kfs[0].gainDb).toBe(kfs[1].gainDb)
  })

  test('A-4 single mid-clip silence → fade-up around start, fade-down around end', () => {
    const kfs = silenceToBgmKeyframes([sr(2000, 3000)], 5000, {
      duckDb: -12,
      fadeMs: 200,
      minSilenceMs: 250
    })
    // Expected boundaries: 0(duck), 1900(duck), 2100(0), 2900(0), 3100(duck), 5000(duck)
    const at = (ms: number): number | undefined =>
      kfs.find((k) => Math.abs(k.atMs - ms) <= 1)?.gainDb
    expect(at(0)).toBe(-12)
    expect(at(1900)).toBe(-12)
    expect(at(2100)).toBe(0)
    expect(at(2900)).toBe(0)
    expect(at(3100)).toBe(-12)
    expect(at(5000)).toBe(-12)
  })

  test('A-5 silence at the very start → BGM starts at 0dB (loud), no fade-up', () => {
    const kfs = silenceToBgmKeyframes([sr(0, 1000)], 5000, {
      duckDb: -10,
      minSilenceMs: 250
    })
    expect(kfs[0].atMs).toBe(0)
    expect(kfs[0].gainDb).toBe(0)
  })

  test('A-6 silence extending to clip end → BGM ends at 0dB (loud), no fade-down', () => {
    const kfs = silenceToBgmKeyframes([sr(3000, 5000)], 5000, {
      duckDb: -10,
      minSilenceMs: 250
    })
    expect(kfs[kfs.length - 1].atMs).toBe(5000)
    expect(kfs[kfs.length - 1].gainDb).toBe(0)
  })

  test('A-7 overlapping / unsorted silences are coalesced', () => {
    const kfs = silenceToBgmKeyframes(
      [sr(3000, 4000), sr(2800, 3200), sr(2000, 2500)],
      5000,
      { duckDb: -12, fadeMs: 100, minSilenceMs: 100 }
    )
    // After coalesce: [2000-2500] and [2800-4000] (two distinct silences).
    // 2500-2800 is a speech gap of ~300ms with duckDb-rated BGM, so EVERY
    // keyframe in that window must be at duckDb (no 0dB lift between).
    const speechGapKfs = kfs.filter((k) => k.atMs > 2550 && k.atMs < 2800)
    expect(speechGapKfs.length).toBeGreaterThanOrEqual(1)
    for (const kf of speechGapKfs) {
      expect(kf.gainDb).toBe(-12)
    }
    // Lift markers inside each silence: at least one kf at 0dB between
    // (2050, 2450) and another between (2850, 3950).
    const liftFirst = kfs.find(
      (k) => k.atMs >= 2050 && k.atMs <= 2450 && k.gainDb === 0
    )
    const liftSecond = kfs.find(
      (k) => k.atMs >= 2850 && k.atMs <= 3950 && k.gainDb === 0
    )
    expect(liftFirst).toBeDefined()
    expect(liftSecond).toBeDefined()
  })
})
