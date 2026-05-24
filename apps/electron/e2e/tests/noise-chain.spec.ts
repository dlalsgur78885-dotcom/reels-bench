/**
 * Phase 3.69 — multi-stage noise-reduction chain.
 *
 * The single-stage `afftdn=…` is now a three-stage chain:
 *   highpass=f=80  (rumble strip)  →  afftdn=nr=…:nf=-25  (spectral)  →
 *   dynaudnorm=…   (gentle leveling)
 *
 * `noiseReduction` absent / 0 STILL returns '' (byte-identical export for
 * clips that never opted in). Only clips with strength > 0 see the new
 * chain.
 *
 * @phase-3-69-noise-chain
 */
import { expect, test } from '@playwright/test'
import { denoiseChain } from '../../src/main/ipc/export'
import type { VideoAudioClip } from '../../src/shared/project'

function mkClip(nr: number | undefined): VideoAudioClip {
  return {
    id: 'c1',
    kind: 'media',
    mediaId: 'm1',
    trackId: 't1',
    startMs: 0,
    endMs: 1000,
    trimInMs: 0,
    trimOutMs: 1000,
    speed: 1,
    noiseReduction: nr
  } as VideoAudioClip
}

test.describe('@phase-3-69-noise-chain denoise chain', () => {
  test('A-1 noiseReduction absent → empty string (BC-safe, byte-identical export)', () => {
    expect(denoiseChain(mkClip(undefined))).toBe('')
  })

  test('A-2 noiseReduction = 0 → empty string (BC-safe)', () => {
    expect(denoiseChain(mkClip(0))).toBe('')
  })

  test('A-3 strength > 0 → three stages: highpass / afftdn / dynaudnorm', () => {
    const chain = denoiseChain(mkClip(50))
    expect(chain).toContain('highpass=f=80')
    expect(chain).toContain('afftdn=nr=')
    expect(chain).toContain('dynaudnorm=')
    // Stage ordering matters (rumble strip first, leveling last).
    const hpIdx = chain.indexOf('highpass')
    const afIdx = chain.indexOf('afftdn')
    const dnIdx = chain.indexOf('dynaudnorm')
    expect(hpIdx).toBeLessThan(afIdx)
    expect(afIdx).toBeLessThan(dnIdx)
  })

  test('A-4 afftdn nr scales with strength (range 6..30 dB)', () => {
    const weak = denoiseChain(mkClip(1))
    const strong = denoiseChain(mkClip(100))
    // Pull out the nr= value.
    const nrFrom = (s: string): number => {
      const m = s.match(/afftdn=nr=([0-9.]+)/)
      return m ? Number(m[1]) : NaN
    }
    expect(nrFrom(weak)).toBeGreaterThanOrEqual(6)
    expect(nrFrom(weak)).toBeLessThanOrEqual(7)
    expect(nrFrom(strong)).toBeGreaterThanOrEqual(29)
    expect(nrFrom(strong)).toBeLessThanOrEqual(30.01)
  })

  test('A-5 dynaudnorm gain cap (m=) scales with strength', () => {
    const weak = denoiseChain(mkClip(1))
    const strong = denoiseChain(mkClip(100))
    const mFrom = (s: string): number => {
      const m = s.match(/dynaudnorm=[^,]*m=([0-9.]+)/)
      return m ? Number(m[1]) : NaN
    }
    expect(mFrom(weak)).toBeCloseTo(1.515, 2)
    expect(mFrom(strong)).toBeCloseTo(3.0, 2)
  })
})
