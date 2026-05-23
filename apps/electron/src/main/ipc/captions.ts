import { ipcMain } from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { ParsedCaptionCue, SubtitleExportResult } from '../../shared/ipc'
import { assertPathAllowed } from '../ffmpeg/security'

// ---------------------------------------------------------------------------
// SRT / VTT parser — pure, side-effect free. Returns cue list, caller maps
// to CaptionClip with a track id (renderer side, after parse).
//
// Edge cases handled:
//   - BOM (UTF-8 / UTF-16-LE) stripped before parsing
//   - CRLF / LF / CR line endings normalized
//   - Leading "WEBVTT" header (and optional "NOTE …" blocks) skipped
//   - Missing index numbers (some VTT, some hand-edited SRT) tolerated
//   - Multi-line cue text joined with " " (single space)
//   - Empty cue blocks (consecutive blank lines) skipped silently
//   - SRT comma decimals (00:00:01,500) and VTT dot decimals (00:00:01.500)
//   - Hours field optional (mm:ss.SSS short form, common in some VTT)
// ---------------------------------------------------------------------------

const BOM_UTF8 = '\uFEFF'

function stripBom(s: string): string {
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) return s.slice(1)
  if (s.startsWith(BOM_UTF8)) return s.slice(BOM_UTF8.length)
  return s
}

function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

/**
 * Parse a single timestamp like:
 *   00:00:01,500   (SRT, comma)
 *   00:00:01.500   (VTT, dot)
 *   01:23.450      (short VTT — mm:ss.SSS)
 * Returns milliseconds. Throws on unparseable input.
 */
export function parseTimestampToMs(raw: string): number {
  const trimmed = raw.trim().replace(',', '.')
  // Split into h/m/s/ms portions.
  const parts = trimmed.split(':')
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`bad timestamp: ${raw}`)
  }
  let hours = 0
  let minutes = 0
  let secondsPart: string

  if (parts.length === 3) {
    hours = Number(parts[0])
    minutes = Number(parts[1])
    secondsPart = parts[2]
  } else {
    minutes = Number(parts[0])
    secondsPart = parts[1]
  }
  // secondsPart may be "01.500" or "01"
  const [secStr, msStr = '0'] = secondsPart.split('.')
  const seconds = Number(secStr)
  // Pad ms to 3 digits if shorter (e.g. ".5" → 500ms).
  const msNum = Number(msStr.padEnd(3, '0').slice(0, 3))

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(msNum)
  ) {
    throw new Error(`bad timestamp: ${raw}`)
  }
  return ((hours * 3600 + minutes * 60 + seconds) * 1000) + msNum
}

/** SRT/VTT arrow line: "00:00:00,000 --> 00:00:02,500 [extra hint]" */
const ARROW_RE = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?\s*$/

export function parseSrtOrVtt(raw: string): ParsedCaptionCue[] {
  const text = normalizeLineEndings(stripBom(raw))
  const lines = text.split('\n')

  // Skip a leading WEBVTT header + any header blocks (NOTE / STYLE / region).
  let i = 0
  if (lines[0]?.trim().toUpperCase().startsWith('WEBVTT')) {
    i = 1
    // Skip until first blank line.
    while (i < lines.length && lines[i].trim() !== '') i++
    // skip the blank
    while (i < lines.length && lines[i].trim() === '') i++
  }

  const cues: ParsedCaptionCue[] = []

  while (i < lines.length) {
    // Skip blank separator lines.
    while (i < lines.length && lines[i].trim() === '') i++
    if (i >= lines.length) break

    // Skip optional cue identifier (a single number or bare id line).
    // Heuristic: if the current line is NOT an arrow line but the next is, it's an id.
    let cueIdLine = ''
    if (!ARROW_RE.test(lines[i]) && i + 1 < lines.length && ARROW_RE.test(lines[i + 1])) {
      cueIdLine = lines[i].trim()
      i++
    }

    if (i >= lines.length) break

    // Skip NOTE / STYLE blocks that some VTT files include between cues.
    const upperFirst = lines[i].trim().toUpperCase()
    if (
      (upperFirst.startsWith('NOTE') || upperFirst.startsWith('STYLE')) &&
      !ARROW_RE.test(lines[i])
    ) {
      // consume until blank line
      while (i < lines.length && lines[i].trim() !== '') i++
      continue
    }

    const arrowMatch = ARROW_RE.exec(lines[i])
    if (!arrowMatch) {
      // Unrecognized; skip this line to avoid infinite loop.
      i++
      continue
    }
    let startMs: number
    let endMs: number
    try {
      startMs = parseTimestampToMs(arrowMatch[1])
      endMs = parseTimestampToMs(arrowMatch[2])
    } catch {
      i++
      continue
    }
    i++

    // Collect the text body until blank line or EOF.
    const bodyLines: string[] = []
    while (i < lines.length && lines[i].trim() !== '') {
      bodyLines.push(lines[i])
      i++
    }
    const body = bodyLines.join(' ').replace(/\s+/g, ' ').trim()
    if (body.length === 0) continue

    if (endMs <= startMs) {
      // Defensive: zero-or-negative duration cue; nudge to 1s minimum.
      endMs = startMs + 1000
    }

    cues.push({
      id: cueIdLine || undefined,
      startMs,
      endMs,
      text: body
    })
  }
  return cues
}

// ---------------------------------------------------------------------------
// IPC registration.
// ---------------------------------------------------------------------------

export function registerCaptionHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.captions.importSrt, async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) {
      throw new Error('[captions] importSrt: bad path')
    }
    const resolved = assertPathAllowed(filePath, 'input')
    const raw = await readFile(resolved, 'utf-8')
    return parseSrtOrVtt(raw)
  })

  // Write a generated SRT/VTT string to disk. The renderer obtains `p` from
  // fs.saveFile (which allow-lists it); we re-assert the allow check here.
  ipcMain.handle(
    IPC_CHANNELS.captions.exportSubtitle,
    async (_event, p: unknown, content: unknown): Promise<SubtitleExportResult> => {
      try {
        if (typeof p !== 'string' || p.length === 0 || p.length > 4096) {
          return { ok: false, error: 'bad path' }
        }
        if (typeof content !== 'string') {
          return { ok: false, error: 'content must be a string' }
        }
        if (content.length > 8 * 1024 * 1024) {
          return { ok: false, error: 'content too large (>8MB)' }
        }
        // Same allow-list check the export/cover-frame output handlers use.
        const resolved = assertPathAllowed(p, 'output')
        // Atomic write — write a sibling tmp file then rename.
        const tmp = resolved + '.tmp'
        await writeFile(tmp, content, 'utf-8')
        await rename(tmp, resolved)
        return {
          ok: true,
          path: resolved,
          bytesWritten: Buffer.byteLength(content, 'utf-8')
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: message }
      }
    }
  )

  // Renderer-side parsing escape hatch — pass a raw SRT/VTT string. Used for
  // test fixtures and for files the user pastes directly (no disk path).
  ipcMain.handle(IPC_CHANNELS.captions.parseSrtString, async (_event, raw: unknown) => {
    if (typeof raw !== 'string') {
      throw new Error('[captions] parseSrtString: string required')
    }
    if (raw.length > 2 * 1024 * 1024) {
      throw new Error('[captions] parseSrtString: payload too large (>2MB)')
    }
    return parseSrtOrVtt(raw)
  })
}
