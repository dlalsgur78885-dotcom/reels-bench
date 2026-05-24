/**
 * Phase 3.85 — auto BGM fade.
 *
 * Pure helper that converts a voice clip's silence-range list into a BGM
 * clip's `VolumeKeyframe[]` so the BGM automatically ducks (drops in dB)
 * while the speaker is talking and lifts during silences.
 *
 * Algorithm
 * ---------
 *
 * Given silence ranges (where the speaker is QUIET — BGM should be loud)
 * over a clip span [0, totalMs], produce a piecewise gain curve:
 *
 *     ┌── 0dB ───┐         ┌── 0dB ───┐
 *     │          ╲         ╱          │
 *     │           ╲       ╱           │
 *     │            ╲_____╱            │   ← -duckDb during speech
 *
 * Each silence→speech edge gets two keyframes `fadeMs` apart so the gain
 * cross-fades smoothly instead of clicking. Same for speech→silence edges.
 *
 * Pure (no DOM, no IPC). Consumed by an upcoming "BGM 자동 페이드 적용"
 * action that writes the resulting array to `clip.volumeKeyframes`.
 */
import type { VolumeKeyframe } from '../../../shared/project'
import type { SilenceRange } from '../../../shared/ipc'

export interface AutoBgmFadeOptions {
  /** dB drop during speech sections. Negative; default -12. */
  duckDb?: number
  /** Cross-fade length in ms around each silence/speech edge. Default 200. */
  fadeMs?: number
  /** Skip silences shorter than this (treat as continued speech). Default 250. */
  minSilenceMs?: number
}

/**
 * Build a piecewise BGM volume curve. `silenceRanges` may be unsorted /
 * overlapping; the helper sorts + coalesces internally. `totalMs` is the
 * BGM clip's full duration (clip-relative ms — same coordinate as the
 * returned `atMs`).
 *
 * Returns:
 *   - `[]` when silenceRanges yields no usable curve (totalMs <= 0, all
 *     silences below minSilenceMs, etc.) — caller treats `[]` as "no
 *     auto-fade, fall back to the clip's static gainDb".
 *   - A `VolumeKeyframe[]` whose first kf is at atMs=0 and last is at
 *     atMs=totalMs (inclusive endpoints so the envelope spans the clip).
 */
export function silenceToBgmKeyframes(
  silenceRanges: ReadonlyArray<SilenceRange>,
  totalMs: number,
  opts: AutoBgmFadeOptions = {}
): VolumeKeyframe[] {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return []
  const duckDb = opts.duckDb ?? -12
  const fadeMs = Math.max(20, opts.fadeMs ?? 200)
  const minSilenceMs = Math.max(0, opts.minSilenceMs ?? 250)

  // Clean + coalesce ranges into [start, end] tuples within [0, totalMs].
  const ranges: Array<[number, number]> = []
  const sorted = [...silenceRanges]
    .filter(
      (r) =>
        r &&
        Number.isFinite(r.startMs) &&
        Number.isFinite(r.endMs) &&
        r.endMs > r.startMs
    )
    .map((r) => ({
      startMs: Math.max(0, Math.min(totalMs, Math.round(r.startMs))),
      endMs: Math.max(0, Math.min(totalMs, Math.round(r.endMs)))
    }))
    .filter((r) => r.endMs - r.startMs >= minSilenceMs)
    .sort((a, b) => a.startMs - b.startMs)
  for (const r of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && r.startMs <= last[1]) {
      last[1] = Math.max(last[1], r.endMs)
    } else {
      ranges.push([r.startMs, r.endMs])
    }
  }

  // Edge case — no usable silences → entire clip is speech, BGM stays
  // ducked the whole time. Emit a flat curve at duckDb so the envelope
  // still applies (caller may prefer plain gainDb instead — they can
  // ignore the result if length < 2 won't help).
  if (ranges.length === 0) {
    return [
      { atMs: 0, gainDb: duckDb },
      { atMs: totalMs, gainDb: duckDb }
    ]
  }

  const kfs: VolumeKeyframe[] = []
  const push = (atMs: number, gainDb: number): void => {
    const cl = Math.max(0, Math.min(totalMs, Math.round(atMs)))
    const last = kfs[kfs.length - 1]
    // De-dup zero-gap pairs (last write wins).
    if (last && Math.abs(cl - last.atMs) < 1) {
      kfs[kfs.length - 1] = { atMs: cl, gainDb }
      return
    }
    kfs.push({ atMs: cl, gainDb })
  }

  // Start: if the very first sample isn't inside a silence, BGM starts
  // ducked (speech is ongoing from t=0).
  const startsInSilence = ranges[0][0] === 0
  push(0, startsInSilence ? 0 : duckDb)

  // For every silence range, fade up to 0dB at its leading edge and back
  // down to duckDb at its trailing edge.
  for (const [s, e] of ranges) {
    if (s > 0) {
      // speech → silence transition: ramp up over fadeMs centered on `s`.
      push(s - fadeMs / 2, duckDb)
      push(s + fadeMs / 2, 0)
    }
    if (e < totalMs) {
      // silence → speech transition: ramp down.
      push(e - fadeMs / 2, 0)
      push(e + fadeMs / 2, duckDb)
    }
  }

  // End: hold whichever state matches the last segment.
  const endsInSilence = ranges[ranges.length - 1][1] >= totalMs
  push(totalMs, endsInSilence ? 0 : duckDb)

  // Need at least 2 keyframes for the store to honor a variable curve.
  return kfs.length >= 2 ? kfs : []
}
