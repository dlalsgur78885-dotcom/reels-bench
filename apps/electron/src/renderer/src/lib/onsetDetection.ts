/**
 * Phase 3.71 — energy-based onset detection (pure helper).
 *
 * No DOM, no WebAudio API — just `Float32Array` PCM samples in, onset
 * timestamps (ms) out. Mirrors the structure of `lib/colorScopes.ts`:
 * pure math, deterministic, unit-testable in isolation.
 *
 * Algorithm:
 *   1. Slice into fixed-size windows (~20ms each by default).
 *   2. Compute RMS per window.
 *   3. Compute positive flux: max(0, rms[w] - rms[w-1]).
 *   4. Adaptive threshold = mean(flux) * (1 + (1 - sensitivity) * 3).
 *      sensitivity ∈ [0,1]; lower → stricter threshold, fewer onsets.
 *   5. Pick local maxima above threshold, enforcing a minimum gap to
 *      avoid double-detection on slow attacks.
 *
 * This is a "tempo-free" onset detector — it does NOT lock to a grid.
 * The `lib/beatCut.ts` BPM detector remains the default; a follow-up
 * phase can wire onset timestamps through `splitClipAtMany` for true
 * music-driven cuts.
 */

export interface OnsetDetectionOptions {
  /** Analysis window length in ms. Default 20 (50 Hz frame rate). */
  windowMs?: number
  /** Sensitivity 0..1. Higher = more onsets. Default 0.5. */
  sensitivity?: number
  /** Minimum spacing between adjacent onsets in ms. Default 100. */
  minGapMs?: number
}

/**
 * Detect onset timestamps (clip-relative ms) in a mono PCM stream.
 *
 * `samples` must be float PCM in [-1, 1] (what `AudioBuffer.getChannelData`
 * yields). Stereo is the caller's responsibility — mix down to mono first.
 *
 * Returns onset times in ascending ms order. Empty array when the stream
 * is too short, silent, or contains no detectable transients.
 */
export function detectOnsets(
  samples: Float32Array,
  sampleRate: number,
  opts: OnsetDetectionOptions = {}
): number[] {
  if (
    !samples ||
    samples.length === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    return []
  }
  const windowMs = Math.max(1, opts.windowMs ?? 20)
  const sensitivity = Math.max(0, Math.min(1, opts.sensitivity ?? 0.5))
  const minGapMs = Math.max(1, opts.minGapMs ?? 100)

  const windowSize = Math.max(1, Math.floor((sampleRate * windowMs) / 1000))
  // Need at least two windows of audio to see any flux at all.
  if (samples.length < windowSize * 2) return []

  const numWindows = Math.floor(samples.length / windowSize)
  const rms = new Float64Array(numWindows)
  let rmsSum = 0
  for (let w = 0; w < numWindows; w++) {
    let sum = 0
    const start = w * windowSize
    for (let i = 0; i < windowSize; i++) {
      const s = samples[start + i]
      sum += s * s
    }
    rms[w] = Math.sqrt(sum / windowSize)
    rmsSum += rms[w]
  }
  const meanRms = rmsSum / Math.max(1, numWindows)

  // Positive RMS flux (rectified differential — energy that has just risen).
  const flux = new Float64Array(numWindows)
  let fluxSum = 0
  for (let w = 1; w < numWindows; w++) {
    const f = rms[w] - rms[w - 1]
    if (f > 0) {
      flux[w] = f
      fluxSum += f
    }
  }
  const meanFlux = fluxSum / Math.max(1, numWindows - 1)
  // Adaptive threshold = meanFlux * (1 + (1 - sens) * 3). sens=1 → threshold
  // = mean; sens=0 → threshold = 4*mean.
  // PLUS a RELATIVE floor (5% of mean RMS) — a constant-amplitude stream
  // (silence, steady sine) generates small flux from window-boundary phase
  // noise (~1% of RMS); the relative floor cuts that noise without
  // suppressing real transients (which spike RMS ≥ 10×).
  const relativeFloor = meanRms * 0.05
  const adaptiveThreshold = meanFlux * (1 + (1 - sensitivity) * 3)
  const threshold = Math.max(0.005, relativeFloor, adaptiveThreshold)
  if (!Number.isFinite(threshold) || threshold <= 0) return []

  const minGapWindows = Math.max(1, Math.floor(minGapMs / windowMs))
  const onsets: number[] = []
  let lastOnsetWindow = -minGapWindows
  for (let w = 1; w < numWindows - 1; w++) {
    const fw = flux[w]
    if (fw < threshold) continue
    // Local max — strictly greater than the immediate predecessor, ≥ the
    // successor (so a flat plateau doesn't fire twice).
    if (fw <= flux[w - 1] || fw < flux[w + 1]) continue
    if (w - lastOnsetWindow < minGapWindows) continue
    onsets.push(Math.round((w * windowSize * 1000) / sampleRate))
    lastOnsetWindow = w
  }
  return onsets
}
