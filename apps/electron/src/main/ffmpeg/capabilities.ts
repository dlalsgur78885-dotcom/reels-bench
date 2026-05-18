import { spawn } from 'node:child_process'
import {
  ALLOWED_CODECS,
  ENCODER_PRIORITY,
  type AllowedCodec,
  type FfmpegCapabilities
} from '../../shared/ipc'
import { resolveFfmpegPath } from './binary'

let cached: FfmpegCapabilities | null = null
let pending: Promise<FfmpegCapabilities> | null = null

/**
 * `ffmpeg -encoders` lists encoders the binary was *compiled* with. On
 * Windows, h264_nvenc/h264_qsv often appear in that list even on machines
 * without the underlying driver/hardware, and only fail at session init.
 * We do a 1-second null-output encode to actually verify each candidate.
 */
async function functionallyVerifyEncoder(
  ffmpegPath: string,
  encoder: AllowedCodec
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=128x128:d=0.2',
        '-c:v',
        encoder,
        '-t',
        '0.2',
        '-f',
        'null',
        '-'
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )
    let failed = false
    proc.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8')
      // The exit code is unreliable across builds, so look at stderr.
      if (
        /Error initializing|cuInit|MFX session|No NVIDIA|not implemented|Unknown encoder|failed/i.test(
          s
        )
      ) {
        failed = true
      }
    })
    let resolved = false
    const settle = (ok: boolean): void => {
      if (resolved) return
      resolved = true
      resolve(ok)
    }
    proc.on('error', () => settle(false))
    proc.on('close', (code) => settle(!failed && code === 0))
    // Hard timeout to keep startup snappy.
    setTimeout(() => {
      if (!resolved) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        settle(false)
      }
    }, 3000)
  })
}

/**
 * Parse `ffmpeg -encoders` stdout and return the encoder identifiers
 * (e.g. "h264_nvenc"). Lines look like:
 *   V..... h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 */
function parseEncoders(stdout: string): string[] {
  const out: string[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimStart()
    // Match leading flags column followed by encoder name. The flag column
    // is exactly 6 chars (e.g. "V....." or "VFS.B."). After it, the name.
    const m = /^[VAS.][FSXBD.]{5}\s+([A-Za-z0-9_]+)\s+/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

async function pickPreferred(
  ffmpegPath: string,
  available: Set<string>
): Promise<AllowedCodec> {
  for (const candidate of ENCODER_PRIORITY) {
    if (candidate === 'libx264') return 'libx264' // always works
    if (!available.has(candidate)) continue
    const ok = await functionallyVerifyEncoder(ffmpegPath, candidate)
    if (ok) return candidate
  }
  return 'libx264'
}

export function getCachedCapabilities(): FfmpegCapabilities | null {
  return cached
}

export async function probeCapabilities(): Promise<FfmpegCapabilities> {
  if (cached) return cached
  if (pending) return pending

  const ffmpegPath = resolveFfmpegPath()
  pending = new Promise<FfmpegCapabilities>((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-encoders'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', (err) => reject(err))
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg -encoders exited with code ${code}: ${stderr}`))
        return
      }
      const encoders = parseEncoders(stdout)
      const available = new Set(encoders)
      // Limit reported list to allow-listed names for renderer (it doesn't
      // need to know about every esoteric encoder).
      const filtered = ALLOWED_CODECS.filter((c) => available.has(c))
      pickPreferred(ffmpegPath, available)
        .then((preferred) => {
          cached = {
            encoders: filtered.length ? filtered : encoders.slice(0, 64),
            preferred
          }
          resolve(cached)
        })
        .catch(reject)
    })
  })

  try {
    return await pending
  } finally {
    pending = null
  }
}
