/**
 * Phase 3.48 — BPM-based "Beat Sync" auto-cut.
 *
 * Splits the selected media clip at every beat between `clip.startMs` and
 * `clip.endMs`, using the global BPM the user set in the toolbar (the same
 * BPM that drives the existing beat-snap feature). The whole run is wrapped
 * in a single zundo step so one Ctrl+Z undoes the entire cut sequence.
 *
 * NOTE on the "AI" label: today this is BPM-driven (deterministic, fast,
 * no IPC). A future v2 can add real onset detection (WebAudio spectral
 * flux) and pick a real BPM automatically; the rest of this module is
 * already ready to consume any timeline-ms cut list.
 */

import { useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import { isClipLocked, isMediaClip } from '../../../shared/project'

export interface BeatCutOptions {
  /** Use every N-th beat (1 = every beat, 2 = every other, 4 = downbeats). */
  step?: number
}

export interface BeatCutResult {
  /** Number of cuts actually performed (split survivors created). */
  cuts: number
  /** Beat positions that fell inside the clip but couldn't be split
   *  (too close to clip edges / another cut). */
  skipped: number
  /** Reason for a no-op run, if any. */
  reason?:
    | 'no-selection'
    | 'not-media-clip'
    | 'clip-locked'
    | 'no-bpm'
    | 'no-beats-in-range'
}

/** Minimum gap between adjacent cuts (ms). Matches `MIN_CLIP_MS` in the store. */
const MIN_GAP_MS = 200

/**
 * Run BPM-based beat-sync auto-cut against the first SELECTED media clip in
 * the project. Returns a summary; never throws.
 *
 * Behaviour:
 * 1. Reads the global BPM from `timelineUi`. No BPM → `reason: 'no-bpm'`.
 * 2. Reads the first id in `selectedClipIds`. Not a media clip / locked →
 *    bail with the matching reason.
 * 3. Generates beats at `startMs + periodMs * k` for k=0,1,2,…, **skipping
 *    `step - 1` beats between each cut**, while the beat lies strictly
 *    inside `(startMs, endMs)`.
 * 4. Iterates beats DESCENDING — splitClipAt always cuts the original/right
 *    survivor, so cutting late→early keeps every prior cut point valid
 *    against the still-extant clip id chain.
 * 5. Wraps the whole loop in `temporal.pause()/resume()` and pushes ONE
 *    snapshot onto `pastStates` so undo restores the pre-run state in one
 *    keystroke (mirrors `autoEdit.ts`).
 */
export function runBeatCut(opts: BeatCutOptions = {}): BeatCutResult {
  const step = Math.max(1, Math.floor(opts.step ?? 1))
  const bpm = useTimelineUi.getState().bpm
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return { cuts: 0, skipped: 0, reason: 'no-bpm' }
  }

  const selection = useTimelineUi.getState().selectedClipIds
  const firstId = selection.values().next().value as string | undefined
  if (!firstId) return { cuts: 0, skipped: 0, reason: 'no-selection' }

  const store = useProjectStore.getState()
  let targetClip = null as
    | null
    | (ReturnType<typeof useProjectStore.getState>['project']['tracks'][number]['clips'][number])
  for (const t of store.project.tracks) {
    const c = t.clips.find((cc) => cc.id === firstId)
    if (c) {
      targetClip = c
      break
    }
  }
  if (!targetClip) return { cuts: 0, skipped: 0, reason: 'no-selection' }
  if (!isMediaClip(targetClip)) {
    return { cuts: 0, skipped: 0, reason: 'not-media-clip' }
  }
  if (isClipLocked(targetClip)) {
    return { cuts: 0, skipped: 0, reason: 'clip-locked' }
  }

  // Beat timestamps in TIMELINE coordinates. The store's `splitClipAt` expects
  // timeline-ms (it derives source-ms internally, including speed-curve
  // inversion). So we just step periodMs * step starting from the clip's
  // timeline start, skipping the endpoints.
  const periodMs = (60 * 1000) / bpm
  const stride = periodMs * step
  const cutPoints: number[] = []
  let t = targetClip.startMs + stride
  while (t < targetClip.endMs - MIN_GAP_MS) {
    cutPoints.push(Math.round(t))
    t += stride
  }
  if (cutPoints.length === 0) {
    return { cuts: 0, skipped: 0, reason: 'no-beats-in-range' }
  }

  // ONE undo step — pause history, do the work, push a single snapshot.
  const preRunProject = store.project
  const temporal = useProjectStore.temporal.getState()
  temporal.pause()

  let cuts = 0
  let skipped = 0
  try {
    // Descending — every call splits the CURRENT survivor (the clip whose id
    // is `currentId`) into [head | tail]. Cutting late → early keeps
    // `currentId` referring to the same chunk that still contains the next
    // earlier cut point. The splitClipAt action returns the NEW (tail) id,
    // which we DON'T use here — we always re-target the original id, because
    // cutting from the right inside the unchanged head is what we want.
    const ordered = cutPoints.slice().sort((a, b) => b - a)
    for (const atMs of ordered) {
      const tail = useProjectStore.getState().splitClipAt(firstId, atMs)
      if (tail) cuts += 1
      else skipped += 1
    }
  } finally {
    temporal.resume()
    const cur = useProjectStore.getState().project
    if (cur !== preRunProject) {
      useProjectStore.temporal.setState((s) => ({
        pastStates: [...s.pastStates, { project: preRunProject }].slice(-100),
        futureStates: []
      }))
    }
  }

  return { cuts, skipped }
}
