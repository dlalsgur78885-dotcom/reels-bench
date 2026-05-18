import type {
  CaptionClip,
  CaptionSpan
} from '../../../shared/project'
import type { ParsedCaptionCue } from '../../../shared/ipc'
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

/** Convert parsed SRT/VTT cues into caption clips, all on the caption track. */
export function cuesToClips(cues: ParsedCaptionCue[]): CaptionClip[] {
  const store = useProjectStore.getState()
  const trackId = store.getCaptionTrackId()
  if (!trackId) return []
  return cues.map((cue) => ({
    id: newId(),
    kind: 'caption' as const,
    trackId,
    startMs: Math.max(0, Math.round(cue.startMs)),
    endMs: Math.max(Math.round(cue.startMs) + 200, Math.round(cue.endMs)),
    spans: spansFromText(cue.text),
    style: makeStyleFromPreset('bottom-center')
  }))
}

/** Append clips to the store. */
export function addClipsToStore(clips: CaptionClip[]): void {
  const store = useProjectStore.getState()
  for (const c of clips) store.addCaption(c)
}
