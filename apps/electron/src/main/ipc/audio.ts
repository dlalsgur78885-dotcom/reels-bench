import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import {
  IPC_CHANNELS,
  type BeatDetectOptions,
  type BeatMarker,
  type SilenceDetectOptions,
  type SilenceRange
} from '../../shared/ipc'
import { resolveFfmpegPath } from '../ffmpeg/binary'
import { assertPathAllowed } from '../ffmpeg/security'

// ---------------------------------------------------------------------------
// Silence detection — uses ffmpeg's silencedetect filter and parses stderr.
// ---------------------------------------------------------------------------

const SILENCE_TIMEOUT_MS = 120_000

function runSilenceDetect(
  ffmpeg: string,
  filePath: string,
  noiseDb: number,
  minSec: number
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-nostdin',
      '-i',
      filePath,
      '-af',
      `silencedetect=noise=${noiseDb}dB:d=${minSec}`,
      '-f',
      'null',
      '-'
    ]
    const proc = spawn(ffmpeg, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    const STDERR_LIMIT = 1024 * 1024
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // ignore
      }
      reject(new Error('[ffmpeg] silencedetect timed out'))
    }, SILENCE_TIMEOUT_MS)
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT)
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      // ffmpeg exits 0 even when input has no audio; reject only on hard error.
      if (code === 0 || code === null) resolve(stderr)
      else reject(new Error(`[ffmpeg] silencedetect exited ${code}: ${stderr.slice(-512)}`))
    })
  })
}

const SILENCE_START_RE = /silence_start:\s*(-?[\d.]+)/g
const SILENCE_END_RE = /silence_end:\s*(-?[\d.]+)\s*\|?\s*silence_duration:\s*([\d.]+)/g

export function parseSilenceLines(stderr: string): SilenceRange[] {
  // Pair each silence_start with the next silence_end. Defensive against
  // truncated lines (we ignore unmatched starts).
  const starts: number[] = []
  let m: RegExpExecArray | null
  SILENCE_START_RE.lastIndex = 0
  while ((m = SILENCE_START_RE.exec(stderr)) !== null) {
    const v = Number(m[1])
    if (Number.isFinite(v)) starts.push(v)
  }
  const ends: { time: number; dur: number }[] = []
  SILENCE_END_RE.lastIndex = 0
  while ((m = SILENCE_END_RE.exec(stderr)) !== null) {
    const t = Number(m[1])
    const d = Number(m[2])
    if (Number.isFinite(t) && Number.isFinite(d)) ends.push({ time: t, dur: d })
  }
  const out: SilenceRange[] = []
  const n = Math.min(starts.length, ends.length)
  for (let i = 0; i < n; i++) {
    const startMs = Math.max(0, Math.round(starts[i] * 1000))
    const endMs = Math.max(startMs, Math.round(ends[i].time * 1000))
    const durationMs = Math.max(0, Math.round(ends[i].dur * 1000))
    out.push({ startMs, endMs, durationMs })
  }
  return out
}

async function detectSilence(
  filePath: string,
  options: SilenceDetectOptions = {}
): Promise<SilenceRange[]> {
  const ffmpeg = resolveFfmpegPath()
  const resolved = assertPathAllowed(filePath, 'input')
  // Clamp inputs to sane ranges so we never inject untrusted numbers.
  const noiseRaw = Number(options.noiseDb ?? -30)
  const minRaw = Number(options.minMs ?? 400)
  const noiseDb = Number.isFinite(noiseRaw) ? Math.max(-90, Math.min(0, noiseRaw)) : -30
  const minMs = Number.isFinite(minRaw) ? Math.max(50, Math.min(60_000, minRaw)) : 400
  const minSec = (minMs / 1000).toFixed(3)
  const stderr = await runSilenceDetect(ffmpeg, resolved, noiseDb, Number(minSec))
  return parseSilenceLines(stderr)
}

// ---------------------------------------------------------------------------
// Beat detection — MVP stub using manual BPM.
//
// We do NOT attempt real onset detection in this pass; ebur128/astats give
// loudness, not beats, and bundling aubio would explode the install size.
// Instead, the renderer surfaces a "BPM: [120]" input; this handler returns
// evenly-spaced beats from start_offset out to duration.
// ---------------------------------------------------------------------------
export function computeBeatsFromBpm(
  bpm: number,
  durationMs: number,
  startOffsetMs = 0
): BeatMarker[] {
  if (!Number.isFinite(bpm) || bpm <= 0) return []
  if (!Number.isFinite(durationMs) || durationMs <= 0) return []
  const periodMs = (60 * 1000) / bpm
  const out: BeatMarker[] = []
  // Hard cap so a tiny BPM with huge duration can't explode memory.
  const MAX_BEATS = 4096
  let t = Math.max(0, startOffsetMs)
  while (t <= durationMs && out.length < MAX_BEATS) {
    out.push({ timeMs: Math.round(t) })
    t += periodMs
  }
  return out
}

async function detectBeats(
  filePath: string,
  options: BeatDetectOptions = {}
): Promise<BeatMarker[]> {
  // assertPathAllowed both validates the path and proves the file exists.
  assertPathAllowed(filePath, 'input')
  const bpm = Number(options.bpm ?? 0)
  const startOffsetMs = Number(options.startOffsetMs ?? 0)
  const durationMs = Number(options.durationMs ?? 0)
  if (!(bpm > 0)) return []
  return computeBeatsFromBpm(bpm, durationMs, startOffsetMs)
}

// ---------------------------------------------------------------------------
// IPC registration.
// ---------------------------------------------------------------------------
export function registerAudioHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.audio.detectSilence,
    async (_event, filePath: unknown, options?: SilenceDetectOptions) => {
      if (typeof filePath !== 'string' || !filePath) {
        throw new Error('[audio] detectSilence: filePath required')
      }
      const safe: SilenceDetectOptions = {
        noiseDb: typeof options?.noiseDb === 'number' ? options.noiseDb : undefined,
        minMs: typeof options?.minMs === 'number' ? options.minMs : undefined
      }
      return detectSilence(filePath, safe)
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.audio.detectBeats,
    async (_event, filePath: unknown, options?: BeatDetectOptions) => {
      if (typeof filePath !== 'string' || !filePath) {
        throw new Error('[audio] detectBeats: filePath required')
      }
      const safe: BeatDetectOptions = {
        bpm: typeof options?.bpm === 'number' ? options.bpm : undefined,
        startOffsetMs:
          typeof options?.startOffsetMs === 'number' ? options.startOffsetMs : undefined,
        durationMs:
          typeof options?.durationMs === 'number' ? options.durationMs : undefined
      }
      return detectBeats(filePath, safe)
    }
  )
}
