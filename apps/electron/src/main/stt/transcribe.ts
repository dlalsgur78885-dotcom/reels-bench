/**
 * STT transcription pipeline.
 *
 *   1. validate + allow-list the source path; clamp the sub-range.
 *   2. ensure the GGML model is on disk (download on first use).
 *   3. ffmpeg → 16kHz mono PCM s16le WAV (sub-range via -ss/-t).
 *   4. fail fast if the source carries no audio.
 *   5. whisper-cli → JSON segments, streaming `progress = NN%` from stderr.
 *   6. parse JSON segments → SttCue[] (offset by startMs when sub-ranged).
 *   7. best-effort cleanup of the temp WAV + JSON.
 *
 * Every spawned path (source, temp WAV, JSON, model) is funneled through
 * `assertPathAllowed` — no untrusted string reaches a spawn argv as a path.
 */
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type {
  SttCue,
  SttLanguage,
  SttModelKey,
  SttPhase,
  SttResult,
  SttTranscribeOptions
} from '../../shared/ipc'
import { resolveFfmpegPath } from '../ffmpeg/binary'
import { assertPathAllowed } from '../ffmpeg/security'
import { resolveWhisperPath, SttTaggedError } from './binary'
import { ensureModel } from './model'

/** Per-job timeout for the whisper pass (~15 min, clamped like the runner). */
const WHISPER_TIMEOUT_MS = 15 * 60 * 1000

/** Progress emitter passed in by the IPC layer. */
export interface TranscribeEmit {
  (phase: SttPhase, percent: number, extra?: {
    message?: string
    modelBytesDownloaded?: number
    modelBytesTotal?: number
  }): void
}

/**
 * Hooks the IPC job registry uses to (a) learn about the live child so it can
 * tree-kill on cancel, and (b) tell `transcribe` it was cancelled.
 */
export interface TranscribeControl {
  /** Called whenever a new child process is spawned for this job. */
  onChild(kind: 'ffmpeg' | 'whisper', child: ChildProcess): void
  /** Returns true once the job has been cancelled. */
  isCancelled(): boolean
}

/**
 * whisper.cpp (-oj) segment shape. `offsets.from`/`offsets.to` are emitted in
 * MILLISECONDS by whisper.cpp (it writes the internal centisecond `t0`/`t1`
 * pre-multiplied by 10). See examples/cli/cli.cpp::times_o().
 */
interface WhisperJsonSegment {
  offsets?: { from?: number; to?: number }
  text?: string
}

interface WhisperJsonOutput {
  result?: { language?: string }
  transcription?: WhisperJsonSegment[]
}

const NOISE_TOKENS = new Set(['[blank_audio]', '[music]', '[silence]', '(music)'])

function sanitizeJobId(jobId: string): string {
  const clean = jobId.replace(/[^A-Za-z0-9_-]/g, '')
  return clean.slice(0, 64) || `job${Date.now()}`
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** Spawn ffmpeg to extract a 16kHz mono s16le WAV; resolves on success. */
function extractAudio(
  ffmpegPath: string,
  sourcePath: string,
  outWav: string,
  startMs: number | null,
  endMs: number | null,
  control: TranscribeControl
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const argv: string[] = ['-hide_banner', '-y', '-nostdin']
    if (startMs != null) argv.push('-ss', String(startMs / 1000))
    argv.push('-i', sourcePath)
    if (startMs != null && endMs != null && endMs > startMs) {
      argv.push('-t', String((endMs - startMs) / 1000))
    }
    // 16kHz mono PCM s16le — whisper.cpp's required input format.
    argv.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', outWav)

    const proc = spawn(ffmpegPath, argv, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    control.onChild('ffmpeg', proc)

    let stderr = ''
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024)
    })
    proc.on('error', (err) =>
      reject(new SttTaggedError('model_missing', `[stt] ffmpeg spawn failed: ${err.message}`))
    )
    proc.on('close', (code) => {
      if (control.isCancelled()) {
        reject(new Error('cancelled'))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      // ffmpeg exits non-zero when the source has no decodable audio stream.
      const tail = stderr.split(/\r?\n/).slice(-6).join('\n')
      reject(new Error(`ffmpeg audio extract failed (exit ${code}): ${tail}`))
    })
  })
}

