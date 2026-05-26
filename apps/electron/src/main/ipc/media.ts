import { app, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, copyFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  IPC_CHANNELS,
  type WaveformOptions,
  type WaveformResult
} from '../../shared/ipc'
import type {
  MediaKind,
  ProbeResult,
  ThumbnailOptions,
  ThumbnailResult
} from '../../shared/project'
import { resolveFfmpegPath } from '../ffmpeg/binary'
import { allowPath, assertPathAllowed } from '../ffmpeg/security'

// ---------------------------------------------------------------------------
// ffprobe binary resolution. Mirrors the rewrite logic in
// main/ffmpeg/binary.ts for the packaged-app case.
// ---------------------------------------------------------------------------
function resolveFfprobePath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const installer = require('@ffprobe-installer/ffprobe') as { path: string }
  let p = installer.path

  if (app.isPackaged) {
    const replaced = p.replace(
      /(.*?)[\\/]app\.asar[\\/](.*)/,
      (_match, root: string, rest: string) =>
        path.join(root, 'app.asar.unpacked', rest)
    )
    if (replaced !== p && existsSync(replaced)) {
      p = replaced
    } else if (!existsSync(p)) {
      const guess = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        '@ffprobe-installer',
        `${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
      )
      if (existsSync(guess)) p = guess
    }
  }

  if (!existsSync(p)) {
    throw new Error(`[ffprobe] binary not found at ${p}`)
  }
  return p
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function classifyByExtension(filePath: string): MediaKind {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(ext)) return 'video'
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio'
  return 'image'
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  duration?: string
  nb_frames?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  /** ffprobe stream disposition flags. `attached_pic` = 1 marks embedded cover art. */
  disposition?: { attached_pic?: number }
}

/** Audio container extensions — used to override embedded cover-art misdetection. */
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']

interface FfprobeFormat {
  duration?: string
}

interface FfprobeJson {
  streams?: FfprobeStream[]
  format?: FfprobeFormat
}

function runProbe(filePath: string, timeoutMs = 15_000): Promise<FfprobeJson> {
  const bin = resolveFfprobePath()
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    filePath
  ]
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const STDOUT_LIMIT = 2 * 1024 * 1024
    const STDERR_LIMIT = 64 * 1024

    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // ignore
      }
      reject(new Error('[ffprobe] timed out'))
    }, timeoutMs)

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > STDOUT_LIMIT) {
        clearTimeout(timer)
        try {
          proc.kill()
        } catch {
          // ignore
        }
        reject(new Error('[ffprobe] stdout overflow'))
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > STDERR_LIMIT) {
        stderr = stderr.slice(-STDERR_LIMIT)
      }
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`[ffprobe] exited ${code}: ${stderr.slice(-512)}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as FfprobeJson
        resolve(parsed)
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  })
}

function parseProbe(json: FfprobeJson, filePath: string): ProbeResult {
  const streams = Array.isArray(json.streams) ? json.streams : []
  // An embedded cover-art / album-art stream is reported by ffprobe as a
  // `video` stream but carries `disposition.attached_pic = 1`. It is NOT real
  // motion video — treat it as if it were not there for kind detection, so a
  // music/TTS file (.mp3 with cover art) is correctly classified as `audio`
  // instead of being misrouted onto a video track. See slide 10.
  const realVideoStream = streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1
  )
  const videoStream = realVideoStream ?? streams.find((s) => s.codec_type === 'video')
  const audioStream = streams.find((s) => s.codec_type === 'audio')

  const extKind = classifyByExtension(filePath)
  const hasCoverArtOnly = !realVideoStream && Boolean(audioStream)

  let kind: MediaKind
  if (extKind === 'audio' && audioStream) {
    // Audio container extension + an audio stream → always audio, even when a
    // cover-art video stream is present. This is the primary cover-art guard.
    kind = 'audio'
  } else if (hasCoverArtOnly) {
    // Only an attached-pic video stream alongside audio → audio file.
    kind = 'audio'
  } else if (realVideoStream && realVideoStream.width && realVideoStream.height) {
    // Distinguish image vs video by frame count / duration. Most images
    // probed by ffprobe have either no duration or a single frame.
    const nbFrames = Number(realVideoStream.nb_frames ?? '0')
    const dur = Number(realVideoStream.duration ?? json.format?.duration ?? '0')
    if ((nbFrames === 1 || Number.isNaN(nbFrames)) && dur < 0.1) {
      kind = 'image'
    } else if (extKind === 'image') {
      kind = 'image'
    } else {
      kind = 'video'
    }
  } else if (audioStream) {
    kind = 'audio'
  } else {
    kind = extKind
  }

  const durationSec = (() => {
    const fromFormat = Number(json.format?.duration ?? '')
    if (Number.isFinite(fromFormat) && fromFormat > 0) return fromFormat
    const fromStream = Number(
      videoStream?.duration ?? audioStream?.duration ?? ''
    )
    return Number.isFinite(fromStream) && fromStream > 0 ? fromStream : 0
  })()

  // For an audio file, report no video dimensions even if a cover-art stream
  // exists — the asset is audio, not an image.
  const width = kind === 'audio' ? 0 : videoStream?.width ?? 0
  const height = kind === 'audio' ? 0 : videoStream?.height ?? 0
  const codec =
    kind === 'audio'
      ? audioStream?.codec_name
      : videoStream?.codec_name ?? audioStream?.codec_name

  return {
    durationMs: Math.round((kind === 'image' ? 0 : durationSec) * 1000),
    width,
    height,
    codec,
    kind
  }
}

