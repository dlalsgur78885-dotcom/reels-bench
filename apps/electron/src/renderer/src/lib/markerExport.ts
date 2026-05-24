/**
 * Phase 3.73 — convert timeline markers to a YouTube/Vimeo-style chapter
 * list.
 *
 * Pure (no DOM, no IPC). The Editor's 옵션 popover wires a "챕터 마커 복사"
 * button that pipes the result into `navigator.clipboard.writeText`.
 *
 * YouTube chapter rules (paraphrased from the upload docs):
 *   - First timestamp MUST be `00:00` (or `00:00:00` if the video is ≥ 1h).
 *   - At least 3 chapters required.
 *   - Each chapter ≥ 10 seconds long.
 *   - One per line: `TIMESTAMP TITLE`.
 *
 * We emit a best-effort string that satisfies the format. If the user's
 * first marker is > 100ms past zero we prepend an "Intro" entry so the
 * 00:00 invariant holds. We do NOT enforce the 3-chapter / 10-second
 * minimums — those are content rules YouTube prefers, not file-format
 * requirements. The user sees what they wrote; uploading a too-short list
 * just won't activate chapters on YouTube, which is acceptable.
 */

import type { TimelineMarker } from '../store/timelineUi'

export type ChapterFormat = 'youtube' | 'simple'

/** Format ms as MM:SS or HH:MM:SS depending on `useHours`. */
function formatTimestamp(ms: number, useHours: boolean): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (useHours) return `${pad(h)}:${pad(m)}:${pad(s)}`
  return `${pad(m)}:${pad(s)}`
}

/**
 * Convert markers → multiline chapter string.
 *
 * Always returns a sorted-ascending, line-separated string with no
 * trailing newline. Empty input → empty string. Marker labels are
 * trimmed; if a marker has no label, fall back to "Chapter N".
 *
 * `format='youtube'`: prepends an "Intro" line at 00:00 if the earliest
 * marker is past zero. `format='simple'`: never prepends.
 */
export function markersToChapters(
  markers: ReadonlyArray<TimelineMarker>,
  format: ChapterFormat = 'youtube'
): string {
  if (!Array.isArray(markers) || markers.length === 0) return ''
  const sorted = [...markers].sort((a, b) => a.atMs - b.atMs)
  // Hours format threshold — once any marker (or the implied total) crosses
  // 1h, every line gets HH:MM:SS to stay uniform.
  const useHours = sorted[sorted.length - 1].atMs >= 3600 * 1000
  const lines: string[] = []
  if (format === 'youtube' && sorted[0].atMs > 100) {
    lines.push(`${formatTimestamp(0, useHours)} Intro`)
  }
  sorted.forEach((m, idx) => {
    const time = formatTimestamp(m.atMs, useHours)
    const title = (m.label ?? '').trim() || `Chapter ${idx + 1}`
    lines.push(`${time} ${title}`)
  })
  return lines.join('\n')
}
