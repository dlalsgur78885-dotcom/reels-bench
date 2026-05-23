import {
  NO_CAPTION_KARAOKE,
  type CaptionClip,
  type CaptionSpan,
  type CaptionStyle,
  type CaptionWord
} from '../../../shared/project'
import type { ParsedCaptionCue, SttWord } from '../../../shared/ipc'
import type { TextTemplate } from '../../../shared/textTemplates'
import { newId, useProjectStore } from '../store/project'
import { makeStyleFromPreset } from './captionPresets'

const DEFAULT_DURATION_MS = 2000
const DEFAULT_TEXT = '자막을 입력하세요'

/** Build spans from a string (split on whitespace). */
export function spansFromText(text: string): CaptionSpan[] {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return [{ text: DEFAULT_TEXT }]
  return words.map((w) => ({ text: w }))
}

/**
 * Insert a new caption clip at the playhead. Returns the new clip's id, or
 * null if the project has no caption track (shouldn't happen — freshProject
 * always creates one).
 */
export function insertCaptionAtPlayhead(
  playheadMs: number,
  opts?: { text?: string; durationMs?: number }
): string | null {
  const store = useProjectStore.getState()
  const trackId = store.getCaptionTrackId()
  if (!trackId) return null

  const id = newId()
  const text = opts?.text ?? DEFAULT_TEXT
  const dur = Math.max(200, opts?.durationMs ?? DEFAULT_DURATION_MS)

  const clip: CaptionClip = {
    id,
    kind: 'caption',
    trackId,
    startMs: Math.max(0, Math.round(playheadMs)),
    endMs: Math.max(0, Math.round(playheadMs)) + dur,
    spans: spansFromText(text),
    style: makeStyleFromPreset('bottom-center')
  }
  store.addCaption(clip)
  return id
}

/**
 * Insert a text-template (Phase 3.24) as a plain caption clip at the playhead.
 * Returns the new clip's id, or null if there is no caption track.
 *
 * The templates in `TEXT_TEMPLATES` are module-level constants — `CaptionEditor`
 * mutates `clip.style` / `clip.spans` by spreading, so the template data MUST be
 * deep-cloned here. A shallow share would let an edit corrupt the library.
 * Once inserted the result is an ordinary `CaptionClip` (export/preview/undo
 * all apply unchanged); a single `addCaption` is one zundo snapshot → one undo.
 */
export function insertTextTemplateAtPlayhead(
  template: TextTemplate,
  playheadMs: number
): string | null {
  const store = useProjectStore.getState()
  const trackId = store.getCaptionTrackId()
  if (!trackId) return null

  const id = newId()
  const startMs = Math.max(0, Math.round(playheadMs))
  const endMs = startMs + Math.max(200, template.durationMs)

  // Deep-clone every nested object so the inserted clip shares NOTHING by
  // reference with the template constant.
  const style: CaptionStyle = { ...template.style }
  if (template.style.textStroke) {
    style.textStroke = { ...template.style.textStroke }
  }
  if (template.style.textShadow) {
    style.textShadow = { ...template.style.textShadow }
  }

  const clip: CaptionClip = {
    id,
    kind: 'caption',
    trackId,
    startMs,
    endMs,
    spans: template.spans.map((s) => ({ ...s })),
    style
  }
  if (template.animation) {
    clip.animation = { ...template.animation }
  }

  store.addCaption(clip)
  return id
}

/**
 * Convert parsed SRT/VTT cues into caption clips, all on the caption track.
 *
 * When `words` is supplied (STT word-granularity pass), each cue picks the
 * `SttWord`s that fall inside its `[startMs, endMs]` window, rebases them to
 * clip-relative ms, and builds `caption.words`. The cue's `spans` are rebuilt
 * from those exact words so `spans` and `words` are positionally 1:1 (one span
 * per word) at generation time, and `caption.karaoke` is switched on by default
 * — matching CapCut's auto-caption behavior. A cue with NO matching words is
 * left as a legacy caption (no `words`, no `karaoke`).
 */
export function cuesToClips(
  cues: ParsedCaptionCue[],
  words?: SttWord[]
): CaptionClip[] {
  const store = useProjectStore.getState()
  const trackId = store.getCaptionTrackId()
  if (!trackId) return []
  const allWords = Array.isArray(words) ? words : []
  return cues.map((cue) => {
    const startMs = Math.max(0, Math.round(cue.startMs))
    const endMs = Math.max(startMs + 200, Math.round(cue.endMs))

    // Select the words whose timing falls within this cue's window, then
    // rebase each to clip-relative ms.
    const cueWords: CaptionWord[] = allWords
      .filter((w) => w.startMs >= cue.startMs && w.startMs < cue.endMs)
      .map((w) => ({
        text: w.text,
        startMs: Math.max(0, Math.round(w.startMs - cue.startMs)),
        endMs: Math.max(
          Math.round(w.startMs - cue.startMs),
          Math.round(w.endMs - cue.startMs)
        )
      }))

    const base: CaptionClip = {
      id: newId(),
      kind: 'caption' as const,
      trackId,
      startMs,
      endMs,
      // 1:1 with words when word timing exists; else split the cue text.
      spans:
        cueWords.length > 0
          ? cueWords.map((w) => ({ text: w.text }))
          : spansFromText(cue.text),
      style: makeStyleFromPreset('bottom-center')
    }
    if (cueWords.length > 0) {
      base.words = cueWords
      // STT-generated captions are karaoke-ON by default.
      base.karaoke = { ...NO_CAPTION_KARAOKE, enabled: true }
    }
    return base
  })
}

/** Append clips to the store. */
export function addClipsToStore(clips: CaptionClip[]): void {
  const store = useProjectStore.getState()
  for (const c of clips) store.addCaption(c)
}
