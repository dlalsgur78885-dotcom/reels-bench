/**
 * whisper.cpp binary + GGML model resolution for the auto-caption STT feature.
 *
 * PINNED whisper.cpp release: v1.8.4 (tag `v1.8.4`).
 *   Windows x64 prebuilt asset: `whisper-bin-x64.zip` from
 *   https://github.com/ggml-org/whisper.cpp/releases/tag/v1.8.4
 *   (v1.7.x had no Windows binary assets; v1.8.4 is the pinned build.)
 *   Source zip SHA-256: 74f973345cb52ef5ba3ec9e7e7af8e48cc8c71722d1528603b80588a11f82e3e
 *   The asset contains `whisper-cli.exe` plus the runtime DLLs. Only the files
 *   needed by whisper-cli are vendored into `resources/whisper/win32-x64/`:
 *
 *   whisper-cli.exe  d4c598cf97de103f888d1a53b8abddc85bf27ab752f785ca69318cedc8a2cf64
 *   whisper.dll      ce1958796ebd9d03aafc56cdc2f04c21f214a9c7623889a0a23bc6c162976e87
 *   ggml.dll         9f2b124cbe1d002dc25de9a5ff9813c4fec7ef9f3bb9f41035fc6b46fb77bfa0
 *   ggml-base.dll    138a2b1a03b7dd757d764f60b39a8b32a08137e21fce4d3d78fbac6c5e716f9d
 *   ggml-cpu.dll     9a74d977527dbac38d96900fd7ce422aebbf96001aff5be6a05d7c547dcb9bcb
 *   SDL2.dll         de23db1694a3c7a4a735e7ecd3d214b2023cc2267922c6c35d30c7fc7370d677
 *
 * GGML model: `ggml-base.bin` (multilingual, ~148 MB). Downloaded on first
 * use into `userData/models/` — NOT vendored. See MODEL_REGISTRY below.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { SttModelKey } from '../../shared/ipc'

/** Tagged error so callers can map cleanly to an `SttErrorCode`. */
export class SttTaggedError extends Error {
  constructor(
    public readonly code:
      | 'binary_missing'
      | 'unsupported_platform'
      | 'model_missing'
      | 'model_download_failed'
      | 'model_checksum_failed',
    message: string
  ) {
    super(message)
    this.name = 'SttTaggedError'
  }
}

const WHISPER_EXE = 'whisper-cli.exe'

/**
 * SHA-256 of the vendored whisper-cli.exe (whisper.cpp v1.8.4 — see header).
 * Verified at runtime before the exe is ever spawned: the GGML model is
 * checksum-gated, so the binary that actually executes must be too — a swapped
 * DLL/exe in resources/ would otherwise run on trust.
 */
const WHISPER_EXE_SHA256 =
  'd4c598cf97de103f888d1a53b8abddc85bf27ab752f785ca69318cedc8a2cf64'

/** Last exe path whose SHA-256 was verified — verification is one-time. */
let verifiedExePath: string | null = null

/**
 * Verify a resolved whisper-cli.exe matches the pinned SHA-256. Cached per
 * path. Throws `binary_missing` on mismatch so a corrupt/tampered binary never
 * reaches `spawn`.
 */
