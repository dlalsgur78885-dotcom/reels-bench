/**
 * Subtitle export (Phase 3.34) — build a `.srt` / `.vtt` document from a
 * project's caption clips. Pure: no `electron`/`fs`/store imports — fully
 * unit-testable. Does NOT touch the video/mp4 export pipeline.
 */
import type { CaptionClip } from './project'

export type SubtitleFormat = 'srt' | 'vtt'

/** `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT) from a non-negative ms value. */
export function formatTimestamp(ms: number, format: SubtitleFormat): string {
  const sep = format === 'srt' ? ',' : '.'
  const total = Math.max(0, Math.floor(Number.isFinite(ms) ? ms : 0))
  const h = Math.floor(total / 3600000)
  const m = Math.floor((total % 3600000) / 60000)
  const s = Math.floor((total % 60000) / 1000)
  const ms3 = total % 1000
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${String(ms3).padStart(3, '0')}`
}

interface SubtitleCue {
  startMs: number
  endMs: number
  text: string
}

/**
 * Collect printable cues from caption clips — defensive (clips may arrive over
 * IPC unvalidated): joins spans with a single space, strips embedded newlines,
 * drops empty-text clips, clamps ms (endMs >= startMs + 1), sorts ascending.
 */
function gatherCues(clips: CaptionClip[]): SubtitleCue[] {
  if (!Array.isArray(clips)) return []
  const cues: SubtitleCue[] = []
  for (const c of clips) {
    if (!c || !Array.isArray(c.spans)) continue
    const text = c.spans
      .map((s) => (s && typeof s.text === 'string' ? s.text : ''))
      .join(' ')
      .replace(/\r?\n/g, ' ')
      .trim()
    if (text.length === 0) continue
    const start = Math.max(0, Math.round(Number.isFinite(c.startMs) ? c.startMs : 0))
    const end = Math.max(
      start + 1,
      Math.round(Number.isFinite(c.endMs) ? c.endMs : start + 1)
    )
    cues.push({ startMs: start, endMs: end, text })
  }
  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  return cues
}

/** Build an `.srt` document. Empty string when there are no printable cues. */
export function captionsToSrt(clips: CaptionClip[]): string {
  const cues = gatherCues(clips)
  if (cues.length === 0) return ''
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\n` +
        `${formatTimestamp(cue.startMs, 'srt')} --> ` +
        `${formatTimestamp(cue.endMs, 'srt')}\n` +
        `${cue.text}\n`
    )
    .join('\n')
}

/** Build a `.vtt` document (always has the `WEBVTT` header). */
export function captionsToVtt(clips: CaptionClip[]): string {
  const cues = gatherCues(clips)
  const body = cues
    .map(
      (cue) =>
        `${formatTimestamp(cue.startMs, 'vtt')} --> ` +
        `${formatTimestamp(cue.endMs, 'vtt')}\n` +
        `${cue.text}\n`
    )
    .join('\n')
  return `WEBVTT\n\n${body}`
}

/** Build a subtitle document in the requested format. */
export function captionsToSubtitle(
  clips: CaptionClip[],
  format: SubtitleFormat
): string {
  return format === 'srt' ? captionsToSrt(clips) : captionsToVtt(clips)
}
