import { spawn, type ChildProcess } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { webContents } from 'electron'
import treeKill from 'tree-kill'
import {
  ALLOWED_CODECS,
  ALLOWED_PRESETS,
  IPC_CHANNELS,
  type AllowedCodec,
  type AllowedPreset,
  type FfmpegJobKind,
  type FfmpegRunSpec,
  type JobResult,
  type ProgressEvent
} from '../../shared/ipc'
import { resolveFfmpegPath } from './binary'
import {
  assertPathAllowed,
  validateExtraArgs,
  validateFilterGraph
} from './security'

// ---------------------------------------------------------------------------
// Concurrency limits.
// ---------------------------------------------------------------------------
const MAX_EXPORT_JOBS = 1
const MAX_PROXY_JOBS = 2

interface ActiveJob {
  jobId: string
  kind: FfmpegJobKind
  proc: ChildProcess
  outputPath: string
  cancelled: boolean
  timeout: NodeJS.Timeout | null
  startedAt: number
  lastEmitAt: number
  durationMs: number | null
}

const active = new Map<string, ActiveJob>()

function activeCount(kind: FfmpegJobKind): number {
  let n = 0
  for (const job of active.values()) if (job.kind === kind) n++
  return n
}

// ---------------------------------------------------------------------------
// Spec validation -> argv.
// ---------------------------------------------------------------------------
function isAllowedCodec(c: unknown): c is AllowedCodec {
  return typeof c === 'string' && (ALLOWED_CODECS as readonly string[]).includes(c)
}
function isAllowedPreset(p: unknown): p is AllowedPreset {
  return typeof p === 'string' && (ALLOWED_PRESETS as readonly string[]).includes(p)
}

function buildArgv(spec: FfmpegRunSpec): {
  argv: string[]
  outputPath: string
} {
  if (!spec || typeof spec !== 'object') {
    throw new Error('[ffmpeg] spec required')
  }
  if (typeof spec.jobId !== 'string' || !spec.jobId) {
    throw new Error('[ffmpeg] jobId required')
  }
  if (typeof spec.output !== 'string' || !spec.output) {
    throw new Error('[ffmpeg] output required')
  }

  const inputs: string[] = []
  if (spec.inputs && Array.isArray(spec.inputs) && spec.inputs.length > 0) {
    for (const i of spec.inputs) {
      if (typeof i !== 'string') throw new Error('[ffmpeg] inputs must be strings')
      inputs.push(assertPathAllowed(i, 'input'))
    }
  } else if (typeof spec.input === 'string' && spec.input) {
    inputs.push(assertPathAllowed(spec.input, 'input'))
  } else {
    throw new Error('[ffmpeg] at least one input required')
  }
  if (inputs.length > 8) throw new Error('[ffmpeg] too many inputs')

  const output = assertPathAllowed(spec.output, 'output')

  const argv: string[] = []
  argv.push('-hide_banner', '-y', '-nostdin')

  // Trim before -i is much cheaper for inputs that support keyframe seeking.
  if (typeof spec.startSec === 'number' && Number.isFinite(spec.startSec)) {
    if (spec.startSec < 0 || spec.startSec > 24 * 3600) {
      throw new Error('[ffmpeg] startSec out of range')
    }
    argv.push('-ss', String(spec.startSec))
  }

  for (const inputPath of inputs) {
    argv.push('-i', inputPath)
  }

  if (typeof spec.durationSec === 'number' && Number.isFinite(spec.durationSec)) {
    if (spec.durationSec <= 0 || spec.durationSec > 24 * 3600) {
      throw new Error('[ffmpeg] durationSec out of range')
    }
    argv.push('-t', String(spec.durationSec))
  }

  // Filter graph or simple scale.
  if (spec.filterGraph) {
    argv.push('-filter_complex', validateFilterGraph(spec.filterGraph))
  } else if (spec.scale) {
    if (!/^[-\d:]+$/.test(spec.scale)) {
      throw new Error('[ffmpeg] scale syntax invalid')
    }
    argv.push('-vf', `scale=${spec.scale}`)
  }

  // Codec.
  const codec: AllowedCodec = isAllowedCodec(spec.codec) ? spec.codec : 'libx264'
  argv.push('-c:v', codec)

  // Preset.
  const preset: AllowedPreset = isAllowedPreset(spec.preset) ? spec.preset : 'veryfast'
  // NVENC accepts the x264-style names since FFmpeg 4.x via the "preset" option.
  argv.push('-preset', preset)

  // Rate control: prefer crf for software, bitrate for HW encoders.
  const isSoftware = codec === 'libx264' || codec === 'libx265'
  if (isSoftware && typeof spec.crf === 'number') {
    if (spec.crf < 0 || spec.crf > 51) throw new Error('[ffmpeg] crf out of range')
    argv.push('-crf', String(Math.round(spec.crf)))
  } else if (!isSoftware && typeof spec.bitrateKbps === 'number') {
    if (spec.bitrateKbps <= 0 || spec.bitrateKbps > 200_000) {
      throw new Error('[ffmpeg] bitrateKbps out of range')
    }
    argv.push('-b:v', `${Math.round(spec.bitrateKbps)}k`)
  } else if (isSoftware) {
    argv.push('-crf', '23')
  } else {
    argv.push('-b:v', '8000k')
  }

  // Audio handling.
  const audio = spec.audio ?? 'aac'
  if (audio === 'none') {
    argv.push('-an')
  } else if (audio === 'copy') {
    argv.push('-c:a', 'copy')
  } else {
    argv.push('-c:a', 'aac', '-b:a', '160k')
  }

  // Any extra (allow-listed) flags.
  argv.push(...validateExtraArgs(spec.extraArgs))

  // Progress stream on stderr (we already capture stderr for logs too).
  argv.push('-progress', 'pipe:2', '-nostats')

  argv.push(output)

  return { argv, outputPath: output }
}

