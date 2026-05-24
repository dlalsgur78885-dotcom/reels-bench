/**
 * Phase 3.71 — energy-based onset detection (pure).
 *
 * `detectOnsets(samples, sampleRate, opts)` is a tempo-free transient
 * detector — given mono PCM in [-1,1] it returns timestamps (ms) at
 * which the local energy spikes. The BPM-driven beat-sync cut keeps
 * working unchanged; this helper is a follow-up substrate for a true
 * music-driven cut mode.
 *
 * @phase-3-71-onset-detection
 */
import { expect, test } from '@playwright/test'
import { detectOnsets } from '../../src/renderer/src/lib/onsetDetection'

const SR = 44100

/** Build a click train — silence with N short impulses at given ms offsets. */
function clickTrain(offsetsMs: number[], totalMs: number): Float32Array {
  const out = new Float32Array(Math.round((SR * totalMs) / 1000))
  for (const ms of offsetsMs) {
    const start = Math.round((SR * ms) / 1000)
    // ~5ms attack burst (220 samples at 44.1k).
    for (let i = 0; i < 220 && start + i < out.length; i++) {
      out[start + i] = Math.exp(-i / 60) * (i % 2 === 0 ? 0.9 : -0.9)
    }
  }
  return out
}

test.describe('@phase-3-71-onset-detection energy-based onset detector', () => {
  test('A-1 silence → []', () => {
    expect(detectOnsets(new Float32Array(SR), SR)).toEqual([])
  })

  test('A-2 constant sine → [] (no flux peaks)', () => {
    const samples = new Float32Array(SR)
    for (let i = 0; i < samples.length; i++) {
      samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)
    }
    expect(detectOnsets(samples, SR)).toEqual([])
  })

  test('A-3 4-click train at 0/250/500/750ms → 4 onsets within ±40ms tolerance', () => {
    const truth = [0, 250, 500, 750]
    const samples = clickTrain(truth, 1000)
    const onsets = detectOnsets(samples, SR, {
      windowMs: 20,
      sensitivity: 0.7,
      minGapMs: 100
    })
    expect(onsets.length).toBeGreaterThanOrEqual(3)
    expect(onsets.length).toBeLessThanOrEqual(5)
    // Each truth point matched by SOME onset within ±40ms.
    const within40 = (t: number): boolean =>
      onsets.some((o) => Math.abs(o - t) <= 40)
    // Allow the first click (at t=0) to be missed by the leading-edge guard,
    // but the other three must all be there.
    const missesAllowed = within40(0) ? 0 : 1
    let misses = 0
    for (const t of truth) if (!within40(t)) misses++
    expect(misses).toBeLessThanOrEqual(missesAllowed)
  })

  test('A-4 minGapMs filters double-detection on slow attacks', () => {
    // 2 clicks at 100 + 110ms — 10ms apart, well under minGapMs.
    const samples = clickTrain([100, 110], 500)
    const onsets = detectOnsets(samples, SR, { minGapMs: 100 })
    // With 100ms gap enforced, can't have two onsets within 100ms.
    for (let i = 1; i < onsets.length; i++) {
      expect(onsets[i] - onsets[i - 1]).toBeGreaterThanOrEqual(100)
    }
  })

  test('A-5 lower sensitivity raises the threshold → fewer or equal onsets', () => {
    const samples = clickTrain([200, 400, 600, 800], 1000)
    const loose = detectOnsets(samples, SR, { sensitivity: 0.9 })
    const strict = detectOnsets(samples, SR, { sensitivity: 0.1 })
    expect(strict.length).toBeLessThanOrEqual(loose.length)
  })

  test('A-6 too-short / empty input → [] (defensive)', () => {
    expect(detectOnsets(new Float32Array(0), SR)).toEqual([])
    expect(detectOnsets(new Float32Array(10), SR)).toEqual([])
    expect(detectOnsets(new Float32Array(1000), 0)).toEqual([])
  })
})
