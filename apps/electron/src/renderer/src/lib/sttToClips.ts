/**
 * STT cue → caption clip conversion (자동 자막 STT, Spec §3c).
 *
 * `SttCue` is shape-compatible with `ParsedCaptionCue` (both carry
 * `startMs`/`endMs`/`text` — `SttCue` simply lacks the optional `id`). So we
 * delegate straight to the existing `cuesToClips` in `lib/captions.ts`, which
 * already resolves the caption track id, builds spans, and applies the
 * default `bottom-center` style. This file is a thin, intentional wrapper so
 * the STT dialog has a single, named conversion entry point.
 *
 * The dialog then bulk-inserts via `useProjectStore.getState().addCaptions()`
 * — the atomic insert that coalesces to one undo step / one re-render.
 */
import type { SttCue, SttWord } from '../../../shared/ipc'
import type { CaptionClip } from '../../../shared/project'
import { cuesToClips } from './captions'

/**
 * Convert transcribed STT cues into caption clips on the project's caption
 * track. Returns an empty array when the project has no caption track.
 *
 * When `words` is provided (Phase 3.17 word-granularity transcription), it is
 * threaded into `cuesToClips`, which slices each cue's words, rebases them to
 * clip-relative ms, and switches karaoke on for those captions.
 */
export function sttCuesToClips(
  cues: SttCue[],
  words?: SttWord[]
): CaptionClip[] {
  if (!Array.isArray(cues) || cues.length === 0) return []
  // SttCue ⊆ ParsedCaptionCue (id optional) — safe widening for cuesToClips.
  return cuesToClips(cues, words)
}