// ---------------------------------------------------------------------------
// Progress parsing.
// ---------------------------------------------------------------------------
interface ProgressState {
  outTimeMs?: number
  fps?: number
  speed?: number
  totalDurationMs?: number
}

function parseProgressBlock(line: string, state: ProgressState): boolean {
  // ffmpeg `-progress pipe:2` emits key=value pairs, one per line. A block
  // ends with `progress=end` or `progress=continue`. We update on each kv.
  const eq = line.indexOf('=')
  if (eq < 0) return false
  const key = line.slice(0, eq).trim()
  const value = line.slice(eq + 1).trim()

  switch (key) {
    case 'out_time_ms':
    case 'out_time_us': {
      // Older ffmpeg emits microseconds under out_time_ms (yes, the name lies).
      const n = Number(value)
      if (Number.isFinite(n)) state.outTimeMs = Math.round(n / 1000)
      break
    }
    case 'fps': {
      const n = Number(value)
      if (Number.isFinite(n)) state.fps = n
      break
    }
    case 'speed': {
      // e.g. "1.23x" or "N/A"
      const m = /([\d.]+)x/.exec(value)
      if (m) state.speed = Number(m[1])
      break
    }
    case 'progress': {
      return value === 'end'
    }
    default:
      break
  }
  return false
}

// Parse "Duration: 00:01:23.45" from stderr header to compute percent.
function parseDuration(line: string): number | null {
  const m = /Duration:\s+(\d+):(\d+):(\d+\.\d+)/.exec(line)
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  const ss = Number(m[3])
  return Math.round((hh * 3600 + mm * 60 + ss) * 1000)
}

// ---------------------------------------------------------------------------
// Job lifecycle.
// ---------------------------------------------------------------------------
function emitProgress(ev: ProgressEvent): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    wc.send(IPC_CHANNELS.ffmpeg.progress, ev)
  }
}

const MIN_EMIT_INTERVAL_MS = 250 // throttle: max 4 events/sec