function verifyWhisperExe(exePath: string): string {
  if (verifiedExePath === exePath) return exePath
  let actual: string
  try {
    actual = createHash('sha256').update(readFileSync(exePath)).digest('hex')
  } catch (err) {
    throw new SttTaggedError(
      'binary_missing',
      `[stt] could not read whisper-cli.exe for integrity check: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
  if (actual !== WHISPER_EXE_SHA256) {
    throw new SttTaggedError(
      'binary_missing',
      `[stt] whisper-cli.exe integrity check failed ` +
        `(expected ${WHISPER_EXE_SHA256.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — ` +
        'the binary may be corrupt or tampered'
    )
  }
  verifiedExePath = exePath
  return exePath
}

/**
 * Resolve the bundled whisper.cpp CLI path.
 *   dev      → <repo>/apps/electron/resources/whisper/win32-x64/whisper-cli.exe
 *   packaged → <resourcesPath>/whisper/win32-x64/whisper-cli.exe (extraResources)
 *
 * Throws `unsupported_platform` on non-win32/non-x64, `binary_missing` when the
 * exe is absent (e.g. the vendoring step was left as a manual TODO).
 */
export function resolveWhisperPath(): string {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new SttTaggedError(
      'unsupported_platform',
      `[stt] whisper.cpp is only vendored for win32-x64 (got ${process.platform}-${process.arch})`
    )
  }

  if (app.isPackaged) {
    const packaged = path.join(
      process.resourcesPath,
      'whisper',
      'win32-x64',
      WHISPER_EXE
    )
    if (!existsSync(packaged)) {
      throw new SttTaggedError(
        'binary_missing',
        `[stt] whisper-cli.exe not found at ${packaged}`
      )
    }
    return verifyWhisperExe(packaged)
  }

  // Dev: resources/ sits at the app root. __dirname at runtime is out/main;
  // app.getAppPath() returns the app root. Try both — whichever exists.
  const candidates = [
    path.join(app.getAppPath(), 'resources', 'whisper', 'win32-x64', WHISPER_EXE),
    path.resolve(__dirname, '..', '..', 'resources', 'whisper', 'win32-x64', WHISPER_EXE)
  ]
  for (const c of candidates) {
    if (existsSync(c)) return verifyWhisperExe(c)
  }
  throw new SttTaggedError(
    'binary_missing',
    `[stt] whisper-cli.exe not found (looked in ${candidates.join(' ; ')}) — ` +
      'see resources/whisper/win32-x64/README.md'
  )
}

// ---------------------------------------------------------------------------
// GGML model registry. Model is download-on-first-use (not vendored).
// ---------------------------------------------------------------------------
export interface ModelRegistryEntry {
  /** GGML filename on disk (under userData/models/). */
  fileName: string
  /** https download URL (Hugging Face mirror). */
  url: string
  /** Expected SHA-256 of the downloaded file (lowercase hex). */
  sha256: string
  /** Expected exact byte size. */
  sizeBytes: number
}

/**
 * `ggml-base.bin` — multilingual base model from the official whisper.cpp
 * Hugging Face repo (ggerganov/whisper.cpp). The SHA-256 + byte size are the
 * published values for that file.
 */
export const MODEL_REGISTRY: Record<SttModelKey, ModelRegistryEntry> = {
  base: {
    fileName: 'ggml-base.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    sizeBytes: 147951465
  }
}

/** Absolute on-disk path for a model (downloaded or to-be-downloaded). */
export function resolveModelPath(model: SttModelKey): string {
  return path.join(app.getPath('userData'), 'models', MODEL_REGISTRY[model].fileName)
}

// ---------------------------------------------------------------------------
// One-shot version probe — logged at startup so the vendored whisper.cpp
// revision is visible in the main-process logs. Cached after first call.
// ---------------------------------------------------------------------------
let cachedVersionLine: string | null = null

export function probeWhisperVersion(): Promise<string> {
  if (cachedVersionLine != null) return Promise.resolve(cachedVersionLine)
  return new Promise<string>((resolve) => {
    let whisperPath: string
    try {
      whisperPath = resolveWhisperPath()
    } catch (err) {
      cachedVersionLine = `unresolved: ${err instanceof Error ? err.message : String(err)}`
      resolve(cachedVersionLine)
      return
    }
    // whisper-cli prints build/system info to stderr and exits non-zero when
    // invoked with no model/file. `--help` is the cheap, deterministic probe.
    const proc = spawn(whisperPath, ['--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let buf = ''
    const collect = (chunk: string): void => {
      buf += chunk
      if (buf.length > 4096) buf = buf.slice(0, 4096)
    }
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', collect)
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', collect)

    const settle = (s: string): void => {
      if (cachedVersionLine != null) return
      cachedVersionLine = s
      resolve(s)
    }
    proc.on('error', (err) => settle(`probe error: ${err.message}`))
    proc.on('close', () => {
      const firstLine = (buf.split(/\r?\n/).find((l) => l.trim()) || '').trim()
      settle(firstLine || 'whisper-cli (version unknown)')
    })
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      settle('probe timed out')
    }, 3_000)
  })
}

export function getCachedWhisperVersion(): string | null {
  return cachedVersionLine
}
