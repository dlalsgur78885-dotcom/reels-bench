/**
 * STT IPC handlers — auto-caption transcription via bundled whisper.cpp.
 *
 * Channels (all in IPC_CHANNELS.stt):
 *   stt:transcribe   invoke → SttResult
 *   stt:cancel       invoke → void
 *   stt:modelStatus  invoke → SttModelStatus
 *   stt:progress     send   → SttProgress (broadcast to all webContents)
 *
 * Concurrency: MAX_STT_JOBS = 1. whisper.cpp is CPU-bound; a second concurrent
 * request is rejected with `queue_full` rather than thrashing the machine.
 */
import { ipcMain, webContents } from 'electron'
import { type ChildProcess } from 'node:child_process'
import treeKill from 'tree-kill'
import {
  IPC_CHANNELS,
  type SttErrorCode,
  type SttLanguage,
  type SttModelKey,
  type SttModelStatus,
  type SttPhase,
  type SttProgress,
  type SttResult,
  type SttTranscribeOptions
} from '../../shared/ipc'
import { SttTaggedError } from '../stt/binary'
import { modelStatusOnDisk } from '../stt/model'
import { transcribe, type TranscribeControl } from '../stt/transcribe'

const MAX_STT_JOBS = 1
const MIN_EMIT_INTERVAL_MS = 200 // throttle progress broadcast

interface ActiveSttJob {
  jobId: string
  ffmpegProc: ChildProcess | null
  whisperProc: ChildProcess | null
  cancelled: boolean
  lastEmitAt: number
}

const active = new Map<string, ActiveSttJob>()

// ---------------------------------------------------------------------------
// Progress broadcast (throttled, except for terminal phases).
// ---------------------------------------------------------------------------
function broadcastProgress(job: ActiveSttJob, ev: SttProgress): void {
  const terminal = ev.phase === 'done' || ev.phase === 'error' || ev.phase === 'cancelled'
  const now = Date.now()
  if (!terminal && now - job.lastEmitAt < MIN_EMIT_INTERVAL_MS) return
  job.lastEmitAt = now
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    wc.send(IPC_CHANNELS.stt.progress, ev)
  }
}

// ---------------------------------------------------------------------------
// Input validation at the IPC boundary.
// ---------------------------------------------------------------------------
const VALID_LANGS: ReadonlySet<string> = new Set(['ko', 'en', 'auto'])
const VALID_MODELS: ReadonlySet<string> = new Set(['base'])

function validateTranscribeOptions(raw: unknown): SttTranscribeOptions {
  if (!raw || typeof raw !== 'object') {
    throw new Error('[stt] transcribe: options object required')
  }
  const o = raw as Record<string, unknown>

  if (typeof o.jobId !== 'string' || o.jobId.length === 0 || o.jobId.length > 128) {
    throw new Error('[stt] transcribe: jobId required (string, 1..128)')
  }
  if (
    typeof o.sourcePath !== 'string' ||
    o.sourcePath.length === 0 ||
    o.sourcePath.length > 4096
  ) {
    throw new Error('[stt] transcribe: sourcePath required (string, 1..4096)')
  }

  const opts: SttTranscribeOptions = {
    jobId: o.jobId,
    sourcePath: o.sourcePath
  }

  if (o.startMs !== undefined) {
    if (typeof o.startMs !== 'number' || !Number.isFinite(o.startMs) || o.startMs < 0) {
      throw new Error('[stt] transcribe: startMs must be a non-negative number')
    }
    opts.startMs = o.startMs
  }
  if (o.endMs !== undefined) {
    if (typeof o.endMs !== 'number' || !Number.isFinite(o.endMs) || o.endMs < 0) {
      throw new Error('[stt] transcribe: endMs must be a non-negative number')
    }
    opts.endMs = o.endMs
  }
  if (o.language !== undefined) {
    if (typeof o.language !== 'string' || !VALID_LANGS.has(o.language)) {
      throw new Error('[stt] transcribe: language must be ko|en|auto')
    }
    opts.language = o.language as SttLanguage
  }
  if (o.model !== undefined) {
    if (typeof o.model !== 'string' || !VALID_MODELS.has(o.model)) {
      throw new Error('[stt] transcribe: model must be "base"')
    }
    opts.model = o.model as SttModelKey
  }
  return opts
}

// ---------------------------------------------------------------------------
// Map a thrown error → SttErrorCode.
// ---------------------------------------------------------------------------
function toErrorCode(err: unknown): SttErrorCode {
  if (err instanceof SttTaggedError) {
    switch (err.code) {
      case 'binary_missing':
        return 'binary_missing'
      case 'unsupported_platform':
        return 'unsupported_platform'
      case 'model_missing':
        return 'model_missing'
      case 'model_download_failed':
        return 'model_download_failed'
      case 'model_checksum_failed':
        return 'model_checksum_failed'
    }
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/not in allowed roots|does not exist/.test(msg)) return 'path_not_allowed'
  if (/cancelled/i.test(msg)) return 'cancelled'
  if (/timed out|timeout/i.test(msg)) return 'timeout'
  return 'spawn_failed'
}

