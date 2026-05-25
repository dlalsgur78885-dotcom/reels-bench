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
import { STT_LOW_CONFIDENCE_THRESHOLD, type SttCue, type SttWord } from '../../../shared/ipc'
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
  const clips = cuesToClips(cues, words)
  // audit #10 — when the transcriber populated `confidence` on a cue and
  // it dropped below the threshold, mark the resulting caption clip so the
  // preview can warn the editor. cuesToClips builds clips in the same
  // order as the input cues, so a positional zip is correct.
  for (let i = 0; i < clips.length && i < cues.length; i++) {
    const conf = cues[i]?.confidence
    if (typeof conf === 'number' && conf < STT_LOW_CONFIDENCE_THRESHOLD) {
      clips[i].lowConfidence = true
    }
  }
  return clips
}