/** Parse whisper.cpp stderr for `whisper_print_progress_callback: progress = NN%`. */
function parseWhisperProgress(line: string): number | null {
  const m = /progress\s*=\s*(\d+)\s*%/i.exec(line)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? clamp(n, 0, 100) : null
}

/** Spawn whisper-cli; resolves with the detected language (best-effort). */
function runWhisper(
  whisperPath: string,
  modelPath: string,
  wavPath: string,
  outBase: string,
  language: SttLanguage,
  control: TranscribeControl,
  emit: TranscribeEmit
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const lang = language === 'auto' ? 'auto' : language
    const argv = [
      '-m', modelPath,
      '-f', wavPath,
      '-l', lang,
      '-oj', // output JSON
      '-of', outBase, // output file base (whisper appends .json)
      '-pp' // print progress
    ]
    const proc = spawn(whisperPath, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    control.onChild('whisper', proc)

    let stderrBuf = ''
    let stderrLog = ''
    let lastPercent = -1
    const onChunk = (chunk: string): void => {
      stderrLog += chunk
      if (stderrLog.length > 16 * 1024) stderrLog = stderrLog.slice(-16 * 1024)
      stderrBuf += chunk
      let idx: number
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx)
        stderrBuf = stderrBuf.slice(idx + 1)
        const pct = parseWhisperProgress(line)
        if (pct != null && pct !== lastPercent) {
          lastPercent = pct
          emit('transcribing', pct)
        }
      }
    }
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', onChunk)
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', onChunk)

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      reject(new SttTaggedError('model_missing', '[stt] whisper timed out'))
    }, WHISPER_TIMEOUT_MS)

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new SttTaggedError('binary_missing', `[stt] whisper spawn failed: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (control.isCancelled()) {
        reject(new Error('cancelled'))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const tail = stderrLog.split(/\r?\n/).slice(-8).join('\n')
      reject(new Error(`whisper failed (exit ${code}): ${tail}`))
    })
  })
}

/** Convert whisper JSON segments → SttCue[], offsetting by the sub-range start. */
function segmentsToCues(
  segments: WhisperJsonSegment[],
  offsetMs: number
): SttCue[] {
  const cues: SttCue[] = []
  for (const seg of segments) {
    const from = seg?.offsets?.from
    const to = seg?.offsets?.to
    if (typeof from !== 'number' || typeof to !== 'number') continue
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    const text = typeof seg.text === 'string' ? seg.text.trim() : ''
    if (!text) continue
    if (NOISE_TOKENS.has(text.toLowerCase())) continue
    // offsets.from/to are already in milliseconds.
    const startMs = Math.round(from) + offsetMs
    let endMs = Math.round(to) + offsetMs
    if (endMs <= startMs) endMs = startMs + 200
    cues.push({ startMs, endMs, text })
  }
  return cues
}

function ok(jobId: string, cues: SttCue[], language: string, durationMs: number): SttResult {
  return { jobId, ok: true, cues, language, durationMs }
}

/**
 * Run a full transcription. Returns a discriminated `SttResult`; the IPC layer
 * maps `SttTaggedError`/thrown messages onto `SttErrorCode`s.
 */
export async function transcribe(
  opts: SttTranscribeOptions,
  emit: TranscribeEmit,
  control: TranscribeControl
): Promise<SttResult> {
  const startedAt = Date.now()
  const model: SttModelKey = opts.model ?? 'base'
  const language: SttLanguage = opts.language ?? 'auto'
  const safeJobId = sanitizeJobId(opts.jobId)

  // (1) allow-list source + clamp the sub-range.
  emit('preparing', 0)
  const sourcePath = assertPathAllowed(opts.sourcePath, 'input')

  let startMs: number | null = null
  let endMs: number | null = null
  if (typeof opts.startMs === 'number' && Number.isFinite(opts.startMs)) {
    startMs = clamp(Math.round(opts.startMs), 0, 24 * 3600 * 1000)
  }
  if (typeof opts.endMs === 'number' && Number.isFinite(opts.endMs)) {
    endMs = clamp(Math.round(opts.endMs), 0, 24 * 3600 * 1000)
  }
  if (startMs != null && endMs != null && endMs <= startMs) {
    endMs = null // ignore an inverted/zero range → transcribe to EOF
  }
  const offsetMs = startMs ?? 0

  // Resolve binaries early so a missing binary fails before the model download.
  const whisperPath = resolveWhisperPath()
  const ffmpegPath = resolveFfmpegPath()

  // Temp + output paths — all under allow-listed roots.
  const tempDir = app.getPath('temp')
  const wavPath = assertPathAllowed(
    path.join(tempDir, `stt-${safeJobId}.wav`),
    'output'
  )
  const sttDir = path.join(app.getPath('userData'), 'stt')
  await mkdir(sttDir, { recursive: true })
  const jsonBase = path.join(sttDir, safeJobId)
  const jsonPath = assertPathAllowed(jsonBase + '.json', 'output')

  const cleanup = async (): Promise<void> => {
    await unlink(wavPath).catch(() => undefined)
    await unlink(jsonPath).catch(() => undefined)
  }

  try {
    // (2) ensure model on disk.
    emit('downloading-model', 0)
    const modelPath = await ensureModel(model, (downloaded, total) => {
      const pct = total > 0 ? clamp((downloaded / total) * 100, 0, 100) : 0
      emit('downloading-model', pct, {
        modelBytesDownloaded: downloaded,
        modelBytesTotal: total
      })
    })
    const modelArg = assertPathAllowed(modelPath, 'input')
    if (control.isCancelled()) {
      await cleanup()
      return { jobId: opts.jobId, ok: false, error: 'cancelled', code: 'cancelled' }
    }

    // (3) extract audio.
    emit('extracting-audio', 0)
    try {
      await extractAudio(ffmpegPath, sourcePath, wavPath, startMs, endMs, control)
    } catch (err) {
      if (control.isCancelled() || (err instanceof Error && err.message === 'cancelled')) {
        await cleanup()
        return { jobId: opts.jobId, ok: false, error: 'cancelled', code: 'cancelled' }
      }
      // ffmpeg failing here almost always means there is no usable audio.
      await cleanup()
      return {
        jobId: opts.jobId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'no_audio'
      }
    }
    emit('extracting-audio', 100)

    // (4) detect empty / silent / no-audio result.
    if (!existsSync(wavPath)) {
      await cleanup()
      return { jobId: opts.jobId, ok: false, error: 'no audio extracted', code: 'no_audio' }
    }
    const wavStat = await stat(wavPath)
    // A bare 16kHz mono WAV header is 44 bytes; anything at/under that = silence.
    if (wavStat.size <= 44) {
      await cleanup()
      return { jobId: opts.jobId, ok: false, error: 'source has no audio', code: 'no_audio' }
    }

    // (5) run whisper.
    emit('transcribing', 0)
    try {
      await runWhisper(
        whisperPath,
        modelArg,
        wavPath,
        jsonBase,
        language,
        control,
        emit
      )
    } catch (err) {
      await cleanup()
      if (control.isCancelled() || (err instanceof Error && err.message === 'cancelled')) {
        return { jobId: opts.jobId, ok: false, error: 'cancelled', code: 'cancelled' }
      }
      if (err instanceof SttTaggedError && err.message.includes('timed out')) {
        return { jobId: opts.jobId, ok: false, error: err.message, code: 'timeout' }
      }
      return {
        jobId: opts.jobId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'spawn_failed'
      }
    }

    // (6) parse JSON segments → cues.
    if (!existsSync(jsonPath)) {
      await cleanup()
      return {
        jobId: opts.jobId,
        ok: false,
        error: 'whisper produced no JSON output',
        code: 'parse_failed'
      }
    }
    let parsed: WhisperJsonOutput
    try {
      const raw = await readFile(jsonPath, 'utf-8')
      parsed = JSON.parse(raw) as WhisperJsonOutput
    } catch (err) {
      await cleanup()
      return {
        jobId: opts.jobId,
        ok: false,
        error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
        code: 'parse_failed'
      }
    }
    const segments = Array.isArray(parsed.transcription) ? parsed.transcription : []
    const cues = segmentsToCues(segments, offsetMs)
    const detectedLang =
      typeof parsed.result?.language === 'string' && parsed.result.language
        ? parsed.result.language
        : language

    // (7) success.
    emit('done', 100)
    return ok(opts.jobId, cues, detectedLang, Date.now() - startedAt)
  } finally {
    // (8) best-effort cleanup of temp WAV + JSON (also on cancel/throw).
    await cleanup()
  }
}