// ---------------------------------------------------------------------------
// Cancel: tree-kill whichever child is live.
// ---------------------------------------------------------------------------
function killChildren(job: ActiveSttJob): void {
  for (const child of [job.whisperProc, job.ffmpegProc]) {
    const pid = child?.pid
    if (!pid) continue
    try {
      treeKill(pid, 'SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------
async function handleTranscribe(rawOpts: unknown): Promise<SttResult> {
  let opts: SttTranscribeOptions
  try {
    opts = validateTranscribeOptions(rawOpts)
  } catch (err) {
    return {
      jobId:
        rawOpts && typeof rawOpts === 'object' && typeof (rawOpts as { jobId?: unknown }).jobId === 'string'
          ? (rawOpts as { jobId: string }).jobId
          : 'unknown',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'path_not_allowed'
    }
  }

  if (active.size >= MAX_STT_JOBS) {
    return { jobId: opts.jobId, ok: false, error: 'an STT job is already running', code: 'queue_full' }
  }
  if (active.has(opts.jobId)) {
    return { jobId: opts.jobId, ok: false, error: 'duplicate jobId', code: 'duplicate_jobId' }
  }

  const job: ActiveSttJob = {
    jobId: opts.jobId,
    ffmpegProc: null,
    whisperProc: null,
    cancelled: false,
    lastEmitAt: 0
  }
  active.set(opts.jobId, job)

  const control: TranscribeControl = {
    onChild: (kind, child) => {
      if (kind === 'ffmpeg') job.ffmpegProc = child
      else job.whisperProc = child
      // If a cancel landed before the child appeared, kill it immediately.
      if (job.cancelled) killChildren(job)
    },
    isCancelled: () => job.cancelled
  }

  const emit = (
    phase: SttPhase,
    percent: number,
    extra?: {
      message?: string
      modelBytesDownloaded?: number
      modelBytesTotal?: number
    }
  ): void => {
    broadcastProgress(job, {
      jobId: opts.jobId,
      phase,
      percent: Math.max(0, Math.min(100, percent)),
      ...extra
    })
  }

  try {
    const result = await transcribe(opts, emit, control)
    if (result.ok) {
      broadcastProgress(job, { jobId: opts.jobId, phase: 'done', percent: 100 })
    } else if (result.code === 'cancelled') {
      broadcastProgress(job, { jobId: opts.jobId, phase: 'cancelled', percent: 0 })
    } else {
      broadcastProgress(job, {
        jobId: opts.jobId,
        phase: 'error',
        percent: 0,
        message: result.error
      })
    }
    return result
  } catch (err) {
    const code = toErrorCode(err)
    const message = err instanceof Error ? err.message : String(err)
    broadcastProgress(job, {
      jobId: opts.jobId,
      phase: code === 'cancelled' ? 'cancelled' : 'error',
      percent: 0,
      message
    })
    return { jobId: opts.jobId, ok: false, error: message, code }
  } finally {
    active.delete(opts.jobId)
  }
}

function handleCancel(rawJobId: unknown): void {
  if (typeof rawJobId !== 'string' || rawJobId.length === 0 || rawJobId.length > 128) {
    return
  }
  const job = active.get(rawJobId)
  if (!job) return
  job.cancelled = true
  killChildren(job)
  // The transcribe() pipeline observes `cancelled` and resolves with
  // code:'cancelled'; the registry entry is cleared in handleTranscribe's
  // finally block.
}

async function handleModelStatus(rawModel: unknown): Promise<SttModelStatus> {
  let model: SttModelKey = 'base'
  if (rawModel !== undefined) {
    if (typeof rawModel !== 'string' || !VALID_MODELS.has(rawModel)) {
      throw new Error('[stt] modelStatus: model must be "base"')
    }
    model = rawModel as SttModelKey
  }
  const status = await modelStatusOnDisk(model)
  return { present: status.present, model, sizeBytes: status.sizeBytes }
}

export function registerSttHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.stt.transcribe, (_event, rawOpts: unknown) =>
    handleTranscribe(rawOpts)
  )
  ipcMain.handle(IPC_CHANNELS.stt.cancel, (_event, rawJobId: unknown) => {
    handleCancel(rawJobId)
  })
  ipcMain.handle(IPC_CHANNELS.stt.modelStatus, (_event, rawModel: unknown) =>
    handleModelStatus(rawModel)
  )
}