export async function runFfmpegJob(spec: FfmpegRunSpec): Promise<JobResult> {
  const kind: FfmpegJobKind = spec.kind === 'proxy' ? 'proxy' : 'export'
  const cap = kind === 'export' ? MAX_EXPORT_JOBS : MAX_PROXY_JOBS

  if (activeCount(kind) >= cap) {
    return {
      jobId: spec.jobId ?? 'unknown',
      ok: false,
      error: 'queue_full'
    }
  }

  if (active.has(spec.jobId)) {
    return {
      jobId: spec.jobId,
      ok: false,
      error: 'duplicate_jobId'
    }
  }

  let argv: string[]
  let outputPath: string
  try {
    const built = buildArgv(spec)
    argv = built.argv
    outputPath = built.outputPath
  } catch (err) {
    return {
      jobId: spec.jobId,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }

  const ffmpegPath = resolveFfmpegPath()
  const startedAt = Date.now()
  const timeoutMs =
    typeof spec.timeoutMs === 'number' && spec.timeoutMs > 0
      ? Math.min(spec.timeoutMs, 60 * 60 * 1000)
      : 10 * 60 * 1000

  // On Windows, child_process can't form a POSIX process group; tree-kill
  // handles platform differences for us. We still pass detached:false to
  // keep cleanup straightforward.
  const proc = spawn(ffmpegPath, argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  const jobState: ActiveJob = {
    jobId: spec.jobId,
    kind,
    proc,
    outputPath,
    cancelled: false,
    timeout: null,
    startedAt,
    lastEmitAt: 0,
    durationMs: null
  }
  active.set(spec.jobId, jobState)

  jobState.timeout = setTimeout(() => {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    void cancelFfmpegJob(spec.jobId, 'timeout')
  }, timeoutMs)

  const progressState: ProgressState = {}
  let stderrBuf = ''
  let stderrLog = '' // for error reporting (capped)
  const STDERR_LOG_LIMIT = 8192

  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    // Capture a bounded suffix for error context.
    stderrLog += chunk
    if (stderrLog.length > STDERR_LOG_LIMIT) {
      stderrLog = stderrLog.slice(-STDERR_LOG_LIMIT)
    }

    stderrBuf += chunk
    // Detect "Duration:" early to compute percent.
    if (jobState.durationMs == null) {
      const dur = parseDuration(stderrBuf)
      if (dur != null) jobState.durationMs = dur
    }

    let idx: number
    while ((idx = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, idx).trim()
      stderrBuf = stderrBuf.slice(idx + 1)
      if (!line) continue

      const isEnd = parseProgressBlock(line, progressState)
      const now = Date.now()
      if (now - jobState.lastEmitAt >= MIN_EMIT_INTERVAL_MS || isEnd) {
        jobState.lastEmitAt = now
        const total =
          typeof spec.durationSec === 'number' && spec.durationSec > 0
            ? Math.round(spec.durationSec * 1000)
            : jobState.durationMs
        let percent = 0
        let etaMs: number | undefined
        if (total && progressState.outTimeMs != null) {
          percent = Math.min(100, Math.max(0, (progressState.outTimeMs / total) * 100))
          if (progressState.speed && progressState.speed > 0) {
            const remaining = Math.max(0, total - progressState.outTimeMs)
            etaMs = Math.round(remaining / progressState.speed)
          }
        }
        emitProgress({
          jobId: spec.jobId,
          percent,
          fps: progressState.fps,
          speed: progressState.speed,
          currentTimeMs: progressState.outTimeMs,
          etaMs
        })
      }
    }
  })

  return new Promise<JobResult>((resolve) => {
    let settled = false
    const settle = (r: JobResult): void => {
      if (settled) return
      settled = true
      if (jobState.timeout) {
        clearTimeout(jobState.timeout)
        jobState.timeout = null
      }
      active.delete(spec.jobId)
      resolve(r)
    }

    proc.on('error', (err) => {
      emitProgress({
        jobId: spec.jobId,
        percent: 0,
        done: true,
        message: err.message
      })
      settle({
        jobId: spec.jobId,
        ok: false,
        error: err.message
      })
    })

    proc.on('close', async (code, signal) => {
      const durationMs = Date.now() - startedAt
      if (jobState.cancelled) {
        // Best-effort cleanup of partial output.
        try {
          await unlink(jobState.outputPath)
        } catch {
          // ignore
        }
        emitProgress({
          jobId: spec.jobId,
          percent: 0,
          done: true,
          cancelled: true
        })
        settle({
          jobId: spec.jobId,
          ok: false,
          error: 'cancelled',
          durationMs
        })
        return
      }
      if (code === 0) {
        emitProgress({
          jobId: spec.jobId,
          percent: 100,
          done: true
        })
        settle({
          jobId: spec.jobId,
          ok: true,
          output: outputPath,
          durationMs
        })
      } else {
        // Cleanup partial output on failure too.
        try {
          await unlink(jobState.outputPath)
        } catch {
          // ignore
        }
        const tail = stderrLog.split(/\r?\n/).slice(-8).join('\n')
        const reason = signal ? `signal ${signal}` : `exit code ${code}`
        emitProgress({
          jobId: spec.jobId,
          percent: 0,
          done: true,
          message: `ffmpeg failed (${reason})`
        })
        settle({
          jobId: spec.jobId,
          ok: false,
          error: `ffmpeg failed (${reason}): ${tail}`,
          durationMs
        })
      }
    })
  })
}

export async function cancelFfmpegJob(
  jobId: string,
  reason: 'user' | 'timeout' | 'shutdown' = 'user'
): Promise<void> {
  const job = active.get(jobId)
  if (!job) return
  job.cancelled = true
  const pid = job.proc.pid
  if (!pid) return
  await new Promise<void>((resolve) => {
    treeKill(pid, 'SIGTERM', () => {
      // SIGTERM may be ignored by ffmpeg in odd states; arm a SIGKILL fallback.
      const force = setTimeout(() => {
        if (job.proc.exitCode == null) {
          treeKill(pid, 'SIGKILL', () => resolve())
        } else {
          resolve()
        }
      }, 2000)
      job.proc.once('close', () => {
        clearTimeout(force)
        resolve()
      })
    })
  })
  // Note: the actual JobResult is resolved by the 'close' handler in
  // runFfmpegJob, which inspects job.cancelled.
  void reason
}

export async function shutdownAllJobs(): Promise<void> {
  const ids = Array.from(active.keys())
  await Promise.all(ids.map((id) => cancelFfmpegJob(id, 'shutdown')))
}

// Exposed for tests / diagnostics.
export function _activeJobIds(): string[] {
  return Array.from(active.keys())
}

// Helper for tests / dev: try to find the bundled ffmpeg path eagerly so
// startup errors surface immediately.
export function preflightBinary(): string {
  return path.resolve(resolveFfmpegPath())
}