// ---------------------------------------------------------------------------
// Thumbnail extraction.
// ---------------------------------------------------------------------------
function thumbnailDir(): string {
  return path.join(app.getPath('userData'), 'thumbnails')
}

async function ensureThumbnailDir(): Promise<string> {
  const dir = thumbnailDir()
  await mkdir(dir, { recursive: true })
  return dir
}

function sanitizeMediaId(id: string | undefined): string {
  if (!id) return `thumb-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  // Allow only safe characters; ulid is [0-9A-HJKMNP-TV-Z].
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'thumb'
}

async function generateThumbnail(
  filePath: string,
  options: ThumbnailOptions = {}
): Promise<ThumbnailResult> {
  const ffmpeg = resolveFfmpegPath()
  const inputPath = assertPathAllowed(filePath, 'input')

  const dir = await ensureThumbnailDir()
  const id = sanitizeMediaId(options.mediaId)
  const outPath = options.outPath
    ? assertPathAllowed(options.outPath, 'output')
    : path.join(dir, `${id}.jpg`)
  // Make sure outPath survives security check (userData is allowed).
  allowPath(outPath)

  const atMs = Math.max(0, Math.floor(Number(options.atMs ?? 0)))
  const ssSec = (atMs / 1000).toFixed(3)

  // For images, ffmpeg also produces a JPG from a single still input — same args work.
  const args = [
    '-hide_banner',
    '-y',
    '-nostdin',
    '-ss',
    ssSec,
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    '-vf',
    'scale=480:-2:force_original_aspect_ratio=decrease',
    outPath
  ]

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    const STDERR_LIMIT = 8192
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // ignore
      }
      reject(new Error('[ffmpeg] thumbnail timed out'))
    }, 30_000)

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
      if (code === 0) resolve()
      else reject(new Error(`[ffmpeg] thumbnail exited ${code}: ${stderr.slice(-512)}`))
    })
  })

  if (!existsSync(outPath)) {
    throw new Error('[ffmpeg] thumbnail file missing after run')
  }

  // Convert to data URI for renderer (CSP-safe; img-src allows data:).
  const buf = await readFile(outPath)
  const dataUri = `data:image/jpeg;base64,${buf.toString('base64')}`

  return { path: outPath, dataUri }
}

// ---------------------------------------------------------------------------
// Waveform PNG generation (Phase 2.5).
// ---------------------------------------------------------------------------
function waveformDir(): string {
  return path.join(app.getPath('userData'), 'waveforms')
}

async function ensureWaveformDir(): Promise<string> {
  const dir = waveformDir()
  await mkdir(dir, { recursive: true })
  return dir
}

async function generateWaveform(
  filePath: string,
  options: WaveformOptions = {}
): Promise<WaveformResult> {
  const ffmpeg = resolveFfmpegPath()
  const inputPath = assertPathAllowed(filePath, 'input')

  const dir = await ensureWaveformDir()
  const id = sanitizeMediaId(options.mediaId)
  // Width/height clamped to sane bounds so a bad caller can't blow up memory.
  const width = Math.max(120, Math.min(4096, Math.floor(options.width ?? 1200)))
  const height = Math.max(20, Math.min(400, Math.floor(options.height ?? 80)))
  const outPath = options.outPath
    ? assertPathAllowed(options.outPath, 'output')
    : path.join(dir, `${id}.png`)
  allowPath(outPath)

  // showwavespic — colors must be ascii word; we hard-code purple.
  const filter = `showwavespic=s=${width}x${height}:colors=0xa78bfa:split_channels=0`
  const args = [
    '-hide_banner',
    '-y',
    '-nostdin',
    '-i',
    inputPath,
    '-filter_complex',
    filter,
    '-frames:v',
    '1',
    outPath
  ]

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    const STDERR_LIMIT = 8192
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // ignore
      }
      reject(new Error('[ffmpeg] waveform timed out'))
    }, 60_000)
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
      if (code === 0) resolve()
      else reject(new Error(`[ffmpeg] waveform exited ${code}: ${stderr.slice(-512)}`))
    })
  })

  if (!existsSync(outPath)) {
    throw new Error('[ffmpeg] waveform file missing after run')
  }

  const buf = await readFile(outPath)
  const dataUri = `data:image/png;base64,${buf.toString('base64')}`
  return { path: outPath, dataUri, width, height }
}

// ---------------------------------------------------------------------------
// IPC registration.
// ---------------------------------------------------------------------------
export function registerMediaHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.media.probe, async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !filePath) {
      throw new Error('[media] probe: filePath required')
    }
    const resolved = assertPathAllowed(filePath, 'input')
    const json = await runProbe(resolved)
    return parseProbe(json, resolved)
  })

  ipcMain.handle(
    IPC_CHANNELS.media.generateThumbnail,
    async (_event, filePath: unknown, options?: ThumbnailOptions) => {
      if (typeof filePath !== 'string' || !filePath) {
        throw new Error('[media] generateThumbnail: filePath required')
      }
      const safeOpts: ThumbnailOptions = {
        atMs: typeof options?.atMs === 'number' ? options.atMs : undefined,
        outPath: typeof options?.outPath === 'string' ? options.outPath : undefined,
        mediaId: typeof options?.mediaId === 'string' ? options.mediaId : undefined
      }
      try {
        return await generateThumbnail(filePath, safeOpts)
      } catch (err) {
        // Best-effort: clean a half-written thumbnail.
        if (safeOpts.outPath) {
          try {
            await unlink(safeOpts.outPath)
          } catch {
            // ignore
          }
        }
        throw err
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.media.readThumbnail, async (_event, thumbPath: unknown) => {
    if (typeof thumbPath !== 'string' || !thumbPath) return null
    try {
      const resolved = assertPathAllowed(thumbPath, 'input')
      const buf = await readFile(resolved)
      return `data:image/jpeg;base64,${buf.toString('base64')}`
    } catch (err) {
      console.warn('[media] readThumbnail failed', err)
      return null
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.media.generateWaveform,
    async (_event, filePath: unknown, options?: WaveformOptions) => {
      if (typeof filePath !== 'string' || !filePath) {
        throw new Error('[media] generateWaveform: filePath required')
      }
      const safeOpts: WaveformOptions = {
        width: typeof options?.width === 'number' ? options.width : undefined,
        height: typeof options?.height === 'number' ? options.height : undefined,
        outPath: typeof options?.outPath === 'string' ? options.outPath : undefined,
        mediaId: typeof options?.mediaId === 'string' ? options.mediaId : undefined
      }
      try {
        return await generateWaveform(filePath, safeOpts)
      } catch (err) {
        if (safeOpts.outPath) {
          try {
            await unlink(safeOpts.outPath)
          } catch {
            // ignore
          }
        }
        throw err
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.media.readWaveform, async (_event, wfPath: unknown) => {
    if (typeof wfPath !== 'string' || !wfPath) return null
    try {
      const resolved = assertPathAllowed(wfPath, 'input')
      const buf = await readFile(resolved)
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch (err) {
      console.warn('[media] readWaveform failed', err)
      return null
    }
  })

  // 0.2.9 — `srcPath` 의 파일을 userData/imports/<mediaId>.<ext> 로 복사.
  // 같은 mediaId 로 재호출되면 idempotent (이미 있으면 그대로 반환). 이로써
  // 사용자가 원본 파일을 어디 두든(특히 install 폴더 안 `새 폴더/`)
  // reinstall 사이클이 파일을 지워도 import는 user-data dir 안 안전 사본을
  // reference 함.
  ipcMain.handle(
    IPC_CHANNELS.media.copyToImports,
    async (_event, srcPath: unknown, mediaId: unknown): Promise<string> => {
      if (typeof srcPath !== 'string' || !srcPath) throw new Error('srcPath required')
      if (typeof mediaId !== 'string' || !mediaId) throw new Error('mediaId required')
      if (!/^[a-zA-Z0-9_-]+$/.test(mediaId)) throw new Error('mediaId invalid')
      const safeSrc = assertPathAllowed(srcPath, 'input')
      const dir = path.join(app.getPath('userData'), 'imports')
      if (!existsSync(dir)) await mkdir(dir, { recursive: true })
      const ext = path.extname(safeSrc) || ''
      const destPath = path.join(dir, `${mediaId}${ext}`)
      // 사본이 이미 있고 source size 와 같으면 skip (idempotent).
      try {
        const sStat = await stat(safeSrc)
        if (existsSync(destPath)) {
          const dStat = await stat(destPath)
          if (dStat.size === sStat.size) {
            allowPath(destPath)
            return destPath
          }
        }
      } catch {
        /* fall through to copy */
      }
      await copyFile(safeSrc, destPath)
      allowPath(destPath)
      return destPath
    }
  )
}
