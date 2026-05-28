/**
 * Export pipeline (Phase 2.6 — Reels Studio capstone).
 *
 * Takes a project snapshot + preset key and produces a single mp4 file via
 * ffmpeg's filter_complex graph engine.
 *
 * Pipeline overview:
 *   1. Walk video tracks → collect media clips in timeline order.
 *   2. For each clip build a filter chain:
 *        trim → setpts → atempo → filter preset → scale + blur-bg pad →
 *        drawtext captions (if any caption clip overlaps).
 *   3. Stitch adjacent clips with xfade for transitions, concat otherwise.
 *   4. Audio: each audio-bearing clip (video tracks too) → trim → atempo →
 *      volume → afade → afade_in/out for transitions.
 *      Per-track amix; bgm-track ducked via sidechaincompress against voice;
 *      final amix.
 *   5. Spawn ffmpeg through the existing runner with the assembled filter
 *      graph + map flags via extraArgs / scale / etc.
 *
 * The graph is written to `userData/exports/last-export-cmd.txt` before each
 * run for post-mortem diagnostics.
 */
import { app, ipcMain, shell } from 'electron'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  IPC_CHANNELS,
  type AllowedCodec,
  type ExportBuildPlanResult,
  type ExportPresetKey,
  type ExportRunOptions,
  type ExportRunResult,
  type FfmpegRunSpec
} from '../../shared/ipc'
import { probeCapabilities } from '../ffmpeg/capabilities'
import {
  adjustmentLayerToFfmpeg,
  colorAdjustToFfmpeg,
  curvesToFfmpeg,
  filmLookToFfmpeg,
  hslToFfmpeg,
  filterPresetToFfmpeg,
  retouchToFfmpeg,
  enhanceToFfmpeg,
  transitionKindToXfade,
  stabilizeShakiness,
  stabilizeToFfmpeg,
  voiceEnhanceToFfmpeg,
  voiceChangerToFfmpeg,
  visualEffectToFfmpeg
} from '../../shared/filterPresets'
import {
  DEFAULT_DUCKING_DB,
  DEFAULT_TRANSITION_MS,
  chromaKeyColorToFfmpeg,
  getChromaKey,
  isCaptionClip,
  isMediaClip,
  isOverlayClip,
  getClipTransform,
  getClipColorAdjust,
  getClipCurves,
  getClipHsl,
  getClipBlurRegions,
  getClipDenoise,
  getClipRetouch,
  getClipEnhance,
  blurRegionBlurRadiusPx,
  blurRegionMosaicBlockPx,
  getOverlayBaseSize,
  isIdentityTransform,
  hasTransformKeyframes,
  getClipCropRect,
  getCaptionAnimation,
  getCaptionAnimWindows,
  hasSpeedCurve,
  getSpeedAt,
  hasFreezeFrames,
  getClipFreezeFrames,
  resolveSpeedSegments,
  getTransformAt,
  getClipDeletedRanges,
  hasTranscriptDeletions,
  isClipReversed,
  getClipTimelineDuration,
  getAdjustmentLayers,
  getAdjustmentLayerTransform,
  MAX_TRANSFORM_OFFSET,
  MAX_TRANSFORM_ROTATION,
  MAX_TRANSFORM_SCALE,
  MIN_TRANSFORM_OFFSET,
  MIN_TRANSFORM_ROTATION,
  MIN_TRANSFORM_SCALE,
  CAPTION_SLIDE_FRAC,
  CAPTION_POP_START_SCALE,
  MAX_CAPTION_TYPEWRITER_STEPS,
  MAX_CAPTION_KARAOKE_STEPS,
  getCaptionKaraoke,
  resolveCaptionWords,
  findMotionTrack,
  getCaptionTextStroke,
  getCaptionTextShadow,
  getCaptionBackgroundSize,
  TRACK_EXPORT_STEP_MS,
  MAX_TRACK_EXPORT_KEYFRAMES,
  type AdjustmentLayer,
  type BlurRegion,
  type CaptionAnimation,
  type CaptionClip,
  type CaptionStyle,
  type ClipTransform,
  type DeletedRange,
  type MotionTrack,
  type OverlayClip,
  type Project,
  type Track,
  type TrackPoint,
  type TransformableClip,
  type FreezeFrame,
  type SpeedKeyframe,
  type TransformKeyframe,
  type VideoAudioClip,
  type VolumeKeyframe,
  resolveCoverMs,
  resolvedVolumeKeyframes,
  getProgressBar,
  getProjectTotalMs,
  progressBarToFfmpeg,
  type ProgressBarConfig,
  getOverlayShadow,
  getFilmLook,
  getClipStabilize,
  getVoiceEnhance,
  getVoiceChanger,
  getVisualEffect,
  getCanvasBackground,
  canvasBackgroundToFfmpegColor,
  easingToFfmpegFExpr
} from '../../shared/project'
import { resolveFfmpegPath } from '../ffmpeg/binary'
import { allowPath, assertPathAllowed } from '../ffmpeg/security'
import {
  renderCaptionToFile,
  resetCaptionRenderStats,
  getCaptionRenderStats
} from '../captions/render'
import {
  renderOverlayShapeToFile,
  resolveBundledStickerPath
} from '../overlays/render'

// ---------------------------------------------------------------------------
// Preset table (kept in sync with renderer's exportPresets.ts — main-process
// copy lets the IPC validate without round-tripping the renderer's bundle).
// ---------------------------------------------------------------------------
type Libx264Preset =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
  | 'veryslow'

interface MainPreset {
  width: number
  height: number
  fps: number
  vBitrateKbps: number
  aBitrateKbps: number
  codec: 'libx264'
  preset: Libx264Preset
}

/**
 * Map a libx264-style preset name to the equivalent for a given encoder. HW
 * encoders advertise their own preset vocabularies; using the wrong one is
 * either rejected at session init or silently ignored (depending on the
 * encoder). See README/Phase 4.2 notes for the source mapping.
 *
 * Returns `null` to mean "do not pass -preset at all" (used by VideoToolbox).
 */
export function mapPresetForCodec(
  preset: Libx264Preset,
  codec: AllowedCodec
): string | null {
  switch (codec) {
    case 'libx264':
    case 'libx265':
      return preset
    case 'h264_amf':
    case 'hevc_amf': {
      // amf usage: -quality {quality|balanced|speed}
      if (preset === 'slow' || preset === 'slower' || preset === 'veryslow') {
        return 'quality'
      }
      if (
        preset === 'veryfast' ||
        preset === 'superfast' ||
        preset === 'ultrafast' ||
        preset === 'faster' ||
        preset === 'fast'
      ) {
        return 'speed'
      }
      return 'balanced'
    }
    case 'h264_nvenc':
    case 'hevc_nvenc': {
      // nvenc usage: -preset p1..p7 (p7 = highest quality / slowest)
      if (preset === 'ultrafast' || preset === 'superfast') return 'p1'
      if (preset === 'veryfast') return 'p1'
      if (preset === 'faster') return 'p2'
      if (preset === 'fast') return 'p3'
      if (preset === 'medium') return 'p4'
      if (preset === 'slow') return 'p7'
      if (preset === 'slower') return 'p7'
      if (preset === 'veryslow') return 'p7'
      return 'p4'
    }
    case 'h264_qsv':
    case 'hevc_qsv':
      // qsv accepts x264-style preset names natively (veryfast..veryslow).
      return preset
    case 'h264_videotoolbox':
    case 'hevc_videotoolbox':
      // VideoToolbox doesn't accept -preset; quality is set via -q:v instead.
      return null
    default:
      return preset
  }
}

/**
 * AMD AMF expects `-quality {...}` rather than `-preset {...}`. Returns the
 * argv flag that should precede the mapped preset string. Most encoders use
 * `-preset`, AMF (and only AMF) uses `-quality`.
 */
export function presetFlagForCodec(codec: AllowedCodec): '-preset' | '-quality' {
  if (codec === 'h264_amf' || codec === 'hevc_amf') return '-quality'
  return '-preset'
}

const PRESETS: Record<ExportPresetKey, MainPreset> = {
  'instagram-reels': {
    width: 1080,
    height: 1920,
    fps: 30,
    vBitrateKbps: 8000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  tiktok: {
    width: 1080,
    height: 1920,
    fps: 30,
    vBitrateKbps: 8000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  'youtube-shorts': {
    width: 1080,
    height: 1920,
    fps: 30,
    vBitrateKbps: 8000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  'instagram-feed': {
    width: 1080,
    height: 1080,
    fps: 30,
    vBitrateKbps: 6000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  'high-quality': {
    width: 1080,
    height: 1920,
    fps: 60,
    vBitrateKbps: 12000,
    aBitrateKbps: 192,
    codec: 'libx264',
    preset: 'slow'
  },
  /**
   * Phase 3.28 — GIF backing preset. Used only by the GIF branch as the
   * composite render target for pass 0 (the intermediate mp4). The gif muxer
   * itself is driven by exportGif. The 5 mp4 presets never touch this entry.
   */
  gif: {
    width: 720,
    height: 1280,
    fps: 15,
    vBitrateKbps: 3000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'fast'
  }
}

// ---------------------------------------------------------------------------
// Filter availability probe. The bundled ffmpeg can be old; xfade landed in
// 4.3 (2020). When absent, we fall back to plain concat (no visible blend).
// ---------------------------------------------------------------------------
let xfadeAvailableCache: boolean | null = null

// Per-path audio-presence cache. ffmpeg 6 rejects the `[N:a:0?]` "optional
// stream" syntax inside filter_complex (`Invalid stream specifier: a:0?`).
// Instead of relying on `?`, we probe each input upfront and only emit an
// audio chain for inputs that actually carry an audio stream.
const audioPresenceCache = new Map<string, boolean>()

function probeHasAudio(ffmpegPath: string, filePath: string): Promise<boolean> {
  const cached = audioPresenceCache.get(filePath)
  if (cached !== undefined) return Promise.resolve(cached)
  return new Promise<boolean>((resolve) => {
    // `ffmpeg -i <file>` prints stream info to stderr then exits with code 1
    // because no output was specified. We grep that for a line that starts
    // with `Stream #X:Y...Audio:` — present iff the file has an audio stream.
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 128 * 1024) stderr = stderr.slice(-128 * 1024)
    })
    const settle = (val: boolean): void => {
      audioPresenceCache.set(filePath, val)
      resolve(val)
    }
    proc.on('error', () => settle(false))
    proc.on('close', () => {
      const has = /Stream #\d+:\d+[^\n]*Audio:/.test(stderr)
      settle(has)
    })
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      if (!audioPresenceCache.has(filePath)) settle(false)
    }, 5_000)
  })
}

function probeXfadeAvailable(ffmpegPath: string): Promise<boolean> {
  if (xfadeAvailableCache !== null) return Promise.resolve(xfadeAvailableCache)
  return new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-filters'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-256 * 1024)
    })
    proc.on('error', () => {
      xfadeAvailableCache = false
      resolve(false)
    })
    proc.on('close', () => {
      // Match a line like " ... xfade            VV->V       ..."
      const has = /\bxfade\b\s+VV->V/.test(stdout)
      xfadeAvailableCache = has
      resolve(has)
    })
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      if (xfadeAvailableCache === null) {
        xfadeAvailableCache = false
        resolve(false)
      }
    }, 3_000)
  })
}

// ---------------------------------------------------------------------------
// Phase 4 — afftdn availability probe. Mirrors probeXfadeAvailable exactly:
// spawn `ffmpeg -hide_banner -filters`, match `/\bafftdn\b\s+A->A/` in stdout,
// cache result, 3s timeout → false.
// ---------------------------------------------------------------------------
let afftdnAvailableCache: boolean | null = null

function probeAfftdnAvailable(ffmpegPath: string): Promise<boolean> {
  if (afftdnAvailableCache !== null) return Promise.resolve(afftdnAvailableCache)
  return new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-filters'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-256 * 1024)
    })
    proc.on('error', () => {
      afftdnAvailableCache = false
      resolve(false)
    })
    proc.on('close', () => {
      // Match a line like " ... afftdn            A->A       ..."
      const has = /\bafftdn\b\s+A->A/.test(stdout)
      afftdnAvailableCache = has
      resolve(has)
    })
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      if (afftdnAvailableCache === null) {
        afftdnAvailableCache = false
        resolve(false)
      }
    }, 3_000)
  })
}

// ---------------------------------------------------------------------------
// Phase 3.39 — deesser availability probe. Mirrors probeAfftdnAvailable
// exactly: spawn `ffmpeg -hide_banner -filters`, match `/\bdeesser\b/` in
// stdout, cache result, 3s timeout → false.
// Core filters (loudnorm, acompressor, equalizer, highpass) are always present
// in ffmpeg 6.x essentials — no probe needed for them.
// ---------------------------------------------------------------------------
let deesserAvailableCache: boolean | null = null

function probeDeesserAvailable(ffmpegPath: string): Promise<boolean> {
  if (deesserAvailableCache !== null) return Promise.resolve(deesserAvailableCache)
  return new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-filters'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-256 * 1024)
    })
    proc.on('error', () => {
      deesserAvailableCache = false
      resolve(false)
    })
    proc.on('close', () => {
      const has = /\bdeesser\b/.test(stdout)
      deesserAvailableCache = has
      resolve(has)
    })
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      if (deesserAvailableCache === null) {
        deesserAvailableCache = false
        resolve(false)
      }
    }, 3_000)
  })
}

// ---------------------------------------------------------------------------
// Phase 3.12 — huesaturation availability probe. Mirrors probeAfftdnAvailable
// exactly: spawn `ffmpeg -hide_banner -filters`, match `/\bhuesaturation\b/`
// in stdout, cache result, 3s timeout → false.
// curves= is ancient (since ffmpeg 2.x) and always present — no probe needed.
// ---------------------------------------------------------------------------
let hueSatAvailableCache: boolean | null = null

function probeHueSaturationAvailable(ffmpegPath: string): Promise<boolean> {
  if (hueSatAvailableCache !== null) return Promise.resolve(hueSatAvailableCache)
  return new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-filters'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-256 * 1024)
    })
    proc.on('error', () => {
      hueSatAvailableCache = false
      resolve(false)
    })
    proc.on('close', () => {
      // Match a line like " ... huesaturation     V->V    Apply hue-saturation..."
      const has = /\bhuesaturation\b/.test(stdout)
      hueSatAvailableCache = has
      resolve(has)
    })
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      if (hueSatAvailableCache === null) {
        hueSatAvailableCache = false
        resolve(false)
      }
    }, 3_000)
  })
}

// ---------------------------------------------------------------------------
// Phase 3.38 — vidstab / deshake availability probes.
// Mirror the probeHueSaturationAvailable pattern exactly.
// ---------------------------------------------------------------------------
let vidstabAvailableCache: boolean | null = null

function probeVidstabAvailable(ffmpegPath: string): Promise<boolean> {
  if (vidstabAvailableCache !== null) return Promise.resolve(vidstabAvailableCache)
  return new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-filters'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-256 * 1024)
    })
    proc.on('error', () => {
      vidstabAvailableCache = false
      resolve(false)
    })
    proc.on('close', () => {
      const has = /\bvidstabtransform\b/.test(stdout)
      vidstabAvailableCache = has
      resolve(has)
    })
    setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
      if (vidstabAvailableCache === null) {
        vidstabAvailableCache = false
        resolve(false)
      }
    }, 3_000)
  })
}

let deshakeAvailableCache: boolean | null = null

function probeDeshakeAvailable(ffmpegPath: string): Promise<boolean> {
  if (deshakeAvailableCache !== null) return Promise.resolve(deshakeAvailableCache)
  return new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-filters'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-256 * 1024)
    })
    proc.on('error', () => {
      deshakeAvailableCache = false
      resolve(false)
    })
    proc.on('close', () => {
      const has = /\bdeshake\b/.test(stdout)
      deshakeAvailableCache = has
      resolve(has)
    })
    setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
      if (deshakeAvailableCache === null) {
        deshakeAvailableCache = false
        resolve(false)
      }
    }, 3_000)
  })
}

// ---------------------------------------------------------------------------
// Phase 3.38 — stabilize job collection + 1st-pass helpers.
// ---------------------------------------------------------------------------

interface StabilizeJob {
  clipId: string
  mediaPath: string
  /** ms — trim start in source time */
  trimInMs: number
  /** ms — speed-adjusted decode window (source time to decode for the pass) */
  durationMs: number
  reversed: boolean
  /**
   * vidstabdetect shakiness (1..10).  Fixed at 5 so the 1st-pass cache key is
   * independent of the user-facing strength slider — the slider only changes
   * the 2nd-pass smoothing/zoom, which does NOT require re-running detect.
   */
  shakiness: number
}

/**
 * Walk the project and collect one StabilizeJob per media clip that has
 * getClipStabilize > 0. Skips overlay/caption clips, clips whose media
 * asset is missing, and image-kind clips (static frames need no stabilize).
 */
function collectStabilizeJobs(project: Project): StabilizeJob[] {
  const jobs: StabilizeJob[] = []
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue
    for (const clip of track.clips) {
      if (!isMediaClip(clip)) continue
      const stab = getClipStabilize(clip)
      if (stab === null) continue
      const asset = project.media[clip.mediaId]
      if (!asset || !asset.path || asset.kind === 'image') continue
      if (!existsSync(asset.path)) continue
      // Source time duration the 1st pass must decode: speed * timeline duration.
      const speed = clip.speed ?? 1
      const timelineDurMs = getClipTimelineDuration(clip)
      const srcDurMs = Math.max(1, Math.round(timelineDurMs * speed))
      jobs.push({
        clipId: clip.id,
        mediaPath: asset.path,
        trimInMs: clip.trimInMs,
        durationMs: srcDurMs,
        reversed: isClipReversed(clip),
        // Fixed at 5 — strength slider only affects the 2nd-pass transform
        // (smoothing + zoom), not the detect pass.  Keeping shakiness constant
        // ensures the .trf cache hit regardless of strength changes.
        shakiness: 5
      })
    }
  }
  return jobs
}

/** Emit a ffmpeg:progress event with message='stabilize-detect'. */
function emitStabilizeProgress(
  jobId: string,
  jobIndex: number,
  total: number,
  clipPct: number
): void {
  if (total === 0) return
  const percent = ((jobIndex + clipPct / 100) / total) * 100
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { webContents } = require('electron') as typeof import('electron')
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue
      wc.send(IPC_CHANNELS.ffmpeg.progress, {
        jobId,
        percent,
        done: false,
        message: 'stabilize-detect'
      })
    }
  } catch {
    // ignore
  }
}

/**
 * Spawn a vidstabdetect 1st pass for one clip.
 *
 * Cache key (SHA-1, first 16 hex chars):
 *   mediaPath + sourceMtimeMs + trimInMs + durationMs + reversed + shakiness
 *
 * Short-circuits immediately when the `.trf` file already exists and is
 * non-empty. On success returns the absolute trf path.
 */
async function runVidstabDetectPass(
  ffmpegPath: string,
  job: StabilizeJob,
  onProgress: (pct: number) => void
): Promise<string> {
  // Build cache key — strength (smoothing/zoom) is NOT in the key so the
  // user can move the strength slider and reuse the same .trf for the 2nd pass.
  let sourceMtimeMs = 0
  try { sourceMtimeMs = statSync(job.mediaPath).mtimeMs } catch { /* 0 if stat fails */ }
  const keyRaw = [
    job.mediaPath,
    sourceMtimeMs,
    job.trimInMs,
    job.durationMs,
    job.reversed ? '1' : '0',
    job.shakiness
  ].join('|')
  const keyHash = createHash('sha1').update(keyRaw).digest('hex').slice(0, 16)

  const cacheDir = path.join(app.getPath('userData'), 'stabilize-cache')
  await mkdir(cacheDir, { recursive: true })
  const trfPath = path.join(cacheDir, `${keyHash}.trf`)

  // Short-circuit if already computed.
  if (existsSync(trfPath) && statSync(trfPath).size > 0) {
    onProgress(100)
    return trfPath
  }

  const trimInSec = (job.trimInMs / 1000).toFixed(4)
  const durSec = (job.durationMs / 1000).toFixed(4)

  // Forward-slash + colon-escape for vidstabdetect result= option.
  // On Windows the drive-letter colon (C:) must be escaped as \: within the
  // FFmpeg filter option value.  Wrapping the entire path in single quotes
  // prevents FFmpeg from treating the : after the drive letter as an option
  // separator — both the \: escape and the surrounding quotes are required.
  const safeTrf = "'" + trfPath.replace(/\\/g, '/').replace(/:/g, '\\:') + "'"

  const vf = [
    ...(job.reversed ? ['reverse'] : []),
    `vidstabdetect=result=${safeTrf}:shakiness=${job.shakiness}:accuracy=15:mincontrast=0.25`
  ].join(',')

  const args = [
    '-hide_banner',
    '-progress', 'pipe:2',
    '-ss', trimInSec,
    '-t', durSec,
    '-i', job.mediaPath,
    '-vf', vf,
    '-an',
    '-f', 'null',
    '-'
  ]

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })

    let stderrBuf = ''
    let totalDurationMs: number | null = null
    let lastEmit = 0
    const EMIT_INTERVAL = 250

    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      stderrBuf += chunk
      // Parse total duration once.
      if (totalDurationMs == null) {
        const dm = /Duration:\s+(\d+):(\d+):([\d.]+)/.exec(stderrBuf)
        if (dm) {
          totalDurationMs = Math.round(
            (Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3])) * 1000
          )
        }
      }
      // Parse progress lines.
      let idx: number
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).trim()
        stderrBuf = stderrBuf.slice(idx + 1)
        if (!line) continue
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const key = line.slice(0, eq).trim()
        const value = line.slice(eq + 1).trim()
        if (key === 'out_time_ms' && totalDurationMs) {
          const outMs = Number(value) / 1000
          const now = Date.now()
          if (now - lastEmit >= EMIT_INTERVAL) {
            lastEmit = now
            const pct = Math.min(99, Math.max(0, (outMs / totalDurationMs) * 100))
            onProgress(pct)
          }
        }
      }
    })

    proc.on('error', (err) => reject(err))
    proc.on('close', (code) => {
      if (code === 0) {
        onProgress(100)
        resolve()
      } else {
        reject(new Error(`vidstabdetect exited with code ${code}`))
      }
    })

    // Per-job timeout: 10 minutes.
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
      reject(new Error('vidstabdetect timed out'))
    }, 10 * 60 * 1000)
    proc.on('close', () => clearTimeout(timer))
  })

  return trfPath
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

interface VideoSegment {
  clip: VideoAudioClip
  track: Track
  /** Input index in the ffmpeg argv. */
  inputIdx: number
  /**
   * Caption overlays whose time range intersects this clip (any caption
   * track). NOTE: when the PNG-overlay path is in use (sharp available),
   * captions are composited *after* segment stitching using ffmpeg's
   * `overlay` filter — see `stitchCaptions()`. We still keep this array on
   * the segment for the drawtext fallback path, which applies captions
   * inside each segment chain via `drawtext`.
   */
  captions: CaptionClip[]
  /** Time-on-timeline of segment start/end (clip.startMs / clip.endMs copy). */
  startMs: number
  endMs: number
  /** Transition window with previous segment (used by both video and audio). */
  transitionInMs: number
  transitionKind: string
  /**
   * Layer (video track) index: 0 = bottom-most video track, increasing upward.
   * Used to decide whether the blurred-background subgraph is emitted (base
   * layer only) vs. transparent-pad path (upper layers).
   */
  layerIndex: number
  /**
   * Phase 3.16 — when set this segment is a freeze-frame hold, not a moving
   * piece. `durationMs` is the held timeline duration; the synthetic clip's
   * trimInMs points at the exact source frame to hold.
   */
  freeze?: { durationMs: number }
}

/**
 * One stepped PNG used by the typewriter entrance — or the single step for
 * all other captions. Each step has its own ffmpeg input index and its own
 * visibility window [visStartMs, visEndMs).
 */
interface CaptionStep {
  pngPath: string
  inputIdx: number
  /** Inclusive start of this step's visibility window (ms, timeline-absolute). */
  visStartMs: number
  /** Exclusive end of this step's visibility window (ms, timeline-absolute). */
  visEndMs: number
}

/**
 * Mapping from `caption.id` → pre-rendered PNG path + assigned ffmpeg input
 * index. When this map is non-empty, the export pipeline uses the PNG-overlay
 * path; when empty, the drawtext fallback runs (which is the legacy code path
 * preserved for fontconfig-only systems or when sharp's native binding is
 * unavailable).
 *
 * Phase 3.9: `animation` carries the resolved CaptionAnimation (null for none).
 * `steps` holds 1 entry for non-typewriter captions, or N entries for typewriter
 * (one per stepped PNG). The first step's `inputIdx` is the lowest; subsequent
 * steps use consecutive indices. Only step[0].pngPath / inputIdx / startMs / endMs
 * are used for backwards-compat bookkeeping; the overlay graph iterates `steps`.
 */
interface CaptionPng {
  pngPath: string
  inputIdx: number
  /** From the original caption clip — preserved for overlay positioning. */
  startMs: number
  endMs: number
  cached: boolean
  // Phase 3.9 fields.
  /** Resolved animation or null (null → byte-identical legacy overlay fragment). */
  animation: CaptionAnimation | null
  /**
   * Entrance window (ms) after getCaptionAnimWindows clamping. 0 when no entrance.
   * Stored so stitchCaptions does not need to re-derive it.
   */
  animInMs: number
  /**
   * Exit window (ms) after getCaptionAnimWindows clamping. 0 when no exit.
   */
  animOutMs: number
  /**
   * Flattened step list. Length = 1 for non-typewriter; length = N for typewriter.
   * Each entry contributes one `-loop 1 -t … -i <png>` input and one overlay
   * fragment in the filter graph.
   */
  steps: CaptionStep[]
}

type CaptionPngMap = Map<string, CaptionPng>

/**
 * Phase 3.8 — mapping from `overlayClip.id` → pre-resolved PNG path + ffmpeg
 * input index. Image overlays use source.path directly; sticker overlays use
 * a bundled file; shape overlays use a sharp-rendered temporary PNG.
 * The map is keyed by overlay clip id for O(1) lookup.
 */
interface OverlayPng {
  pngPath: string
  inputIdx: number
  startMs: number
  endMs: number
  /** Pixel size AFTER baseWidthFrac/baseHeightFrac × canvas was applied. */
  pxW: number
  pxH: number
  /** Reference to the original clip — needed to build the transform sub-chain. */
  clip: OverlayClip
}

type OverlayPngMap = Map<string, OverlayPng>

interface AudioSegment {
  clip: VideoAudioClip
  track: Track
  inputIdx: number
  /** True if this is the audio of a video-track clip (uses same input but 0:a stream). */
  fromVideoTrack: boolean
  /**
   * Phase 3.16 — when set this segment is a freeze-frame hold; audio is
   * silence for `durationMs`. No source stream is read.
   */
  freeze?: { durationMs: number }
}

// ---------------------------------------------------------------------------
// Phase 3.17 — transcript-deletion survivor decomposition.
//
// When a clip has transcript deletions, its source window is divided into
// "survivors" — contiguous source ranges that were NOT deleted. Each survivor
// becomes a synthetic VideoAudioClip with:
//   - trimInMs/trimOutMs spanning only that survivor's source window.
//   - deletedRanges/transcript cleared (no recursion).
//   - speedKeyframes/freezeFrames filtered and re-based to the new trimInMs.
//   - startMs/endMs on the timeline laid end-to-end from the original startMs.
//
// When the clip has NO effective deletions this returns [clip] unchanged, so
// the call site is always byte-identical for deletion-free clips.
//
// Speed-keyframe strategy: we keep keyframes whose source offset (from the
// original trimInMs) falls inside this survivor's source window, then re-base
// them so atMs is relative to the survivor's new trimInMs. If fewer than 2
// keyframes survive, we drop speedKeyframes entirely and fall back to the
// constant `speed` field (sampled as the clip's declared speed). This is the
// simplest correct approach — a sub-window of a variable-speed clip with a
// sparse keyframe set will play at the constant-speed fallback, which is
// far preferable to a crash or a corrupt filter graph.
// ---------------------------------------------------------------------------

/**
 * Decompose a clip that has transcript deletions into an ordered array of
 * synthetic "survivor" sub-clips — the source windows that survive after
 * deletion.  Each survivor has `deletedRanges: undefined` so subsequent
 * speed/freeze expansion sees a clean clip.  Survivors are laid end-to-end on
 * the timeline starting at `clip.startMs`.
 *
 * If the clip has no effective deletions (`hasTranscriptDeletions` false),
 * returns `[clip]` unchanged — byte-identical.
 */
function expandDeletedRanges(clip: VideoAudioClip): VideoAudioClip[] {
  if (!hasTranscriptDeletions(clip)) return [clip]

  const deleted: DeletedRange[] = getClipDeletedRanges(clip)
  const origTrimIn = clip.trimInMs
  const origTrimOut = clip.trimOutMs

  // Build survivor source windows: gaps in [origTrimIn, origTrimOut] not
  // covered by any deleted range.
  const survivors: Array<{ srcLo: number; srcHi: number }> = []
  let cursor = origTrimIn
  for (const d of deleted) {
    if (d.sourceStartMs > cursor) {
      survivors.push({ srcLo: cursor, srcHi: d.sourceStartMs })
    }
    cursor = Math.max(cursor, d.sourceEndMs)
  }
  if (cursor < origTrimOut) {
    survivors.push({ srcLo: cursor, srcHi: origTrimOut })
  }

  // Drop zero-width survivors (shouldn't happen after getClipDeletedRanges
  // filtering but be defensive).
  const validSurvivors = survivors.filter((s) => s.srcHi - s.srcLo > 0)
  if (validSurvivors.length === 0) {
    // All source was deleted — no output. Return empty array; the caller must
    // skip this clip entirely.
    return []
  }

  // Lay survivors end-to-end on the timeline starting at clip.startMs.
  let timelineCursor = clip.startMs
  const result: VideoAudioClip[] = []

  for (const { srcLo, srcHi } of validSurvivors) {
    // Build a synthetic survivor clip (shallow clone, overrides below).
    const synth: VideoAudioClip = {
      ...clip,
      trimInMs: srcLo,
      trimOutMs: srcHi,
      // Remove deletion-related fields so downstream expansion is clean.
      deletedRanges: undefined,
      transcript: undefined,
    }

    // -----------------------------------------------------------------
    // Speed-keyframe re-basing.
    // SpeedKeyframe.atMs is a source offset from the ORIGINAL trimInMs.
    //
    // When the original clip has an active speed curve (>= 2 keyframes),
    // we RESTRICT the curve to this survivor's source window [a, b] where
    // a = srcLo - origTrimIn and b = srcHi - origTrimIn (both are source
    // offsets from the original trimInMs).
    //
    // The restricted curve is built as:
    //   [{ atMs: 0,   speed: getSpeedAt(clip, a) },        // synthesized lo boundary
    //    ...interior original keyframes with atMs in (a,b), re-based by -a,
    //    { atMs: b-a, speed: getSpeedAt(clip, b) }]        // synthesized hi boundary
    //
    // This always yields >= 2 keyframes, so the curve is preserved.
    // getClipTimelineDuration(synth) will then integrate the SAME piecewise-
    // linear curve over [0, b-a] that the store integrated over [a, b] in
    // the original clip, guaranteeing duration consistency.
    //
    // When the original clip has NO active speed curve (constant speed),
    // the survivor inherits the constant `speed` field — no keyframes
    // synthesized (byte-identical to pre-fix behaviour for constant-speed
    // clips).
    // -----------------------------------------------------------------
    if (hasSpeedCurve(clip)) {
      const srcLoOffset = srcLo - origTrimIn   // a: survivor lo as source offset from orig trimIn
      const srcHiOffset = srcHi - origTrimIn   // b: survivor hi as source offset from orig trimIn
      const survivorDur = srcHiOffset - srcLoOffset

      // Interior original keyframes strictly inside (a, b), re-based by -a.
      const interior = (clip.speedKeyframes as SpeedKeyframe[])
        .filter((kf) => kf.atMs > srcLoOffset && kf.atMs < srcHiOffset)
        .map((kf) => ({ atMs: kf.atMs - srcLoOffset, speed: kf.speed }))

      // Synthesized boundary keyframes at the exact survivor edges.
      const loBoundary: SpeedKeyframe = { atMs: 0,          speed: getSpeedAt(clip, srcLoOffset) }
      const hiBoundary: SpeedKeyframe = { atMs: survivorDur, speed: getSpeedAt(clip, srcHiOffset) }

      // Merge: boundary + interior, sort ascending, dedupe same-atMs (keep first).
      const merged: SpeedKeyframe[] = [loBoundary, ...interior, hiBoundary]
      merged.sort((a, b) => a.atMs - b.atMs)
      const deduped: SpeedKeyframe[] = []
      for (const kf of merged) {
        if (deduped.length === 0 || kf.atMs !== deduped[deduped.length - 1].atMs) {
          deduped.push(kf)
        }
      }
      // deduped always has >= 2 entries (loBoundary at 0 and hiBoundary at survivorDur
      // are distinct because survivorDur > 0, guaranteed by validSurvivors filter above).
      synth.speedKeyframes = deduped
    } else {
      synth.speedKeyframes = undefined
    }

    // -----------------------------------------------------------------
    // Freeze-frame re-basing.
    // FreezeFrame.sourceMs is a source offset from the ORIGINAL trimInMs.
    // Keep only freezes whose source falls within this survivor's source
    // window, re-base to the survivor's new trimInMs.
    // -----------------------------------------------------------------
    if (Array.isArray(clip.freezeFrames) && clip.freezeFrames.length > 0) {
      const srcLoOffset = srcLo - origTrimIn
      const srcHiOffset = srcHi - origTrimIn
      const keptFreezes: FreezeFrame[] = (clip.freezeFrames as FreezeFrame[])
        .filter((f) => f.sourceMs >= srcLoOffset && f.sourceMs < srcHiOffset)
        .map((f) => ({ sourceMs: f.sourceMs - srcLoOffset, durationMs: f.durationMs }))
      synth.freezeFrames = keptFreezes.length > 0 ? keptFreezes : undefined
    } else {
      synth.freezeFrames = undefined
    }

    // -----------------------------------------------------------------
    // Timeline placement: assign startMs/endMs for this survivor.
    // getClipTimelineDuration on synth (which now has no deletions) gives
    // the correct speed+freeze-aware duration for this source window.
    // -----------------------------------------------------------------
    const dur = getClipTimelineDuration(synth)
    synth.startMs = timelineCursor
    synth.endMs = timelineCursor + dur

    // -----------------------------------------------------------------
    // Phase 3.30 — Volume-keyframe re-basing for deletion survivors.
    // VolumeKeyframe.atMs is clip-relative TIMELINE ms (offset from the
    // ORIGINAL clip.startMs).  This survivor occupies:
    //   localLo = timelineCursor - clip.startMs
    //   localHi = localLo + dur
    // in that original timeline.
    //
    // Keep every keyframe whose atMs falls in [localLo, localHi], plus the
    // nearest neighbour outside each edge so the hold-clamp behaves correctly
    // at the survivor boundaries. Re-base kept keyframes by subtracting localLo.
    // Set volumeKeyframes: undefined when fewer than 2 survive so the constant
    // gainDb fallback is used — mirroring the null gate of resolvedVolumeKeyframes.
    // -----------------------------------------------------------------
    if (Array.isArray(clip.volumeKeyframes) && clip.volumeKeyframes.length >= 2) {
      const localLo = timelineCursor - clip.startMs
      const localHi = localLo + dur
      const vkfs = clip.volumeKeyframes as VolumeKeyframe[]

      // Interior: strictly inside the window.
      const interior = vkfs.filter((kf) => kf.atMs > localLo && kf.atMs < localHi)

      // Nearest outside-left neighbour: largest atMs <= localLo.
      const leftNeighbors = vkfs.filter((kf) => kf.atMs <= localLo)
      const leftPin = leftNeighbors.length > 0
        ? leftNeighbors.reduce((best, kf) => kf.atMs > best.atMs ? kf : best)
        : null

      // Nearest outside-right neighbour: smallest atMs >= localHi.
      const rightNeighbors = vkfs.filter((kf) => kf.atMs >= localHi)
      const rightPin = rightNeighbors.length > 0
        ? rightNeighbors.reduce((best, kf) => kf.atMs < best.atMs ? kf : best)
        : null

      // Assemble: pin at localLo (if we have a left neighbour), interior, pin
      // at localHi (if we have a right neighbour).  This guarantees boundary
      // values are accurate regardless of where the original keyframes sit.
      const assembled: VolumeKeyframe[] = []
      if (leftPin !== null) {
        assembled.push({ atMs: localLo, gainDb: leftPin.gainDb })
      }
      for (const kf of interior) {
        assembled.push(kf)
      }
      if (rightPin !== null) {
        assembled.push({ atMs: localHi, gainDb: rightPin.gainDb })
      }

      // Re-base to survivor-local 0.
      const rebased = assembled.map((kf) => ({ atMs: kf.atMs - localLo, gainDb: kf.gainDb }))
      // Dedupe same-atMs (keep first).
      const deduped = rebased.filter(
        (kf, idx) => idx === 0 || kf.atMs !== rebased[idx - 1].atMs
      )

      synth.volumeKeyframes = deduped.length >= 2 ? deduped : undefined
    } else {
      synth.volumeKeyframes = undefined
    }

    timelineCursor += dur

    result.push(synth)
  }

  return result
}

/**
 * Collect media clips from all video tracks (ordered by startMs) and assign
 * input indices. Each unique input file maps to one ffmpeg `-i`; if the same
 * media file is referenced by multiple clips we still re-add it because
 * different trim windows make stream cloning fragile.
 *
 * Returns per-track grouped layers (videoTrackLayers[i] = sorted segments for
 * video track i, layerIndex 0 = bottom). A flat `videoSegments` convenience
 * accessor (all segments across all layers) is also returned for callers that
 * just need the count or audio wiring.
 *
 * IMPORTANT: transitionIn is resolved against the PREVIOUS CLIP ON THE SAME
 * TRACK — not a global ordering — so multi-track layouts don't cross-pollinate.
 */
function collectSegments(
  project: Project,
  exportFps = 30
): {
  videoTrackLayers: VideoSegment[][]
  videoSegments: VideoSegment[]
  audioSegments: AudioSegment[]
  inputs: string[]
} {
  const inputs: string[] = []
  const audioSegments: AudioSegment[] = []

  // Video tracks in declared order; clips sorted by startMs within each track.
  const videoTracks = project.tracks.filter((t) => t.kind === 'video')
  const allCaptionClips: CaptionClip[] = []
  for (const t of project.tracks) {
    if (t.kind !== 'caption') continue
    for (const c of t.clips) {
      if (isCaptionClip(c)) allCaptionClips.push(c)
    }
  }

  // Build per-track segment lists; each track gets its own layerIndex.
  const videoTrackLayers: VideoSegment[][] = []

  for (let layerIndex = 0; layerIndex < videoTracks.length; layerIndex++) {
    const t = videoTracks[layerIndex]
    const trackClips: { clip: VideoAudioClip; track: Track }[] = []
    for (const c of t.clips) {
      if (!isMediaClip(c)) continue
      const media = project.media[c.mediaId]
      if (!media) continue
      trackClips.push({ clip: c, track: t })
    }
    // Sort within this track by timeline start.
    trackClips.sort((a, b) => a.clip.startMs - b.clip.startMs)

    const layerSegments: VideoSegment[] = []
    for (let i = 0; i < trackClips.length; i++) {
      const { clip, track } = trackClips[i]
      const media = project.media[clip.mediaId]
      if (!media) continue

      // Transition: defined on this clip (transitionIn) — only valid if there
      // is a previous segment ON THE SAME TRACK (not a global predecessor).
      const prev = i > 0 ? trackClips[i - 1].clip : null
      let transitionInMs = 0
      let transitionKind = 'none'
      if (prev && clip.transitionIn && clip.transitionIn.kind !== 'none') {
        const want = Math.max(
          100,
          Math.min(
            clip.transitionIn.durationMs ?? DEFAULT_TRANSITION_MS,
            // can't exceed either clip's duration
            (clip.endMs - clip.startMs) - 1,
            (prev.endMs - prev.startMs) - 1
          )
        )
        transitionInMs = want
        transitionKind = clip.transitionIn.kind
      }

      if (!hasSpeedCurve(clip) && !hasFreezeFrames(clip) && !hasTranscriptDeletions(clip)) {
        // -----------------------------------------------------------------------
        // FAST PATH: no speed curve, no freeze frames, no transcript deletions —
        // single segment, byte-identical to pre-3.10 / pre-3.16 / pre-3.17.
        // -----------------------------------------------------------------------
        const inputIdx = inputs.length
        inputs.push(media.path)
        const captions = allCaptionClips.filter(
          (c) => c.endMs > clip.startMs && c.startMs < clip.endMs
        )
        layerSegments.push({
          clip,
          track,
          inputIdx,
          captions,
          startMs: clip.startMs,
          endMs: clip.endMs,
          transitionInMs,
          transitionKind,
          layerIndex
        })
      } else if (hasTranscriptDeletions(clip) && !hasSpeedCurve(clip) && !hasFreezeFrames(clip)) {
        // -----------------------------------------------------------------------
        // DELETION-ONLY PATH (Phase 3.17): decompose into survivor sub-clips,
        // each of which has no deletions and no speed/freeze complexity, so each
        // maps to exactly one VideoSegment via the fast path.
        // -----------------------------------------------------------------------
        const survivors = expandDeletedRanges(clip)
        for (let si = 0; si < survivors.length; si++) {
          const sv = survivors[si]
          const inputIdx = inputs.length
          inputs.push(media.path)
          const captions = allCaptionClips.filter(
            (c) => c.endMs > sv.startMs && c.startMs < sv.endMs
          )
          layerSegments.push({
            clip: sv,
            track,
            inputIdx,
            captions,
            startMs: sv.startMs,
            endMs: sv.endMs,
            // Transition applies only to the first survivor of the original clip.
            transitionInMs: si === 0 ? transitionInMs : 0,
            transitionKind: si === 0 ? transitionKind : 'none',
            layerIndex
          })
        }
      } else {
        // -----------------------------------------------------------------------
        // EXPANSION PATH (Phase 3.10 / 3.16 / 3.17): build an ordered list of pieces
        // (moving and freeze) then emit one VideoSegment per piece.
        //
        // Phase 3.17 survivor pre-pass: if the clip has transcript deletions,
        // expandDeletedRanges decomposes it into deletion-free survivor sub-clips
        // (already laid out on the timeline with correct startMs/endMs/trimInMs/
        // trimOutMs and speed/freeze fields re-based). Each survivor is then run
        // through the same speed+freeze expansion below. For a clip with no
        // deletions, expandDeletedRanges returns [clip] unchanged → byte-identical.
        //
        // Step 1: resolveSpeedSegments gives the constant-speed moving pieces
        //         in the SPEED-ONLY timeline domain (freeze-agnostic).
        // Step 2: walk getClipFreezeFrames (sorted ascending by sourceMs) and
        //         SPLIT the moving piece whose source window contains each
        //         freeze.sourceMs into [pre, freeze, post] sub-pieces.
        // Step 3: emit one synthetic clip + VideoSegment per piece.
        // -----------------------------------------------------------------------

        // --- Phase 3.16 helper constant ----------------------------------------
        // One source frame at export fps, used as the trimOut span for freeze segs.
        const ONE_FRAME_MS = 1000 / exportFps

        // --- Phase 3.17 survivor pre-pass --------------------------------------
        // expandDeletedRanges returns [clip] when there are no deletions, so
        // the loop body runs exactly once — byte-identical to pre-3.17 behavior.
        const expandedClips = expandDeletedRanges(clip)
        // isVeryFirstPiece tracks whether we're at the very first piece across ALL
        // survivors so we assign transitionInMs/transitionKind only once.
        let isVeryFirstPiece = true

        for (const ec of expandedClips) {
        // --- Build ordered piece list ------------------------------------------
        type MovingPiece = {
          kind: 'moving'
          srcStartMs: number   // source offset from ec.trimInMs
          srcEndMs: number
          speed: number
          outDurMs: number
        }
        type FreezePiece = {
          kind: 'freeze'
          sourceMs: number     // source offset from ec.trimInMs (the frame to hold)
          durationMs: number
        }
        type Piece = MovingPiece | FreezePiece

        const speedSegs = resolveSpeedSegments(ec)
        const freezes: FreezeFrame[] = getClipFreezeFrames(ec)

        // Seed the piece list with the speed-segment moving pieces.
        const pieces: Piece[] = speedSegs.map((s) => ({
          kind: 'moving' as const,
          srcStartMs: s.srcStartMs,
          srcEndMs: s.srcEndMs,
          speed: s.speed,
          outDurMs: s.outDurMs
        }))

        // Insert freeze pieces by splitting the enclosing moving piece.
        for (const freeze of freezes) {
          const fs = freeze.sourceMs // source offset at which the freeze happens

          // Find the moving piece that contains fs.
          let foundIdx = -1
          for (let pi = 0; pi < pieces.length; pi++) {
            const p = pieces[pi]
            if (p.kind !== 'moving') continue
            if (fs >= p.srcStartMs && fs <= p.srcEndMs) {
              foundIdx = pi
              break
            }
          }
          if (foundIdx < 0) continue // freeze outside source range — skip

          const original = pieces[foundIdx] as MovingPiece

          // Build pre, freeze, and post sub-pieces.
          const newPieces: Piece[] = []

          // pre-piece: [original.srcStartMs, fs)
          if (fs > original.srcStartMs) {
            const preSrcSpan = fs - original.srcStartMs
            const preOutDur = original.speed > 0 ? preSrcSpan / original.speed : 0
            newPieces.push({
              kind: 'moving',
              srcStartMs: original.srcStartMs,
              srcEndMs: fs,
              speed: original.speed,
              outDurMs: preOutDur
            })
          }

          // freeze piece
          newPieces.push({
            kind: 'freeze',
            sourceMs: fs,
            durationMs: freeze.durationMs
          })

          // post-piece: [fs, original.srcEndMs)
          if (fs < original.srcEndMs) {
            const postSrcSpan = original.srcEndMs - fs
            const postOutDur = original.speed > 0 ? postSrcSpan / original.speed : 0
            newPieces.push({
              kind: 'moving',
              srcStartMs: fs,
              srcEndMs: original.srcEndMs,
              speed: original.speed,
              outDurMs: postOutDur
            })
          }

          // Replace the original piece with the expanded sub-pieces.
          pieces.splice(foundIdx, 1, ...newPieces)
        }

        // --- Emit one VideoSegment per piece -----------------------------------
        let stepStartMs = ec.startMs
        const totalPieces = pieces.length

        for (let pi = 0; pi < totalPieces; pi++) {
          const piece = pieces[pi]
          const isFirst = pi === 0
          const isLast = pi === totalPieces - 1
          // isVeryFirstPiece: transition applies only to the very first piece
          // across all survivors of the original clip.
          const claimTransition = isVeryFirstPiece
          if (isVeryFirstPiece) isVeryFirstPiece = false

          if (piece.kind === 'freeze') {
            // ---------------------------------------------------------------
            // FREEZE PIECE: synthetic clip trimmed to ONE source frame.
            // ---------------------------------------------------------------
            const freezeStartMs = stepStartMs
            const freezeEndMs = stepStartMs + piece.durationMs

            // The source frame we hold: ec.trimInMs + piece.sourceMs
            const freezeTrimIn = ec.trimInMs + piece.sourceMs
            const freezeTrimOut = freezeTrimIn + ONE_FRAME_MS

            const syntheticFreeze: VideoAudioClip = {
              ...ec,
              startMs: freezeStartMs,
              endMs: freezeEndMs,
              trimInMs: freezeTrimIn,
              trimOutMs: freezeTrimOut,
              speed: 1,
              speedKeyframes: undefined,
              freezeFrames: undefined,
              // Transition belongs only to the very first piece of the original clip.
              transitionIn: claimTransition ? clip.transitionIn : undefined,
              fadeInMs: 0,
              fadeOutMs: 0,
            }

            // Transform keyframes during a freeze: the frozen frame must hold
            // STILL — synthesise two boundary keyframes both sampled at the
            // single pre-freeze source instant (stepStartMs on the original
            // timeline), so the result is a constant (non-animating) transform.
            if (hasTransformKeyframes(ec)) {
              const frozenT = getTransformAt(ec, freezeStartMs)
              syntheticFreeze.transformKeyframes = [
                { atMs: 0, transform: frozenT },
                { atMs: piece.durationMs, transform: frozenT }
              ]
              syntheticFreeze.transform = undefined
            }

            const inputIdx = inputs.length
            inputs.push(media.path)

            const captions = allCaptionClips.filter(
              (c) => c.endMs > freezeStartMs && c.startMs < freezeEndMs
            )

            layerSegments.push({
              clip: syntheticFreeze,
              track,
              inputIdx,
              captions,
              startMs: freezeStartMs,
              endMs: freezeEndMs,
              transitionInMs: claimTransition ? transitionInMs : 0,
              transitionKind: claimTransition ? transitionKind : 'none',
              layerIndex,
              freeze: { durationMs: piece.durationMs }
            })

            stepStartMs = freezeEndMs

          } else {
            // ---------------------------------------------------------------
            // MOVING PIECE: same logic as the pre-3.16 speed-curve path.
            // ---------------------------------------------------------------
            const stepEndMs = isLast
              ? ec.endMs // force last moving piece to ec.endMs (kills rounding drift)
              : stepStartMs + Math.round(piece.outDurMs)

            const syntheticClip: VideoAudioClip = {
              ...ec,
              startMs: stepStartMs,
              endMs: stepEndMs,
              trimInMs: ec.trimInMs + piece.srcStartMs,
              trimOutMs: ec.trimInMs + piece.srcEndMs,
              speed: piece.speed,
              speedKeyframes: undefined,
              freezeFrames: undefined,
              // Transition belongs only to the first piece.
              transitionIn: claimTransition ? clip.transitionIn : undefined,
              // Audio fades: first piece keeps fadeInMs, last keeps fadeOutMs.
              fadeInMs:  isFirst ? (ec.fadeInMs ?? 0)  : 0,
              fadeOutMs: isLast  ? (ec.fadeOutMs ?? 0) : 0,
            }

            // -----------------------------------------------------------------
            // Transform-keyframe re-basing — mirrors the original speed-curve
            // path exactly, so the spec §3a guarantee is preserved.
            // TransformKeyframe.atMs is clip-relative (from clip.startMs); the
            // survivor ec has correct startMs/endMs so the same localLo/localHi
            // logic works unchanged.
            // -----------------------------------------------------------------
            if (hasTransformKeyframes(ec)) {
              const localLo = stepStartMs - ec.startMs
              const localHi = stepEndMs - ec.startMs

              const tAtLo = getTransformAt(ec, ec.startMs + localLo)
              const tAtHi = getTransformAt(ec, ec.startMs + localHi)

              const interior = (ec.transformKeyframes as TransformKeyframe[]).filter(
                (kf) => kf.atMs > localLo && kf.atMs < localHi
              )

              const rawKfs: TransformKeyframe[] = [
                { atMs: localLo, transform: tAtLo },
                ...interior,
                { atMs: localHi, transform: tAtHi }
              ]
              const rebased: TransformKeyframe[] = rawKfs.map((kf) => ({
                atMs: kf.atMs - localLo,
                transform: kf.transform
              }))
              const deduped = rebased.filter(
                (kf, idx) => idx === 0 || kf.atMs !== rebased[idx - 1].atMs
              )

              if (deduped.length >= 2) {
                syntheticClip.transformKeyframes = deduped
                syntheticClip.transform = undefined
              } else {
                syntheticClip.transformKeyframes = undefined
                syntheticClip.transform = getTransformAt(
                  ec,
                  ec.startMs + Math.round((localLo + localHi) / 2)
                )
              }
            }

            // -----------------------------------------------------------------
            // Phase 3.30 — Volume-keyframe re-basing for video moving pieces.
            // VolumeKeyframe.atMs is clip-relative timeline ms (offset from
            // ec.startMs). This piece occupies [localLo, localHi] in that space.
            // Mirror the transform-keyframe re-basing above: keep interior kfs
            // plus nearest-neighbour boundary pins, re-base to [0, localHi-localLo].
            // -----------------------------------------------------------------
            if (Array.isArray(ec.volumeKeyframes) && ec.volumeKeyframes.length >= 2) {
              const localLo = stepStartMs - ec.startMs
              const localHi = stepEndMs - ec.startMs
              const vkfs = ec.volumeKeyframes as VolumeKeyframe[]

              const interior = vkfs.filter((kf) => kf.atMs > localLo && kf.atMs < localHi)

              const leftNeighbors = vkfs.filter((kf) => kf.atMs <= localLo)
              const leftPin = leftNeighbors.length > 0
                ? leftNeighbors.reduce((best, kf) => kf.atMs > best.atMs ? kf : best)
                : null
              const rightNeighbors = vkfs.filter((kf) => kf.atMs >= localHi)
              const rightPin = rightNeighbors.length > 0
                ? rightNeighbors.reduce((best, kf) => kf.atMs < best.atMs ? kf : best)
                : null

              const assembled: VolumeKeyframe[] = []
              if (leftPin !== null) assembled.push({ atMs: localLo, gainDb: leftPin.gainDb })
              for (const kf of interior) assembled.push(kf)
              if (rightPin !== null) assembled.push({ atMs: localHi, gainDb: rightPin.gainDb })

              const rebased = assembled.map((kf) => ({ atMs: kf.atMs - localLo, gainDb: kf.gainDb }))
              const vDeduped = rebased.filter(
                (kf, idx) => idx === 0 || kf.atMs !== rebased[idx - 1].atMs
              )
              syntheticClip.volumeKeyframes = vDeduped.length >= 2 ? vDeduped : undefined
            } else {
              syntheticClip.volumeKeyframes = undefined
            }

            const inputIdx = inputs.length
            inputs.push(media.path)

            const captions = allCaptionClips.filter(
              (c) => c.endMs > stepStartMs && c.startMs < stepEndMs
            )

            layerSegments.push({
              clip: syntheticClip,
              track,
              inputIdx,
              captions,
              startMs: stepStartMs,
              endMs: stepEndMs,
              transitionInMs: claimTransition ? transitionInMs : 0,
              transitionKind: claimTransition ? transitionKind : 'none',
              layerIndex
            })

            stepStartMs = stepEndMs
          }
        }
        } // end for (const ec of expandedClips)
      }
    }
    videoTrackLayers.push(layerSegments)
  }

  // Flat view (all segments, sorted globally by startMs then layerIndex for
  // determinism) — used for audio wiring and videoSegmentCount.
  const videoSegments: VideoSegment[] = videoTrackLayers
    .flat()
    .sort((a, b) => a.startMs - b.startMs || a.layerIndex - b.layerIndex)

  // Audio: collect from audio tracks AND from video-track clips (they carry
  // embedded audio). Each gets the same input index as the corresponding
  // video clip when possible — but for simplicity in MVP we re-add inputs.
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio')
  for (const t of audioTracks) {
    for (const c of t.clips) {
      if (!isMediaClip(c)) continue
      const media = project.media[c.mediaId]
      if (!media) continue

      if (!hasSpeedCurve(c) && !hasFreezeFrames(c) && !hasTranscriptDeletions(c)) {
        // Fast path: single audio segment — byte-identical to pre-3.10/3.16/3.17.
        const inputIdx = inputs.length
        inputs.push(media.path)
        audioSegments.push({ clip: c, track: t, inputIdx, fromVideoTrack: false })
      } else if (hasTranscriptDeletions(c) && !hasSpeedCurve(c) && !hasFreezeFrames(c)) {
        // -----------------------------------------------------------------------
        // AUDIO DELETION-ONLY PATH (Phase 3.17): decompose into survivor sub-clips.
        // Deleted gaps produce NO audio (no anullsrc filler) — unlike a freeze,
        // a deletion removes time entirely, so the next survivor's audio butts
        // directly against the previous one.
        // -----------------------------------------------------------------------
        const audioSurvivors = expandDeletedRanges(c)
        for (const sv of audioSurvivors) {
          const inputIdx = inputs.length
          inputs.push(media.path)
          audioSegments.push({ clip: sv, track: t, inputIdx, fromVideoTrack: false })
        }
      } else {
        // Expansion path: mirrors the video expansion above but for audio.
        // Phase 3.17 survivor pre-pass: expandDeletedRanges(c) returns [c] when
        // there are no deletions → byte-identical. Each survivor is then expanded
        // for speed/freeze below.
        // Moving pieces get real audio segments; freeze pieces get silence.
        const ONE_FRAME_MS_AUDIO = 1000 / exportFps

        const audioExpandedClips = expandDeletedRanges(c)
        for (const aec of audioExpandedClips) {

        const speedSegsAudio = resolveSpeedSegments(aec)
        const freezesAudio: FreezeFrame[] = getClipFreezeFrames(aec)

        type AudioMovingPiece = {
          kind: 'moving'
          srcStartMs: number
          srcEndMs: number
          speed: number
          outDurMs: number
        }
        type AudioFreezePiece = {
          kind: 'freeze'
          sourceMs: number
          durationMs: number
        }
        type AudioPiece = AudioMovingPiece | AudioFreezePiece

        const audioPieces: AudioPiece[] = speedSegsAudio.map((s) => ({
          kind: 'moving' as const,
          srcStartMs: s.srcStartMs,
          srcEndMs: s.srcEndMs,
          speed: s.speed,
          outDurMs: s.outDurMs
        }))

        for (const freeze of freezesAudio) {
          const fs = freeze.sourceMs
          let foundIdx = -1
          for (let pi = 0; pi < audioPieces.length; pi++) {
            const p = audioPieces[pi]
            if (p.kind !== 'moving') continue
            if (fs >= p.srcStartMs && fs <= p.srcEndMs) {
              foundIdx = pi
              break
            }
          }
          if (foundIdx < 0) continue
          const orig = audioPieces[foundIdx] as AudioMovingPiece
          const newPieces: AudioPiece[] = []
          if (fs > orig.srcStartMs) {
            const preSrcSpan = fs - orig.srcStartMs
            newPieces.push({
              kind: 'moving',
              srcStartMs: orig.srcStartMs,
              srcEndMs: fs,
              speed: orig.speed,
              outDurMs: orig.speed > 0 ? preSrcSpan / orig.speed : 0
            })
          }
          newPieces.push({ kind: 'freeze', sourceMs: fs, durationMs: freeze.durationMs })
          if (fs < orig.srcEndMs) {
            const postSrcSpan = orig.srcEndMs - fs
            newPieces.push({
              kind: 'moving',
              srcStartMs: fs,
              srcEndMs: orig.srcEndMs,
              speed: orig.speed,
              outDurMs: orig.speed > 0 ? postSrcSpan / orig.speed : 0
            })
          }
          audioPieces.splice(foundIdx, 1, ...newPieces)
        }

        let audioStepStartMs = aec.startMs
        const totalAudioPieces = audioPieces.length
        for (let pi = 0; pi < totalAudioPieces; pi++) {
          const piece = audioPieces[pi]
          const isFirst = pi === 0
          const isLast = pi === totalAudioPieces - 1

          if (piece.kind === 'freeze') {
            const freezeStartMs = audioStepStartMs
            const freezeEndMs = audioStepStartMs + piece.durationMs
            // Synthetic clip stub — only startMs is used for adelay in the
            // silence path; the audio segment chain will emit anullsrc instead
            // of reading a source stream.
            const syntheticFreezeAudio: VideoAudioClip = {
              ...aec,
              startMs: freezeStartMs,
              endMs: freezeEndMs,
              trimInMs: aec.trimInMs + piece.sourceMs,
              trimOutMs: aec.trimInMs + piece.sourceMs + ONE_FRAME_MS_AUDIO,
              speed: 1,
              speedKeyframes: undefined,
              freezeFrames: undefined,
              fadeInMs: 0,
              fadeOutMs: 0,
            }
            // No real input added — silence is synthesised by anullsrc.
            // inputIdx = -1 signals to buildAudioSegmentChain that this is a
            // freeze silence segment (no source stream to read).
            audioSegments.push({
              clip: syntheticFreezeAudio,
              track: t,
              inputIdx: -1,
              fromVideoTrack: false,
              freeze: { durationMs: piece.durationMs }
            })
            audioStepStartMs = freezeEndMs
          } else {
            const audioStepEndMs = isLast
              ? aec.endMs
              : audioStepStartMs + Math.round(piece.outDurMs)
            const syntheticAudio: VideoAudioClip = {
              ...aec,
              startMs: audioStepStartMs,
              endMs: audioStepEndMs,
              trimInMs: aec.trimInMs + piece.srcStartMs,
              trimOutMs: aec.trimInMs + piece.srcEndMs,
              speed: piece.speed,
              speedKeyframes: undefined,
              freezeFrames: undefined,
              fadeInMs:  isFirst ? (aec.fadeInMs ?? 0)  : 0,
              fadeOutMs: isLast  ? (aec.fadeOutMs ?? 0) : 0,
            }
            // -----------------------------------------------------------------
            // Phase 3.30 — Volume-keyframe re-basing for audio moving pieces.
            // VolumeKeyframe.atMs is clip-relative timeline ms (offset from
            // aec.startMs). This piece occupies [localLo, localHi].
            // -----------------------------------------------------------------
            if (Array.isArray(aec.volumeKeyframes) && aec.volumeKeyframes.length >= 2) {
              const localLo = audioStepStartMs - aec.startMs
              const localHi = audioStepEndMs - aec.startMs
              const vkfs = aec.volumeKeyframes as VolumeKeyframe[]

              const interior = vkfs.filter((kf) => kf.atMs > localLo && kf.atMs < localHi)

              const leftNeighbors = vkfs.filter((kf) => kf.atMs <= localLo)
              const leftPin = leftNeighbors.length > 0
                ? leftNeighbors.reduce((best, kf) => kf.atMs > best.atMs ? kf : best)
                : null
              const rightNeighbors = vkfs.filter((kf) => kf.atMs >= localHi)
              const rightPin = rightNeighbors.length > 0
                ? rightNeighbors.reduce((best, kf) => kf.atMs < best.atMs ? kf : best)
                : null

              const assembled: VolumeKeyframe[] = []
              if (leftPin !== null) assembled.push({ atMs: localLo, gainDb: leftPin.gainDb })
              for (const kf of interior) assembled.push(kf)
              if (rightPin !== null) assembled.push({ atMs: localHi, gainDb: rightPin.gainDb })

              const rebased = assembled.map((kf) => ({ atMs: kf.atMs - localLo, gainDb: kf.gainDb }))
              const vDeduped = rebased.filter(
                (kf, idx) => idx === 0 || kf.atMs !== rebased[idx - 1].atMs
              )
              syntheticAudio.volumeKeyframes = vDeduped.length >= 2 ? vDeduped : undefined
            } else {
              syntheticAudio.volumeKeyframes = undefined
            }

            const inputIdx = inputs.length
            inputs.push(media.path)
            audioSegments.push({ clip: syntheticAudio, track: t, inputIdx, fromVideoTrack: false })
            audioStepStartMs = audioStepEndMs
          }
        }
        } // end for (const aec of audioExpandedClips)
      }
    }
  }
  // Embedded audio from video clips. We reuse the same input index as the
  // corresponding video segment — the video clip's input #N also exposes
  // audio at [N:a:0] (if present). Speed-curve clips are already expanded
  // into synthetic constant-speed VideoSegments above, so we simply walk
  // videoSegments — each synthetic seg.clip is already a constant-speed clone
  // with the correct trimInMs/trimOutMs/speed, and its inputIdx matches the
  // video input for that step.
  //
  // Phase 3.16: freeze video segments have NO source audio — the held frame
  // is a still image. We skip them and instead emit a silence AudioSegment
  // (freeze marker) so the audio timeline stays length-matched.
  for (const seg of videoSegments) {
    if (seg.freeze) {
      // Freeze video segment — emit a silence AudioSegment rather than
      // reading the video input's audio stream.
      audioSegments.push({
        clip: seg.clip,
        track: seg.track,
        inputIdx: -1,
        fromVideoTrack: true,
        freeze: { durationMs: seg.freeze.durationMs }
      })
    } else {
      // Normal moving segment — same as before.
      audioSegments.push({
        clip: seg.clip,
        track: seg.track,
        inputIdx: seg.inputIdx,
        fromVideoTrack: true
      })
    }
  }

  return { videoTrackLayers, videoSegments, audioSegments, inputs }
}

/** Escape text for ffmpeg `drawtext` text= option. */
function escapeDrawtext(s: string): string {
  // ffmpeg drawtext quirks:
  //   - backslash is the escape char (must be first to avoid double-escaping)
  //   - colon separates options
  //   - single quote terminates the text arg
  //   - percent introduces format specifiers
  //   - newlines should be replaced with explicit \n inside the string
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ')
}

/**
 * Phase 3.23 — build drawtext border/shadow args from a caption style.
 *
 * Returns `{ borderArgs, shadowArgs }` — arrays of colon-delimited drawtext
 * key=value tokens to splice into a drawtext arg list.
 *
 * BYTE-IDENTICAL GATE: when getCaptionTextStroke / getCaptionTextShadow both
 * return null, BOTH arrays are empty → callers keep the legacy hardcoded
 * `borderw=2:bordercolor=black@0.7` string CHARACTER-FOR-CHARACTER unchanged.
 *
 * Color conversion: #rrggbb → 0xRRGGBB (ffmpeg drawtext hex format, uppercase).
 * Width scaling: style values are referenced against the 1920-px ref height;
 * we scale linearly by canvasHeight/1920 (same formula used for fontSize).
 *
 * Shadow note: drawtext's `shadowx/shadowy` parameters have no blur support.
 * A zero-offset glow (offsetX=0, offsetY=0) produces no drawtext shadow, which
 * is accepted as an ffmpeg limitation on the fallback path; the SVG path renders
 * the blur correctly.
 */
function captionDecorationDrawtextArgs(
  style: CaptionStyle,
  canvasHeight: number
): { borderArgs: string[]; shadowArgs: string[] } {
  const scale = canvasHeight / 1920

  const stroke = getCaptionTextStroke(style)
  const shadow = getCaptionTextShadow(style)

  const borderArgs: string[] = []
  const shadowArgs: string[] = []

  if (stroke) {
    // Convert #rrggbb → 0xRRGGBB (drop the '#', uppercase, prepend '0x').
    const hex = stroke.color.slice(1).toUpperCase()
    const scaledWidth = Math.round(stroke.width * scale)
    if (scaledWidth > 0) {
      borderArgs.push(`borderw=${scaledWidth}`, `bordercolor=0x${hex}`)
    }
  }

  if (shadow && (shadow.offsetX !== 0 || shadow.offsetY !== 0)) {
    const hex = shadow.color.slice(1).toUpperCase()
    const sx = Math.round(shadow.offsetX * scale)
    const sy = Math.round(shadow.offsetY * scale)
    shadowArgs.push(`shadowcolor=0x${hex}`, `shadowx=${sx}`, `shadowy=${sy}`)
  }

  return { borderArgs, shadowArgs }
}

/** Compute atempo filter chain for a given speed, in 0.5..2 range steps. */
function atempoChain(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0 || Math.abs(speed - 1) < 1e-3) {
    return ''
  }
  // atempo accepts 0.5..100 in modern ffmpeg, but 0.5..2 is the historical
  // safe range and tools like older HW assume that. Chain multiple if needed.
  let s = speed
  const parts: string[] = []
  while (s > 2) {
    parts.push('atempo=2.0')
    s /= 2
  }
  while (s < 0.5) {
    parts.push('atempo=0.5')
    s *= 2
  }
  parts.push(`atempo=${s.toFixed(4)}`)
  return parts.join(',')
}

/**
 * Phase 4 — per-clip noise-reduction filter string.
 *
 * Maps noiseReduction 1..100 → afftdn nr= 6.24..30.00 dB (linear interpolation
 * so strength 1 = gentle, 100 = aggressive). Returns '' when off so the caller
 * can unconditionally push the result and the parts array stays byte-identical
 * to pre-Phase-4 for clips with noiseReduction absent / 0.
 */
export function denoiseChain(clip: VideoAudioClip): string {
  const s = getClipDenoise(clip)
  if (s === null) return ''
  // Phase 3.69 — multi-stage noise chain (was: single afftdn).
  //   1. highpass = strip sub-80Hz rumble (AC hum / wind buffeting) the
  //      spectral denoiser otherwise has to flatten.
  //   2. afftdn   = main spectral subtraction (existing behavior).
  //   3. dynaudnorm = gentle gain leveling so the post-denoise floor isn't
  //      audibly louder than the original peaks. Strength scales the gain
  //      cap so weak settings stay close to identity.
  const nr = (6 + (s / 100) * 24).toFixed(2) // 6.24..30.00 dB
  const gainCap = (1.5 + (s / 100) * 1.5).toFixed(2) // 1.5..3.0
  return `highpass=f=80,afftdn=nr=${nr}:nf=-25,dynaudnorm=g=5:p=0.9:m=${gainCap}`
}

function retouchChain(clip: VideoAudioClip): string {
  return retouchToFfmpeg(getClipRetouch(clip))
}

// ---------------------------------------------------------------------------
// Phase 3.5 — keyframe expression compiler.
// ---------------------------------------------------------------------------

/**
 * Compile a sorted keyframe list into a piecewise-linear ffmpeg expression
 * string for a single transform property.
 *
 * The time variable `varName` (default `'t'`) is the filter-local time in
 * seconds. For zoompan the caller passes `'time'`; for rotate/pad/geq the
 * caller passes `'t'`.
 *
 * Output form (N keyframes at local seconds s0 < s1 < ... < s_{n-1}):
 *   if(lt(VAR,s0), v0,
 *     if(lt(VAR,s1), v0+(v1-v0)*(VAR-s0)/(s1-s0),
 *       ... v_{n-1}))
 *
 * Optimisation — when ALL interpolated values are equal the bare constant is
 * returned (no if() nesting). Callers use this to skip animated filters
 * entirely and fall back to the Phase 3 static snippet, keeping non-animated
 * properties free of the `geq`/`zoompan` performance cost.
 *
 * Guard: zero-width segments (duplicate timestamps) are skipped to prevent
 * divide-by-zero in the interpolation expression. The project arrives over IPC
 * unvalidated so this guard is safety-critical, not cosmetic.
 *
 * NOTE: MAX_KEYFRAMES_PER_CLIP=24 caps the nested-if depth at 23 levels — well
 * within ffmpeg's expression evaluator limits for typical usage.
 */
export function keyframeExpr(
  kfs: TransformKeyframe[],
  pick: (t: ClipTransform) => number,
  varName = 't'
): string {
  // Sort ascending and deduplicate zero-gap pairs defensively (store should
  // have already enforced MIN_KEYFRAME_GAP_MS >= 30, but IPC is untrusted).
  const sorted = [...kfs].sort((a, b) => a.atMs - b.atMs)

  // Build de-duplicated list: keep first occurrence when two keyframes are
  // within 1 ms (floating-point safe threshold).
  const deduped: TransformKeyframe[] = []
  for (const kf of sorted) {
    if (
      deduped.length === 0 ||
      kf.atMs - deduped[deduped.length - 1].atMs >= 1
    ) {
      deduped.push(kf)
    }
  }

  // Collect values.
  const vals = deduped.map((kf) => pick(kf.transform))
  const secs = deduped.map((kf) => kf.atMs / 1000)

  // Constant-skip: all values equal → bare constant.
  if (vals.every((v) => Math.abs(v - vals[0]) < 1e-9)) {
    return vals[0].toFixed(6)
  }

  // Build right-to-left nested if() expression.
  // Start from the final (hold-last) value, wrap in if(lt(...), interp, rest)
  // for each interval from the right.
  let expr = vals[vals.length - 1].toFixed(6)

  for (let i = deduped.length - 2; i >= 0; i--) {
    const s0 = secs[i]
    const s1 = secs[i + 1]
    const v0 = vals[i]
    const v1 = vals[i + 1]

    // Guard: skip zero-width segment (safety; should not occur after dedup).
    const span = s1 - s0
    if (span < 1e-6) continue

    // Linear interpolation: v0 + (v1-v0) * easing((VAR-s0)/(s1-s0))
    // Phase 3.54 — outgoing easing on deduped[i] wraps the raw [0,1]
    // fraction. Absent / 'linear' → identity (byte-identical pre-3.54 string).
    const dv = v1 - v0
    let interp: string
    if (Math.abs(dv) < 1e-9) {
      // Flat segment — avoid emitting a divide for zero slope.
      interp = v0.toFixed(6)
    } else {
      const fRawExpr = `(${varName}-${s0.toFixed(4)})/${span.toFixed(4)}`
      const easedF = easingToFfmpegFExpr(deduped[i].easing, fRawExpr)
      // Wrap in parens so the multiplication binds correctly when the eased
      // form is a multi-token expression (pow(...) / if(lt(...)) / etc.).
      interp = `${v0.toFixed(6)}+${dv.toFixed(6)}*(${easedF})`
    }

    // Hold-first before s0.
    if (i === 0) {
      expr = `if(lt(${varName},${s0.toFixed(4)}),${v0.toFixed(6)},if(lt(${varName},${s1.toFixed(4)}),${interp},${expr}))`
    } else {
      expr = `if(lt(${varName},${s1.toFixed(4)}),${interp},${expr})`
    }
  }

  return expr
}

// ---------------------------------------------------------------------------
// Phase 3.30 — Volume-envelope expression builder.
//
// Given a RESOLVED (>= 2, segment-local) VolumeKeyframe array, emits a
// nested-if piecewise-linear-in-dB expression over `t` (filter-local seconds)
// suitable for the ffmpeg `volume` filter's `expr=` parameter:
//
//   volume=expr='pow(10\,(DBEXPR)/20)':eval=frame
//
// where DBEXPR is the string returned here.
//
// Convention mirrors keyframeExpr:
//   - Hold-clamp before the first keyframe / after the last.
//   - Zero-width intervals are skipped (divide-by-zero guard).
//   - Flat segments emit a constant rather than a divide expression.
//
// `segDurSec` is currently accepted for documentation / future clamping but
// is not used in the expression itself (the hold-clamp after the last keyframe
// already handles t > last).
// ---------------------------------------------------------------------------
export function volumeKeyframeDbExpr(
  kfs: VolumeKeyframe[],
  _segDurSec: number
): string {
  // kfs is already resolved (sorted, deduped, clamped) by resolvedVolumeKeyframes.
  // Still guard defensively against zero-gap pairs (IPC is untrusted).
  const secs = kfs.map((kf) => kf.atMs / 1000)
  const dbs  = kfs.map((kf) => kf.gainDb)

  // Constant-skip optimisation: all dB values identical → bare constant.
  if (dbs.every((v) => Math.abs(v - dbs[0]) < 1e-9)) {
    return dbs[0].toFixed(6)
  }

  // Build right-to-left nested if() expression (hold-last after final kf).
  let expr = dbs[dbs.length - 1].toFixed(6)

  for (let i = kfs.length - 2; i >= 0; i--) {
    const s0 = secs[i]
    const s1 = secs[i + 1]
    const d0 = dbs[i]
    const d1 = dbs[i + 1]

    const span = s1 - s0
    // Guard: skip zero-width segment.
    if (span < 1e-6) continue

    const dd = d1 - d0
    let interp: string
    if (Math.abs(dd) < 1e-9) {
      // Flat segment — no divide needed.
      interp = d0.toFixed(6)
    } else {
      interp = `${d0.toFixed(6)}+${dd.toFixed(6)}*(t-${s0.toFixed(4)})/${span.toFixed(4)}`
    }

    if (i === 0) {
      // Hold-first before s0, then interpolate s0..s1, then hold-last (expr).
      expr = `if(lt(t,${s0.toFixed(4)}),${d0.toFixed(6)},if(lt(t,${s1.toFixed(4)}),${interp},${expr}))`
    } else {
      expr = `if(lt(t,${s1.toFixed(4)}),${interp},${expr})`
    }
  }

  return expr
}

// ---------------------------------------------------------------------------
// Phase 3.8 — SHARED transform sub-chain builder.
//
// Extracted from the inline code in `buildVideoSegmentChain` so that overlay
// clips can reuse the SAME filter fragment logic without code duplication.
//
// CRITICAL INVARIANT: calling this function for a VideoAudioClip with the
// same (clip, W, H, labelSuffix) as the old inline code produces a
// BYTE-IDENTICAL fragment string. The extraction is purely mechanical — the
// two branches (hasTransformKeyframes / static) are UNCHANGED from the
// original implementation; only the surrounding function boundary is new.
//
// Parameters:
//   clip          — the clip whose transform is rendered (media or overlay)
//   W, H          — canvas pixel dimensions
//   labelSuffix   — unique string used to name intermediate split/bg/content
//                   filter pads; for media clips pass String(inputIdx) to
//                   preserve byte-identical label names; for overlay clips
//                   pass a unique overlay-specific string.
//   fps           — canvas fps (required by zoompan in the keyframe path)
//
// Returns a filter fragment string that BEGINS with a comma (`,format=rgba,…`)
// or is EMPTY when the transform is identity. The caller appends it directly
// to the chain fragment it already has.
// ---------------------------------------------------------------------------
function buildTransformSubchain(
  clip: TransformableClip,
  W: number,
  H: number,
  labelSuffix: string,
  fps: number
): string {
  let fragment = ''

  if (hasTransformKeyframes(clip)) {
    // -----------------------------------------------------------------------
    // Phase 3.5 animated sub-chain — BYTE-IDENTICAL to the inline block.
    // -----------------------------------------------------------------------
    const clampField = (v: number, lo: number, hi: number): number =>
      Math.min(hi, Math.max(lo, v))

    const rawKfs = (clip.transformKeyframes as TransformKeyframe[])
    const kfs: TransformKeyframe[] = rawKfs
      .slice()
      .sort((a, b) => a.atMs - b.atMs)
      .map((kf) => ({
        atMs: Number.isFinite(kf.atMs) ? Math.max(0, kf.atMs) : 0,
        transform: {
          x: clampField(Number.isFinite(kf.transform.x) ? kf.transform.x : 0, MIN_TRANSFORM_OFFSET, MAX_TRANSFORM_OFFSET),
          y: clampField(Number.isFinite(kf.transform.y) ? kf.transform.y : 0, MIN_TRANSFORM_OFFSET, MAX_TRANSFORM_OFFSET),
          scale: clampField(Number.isFinite(kf.transform.scale) ? kf.transform.scale : 1, MIN_TRANSFORM_SCALE, MAX_TRANSFORM_SCALE),
          rotation: clampField(Number.isFinite(kf.transform.rotation) ? kf.transform.rotation : 0, MIN_TRANSFORM_ROTATION, MAX_TRANSFORM_ROTATION),
          opacity: clampField(Number.isFinite(kf.transform.opacity) ? kf.transform.opacity : 1, 0, 1)
        }
      }))

    const scaleExpr    = keyframeExpr(kfs, (t) => t.scale,    'time')
    const rotExpr      = keyframeExpr(kfs, (t) => t.rotation * Math.PI / 180, 't')
    const xExpr        = keyframeExpr(kfs, (t) => t.x * W,    't')
    const yExpr        = keyframeExpr(kfs, (t) => t.y * H,    't')
    const opacityExpr  = keyframeExpr(kfs, (t) => t.opacity,  't')

    const isConstExpr = (e: string): boolean => !e.includes('(')

    const firstT = kfs[0].transform
    const constScale    = firstT.scale
    const constRotRad   = firstT.rotation * Math.PI / 180
    const constX        = firstT.x
    const constY        = firstT.y
    const constOpacity  = firstT.opacity

    // 6a.
    fragment += `,format=rgba`

    // 6b. scale
    if (isConstExpr(scaleExpr)) {
      if (Math.abs(constScale - 1) > 1e-5) {
        fragment += `,scale=iw*${constScale.toFixed(6)}:ih*${constScale.toFixed(6)}`
        if (constScale > 1) {
          fragment += `,crop=${W}:${H}`
        } else {
          fragment += `,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`
        }
      }
    } else {
      fragment += `,zoompan=z='${scaleExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps}`
    }

    // 6c. rotation
    if (isConstExpr(rotExpr)) {
      if (Math.abs(constRotRad) > 1e-5) {
        fragment += `,rotate=${constRotRad.toFixed(6)}:c=black@0:ow=${W}:oh=${H}`
      }
    } else {
      fragment += `,rotate=a='${rotExpr}':c=black@0:ow=${W}:oh=${H}`
    }

    // 6d. translation
    if (isConstExpr(xExpr) && isConstExpr(yExpr)) {
      if (Math.abs(constX) > 1e-6 || Math.abs(constY) > 1e-6) {
        const xPx = Math.round(constX * W)
        const yPx = Math.round(constY * H)
        fragment += `,pad=${W}:${H}:${xPx}+(ow-iw)/2:${yPx}+(oh-ih)/2:color=black@0`
        fragment += `,crop=${W}:${H}:0:0`
      }
    } else {
      const splitLbl   = `xt_split_${labelSuffix}`
      const bgLbl      = `xt_bg_${labelSuffix}`
      const contentLbl = `xt_content_${labelSuffix}`
      const overlayX = `${xExpr}+(${W}-iw)/2`
      const overlayY = `${yExpr}+(${H}-ih)/2`
      fragment += `,split=2[${splitLbl}_bg][${splitLbl}_fg]`
      fragment += `;[${splitLbl}_bg]pad=${W}:${H}:0:0:color=black@0[${bgLbl}]`
      fragment += `;[${bgLbl}][${splitLbl}_fg]overlay=x='${overlayX}':y='${overlayY}'[${contentLbl}]`
      fragment += `;[${contentLbl}]null`
    }

    // 6e. opacity
    if (isConstExpr(opacityExpr)) {
      if (Math.abs(constOpacity - 1) > 1e-5) {
        fragment += `,colorchannelmixer=aa=${constOpacity.toFixed(6)}`
      }
    } else {
      fragment += `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${opacityExpr}*alpha(X,Y)'`
    }

  } else {
    // -----------------------------------------------------------------------
    // Phase 3 static sub-chain — BYTE-IDENTICAL to the inline block.
    // -----------------------------------------------------------------------
    const rawXform = getClipTransform(clip)
    const clampField = (v: number, lo: number, hi: number): number =>
      Math.min(hi, Math.max(lo, v))
    const xform = {
      x: clampField(rawXform.x, MIN_TRANSFORM_OFFSET, MAX_TRANSFORM_OFFSET),
      y: clampField(rawXform.y, MIN_TRANSFORM_OFFSET, MAX_TRANSFORM_OFFSET),
      scale: clampField(rawXform.scale, MIN_TRANSFORM_SCALE, MAX_TRANSFORM_SCALE),
      rotation: clampField(
        rawXform.rotation,
        MIN_TRANSFORM_ROTATION,
        MAX_TRANSFORM_ROTATION
      ),
      opacity: clampField(rawXform.opacity, 0, 1)
    }
    if (!isIdentityTransform(xform)) {
      const { x, y, scale, rotation, opacity } = xform
      // 6a.
      fragment += `,format=rgba`

      // 6b.
      if (Math.abs(scale - 1) > 1e-5) {
        fragment += `,scale=iw*${scale.toFixed(6)}:ih*${scale.toFixed(6)}`
        if (scale > 1) {
          fragment += `,crop=${W}:${H}`
        } else {
          fragment += `,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`
        }
      }

      // 6c.
      if (Math.abs(rotation) > 1e-5) {
        const rad = (rotation * Math.PI) / 180
        fragment += `,rotate=${rad.toFixed(6)}:c=black@0:ow=${W}:oh=${H}`
      }

      // 6d.
      if (Math.abs(x) > 1e-6 || Math.abs(y) > 1e-6) {
        const xPx = Math.round(x * W)
        const yPx = Math.round(y * H)
        fragment += `,pad=${W}:${H}:${xPx}+(ow-iw)/2:${yPx}+(oh-ih)/2:color=black@0`
        fragment += `,crop=${W}:${H}:0:0`
      }

      // 6e.
      if (Math.abs(opacity - 1) > 1e-5) {
        fragment += `,colorchannelmixer=aa=${opacity.toFixed(6)}`
      }
    }
  }

  return fragment
}

// ---------------------------------------------------------------------------
// Phase 3.11 — mosaic / blur region sub-chain builder.
//
// CRITICAL INVARIANT: `getClipBlurRegions(clip)` returns [] for any clip that
// has no blurRegions (absent, empty, or all-malformed) → this function returns
// '' → `fragment` in buildVideoSegmentChain stays byte-identical to pre-3.11.
//
// When regions ARE present the helper:
//   1. Continues the current unlabelled chain end with `split=2` (comma).
//   2. Per region: crop the patch, apply effect, optionally alpha-mask it as
//      an ellipse, then overlay back onto the base frame.
//   3. Terminates with `;[br_out_S_lastN]null` so that buildTransformSubchain
//      (which starts with `,format=rgba,...`) or the bare `[${out}]` label can
//      be appended cleanly — matching the xt_* path convention exactly.
//
// Label namespace: `br_*_${labelSuffix}_${i}` — never collides with
// pre/bg/main/xt_*/vN/vtrack*/vcomp* namespaces. `labelSuffix` =
// String(seg.inputIdx), globally unique per ffmpeg input.
// ---------------------------------------------------------------------------

/**
 * Build the mosaic/blur region sub-chain for a single clip.
 *
 * @param clip        — VideoAudioClip whose blurRegions are read via getClipBlurRegions.
 * @param W           — Canvas width in pixels.
 * @param H           — Canvas height in pixels.
 * @param labelSuffix — Globally unique suffix (String(seg.inputIdx)).
 * @param project     — Full project snapshot; used to resolve motionTrackId.
 * @returns A filter-fragment string to append to `fragment`, or '' when there
 *          are no regions (byte-identical invariant).
 */
function buildBlurRegionsSubchain(
  clip: VideoAudioClip,
  W: number,
  H: number,
  labelSuffix: string,
  project: Project
): string {
  const regions = getClipBlurRegions(clip)
  if (regions.length === 0) return ''

  let frag = ''
  // `prev` is the label of the current full-canvas frame at the start of each
  // region iteration. For region 0 we label the incoming unlabelled chain end
  // by using split=2 (comma-continuation) — the first [br_base_S_0] output
  // becomes `prev` for region 1, etc.
  let prev = ''

  for (let i = 0; i < regions.length; i++) {
    const region: BlurRegion = regions[i]
    const s = labelSuffix

    // --- pixel size (yuv420p even-alignment) — always fixed for the patch ---
    let rw = Math.round(region.w * W)
    let rh = Math.round(region.h * H)
    // Floor to even (yuv420p). Min 2.
    rw = Math.max(2, rw - (rw % 2))
    rh = Math.max(2, rh - (rh % 2))

    // -------------------------------------------------------------------------
    // Phase 3.13 — motion-track follow for blur regions.
    //
    // Gate: the region ONLY takes the time-varying path when ALL three hold:
    //   1. region.motionTrackId is set (non-empty string).
    //   2. findMotionTrack resolves it to an existing MotionTrack.
    //   3. The track has >= 2 points (getTrackPositionAt would return non-null).
    //
    // When ANY of those is false (no motionTrackId, dangling id, <2 points,
    // motionTracks absent entirely) → the legacy CONSTANT-coordinate path runs
    // VERBATIM — byte-identical to the pre-Phase-3.13 graph.
    // -------------------------------------------------------------------------
    let xExpr: string
    let yExpr: string

    const resolvedTrack: MotionTrack | null =
      region.motionTrackId
        ? findMotionTrack(project, region.motionTrackId)
        : null

    const useTrack =
      resolvedTrack !== null && resolvedTrack.points.length >= 2

    if (useTrack) {
      // -----------------------------------------------------------------------
      // Time-varying path: sample track.points at TRACK_EXPORT_STEP_MS spacing,
      // keeping at most MAX_TRACK_EXPORT_KEYFRAMES (first & last always kept).
      //
      // track.points are already sanitized + sorted ascending by atMs by
      // getClipMotionTracks (called inside findMotionTrack). resolvedTrack is
      // the sanitized copy.
      //
      // Decimation: walk the point array and emit one point per step bucket.
      // The step boundary is TRACK_EXPORT_STEP_MS ms from the previous emitted
      // point's atMs — this produces at most ceil(trackDurMs/STEP)+1 candidates,
      // then we cap to MAX_TRACK_EXPORT_KEYFRAMES by uniform sub-sampling if
      // needed.
      // -----------------------------------------------------------------------
      const pts: TrackPoint[] = resolvedTrack.points

      // --- Decimate ---
      const decimated: TrackPoint[] = [pts[0]]
      let lastEmittedMs = pts[0].atMs
      for (let pi = 1; pi < pts.length - 1; pi++) {
        if (pts[pi].atMs - lastEmittedMs >= TRACK_EXPORT_STEP_MS) {
          decimated.push(pts[pi])
          lastEmittedMs = pts[pi].atMs
        }
      }
      // Always include the last point.
      if (pts[pts.length - 1] !== decimated[decimated.length - 1]) {
        decimated.push(pts[pts.length - 1])
      }

      // --- Cap to MAX_TRACK_EXPORT_KEYFRAMES by uniform stride sub-sampling ---
      let sampled: TrackPoint[]
      if (decimated.length <= MAX_TRACK_EXPORT_KEYFRAMES) {
        sampled = decimated
      } else {
        // Uniform stride, always include first and last.
        const stride = (decimated.length - 1) / (MAX_TRACK_EXPORT_KEYFRAMES - 1)
        sampled = []
        for (let ki = 0; ki < MAX_TRACK_EXPORT_KEYFRAMES; ki++) {
          const idx = ki === MAX_TRACK_EXPORT_KEYFRAMES - 1
            ? decimated.length - 1
            : Math.round(ki * stride)
          sampled.push(decimated[idx])
        }
      }

      // --- Build TransformKeyframe-shaped objects for keyframeExpr.
      //
      // keyframeExpr works on TransformKeyframe[] + a picker (t: ClipTransform).
      // We synthesize fake TransformKeyframes whose `transform` carries:
      //   x → the time-varying TOP-LEFT pixel x for the blur patch
      //   y → the time-varying TOP-LEFT pixel y
      //
      // track point gives CENTER fraction (px, py) of the CANVAS.
      // Blur patch top-left = center - half patch size, clamped to canvas.
      //   topLeftX = px * W - rw/2,  clamped [0, W-rw]
      //   topLeftY = py * H - rh/2,  clamped [0, H-rh]
      //
      // We store these pre-computed pixel values in the fake ClipTransform's
      // `x` and `y` fields (picker just reads those directly — no further
      // scaling inside keyframeExpr).
      // -----------------------------------------------------------------------
      const fakeKfs: TransformKeyframe[] = sampled.map((pt) => {
        // For 'remove' (delogo) regions the box must never touch a frame edge
        // mid-animation — delogo aborts with "Invalid argument" if x=0 or the
        // box reaches W/H. Clamp to [1, W-rw-1] / [1, H-rh-1] instead of the
        // [0, W-rw] / [0, H-rh] used for mosaic/blur (byte-identical for those).
        const xLo = region.effect === 'remove' ? 1 : 0
        const yLo = region.effect === 'remove' ? 1 : 0
        const xHi = region.effect === 'remove' ? W - rw - 1 : W - rw
        const yHi = region.effect === 'remove' ? H - rh - 1 : H - rh
        const topLeftX = Math.min(xHi, Math.max(xLo, pt.x * W - rw / 2))
        const topLeftY = Math.min(yHi, Math.max(yLo, pt.y * H - rh / 2))
        return {
          atMs: pt.atMs,
          transform: {
            x: topLeftX,
            y: topLeftY,
            scale: 1,    // unused by pickers below
            rotation: 0, // unused
            opacity: 1   // unused
          }
        }
      })

      // keyframeExpr uses varName 't' (filter-local time in seconds, same as
      // the crop/overlay filter context in filter_complex).
      xExpr = keyframeExpr(fakeKfs, (t) => t.x, 't')
      yExpr = keyframeExpr(fakeKfs, (t) => t.y, 't')

      // If keyframeExpr returned a bare constant (all points identical x or y)
      // the expression is still valid and correct — ffmpeg evaluates it as a
      // constant, which is fine.
    } else {
      // -----------------------------------------------------------------------
      // Constant-coordinate path — UNCHANGED from pre-Phase-3.13.
      // Byte-identical for: no motionTrackId, dangling id, <2 points.
      // -----------------------------------------------------------------------
      const rx = Math.round(region.x * W)
      const ry = Math.round(region.y * H)
      xExpr = String(rx)
      yExpr = String(ry)
    }

    const baseLabel  = `br_base_${s}_${i}`
    const srcLabel   = `br_src_${s}_${i}`
    const cropLabel  = `br_crop_${s}_${i}`
    const patchLabel = `br_patch_${s}_${i}`
    const outLabel   = `br_out_${s}_${i}`

    // -------------------------------------------------------------------------
    // Phase 3.14 — object removal via delogo.
    //
    // delogo operates IN-PLACE on the full frame — it needs no split/crop/overlay
    // dance. It also ERRORS if any edge of its box touches a frame boundary
    // (x=0 or x+w=W etc. → ffmpeg "Invalid argument"). Safety:
    //   - clampBlurRegion already insets 'remove' regions by REMOVAL_REGION_EDGE_INSET
    //     in fractional space so that Math.round(coord * dim) rarely lands on 0 or dim.
    //   - We add a second integer-level clamp here as a defensive backstop in case
    //     Math.round nudges a fractional-inset value back onto an edge pixel.
    //
    // For motion-tracked 'remove' regions the fakeKfs build above already uses
    // [1, W-rw-1] / [1, H-rh-1] bounds (gated on effect==='remove') so every
    // keyframe pixel coordinate is safe.
    //
    // Shape is ignored — delogo is rectangle-only; an ellipse 'remove' region
    // just delogos its bounding rect.
    // Strength is ignored — delogo has no strength parameter.
    //
    // Label chain: delogo consumes the current `prev` (or the unlabelled chain
    // end on i===0 via comma-continuation) and produces `outLabel`, keeping the
    // same prev→outLabel invariant as the split/crop/overlay path. The `continue`
    // skips the rest of the loop body so no label collision occurs.
    // -------------------------------------------------------------------------
    if (region.effect === 'remove') {
      if (useTrack) {
        // Time-varying: xExpr/yExpr already use the inset-clamped fakeKfs values.
        // Wrap in quotes for the delogo filter (it accepts expressions via the F flag).
        const dxArg = `'${xExpr}'`
        const dyArg = `'${yExpr}'`
        if (i === 0) {
          frag += `,delogo=x=${dxArg}:y=${dyArg}:w=${rw}:h=${rh}:show=0[${outLabel}]`
        } else {
          frag += `;[${prev}]delogo=x=${dxArg}:y=${dyArg}:w=${rw}:h=${rh}:show=0[${outLabel}]`
        }
      } else {
        // Static: rx/ry come from Math.round — apply integer safety clamp so the
        // box stays >= 1px from every frame edge regardless of rounding.
        const rx = Math.round(region.x * W)
        const ry = Math.round(region.y * H)
        const dx = Math.min(W - rw - 1, Math.max(1, rx))
        const dy = Math.min(H - rh - 1, Math.max(1, ry))
        if (i === 0) {
          frag += `,delogo=x=${dx}:y=${dy}:w=${rw}:h=${rh}:show=0[${outLabel}]`
        } else {
          frag += `;[${prev}]delogo=x=${dx}:y=${dy}:w=${rw}:h=${rh}:show=0[${outLabel}]`
        }
      }
      prev = outLabel
      continue
    }

    // Step 1: split the current frame into base (keep) + source (to crop).
    if (i === 0) {
      // Comma-continuation: the unlabelled chain end feeds directly into split.
      frag += `,split=2[${baseLabel}][${srcLabel}]`
    } else {
      // prev = br_out_S_{i-1} — a labelled output from the previous overlay.
      frag += `;[${prev}]split=2[${baseLabel}][${srcLabel}]`
    }

    // Step 2: crop the patch out of the source copy.
    // When time-varying, xExpr/yExpr are ffmpeg t-expressions.
    // ffmpeg crop accepts expressions for x/y (4th and 5th positional args).
    // Format: crop=w:h:x:y — x/y must be quoted when they contain expressions.
    const xArg = useTrack ? `'${xExpr}'` : xExpr
    const yArg = useTrack ? `'${yExpr}'` : yExpr
    frag += `;[${srcLabel}]crop=${rw}:${rh}:${xArg}:${yArg}[${cropLabel}]`

    // Step 3: apply effect.
    if (region.effect === 'blur') {
      const radius = blurRegionBlurRadiusPx(region)
      frag += `;[${cropLabel}]boxblur=${radius}:1`
    } else {
      // mosaic: scale down (neighbor) then scale back up (neighbor).
      const block = blurRegionMosaicBlockPx(region, W, H)
      const mwPx = Math.max(1, Math.floor(rw / block))
      const mhPx = Math.max(1, Math.floor(rh / block))
      frag += `;[${cropLabel}]scale=${mwPx}:${mhPx}:flags=neighbor,scale=${rw}:${rh}:flags=neighbor`
    }

    // Step 4: ellipse alpha-mask (rectangle skips this — opaque patch).
    if (region.shape === 'ellipse') {
      // format=rgba so alpha channel is available, then geq paints alpha.
      // Commas inside geq function calls must be escaped as \, in filter_complex.
      // The ellipse test: (X - rw/2)^2 / (rw/2)^2 + (Y - rh/2)^2 / (rh/2)^2 <= 1
      frag +=
        `,format=rgba` +
        `,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)'` +
        `:a='if(lte(pow((X-${rw}/2)/(${rw}/2)\\,2)+pow((Y-${rh}/2)/(${rh}/2)\\,2)\\,1)\\,255\\,0)'`
    }

    // Close the effect chain with a label.
    frag += `[${patchLabel}]`

    // Step 5: overlay the processed patch back onto the base frame.
    // Same time-varying x/y expressions as the crop step.
    frag += `;[${baseLabel}][${patchLabel}]overlay=${xArg}:${yArg}:format=auto[${outLabel}]`

    prev = outLabel
  }

  // Terminate with ;[last_out]null so buildTransformSubchain (`,format=rgba,...`)
  // and/or the bare `[out]` label both append cleanly — matching the xt_* path.
  const lastOut = `br_out_${labelSuffix}_${regions.length - 1}`
  frag += `;[${lastOut}]null`

  return frag
}

/**
 * Build the per-clip video filter chain (excluding the xfade join).
 *
 * When `captionPngMap` is provided AND contains the caption's id, the
 * drawtext fallback is skipped for that caption — the PNG overlay path
 * handles it post-stitching in `stitchCaptions()`. Captions absent from the
 * map fall back to drawtext (this lets a mixed scenario work: e.g. sharp
 * succeeded for 3 of 5 captions, failed for 2 — those 2 still render via
 * drawtext rather than vanishing).
 *
 * `isBaseLayer` — when true (layerIndex === 0) the blurred-bg opaque canvas
 * subgraph is emitted (legacy behaviour, preserved exactly for single-track
 * projects). When false (upper layers) a transparent-pad canvas frame is used
 * instead so lower layers show through.
 */
function buildVideoSegmentChain(
  seg: VideoSegment,
  preset: MainPreset,
  captionPngMap?: CaptionPngMap,
  isBaseLayer = true,
  options: {
    hueSatAvailable?: boolean
    vidstabAvailable?: boolean
    deshakeAvailable?: boolean
    stabilizeTrfMap?: ReadonlyMap<string, string>
  } = {},
  project?: Project
): {
  /** Filter chain label (output pad name). */
  out: string
  /** Filter graph fragment ending with `[<out>]`. */
  fragment: string
} {
  const out = `v${seg.inputIdx}`

  // Phase 3.44 — resolve canvas background once for both FREEZE and NORMAL paths.
  // When `project` is absent (freeze-path shim supplies a minimal stub) or
  // `canvasBackground` is absent/invalid, getCanvasBackground returns { kind: 'blur' }
  // which routes to the BYTE-IDENTICAL legacy blur sub-chain below.
  const bg = getCanvasBackground(
    project ?? { tracks: [], media: {}, id: '', name: '', aspectRatio: '9:16', width: preset.width, height: preset.height, fps: preset.fps, createdAt: 0, updatedAt: 0 }
  )

  // -----------------------------------------------------------------------
  // Phase 3.16 — FREEZE SEGMENT path.
  // For a freeze segment we replace the normal trim+setpts+speed chain with
  // a one-frame trim + tpad=stop_mode=clone. ALL downstream filters (color
  // grading, fps normalization, crop, scale/pad, blur regions, transform)
  // run IDENTICALLY so the frozen frame is graded/positioned consistently.
  // -----------------------------------------------------------------------
  if (seg.freeze) {
    const freezeDurSec = seg.freeze.durationMs / 1000
    const srcFrameSec = seg.clip.trimInMs / 1000           // absolute source start of the one-frame window
    const oneFrameSec = (1000 / preset.fps) / 1000         // duration of one frame at export fps

    const freezeParts: string[] = []
    // Trim exactly one source frame at the held instant.
    freezeParts.push(`trim=start=${srcFrameSec.toFixed(4)}:duration=${oneFrameSec.toFixed(6)}`)
    freezeParts.push('setpts=PTS-STARTPTS')
    // Clone-pad that single frame out to the full freeze duration.
    freezeParts.push(`tpad=stop_mode=clone:stop_duration=${freezeDurSec.toFixed(4)}`)

    // Color grading chain (identical to normal path).
    const fpFreeze = filterPresetToFfmpeg(seg.clip.filterPreset, seg.clip.filterIntensity ?? 1)
    if (fpFreeze) freezeParts.push(fpFreeze)
    // Phase 3.79 — user LUT (.cube) follows the preset chain, before manual
    // colour adjust. Path is normalized to forward slashes (ffmpeg accepts
    // them on every platform) and any embedded single-quote is stripped
    // so the wrapping single-quotes can't break out of the filter_complex
    // token.
    const lutFreeze = seg.clip.lutPath
    if (
      typeof lutFreeze === 'string' &&
      lutFreeze.toLowerCase().endsWith('.cube')
    ) {
      const norm = lutFreeze.replace(/\\+/g, '/').replace(/'/g, '')
      freezeParts.push(`lut3d='${norm}'`)
    }
    const caFreeze = colorAdjustToFfmpeg(getClipColorAdjust(seg.clip))
    if (caFreeze) freezeParts.push(caFreeze)
    const cvFreeze = curvesToFfmpeg(getClipCurves(seg.clip))
    if (cvFreeze) freezeParts.push(cvFreeze)
    if (options.hueSatAvailable !== false) {
      const hsFreeze = hslToFfmpeg(getClipHsl(seg.clip))
      if (hsFreeze) freezeParts.push(hsFreeze)
    }
    // 2.8. RETOUCH / BEAUTY (Phase 3.21) — edge-preserving skin smoothing
    //      (smartblur, luma-only). Stacks AFTER all colour grading, BEFORE fps
    //      normalization + crop. smartblur is a core ffmpeg filter (no probe).
    //      CRITICAL INVARIANT: getClipRetouch returns null for an absent OR 0
    //      retouch → retouchToFfmpeg returns '' → the `if` is skipped → `freezeParts`
    //      stays byte-identical to the pre-Phase-3.21 graph.
    const rtFreeze = retouchToFfmpeg(getClipRetouch(seg.clip))
    if (rtFreeze) freezeParts.push(rtFreeze)
    // Phase 3.49 — VIDEO QUALITY ENHANCER (hqdn3d + unsharp). Stacks AFTER
    // retouch, BEFORE filmLook (so the enhanced detail is what tone/grain
    // composites on top of). BYTE-IDENTICAL GATE: null/0 → '' → skipped.
    const enFreeze = enhanceToFfmpeg(getClipEnhance(seg.clip))
    if (enFreeze) freezeParts.push(enFreeze)
    // FILM LOOK (Phase 3.37) — faded tone + vignette + grain. Stacks AFTER all
    // colour grading + retouch, BEFORE fps normalization: tone joins the grade,
    // vignette next, grain LAST so nothing blurs it away. vignette + noise are
    // core ffmpeg filters (no probe needed).
    // BYTE-IDENTICAL GATE: getFilmLook returns null for an absent OR neutral look
    // → filmLookToFfmpeg returns [] → nothing pushed → `freezeParts` byte-identical.
    for (const f of filmLookToFfmpeg(getFilmLook(seg.clip))) freezeParts.push(f)
    // Phase 3.51 — VISUAL EFFECT (glitch/VHS/dream/dual-tone/etc). Stacks
    // AFTER filmLook (effect layered on top of tone+vignette+grain),
    // BEFORE fps + crop. BYTE-IDENTICAL GATE: null/'none' → '' → skipped.
    const vfxFreeze = visualEffectToFfmpeg(getVisualEffect(seg.clip))
    if (vfxFreeze) freezeParts.push(vfxFreeze)
    freezeParts.push(`fps=${preset.fps}`)
    const cropRectFreeze = getClipCropRect(seg.clip)
    if (cropRectFreeze) {
      const cw = cropRectFreeze.w.toFixed(6)
      const ch = cropRectFreeze.h.toFixed(6)
      const cx = cropRectFreeze.x.toFixed(6)
      const cy = cropRectFreeze.y.toFixed(6)
      freezeParts.push(
        `crop=w=floor(iw*${cw}/2)*2:h=floor(ih*${ch}/2)*2:x=iw*${cx}:y=ih*${cy}`
      )
    }

    const W = preset.width
    const H = preset.height
    const labelIn = `pre${seg.inputIdx}`
    const freezePreChain = freezeParts.join(',')

    let freezeFragment: string
    if (isBaseLayer) {
      const labelBg = `bg${seg.inputIdx}`
      const labelMain = `main${seg.inputIdx}`
      if (bg.kind === 'blur') {
        // BYTE-IDENTICAL legacy blur sub-chain (Phase 3.44 gate).
        freezeFragment =
          `[${seg.inputIdx}:v]${freezePreChain}[${labelIn}];` +
          `[${labelIn}]split=2[${labelMain}src][${labelBg}src];` +
          `[${labelBg}src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:1,eq=brightness=-0.2[${labelBg}];` +
          `[${labelMain}src]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0[${labelMain}];` +
          `[${labelBg}][${labelMain}]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1`
      } else {
        // Solid-color backdrop — drop split+boxblur; use a color= source.
        const cArg = canvasBackgroundToFfmpegColor(bg)
        freezeFragment =
          `[${seg.inputIdx}:v]${freezePreChain}[${labelIn}];` +
          `color=c=${cArg}:s=${W}x${H}:d=${freezeDurSec.toFixed(4)}:r=${preset.fps}[${labelBg}];` +
          `[${labelIn}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0[${labelMain}];` +
          `[${labelBg}][${labelMain}]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1`
      }
    } else {
      freezeFragment =
        `[${seg.inputIdx}:v]${freezePreChain}[${labelIn}];` +
        `[${labelIn}]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1`
    }

    // Captions during freeze (drawtext path only — static captions are valid
    // over a held frame exactly as over a normal segment).
    const freezeSegDurSec = Math.max(0.001, freezeDurSec)
    if (seg.captions.length > 0) {
      const drawtexts: string[] = []
      for (const cap of seg.captions) {
        if (captionPngMap && captionPngMap.has(cap.id)) continue
        const localStart = Math.max(0, (cap.startMs - seg.startMs) / 1000)
        const localEnd = Math.min(freezeSegDurSec, (cap.endMs - seg.startMs) / 1000)
        if (localEnd <= localStart) continue
        const txt = escapeDrawtext(cap.spans.map((sp) => sp.text).join(' ').slice(0, 500))
        if (!txt) continue
        const fontSize = Math.max(16, Math.round((cap.style.fontSize * H) / 1920))
        const yPx = Math.round((1 - (1 - cap.style.yPosition)) * H - fontSize)
        const yExpr = `${Math.max(0, Math.min(H - fontSize, yPx))}`
        const hasBox = cap.style.background === 'solid' || cap.style.background === 'pill'
        const { borderArgs: freezeBorderArgs, shadowArgs: freezeShadowArgs } =
          captionDecorationDrawtextArgs(cap.style, H)
        const drawArgs = [
          `text='${txt}'`, `fontsize=${fontSize}`, `fontcolor=white`,
          ...(freezeBorderArgs.length > 0 ? freezeBorderArgs : [`borderw=2`, `bordercolor=black@0.7`]),
          `x=(w-text_w)/2`, `y=${yExpr}`,
          `enable='between(t,${localStart.toFixed(3)},${localEnd.toFixed(3)})'`
        ]
        if (freezeShadowArgs.length > 0) drawArgs.push(...freezeShadowArgs)
        if (hasBox) {
          const bgSize = getCaptionBackgroundSize(cap.style)
          const extraPx = Math.round(Math.max(bgSize.heightFrac * H, bgSize.widthFrac * W) / 2)
          const boxborderw = 10 + extraPx
          drawArgs.push(`box=1`, `boxcolor=black@0.55`, `boxborderw=${boxborderw}`)
        }
        drawtexts.push(`drawtext=${drawArgs.join(':')}`)
      }
      if (drawtexts.length > 0) {
        freezeFragment += ',' + drawtexts.join(',')
      }
    }

    // Blur regions + transform sub-chain (identical to normal path).
    freezeFragment += buildBlurRegionsSubchain(
      seg.clip, W, H, String(seg.inputIdx),
      project ?? { tracks: [], media: {}, id: '', name: '', aspectRatio: '9:16', width: W, height: H, fps: 30, createdAt: 0, updatedAt: 0 }
    )
    freezeFragment += buildTransformSubchain(seg.clip, W, H, String(seg.inputIdx), preset.fps)
    freezeFragment += `[${out}]`
    return { out, fragment: freezeFragment }
  }

  // -----------------------------------------------------------------------
  // NORMAL (non-freeze) path — unchanged from pre-3.16.
  // -----------------------------------------------------------------------
  const speed = seg.clip.speed ?? 1
  const segDurSec = Math.max(0.001, (seg.endMs - seg.startMs) / 1000)
  const trimInSec = seg.clip.trimInMs / 1000
  // source-time duration consumed
  const srcDurSec = (segDurSec * speed)

  const parts: string[] = []
  // 1. Trim the source window. We use the `trim=` filter (not -ss) since the
  //    filter graph needs explicit cut points after we've already mapped the
  //    input. setpts resets the PTS so frames start at 0.
  parts.push(`trim=start=${trimInSec.toFixed(4)}:duration=${srcDurSec.toFixed(4)}`)
  parts.push('setpts=PTS-STARTPTS')
  // Phase 3.19 — reverse the TRIMMED window.
  // Gated on isClipReversed → a forward clip never adds these filters, so
  // `parts` stays byte-identical to pre-3.19 for any non-reversed clip.
  // `reverse` buffers only the trimmed window (already cut by `trim` above).
  // An explicit `setpts=PTS-STARTPTS` follows because `reverse` re-orders
  // frames but does not re-base PTS to 0. The filter runs BEFORE the speed
  // `setpts` so we reverse at natural rate, then time-scale.
  // Image clips (kind === 'image') are a looped single frame — `reverse` on a
  // one-frame input is a harmless no-op, but we skip it cleanly when the media
  // kind is readily available via `project.media`.
  if (isClipReversed(seg.clip)) {
    const mediaKind = project?.media[seg.clip.mediaId]?.kind
    if (mediaKind !== 'image') {
      parts.push('reverse')
      parts.push('setpts=PTS-STARTPTS')
    }
  }
  // Phase 3.38 — VIDEO STABILIZATION. Inserted AFTER trim+reverse (natural
  // rate) and BEFORE the speed setpts so motion is analysed at native playback
  // rate, then time-warped. FREEZE SEGMENTS never reach this path.
  // BYTE-IDENTICAL GATE: getClipStabilize returns null for an absent / 0
  // stabilize value → nothing pushed → `parts` byte-identical to pre-3.38.
  {
    const stab = getClipStabilize(seg.clip)
    if (stab !== null) {
      if (options.vidstabAvailable && options.stabilizeTrfMap) {
        const trf = options.stabilizeTrfMap.get(seg.clip.id)
        if (trf) {
          const f = stabilizeToFfmpeg(stab, 'vidstab', trf)
          if (f) parts.push(f)
        }
      } else if (options.deshakeAvailable) {
        const f = stabilizeToFfmpeg(stab, 'deshake')
        if (f) parts.push(f)
      }
      // Neither available → silent no-op (byte-identical gate still holds
      // because getClipStabilize===null callers never reach this block).
    }
  }
  if (Math.abs(speed - 1) > 1e-3) {
    parts.push(`setpts=PTS/${speed.toFixed(4)}`)
  }
  // 1.5. CHROMA KEY. Cuts the screen color to alpha BEFORE color grading so
  //      the picked color is still its raw value (a graded green is still
  //      "green-ish" but the similarity tolerance was calibrated against the
  //      raw source). `format=yuva420p` first so chromakey has an alpha
  //      channel to write into; downstream filters tolerate yuva420p and
  //      the final encode reconverts to yuv420p anyway. Absent / disabled
  //      → no-op (byte-identical legacy graph).
  const ck = getChromaKey(seg.clip.chromaKey)
  if (ck) {
    parts.push('format=yuva420p')
    parts.push(
      `chromakey=color=${chromaKeyColorToFfmpeg(ck.color)}:similarity=${ck.similarity.toFixed(3)}:blend=${ck.blend.toFixed(3)}`
    )
  }
  // 2. Filter preset (eq/hue chain).
  const fp = filterPresetToFfmpeg(seg.clip.filterPreset, seg.clip.filterIntensity ?? 1)
  if (fp) parts.push(fp)
  // 2.4. USER LUT (Phase 3.79). `lut3d=PATH` after the preset chain so the
  //      preset look can be augmented by the LUT, and BEFORE manual color
  //      adjust so the user's sliders still bite on the LUT-graded image.
  //      Path is forward-slashed (ffmpeg accepts on every platform) and
  //      single-quote-stripped so the wrapping quotes can't escape the
  //      filter_complex token. Absent / non-.cube → no-op (byte-identical).
  const lutPath = seg.clip.lutPath
  if (
    typeof lutPath === 'string' &&
    lutPath.toLowerCase().endsWith('.cube')
  ) {
    // Collapse one-or-more consecutive backslashes to a single forward
    // slash so Windows paths (`C:\\luts\\look.cube` after json round-trip)
    // come out as `C:/luts/look.cube` rather than `C://luts//look.cube`.
    const norm = lutPath.replace(/\\+/g, '/').replace(/'/g, '')
    parts.push(`lut3d='${norm}'`)
  }
  // 2.5. MANUAL COLOR ADJUST (Phase 3.7). Stacks AFTER the filter preset
  //      (preset look first, manual brightness/contrast/saturation/temperature
  //      second) — same order as the PreviewCanvas CSS composition.
  //      CRITICAL INVARIANT: getClipColorAdjust returns null for an absent OR
  //      neutral adjust → colorAdjustToFfmpeg returns '' → the `if` is skipped
  //      and `parts` stays byte-identical to the pre-Phase-3.7 graph.
  const ca = colorAdjustToFfmpeg(getClipColorAdjust(seg.clip))
  if (ca) parts.push(ca)
  // 2.6. TONE CURVES (Phase 3.12). Stacks AFTER manual color-adjust, BEFORE
  //      fps normalization. CRITICAL INVARIANT: getClipCurves returns null for
  //      an absent OR all-identity curve set → curvesToFfmpeg returns '' → the
  //      `if` is skipped and `parts` stays byte-identical to the pre-Phase-3.12
  //      graph.
  const cv = curvesToFfmpeg(getClipCurves(seg.clip))
  if (cv) parts.push(cv)
  // 2.7. HSL SECONDARY GRADING (Phase 3.12). Requires ffmpeg's `huesaturation`
  //      filter — probe-gated; when absent, HSL is silently omitted from export
  //      (curves are unaffected). Same byte-identical invariant: getClipHsl
  //      returns null for absent/neutral.
  if (options.hueSatAvailable !== false) {
    const hs = hslToFfmpeg(getClipHsl(seg.clip))
    if (hs) parts.push(hs)
  }
  // 2.8. RETOUCH / BEAUTY (Phase 3.21) — edge-preserving skin smoothing
  //      (smartblur, luma-only). Stacks AFTER all colour grading, BEFORE fps
  //      normalization + crop. smartblur is a core ffmpeg filter (no probe).
  //      CRITICAL INVARIANT: getClipRetouch returns null for an absent OR 0
  //      retouch → retouchToFfmpeg returns '' → the `if` is skipped → `parts`
  //      stays byte-identical to the pre-Phase-3.21 graph.
  const rt = retouchToFfmpeg(getClipRetouch(seg.clip))
  if (rt) parts.push(rt)
  // Phase 3.49 — VIDEO QUALITY ENHANCER (hqdn3d + unsharp). Stacks AFTER
  // retouch, BEFORE filmLook. BYTE-IDENTICAL GATE: null/0 → '' → skipped.
  const en = enhanceToFfmpeg(getClipEnhance(seg.clip))
  if (en) parts.push(en)
  // FILM LOOK (Phase 3.37) — faded tone + vignette + grain. Stacks AFTER all
  // colour grading + retouch, BEFORE fps normalization: tone joins the grade,
  // vignette next, grain LAST so nothing blurs it away. vignette + noise are
  // core ffmpeg filters (no probe needed).
  // BYTE-IDENTICAL GATE: getFilmLook returns null for an absent OR neutral look
  // → filmLookToFfmpeg returns [] → nothing pushed → `parts` byte-identical.
  for (const f of filmLookToFfmpeg(getFilmLook(seg.clip))) parts.push(f)
  // Phase 3.51 — VISUAL EFFECT (glitch/VHS/dream/etc). Stacks AFTER filmLook,
  // BEFORE fps + crop. BYTE-IDENTICAL GATE: null/'none' → '' → skipped.
  const vfx = visualEffectToFfmpeg(getVisualEffect(seg.clip))
  if (vfx) parts.push(vfx)
  // 3. fps normalization (so xfade durations line up cleanly, and all layers
  //    share the same timebase before overlay).
  parts.push(`fps=${preset.fps}`)

  // 3.5. SOURCE CROP (Phase 3.6). crop samples the source frame; it MUST run
  //      before the step-4 aspect-fit + blurred-bg pad so the blurred gutters
  //      and the contain-fit both derive from the cropped region.
  //      CRITICAL INVARIANT: getClipCropRect returns null for an absent OR
  //      identity crop — the `if` is skipped and `parts` stays byte-identical.
  const cropRect = getClipCropRect(seg.clip)
  if (cropRect) {
    const cw = cropRect.w.toFixed(6)
    const ch = cropRect.h.toFixed(6)
    const cx = cropRect.x.toFixed(6)
    const cy = cropRect.y.toFixed(6)
    // floor(iw*w/2)*2 → even width (yuv420p safeguard); same for height.
    parts.push(
      `crop=w=floor(iw*${cw}/2)*2:h=floor(ih*${ch}/2)*2:x=iw*${cx}:y=ih*${cy}`
    )
  }

  const W = preset.width
  const H = preset.height
  const labelIn = `pre${seg.inputIdx}`
  const preChain = parts.join(',')

  let fragment: string

  if (isBaseLayer) {
    // 4-BASE. Aspect-correct scale + canvas-backdrop pad. Two-stage subgraph:
    //   main (object-fit: contain) and bg (backdrop) merged via overlay.
    //   Phase 3.44: bg.kind selects blur (legacy) or solid-color backdrop.
    const labelBg = `bg${seg.inputIdx}`
    const labelMain = `main${seg.inputIdx}`

    if (bg.kind === 'blur') {
      // BYTE-IDENTICAL legacy blur sub-chain (Phase 3.44 gate).
      fragment =
        `[${seg.inputIdx}:v]${preChain}[${labelIn}];` +
        `[${labelIn}]split=2[${labelMain}src][${labelBg}src];` +
        `[${labelBg}src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:1,eq=brightness=-0.2[${labelBg}];` +
        `[${labelMain}src]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0[${labelMain}];` +
        `[${labelBg}][${labelMain}]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1`
    } else {
      // Solid-color backdrop — drop split+boxblur; use a color= source.
      const cArg = canvasBackgroundToFfmpegColor(bg)
      fragment =
        `[${seg.inputIdx}:v]${preChain}[${labelIn}];` +
        `color=c=${cArg}:s=${W}x${H}:d=${segDurSec.toFixed(4)}:r=${preset.fps}[${labelBg}];` +
        `[${labelIn}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0[${labelMain}];` +
        `[${labelBg}][${labelMain}]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1`
    }
  } else {
    // 4-UPPER. Transparent-pad canvas frame: scale to contain, then pad with
    // transparent gutters to fill canvas dimensions. Lower layers show through
    // the transparent area.
    fragment =
      `[${seg.inputIdx}:v]${preChain}[${labelIn}];` +
      `[${labelIn}]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1`
  }

  // 5. Caption drawtext overlays. Each caption clip becomes one drawtext
  //    filter that's only enabled during its time-on-timeline (relative to
  //    this segment after we reset PTS, segment_t = timeline_t - clip.startMs).
  //    Captions handled by the PNG-overlay path (captionPngMap) are skipped
  //    here — they'll be composited onto the stitched final video.
  //    §3.5: this drawtext fallback path does NOT animate — captions render
  //    statically here regardless of clip.animation. Animation is exclusive
  //    to the PNG-overlay path in stitchCaptions.
  //
  //    NOTE: drawtext captions are applied BEFORE the transform sub-chain so
  //    they move and scale with the clip. This matches the mental model that
  //    captions "belong" to the clip content.
  if (seg.captions.length > 0) {
    const drawtexts: string[] = []
    for (const cap of seg.captions) {
      if (captionPngMap && captionPngMap.has(cap.id)) continue
      // Compute the visible window relative to this segment's local time (0..segDurSec).
      const localStart = Math.max(0, (cap.startMs - seg.startMs) / 1000)
      const localEnd = Math.min(segDurSec, (cap.endMs - seg.startMs) / 1000)
      if (localEnd <= localStart) continue
      const txt = escapeDrawtext(
        cap.spans.map((sp) => sp.text).join(' ').slice(0, 500)
      )
      if (!txt) continue
      // Scale font from style.fontSize (referenced against a 1920-tall canvas).
      const fontSize = Math.max(
        16,
        Math.round((cap.style.fontSize * H) / 1920)
      )
      // Vertical position: yPosition is 0(top)..1(bottom). Anchor is baseline.
      const yPx = Math.round((1 - (1 - cap.style.yPosition)) * H - fontSize)
      const yExpr = `${Math.max(0, Math.min(H - fontSize, yPx))}`
      // Background pill (box=1) — approximation of the React preview.
      const hasBox = cap.style.background === 'solid' || cap.style.background === 'pill'
      const { borderArgs: segBorderArgs, shadowArgs: segShadowArgs } =
        captionDecorationDrawtextArgs(cap.style, H)
      const drawArgs = [
        `text='${txt}'`,
        `fontsize=${fontSize}`,
        `fontcolor=white`,
        ...(segBorderArgs.length > 0 ? segBorderArgs : [`borderw=2`, `bordercolor=black@0.7`]),
        `x=(w-text_w)/2`,
        `y=${yExpr}`,
        `enable='between(t,${localStart.toFixed(3)},${localEnd.toFixed(3)})'`
      ]
      if (segShadowArgs.length > 0) drawArgs.push(...segShadowArgs)
      if (hasBox) {
        const bgSize = getCaptionBackgroundSize(cap.style)
        const extraPx = Math.round(Math.max(bgSize.heightFrac * H, bgSize.widthFrac * W) / 2)
        const boxborderw = 10 + extraPx
        drawArgs.push(`box=1`, `boxcolor=black@0.55`, `boxborderw=${boxborderw}`)
      }
      drawtexts.push(`drawtext=${drawArgs.join(':')}`)
    }
    if (drawtexts.length > 0) {
      fragment += ',' + drawtexts.join(',')
    }
  }

  // 5.5. MOSAIC / BLUR REGIONS (Phase 3.11 / 3.13). Runs on the canvas-sized
  //      frame AFTER aspect-fit so canvas-relative region coords match the
  //      preview, and BEFORE the transform sub-chain so a region moves WITH
  //      the clip.
  //      INVARIANT: getClipBlurRegions returns [] for a clip with no regions →
  //      buildBlurRegionsSubchain returns '' → `fragment` stays byte-identical.
  //      Phase 3.13: `project` is threaded through so bound blur regions can
  //      resolve their motionTrackId. When project is undefined (should not
  //      happen in practice — buildVideoSegmentChain is always called from
  //      stitchVideoTrack which receives project) we pass a minimal sentinel
  //      that makes findMotionTrack return null → constant-coord fallback.
  fragment += buildBlurRegionsSubchain(
    seg.clip,
    W,
    H,
    String(seg.inputIdx),
    project ?? { tracks: [], media: {}, id: '', name: '', aspectRatio: '9:16', width: W, height: H, fps: 30, createdAt: 0, updatedAt: 0 }
  )

  // 6. Transform sub-chain — delegated to the shared helper so overlay clips
  //    can reuse EXACTLY the same logic. For media clips labelSuffix =
  //    String(seg.inputIdx), which reproduces the BYTE-IDENTICAL intermediate
  //    pad names (`xt_split_N`, `xt_bg_N`, `xt_content_N`) that the original
  //    inline code produced. fps is passed through so zoompan's fps= matches.
  fragment += buildTransformSubchain(seg.clip, W, H, String(seg.inputIdx), preset.fps)

  fragment += `[${out}]`
  return { out, fragment }
}

/** Build the per-clip audio filter chain (returns the output label). */
function buildAudioSegmentChain(
  seg: AudioSegment,
  options: { inputHasAudio?: (inputIdx: number) => boolean; denoiseAvailable?: boolean; deEsserAvailable?: boolean } = {}
): { out: string; fragment: string } | null {
  // -----------------------------------------------------------------------
  // Phase 3.16 — FREEZE SILENCE path.
  // A freeze AudioSegment has no source stream (inputIdx === -1); we emit an
  // anullsrc silence block of the correct duration placed on the timeline via
  // adelay. The output label uses a synthetic index so it never collides with
  // real input indices.
  // -----------------------------------------------------------------------
  if (seg.freeze) {
    const freezeDurSec = seg.freeze.durationMs / 1000
    const startDelayMs = seg.clip.startMs
    // Build a unique output label from clip id + startMs (no real inputIdx).
    const out = `a${seg.fromVideoTrack ? 'v' : 't'}frz_${seg.clip.id.slice(-6)}_${startDelayMs}`
    const parts: string[] = []
    // anullsrc is a SOURCE filter — no `[N:a:0]` input pad.
    // atrim caps the generated silence to exactly the freeze duration.
    parts.push(`anullsrc=channel_layout=stereo:sample_rate=44100`)
    parts.push(`atrim=duration=${freezeDurSec.toFixed(4)}`)
    parts.push('asetpts=PTS-STARTPTS')
    if (startDelayMs > 0) {
      parts.push(`adelay=${startDelayMs}|${startDelayMs}`)
    }
    parts.push('aformat=channel_layouts=stereo:sample_rates=44100')
    // anullsrc needs no input pad — write the chain without a leading `[N:a:0]`.
    const fragment = `${parts.join(',')}[${out}]`
    return { out, fragment }
  }

  // -----------------------------------------------------------------------
  // NORMAL (non-freeze) path — unchanged from pre-3.16.
  // -----------------------------------------------------------------------

  // ffmpeg 6 rejects the `[N:a:0?]` syntax in filter_complex — see top-of-file
  // comment near `probeHasAudio`. We instead skip the segment if its source
  // input has no audio stream, and use a plain `[N:a:0]` specifier otherwise.
  const hasAudio = options.inputHasAudio ? options.inputHasAudio(seg.inputIdx) : true
  if (!hasAudio) return null

  const out = `a${seg.fromVideoTrack ? 'v' : 't'}${seg.inputIdx}_${seg.clip.id.slice(-6)}`
  const speed = seg.clip.speed ?? 1
  const segDurSec = Math.max(0.001, (seg.clip.endMs - seg.clip.startMs) / 1000)
  const trimInSec = seg.clip.trimInMs / 1000
  const srcDurSec = segDurSec * speed
  const startDelayMs = seg.clip.startMs // delay on the FINAL timeline

  // Use a plain `N:a:0` specifier (no `?`). Audio presence was checked above;
  // for inputs without audio we never reach this point.
  const streamSpec = `${seg.inputIdx}:a:0`

  const parts: string[] = []
  parts.push(`atrim=start=${trimInSec.toFixed(4)}:duration=${srcDurSec.toFixed(4)}`)
  parts.push('asetpts=PTS-STARTPTS')
  // Phase 3.19 — reverse the TRIMMED audio window.
  // Gated on isClipReversed → a forward clip never adds these filters, so
  // `parts` stays byte-identical to pre-3.19 for any non-reversed clip.
  // `areverse` buffers only the trimmed window (already cut by `atrim` above).
  // `asetpts=PTS-STARTPTS` follows to re-base PTS after the reversal.
  // Runs BEFORE denoise and atempo: reverse at natural rate, then tempo-scale.
  // The audio-less guard above (`if (!hasAudio) return null`) already ensures
  // we only reach this point when a real audio stream is present.
  if (isClipReversed(seg.clip)) {
    parts.push('areverse')
    parts.push('asetpts=PTS-STARTPTS')
  }
  // Phase 4 — noise reduction on the RAW source, before tempo/gain/fade.
  // Capability-gated: no-op when the bundled ffmpeg lacks afftdn.
  if (options.denoiseAvailable !== false) {
    const dn = denoiseChain(seg.clip)
    if (dn) parts.push(dn)
  }
  // Phase 3.39 — voice enhancement. After denoise (clean signal in), BEFORE
  // atempo + volume + fades (loudnorm normalizes the LAST processed signal;
  // user volume/fades stack OVER the normalized clip). Capability-gated only
  // for deesser; other filters are core ffmpeg.
  //
  // BYTE-IDENTICAL GATE: getVoiceEnhance returns null for an absent OR neutral
  // payload → voiceEnhanceToFfmpeg returns '' → nothing pushed → `parts`
  // byte-identical to the pre-Phase-3.39 graph.
  const ve = voiceEnhanceToFfmpeg(getVoiceEnhance(seg.clip), {
    deEsserAvailable: options.deEsserAvailable
  })
  if (ve) parts.push(ve)
  // Phase 3.50 — voice changer. Stacks AFTER voiceEnhance (so loudnorm sees
  // the original pitch), BEFORE atempo (user's speed stays the last temporal
  // modifier). BYTE-IDENTICAL GATE: null/'none' → '' → skipped.
  const vc = voiceChangerToFfmpeg(getVoiceChanger(seg.clip))
  if (vc) parts.push(vc)
  const tempo = atempoChain(speed)
  if (tempo) parts.push(tempo)

  // Volume from gainDb / mute / volume envelope.
  // Phase 3.30: resolvedVolumeKeyframes returns null when the clip has < 2
  // keyframes — the null gate falls through to the EXACT pre-3.30 constant-gain
  // code, preserving byte-identical filter graphs for all non-envelope clips.
  const env = resolvedVolumeKeyframes(seg.clip)
  if (seg.clip.isMuted) {
    parts.push('volume=0')
  } else if (env) {
    const dbExpr = volumeKeyframeDbExpr(env, segDurSec)
    // The comma inside pow(10,...) MUST be backslash-escaped inside filter_complex.
    parts.push(`volume=expr='pow(10\\,(${dbExpr})/20)':eval=frame`)
  } else {
    const gainDb = seg.clip.gainDb ?? 0
    if (gainDb !== 0) {
      const linear = Math.pow(10, gainDb / 20)
      parts.push(`volume=${linear.toFixed(4)}`)
    }
  }

  // Fades.
  const fadeIn = seg.clip.fadeInMs ?? 0
  const fadeOut = seg.clip.fadeOutMs ?? 0
  if (fadeIn > 0) {
    parts.push(`afade=t=in:st=0:d=${(fadeIn / 1000).toFixed(3)}`)
  }
  if (fadeOut > 0) {
    const startSec = Math.max(0, segDurSec - fadeOut / 1000)
    parts.push(`afade=t=out:st=${startSec.toFixed(3)}:d=${(fadeOut / 1000).toFixed(3)}`)
  }

  // adelay to place on the final timeline. adelay takes per-channel ms.
  if (startDelayMs > 0) {
    parts.push(`adelay=${startDelayMs}|${startDelayMs}`)
  }
  // Ensure stereo for amix consistency.
  parts.push('aformat=channel_layouts=stereo:sample_rates=44100')

  const fragment = `[${streamSpec}]${parts.join(',')}[${out}]`
  return { out, fragment }
}

/**
 * Stitch a single video track's segments into one labelled timeline stream.
 *
 * Uses xfade when transitions are present (and xfade is available), concat
 * otherwise. The `prevEndSec` xfade accumulator is LOCAL to this track —
 * it must reset per track, which is why this is a per-track helper.
 *
 * Returns the output label and all filter graph fragments for this track.
 * The output label is `vtrack${layerIndex}`.
 */
function stitchVideoTrack(
  segments: VideoSegment[],
  layerIndex: number,
  preset: MainPreset,
  xfadeAvailable: boolean,
  captionPngMap?: CaptionPngMap,
  hueSatAvailable = true,
  project?: Project,
  vidstabAvailable = false,
  deshakeAvailable = false,
  stabilizeTrfMap?: ReadonlyMap<string, string>
): { fragments: string[]; trackLabel: string } {
  const isBase = layerIndex === 0
  const fragments: string[] = []
  const segOutputs: string[] = []

  for (const seg of segments) {
    const { out, fragment } = buildVideoSegmentChain(
      seg, preset, captionPngMap, isBase,
      { hueSatAvailable, vidstabAvailable, deshakeAvailable, stabilizeTrfMap },
      project
    )
    fragments.push(fragment)
    segOutputs.push(out)
  }

  const trackLabel = `vtrack${layerIndex}`

  if (segments.length === 0) {
    // Empty layer — emit a silent transparent frame so overlay doesn't choke.
    // (Rare: an empty video track shouldn't reach this path.)
    fragments.push(
      `color=c=black@0:s=${preset.width}x${preset.height}:d=0.001:r=${preset.fps}[${trackLabel}]`
    )
    return { fragments, trackLabel }
  }

  if (segments.length === 1) {
    // Single segment: just alias the segment output to the track label.
    fragments.push(`[${segOutputs[0]}]null[${trackLabel}]`)
    return { fragments, trackLabel }
  }

  // Multi-segment: build sequential xfade or concat.
  const anyTransition =
    xfadeAvailable &&
    segments.some(
      (s, i) => i > 0 && s.transitionInMs > 0 && s.transitionKind !== 'none'
    )

  if (!anyTransition) {
    // Simple concat: [v0][v1]...concat=n=N:v=1:a=0[vtrackN]
    const inputPads = segOutputs.map((l) => `[${l}]`).join('')
    fragments.push(`${inputPads}concat=n=${segments.length}:v=1:a=0[${trackLabel}]`)
    return { fragments, trackLabel }
  }

  // xfade chain: pairwise reduce.
  // prevEndSec RESETS per track — this is the key correctness requirement.
  let prevLabel = segOutputs[0]
  let prevEndSec = (segments[0].endMs - segments[0].startMs) / 1000
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]
    const thisDurSec = (seg.endMs - seg.startMs) / 1000
    const transSec = seg.transitionInMs / 1000
    const xfadeKind =
      seg.transitionInMs > 0 && seg.transitionKind !== 'none'
        ? transitionKindToXfade(seg.transitionKind)
        : 'fade'
    const offsetSec = prevEndSec - transSec
    const safeOffset = Math.max(0, offsetSec).toFixed(4)
    const safeDur =
      seg.transitionInMs > 0 ? Math.max(0.1, transSec).toFixed(4) : '0.001'
    const newLabel = `vxf${layerIndex}_${i}`
    fragments.push(
      `[${prevLabel}][${segOutputs[i]}]xfade=transition=${xfadeKind}:duration=${safeDur}:offset=${safeOffset}[${newLabel}]`
    )
    prevLabel = newLabel
    prevEndSec = prevEndSec + thisDurSec - (seg.transitionInMs > 0 ? transSec : 0)
  }
  // Rename final xfade label to the track label.
  fragments.push(`[${prevLabel}]null[${trackLabel}]`)
  return { fragments, trackLabel }
}

/**
 * Composite multiple per-track labels bottom→top using `overlay`.
 *
 * Returns new filter graph fragments + the final composited label.
 * If only one track, no overlay is emitted — the base track label IS the
 * final label.
 *
 * overlay options:
 *   - `overlay=0:0` — transform was baked into each segment, so fixed origin.
 *   - `eof_action=pass` — when an upper layer ends, base continues undisturbed.
 *   - `shortest=0` — composite length follows the base layer, not the shortest.
 *   - `format=auto` — lets ffmpeg handle RGBA→yuv alpha flattening correctly.
 */
function compositeLayers(
  trackLabels: string[]
): { fragments: string[]; compositeLabel: string } {
  if (trackLabels.length === 1) {
    return { fragments: [], compositeLabel: trackLabels[0] }
  }

  const fragments: string[] = []
  // Start with base (layer 0) — it is the opaque bottom.
  let prevLabel = trackLabels[0]
  for (let i = 1; i < trackLabels.length; i++) {
    const newLabel = i === trackLabels.length - 1 ? 'vcomp' : `vcomp${i}`
    fragments.push(
      `[${prevLabel}][${trackLabels[i]}]overlay=0:0:eof_action=pass:shortest=0:format=auto[${newLabel}]`
    )
    prevLabel = newLabel
  }
  return { fragments, compositeLabel: prevLabel }
}

/**
 * Stitch all video track layers into a single final video stream.
 *
 * STAGE A: each track's segments are stitched via `stitchVideoTrack` (xfade or
 * concat, per-track, with per-track xfade offset accumulator reset).
 * STAGE B: per-track labels are composited bottom→top via `overlay`.
 *
 * Single video track with identity transforms → output is structurally
 * identical to the old code (concat/xfade, same label `vfinal`), preserving
 * byte-identical filter graphs for legacy projects.
 */
function stitchVideo(
  videoTrackLayers: VideoSegment[][],
  preset: MainPreset,
  xfadeAvailable = true,
  captionPngMap?: CaptionPngMap,
  hueSatAvailable = true,
  project?: Project,
  vidstabAvailable = false,
  deshakeAvailable = false,
  stabilizeTrfMap?: ReadonlyMap<string, string>
): { graph: string; finalLabel: string } {
  const allFragments: string[] = []

  if (videoTrackLayers.length === 0 || videoTrackLayers.every((l) => l.length === 0)) {
    // Should be caught earlier — render a 1-second black frame as a fallback.
    allFragments.push(
      `color=c=black:s=${preset.width}x${preset.height}:d=1:r=${preset.fps}[vfinal]`
    )
    return { graph: allFragments.join(';'), finalLabel: 'vfinal' }
  }

  // STAGE A — per-track stitch. Skip empty layers.
  const trackLabels: string[] = []
  for (let layerIndex = 0; layerIndex < videoTrackLayers.length; layerIndex++) {
    const layerSegs = videoTrackLayers[layerIndex]
    if (layerSegs.length === 0) continue

    const { fragments, trackLabel } = stitchVideoTrack(
      layerSegs,
      layerIndex,
      preset,
      xfadeAvailable,
      captionPngMap,
      hueSatAvailable,
      project,
      vidstabAvailable,
      deshakeAvailable,
      stabilizeTrfMap
    )
    for (const f of fragments) allFragments.push(f)
    trackLabels.push(trackLabel)
  }

  if (trackLabels.length === 0) {
    allFragments.push(
      `color=c=black:s=${preset.width}x${preset.height}:d=1:r=${preset.fps}[vfinal]`
    )
    return { graph: allFragments.join(';'), finalLabel: 'vfinal' }
  }

  // STAGE B — composite layers. Single-layer: no overlay emitted.
  const { fragments: compFragments, compositeLabel } = compositeLayers(trackLabels)
  for (const f of compFragments) allFragments.push(f)

  // Always expose as `vfinal` for downstream consumers.
  const finalLabel = 'vfinal'
  allFragments.push(`[${compositeLabel}]null[${finalLabel}]`)

  return { graph: allFragments.join(';'), finalLabel }
}

// ---------------------------------------------------------------------------
// Phase 3.9 — caption animation helpers.
// ---------------------------------------------------------------------------

/**
 * Build a piecewise Y-offset expression (in canvas pixels) for slide-up /
 * slide-down caption animations. The expression returns 0 (at-rest position)
 * outside the animation windows and linearly interpolates within them.
 *
 * `D` = slide travel distance in pixels = round(CAPTION_SLIDE_FRAC * H).
 * slide-up entrance: y goes from +D → 0 over [startSec, startSec+inSec].
 * slide-up exit:     y goes from 0 → -D over [endSec-outSec, endSec].
 * slide-down mirrors sign for both entrance and exit.
 *
 * The expression is consumed by the overlay filter's `y` attribute (which is
 * evaluated in filter-global time `t`).
 */
function captionSlideYExpr(
  startSec: number,
  endSec: number,
  inSec: number,
  outSec: number,
  H: number,
  entrance: 'slide-up' | 'slide-down' | 'none',
  exit: 'slide-up' | 'slide-down' | 'none'
): string {
  const D = Math.round(CAPTION_SLIDE_FRAC * H)

  // Determine per-direction entrance/exit displacements.
  // slide-up entrance: caption comes FROM below (+D) → 0.
  // slide-up exit:     caption goes TO above (0 → -D).
  // slide-down entrance: caption comes FROM above (-D) → 0.
  // slide-down exit:     caption goes TO below (0 → +D).
  const eD = entrance === 'slide-up' ? D : entrance === 'slide-down' ? -D : 0
  const xD = exit === 'slide-up' ? -D : exit === 'slide-down' ? D : 0

  // Build nested if() expression:
  // if t < startSec+inSec (entrance window): eD + (0-eD)*(t-startSec)/inSec
  // else if t >= endSec-outSec (exit window): (xD)*(t-(endSec-outSec))/outSec
  // else: 0

  const hasEntrance = entrance !== 'none' && inSec > 1e-4
  const hasExit = exit !== 'none' && outSec > 1e-4

  if (!hasEntrance && !hasExit) return '0'

  // Build right-to-left: start with hold-last (0 after all windows).
  let expr = '0'

  if (hasExit) {
    const exitStart = (endSec - outSec).toFixed(4)
    // xD * (t - exitStart) / outSec
    const exitInterp = `${xD.toFixed(2)}*(t-${exitStart})/${outSec.toFixed(4)}`
    expr = `if(gte(t,${exitStart}),${exitInterp},${expr})`
  }

  if (hasEntrance) {
    const entranceEnd = (startSec + inSec).toFixed(4)
    const entranceStart = startSec.toFixed(4)
    // eD + (0 - eD) * (t - startSec) / inSec  = eD * (1 - (t-startSec)/inSec)
    const entranceInterp = `${eD.toFixed(2)}*(1-(t-${entranceStart})/${inSec.toFixed(4)})`
    expr = `if(lt(t,${entranceEnd}),${entranceInterp},${expr})`
    // Hold entrance start value before the window begins.
    expr = `if(lt(t,${entranceStart}),${eD.toFixed(2)},${expr})`
  }

  return expr
}

/**
 * Append a chain of `overlay` filters that composite caption PNGs onto the
 * stitched video. Each caption is sourced from its own ffmpeg input (`-i
 * captionN.png`) and gated by `enable='between(t,startSec,endSec)'`.
 *
 * The PNG is full-canvas — caption position was baked into the SVG during
 * rendering, so the overlay simply pastes at (0,0).
 *
 * Phase 3.9: when a caption has a non-null animation, a per-caption PNG
 * sub-chain is emitted (`[N:v]<animChain>[capanim_X]`) before the overlay
 * compositor. Captions with null animation (the majority) emit the EXACT same
 * single-fragment overlay as before (byte-identical invariant §3.1/3.6).
 *
 * Returns the new final label + filter fragments. When the map is empty,
 * returns the input label unchanged (no-op chain).
 *
 * // TODO Phase 3.13 caption track-follow:
 * // Caption-clip position is baked into the PNG at render time (position comes
 * // from CaptionStyle.yPosition, which is static). Making caption position
 * // time-varying via a motionTrackId requires either:
 * //   (a) Re-rendering the caption PNG at a neutral y=0 and driving its overlay
 * //       y-offset with a track-derived keyframeExpr (similar to captionSlideYExpr
 * //       but derived from TrackPoint.y rather than the slide animation), or
 * //   (b) Changing the caption render step to produce a full-canvas PNG with the
 * //       caption at (0,0) and using a time-varying overlay=x='...':y='...' here.
 * // This is deferred because it requires coordinated changes in:
 * //   - renderCaptionToFile (renderer/main captions/render.ts) to support neutral-y
 * //     rendering, and
 * //   - the CaptionPng data structure to carry a motionTrackId.
 * // The blur-region (Part A) and overlay (Part B) paths are complete.
 * // Captions with motionTrackId today fall back gracefully to static behavior —
 * // the CaptionClip.motionTrackId field is present in the contract but stitchCaptions
 * // does not read captionClip directly (it reads CaptionPng entries). No regression.
 */
function stitchCaptions(
  inputVideoLabel: string,
  captionPngMap: CaptionPngMap,
  preset: MainPreset
): { graph: string; finalLabel: string } {
  if (captionPngMap.size === 0) {
    return { graph: '', finalLabel: inputVideoLabel }
  }
  const W = preset.width
  const H = preset.height
  const fragments: string[] = []
  let prevLabel = inputVideoLabel

  // Flatten captions → steps in inputIdx order for deterministic graph output.
  // Each flat entry carries everything stitchCaptions needs to emit one overlay op.
  interface FlatEntry {
    step: CaptionStep
    animation: CaptionAnimation | null
    capStartMs: number
    capEndMs: number
    inSec: number
    outSec: number
    stepIndex: number
    stepCount: number
  }
  const flatEntries: FlatEntry[] = []
  // Sort by top-level cap.inputIdx (= first step's inputIdx) for determinism.
  const ordered = Array.from(captionPngMap.values()).sort(
    (a, b) => a.inputIdx - b.inputIdx
  )
  for (const cap of ordered) {
    const inSec = cap.animInMs / 1000
    const outSec = cap.animOutMs / 1000
    for (let si = 0; si < cap.steps.length; si++) {
      flatEntries.push({
        step: cap.steps[si],
        animation: cap.animation,
        capStartMs: cap.startMs,
        capEndMs: cap.endMs,
        inSec,
        outSec,
        stepIndex: si,
        stepCount: cap.steps.length
      })
    }
  }

  const totalOps = flatEntries.length
  let opIdx = 0

  for (const entry of flatEntries) {
    const { step, animation, capStartMs, capEndMs, inSec, outSec, stepIndex, stepCount } = entry
    const startSec = capStartMs / 1000
    const endSec = capEndMs / 1000
    const stepStartSec = step.visStartMs / 1000
    const stepEndSec = step.visEndMs / 1000
    const newLabel = opIdx === totalOps - 1 ? 'vcaptioned' : `vcap${opIdx}`

    if (animation === null) {
      // =======================================================================
      // INVARIANT §3.1/3.6: null animation → BYTE-IDENTICAL legacy fragment.
      // A null-animation caption has exactly one step and its vis window equals
      // the caption's [startMs, endMs]. The overlay fragment is character-for-
      // character identical to the pre-Phase-3.9 implementation.
      // =======================================================================
      fragments.push(
        `[${prevLabel}][${step.inputIdx}:v]overlay=0:0:enable='between(t,${stepStartSec.toFixed(3)},${stepEndSec.toFixed(3)})'[${newLabel}]`
      )
    } else {
      // =======================================================================
      // Phase 3.9: animated caption — emit a per-step sub-chain then overlay.
      // =======================================================================
      const animLabel = `capanim_${step.inputIdx}`
      const chainParts: string[] = []

      // format=rgba is required first so the alpha channel exists for fade/pop.
      chainParts.push('format=rgba')

      const entrance = animation.entrance
      const exit = animation.exit
      // Exit animation applies ONLY to the FINAL step of a caption.
      const isFinalStep = stepIndex === stepCount - 1
      const effectiveExit: typeof exit = isFinalStep ? exit : 'none'

      // --- POP: zoompan from CAPTION_POP_START_SCALE → 1 over entrance window,
      //          centred on the PNG's own midpoint (PNG is full-canvas). ---
      // NOTE: zoompan's `z=` expression does NOT accept the `t` time variable —
      // only `in`, `on`, `pdur`, `px`, `py`, `pzoom`. Older docs hinted at
      // `time` but that's not in our bundled ffmpeg. We derive time from the
      // output frame counter `on` and the preset fps. Since the caption PNG is
      // looped from input time 0, `on/fps` equals absolute timeline seconds.
      if (entrance === 'pop' && inSec > 1e-4) {
        const entranceEnd = (startSec + inSec).toFixed(4)
        const timeVar = `(on/${preset.fps})`
        const scaleExpr =
          `if(lt(${timeVar},${entranceEnd}),` +
          `${CAPTION_POP_START_SCALE.toFixed(4)}+(1-${CAPTION_POP_START_SCALE.toFixed(4)})*(${timeVar}-${startSec.toFixed(4)})/${inSec.toFixed(4)},` +
          `1)`
        chainParts.push(
          `zoompan=z='${scaleExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${preset.fps}`
        )
        // Pop also cross-fades in over the same entrance window.
        chainParts.push(`fade=t=in:st=${startSec.toFixed(4)}:d=${inSec.toFixed(4)}:alpha=1`)
      }

      // --- FADE entrance ---
      if (entrance === 'fade' && inSec > 1e-4) {
        chainParts.push(`fade=t=in:st=${startSec.toFixed(4)}:d=${inSec.toFixed(4)}:alpha=1`)
      }

      // --- FADE exit (final step only, gate already applied via effectiveExit) ---
      if (effectiveExit === 'fade' && outSec > 1e-4) {
        chainParts.push(`fade=t=out:st=${(endSec - outSec).toFixed(4)}:d=${outSec.toFixed(4)}:alpha=1`)
      }

      // Emit the per-step sub-chain that transforms the PNG input.
      fragments.push(`[${step.inputIdx}:v]${chainParts.join(',')}[${animLabel}]`)

      // --- SLIDE overlay: y carries the piecewise travel expression.
      //     Slide entrance and/or slide exit govern the y offset.
      //     Non-slide animations use y=0. ---
      const isSlideEntrance = entrance === 'slide-up' || entrance === 'slide-down'
      const isSlideExit = effectiveExit === 'slide-up' || effectiveExit === 'slide-down'

      if (isSlideEntrance || isSlideExit) {
        const yExpr = captionSlideYExpr(
          startSec,
          endSec,
          inSec,
          outSec,
          H,
          isSlideEntrance ? (entrance as 'slide-up' | 'slide-down') : 'none',
          isSlideExit ? (effectiveExit as 'slide-up' | 'slide-down') : 'none'
        )
        fragments.push(
          `[${prevLabel}][${animLabel}]overlay=0:'${yExpr}':enable='between(t,${stepStartSec.toFixed(3)},${stepEndSec.toFixed(3)})'[${newLabel}]`
        )
      } else {
        // Fade / pop / typewriter step: compositor pastes at (0,0).
        fragments.push(
          `[${prevLabel}][${animLabel}]overlay=0:0:enable='between(t,${stepStartSec.toFixed(3)},${stepEndSec.toFixed(3)})'[${newLabel}]`
        )
      }
    }

    prevLabel = newLabel
    opIdx++
  }

  return { graph: fragments.join(';'), finalLabel: prevLabel }
}

// ---------------------------------------------------------------------------
// Phase 3.8 — overlay helpers.
// ---------------------------------------------------------------------------

/**
 * Collect all OverlayClips from all overlay tracks in declaration order.
 * Returns an empty array when no overlay tracks / clips exist — the export
 * path then emits zero overlay inputs and an identical filter graph to
 * pre-Phase-3.8, satisfying the byte-identical invariant.
 */
function collectOverlays(project: Project): OverlayClip[] {
  const result: OverlayClip[] = []
  for (const t of project.tracks) {
    if (t.kind !== 'overlay') continue
    for (const c of t.clips) {
      if (isOverlayClip(c)) result.push(c)
    }
  }
  return result
}

/**
 * Composite overlay PNGs onto the stitched video, one `overlay` filter per
 * overlay clip. Modeled byte-for-byte on `stitchCaptions`.
 *
 * Each overlay was assigned its own ffmpeg `-loop 1 -t <endSec> -i <png>`
 * input. Position / scale / rotation / opacity are ALREADY baked into the
 * per-overlay transform sub-chain that runs before this stitch, so the
 * compositor uses `overlay=0:0` (origin is the canvas top-left, and the
 * transparent PNG was composited onto a full-canvas RGBA frame).
 *
 * Empty map → early return, preserving the input video label unchanged (the
 * caller receives the same label it passed in — byte-identical to the
 * pre-3.8 path).
 */
function stitchOverlays(
  inputVideoLabel: string,
  overlayPngMap: OverlayPngMap,
  preset: MainPreset,
  project?: Project
): { graph: string; finalLabel: string } {
  if (overlayPngMap.size === 0) {
    return { graph: '', finalLabel: inputVideoLabel }
  }
  const W = preset.width
  const H = preset.height
  const fragments: string[] = []
  let prevLabel = inputVideoLabel
  // Sort by inputIdx for deterministic graph output.
  const ordered = Array.from(overlayPngMap.values()).sort(
    (a, b) => a.inputIdx - b.inputIdx
  )
  for (let i = 0; i < ordered.length; i++) {
    const ov = ordered[i]
    const startSec = (ov.startMs / 1000).toFixed(3)
    const endSec = (ov.endMs / 1000).toFixed(3)
    const newLabel = i === ordered.length - 1 ? 'voverlaid' : `vov${i}`

    // Per-overlay filter chain on the PNG input stream:
    //   scale to pixel size → format=rgba → transform sub-chain.
    // labelSuffix is based on clip.id slice to be unique and never collide
    // with media-clip labels (which use numeric inputIdx strings).
    const ovLabelSuffix = `ov_${ov.clip.id.slice(-8)}`

    // -------------------------------------------------------------------------
    // Phase 3.13 — motion-track follow for overlay clips (Part B).
    //
    // Gate: same three-way check as blur regions.
    //   1. overlayClip.motionTrackId is set.
    //   2. findMotionTrack resolves it.
    //   3. The track has >= 2 points.
    //
    // When true: synthesize TransformKeyframes from the decimated track points
    // and pass a shallow-cloned overlay clip with those keyframes to
    // buildTransformSubchain — it picks up the existing hasTransformKeyframes
    // path, no new expression logic needed.
    //
    // Coordinate mapping (CONFIRMED from buildTransformSubchain source):
    //   ClipTransform.x/y are canvas-CENTER-relative FRACTIONS:
    //     x=0  → horizontally centred   (pad offset = (ow-iw)/2)
    //     x=0.5 → shifted right by W/2
    //   TrackPoint.x/y are canvas-absolute fractions (0=left/top, 1=right/bottom):
    //     object CENTER at (px, py) → transform offset = (px - 0.5, py - 0.5)
    //
    // When false (no motionTrackId, dangling id, <2 pts, project undefined):
    //   ov.clip passes through UNCHANGED → byte-identical to pre-3.13.
    // -------------------------------------------------------------------------
    let clipForTransform: OverlayClip = ov.clip

    const resolvedOvTrack: MotionTrack | null =
      project && ov.clip.motionTrackId
        ? findMotionTrack(project, ov.clip.motionTrackId)
        : null

    const useOvTrack =
      resolvedOvTrack !== null && resolvedOvTrack.points.length >= 2

    if (useOvTrack) {
      // Decimate track points (same logic as blur region path above).
      const pts: TrackPoint[] = resolvedOvTrack.points

      const decimated: TrackPoint[] = [pts[0]]
      let lastEmittedMs = pts[0].atMs
      for (let pi = 1; pi < pts.length - 1; pi++) {
        if (pts[pi].atMs - lastEmittedMs >= TRACK_EXPORT_STEP_MS) {
          decimated.push(pts[pi])
          lastEmittedMs = pts[pi].atMs
        }
      }
      if (pts[pts.length - 1] !== decimated[decimated.length - 1]) {
        decimated.push(pts[pts.length - 1])
      }

      let sampled: TrackPoint[]
      if (decimated.length <= MAX_TRACK_EXPORT_KEYFRAMES) {
        sampled = decimated
      } else {
        const stride = (decimated.length - 1) / (MAX_TRACK_EXPORT_KEYFRAMES - 1)
        sampled = []
        for (let ki = 0; ki < MAX_TRACK_EXPORT_KEYFRAMES; ki++) {
          const idx = ki === MAX_TRACK_EXPORT_KEYFRAMES - 1
            ? decimated.length - 1
            : Math.round(ki * stride)
          sampled.push(decimated[idx])
        }
      }

      // Get the overlay's static scale + rotation + opacity as fallbacks.
      // The track drives x and y; static transform fields drive everything else.
      const baseXform = getClipTransform(ov.clip)

      // Build TransformKeyframe[] from sampled track points.
      // Each keyframe atMs is the clip-relative ms from the track sample.
      // x/y: convert canvas-absolute center fraction → canvas-centered fraction.
      const synthKfs: TransformKeyframe[] = sampled.map((pt) => ({
        atMs: pt.atMs,
        transform: {
          x: pt.x - 0.5,
          y: pt.y - 0.5,
          scale: pt.scale !== undefined ? pt.scale * baseXform.scale : baseXform.scale,
          rotation: baseXform.rotation,
          opacity: baseXform.opacity
        }
      }))

      // Shallow-clone the overlay clip with synthesized keyframes injected.
      // We do NOT mutate ov.clip — a fresh object is constructed.
      clipForTransform = {
        ...ov.clip,
        transformKeyframes: synthKfs,
        // Clear the static transform so hasTransformKeyframes path takes over.
        transform: undefined
      }
    }

    const transformFragment = buildTransformSubchain(
      clipForTransform,
      W,
      H,
      ovLabelSuffix,
      preset.fps
    )
    // Intermediate label for the transformed overlay stream.
    const ovStreamLabel = `ovs_${ov.clip.id.slice(-8)}`

    // Phase 3.36 — byte-identical gate: when getOverlayShadow returns null the
    // EXACT pre-3.36 two fragments are emitted. Any overlay without a shadow
    // field takes this branch and produces an unchanged filter graph.
    const shadow = getOverlayShadow(ov.clip)

    if (shadow) {
      // Drop-shadow subchain.
      //
      // Strategy: pad the element symmetrically so the blurred+offset shadow
      // has room beyond the element boundary, split the padded stream into 3
      // branches — one for the sharp source (ovsrc), one for the coloured+blurred
      // shadow (ovsh), one for the transparent backdrop (ovbg) — composite shadow
      // behind element, then run the combined unit through the transform chain.
      //
      // NOTE: geq cost scales with the padded area (element + 2·margin), which
      // is bounded and far smaller than the full canvas frame.

      // Parse the validated #rrggbb color into 0..255 R G B integers.
      const R = parseInt(shadow.color.slice(1, 3), 16)
      const G = parseInt(shadow.color.slice(3, 5), 16)
      const B = parseInt(shadow.color.slice(5, 7), 16)

      // Compute pad expansion so the shadow (blurred and offset) is never clipped.
      const blurExpand = Math.ceil(shadow.blur * 3)
      const margin = Math.ceil(
        Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) + blurExpand
      ) + 4
      const padW = ov.pxW + margin * 2
      const padH = ov.pxH + margin * 2
      // boxblur radius: /2 matches CSS/feDropShadow perception (box ≈ Gaussian).
      const blurR = Math.max(0, Math.round(shadow.blur / 2))

      // Deterministically stringify all numerics (byte-stable graph strings).
      const sOffX = String(Math.round(shadow.offsetX))
      const sOffY = String(Math.round(shadow.offsetY))
      const sOpacity = shadow.opacity.toFixed(6)

      // Label suffix shared by all internal nodes for this overlay (unique per overlay).
      const id = ov.clip.id.slice(-8)

      // Build the multi-node shadow subchain (all joined with ';' into fragments[]).
      // [N:v] → scale → format=rgba → pad (transparent) → split=3
      fragments.push(
        `[${ov.inputIdx}:v]scale=${ov.pxW}:${ov.pxH},format=rgba,` +
        `pad=${padW}:${padH}:${margin}:${margin}:color=0x00000000,` +
        `split=3[ovsrc_${id}][ovsh_${id}][ovbg_${id}]`
      )
      // Transparent backdrop: zero the alpha of the padded stream.
      fragments.push(
        `[ovbg_${id}]colorchannelmixer=aa=0[ovtrans_${id}]`
      )
      // Shadow branch: recolour all pixels to flat RGB, copy original alpha,
      // then scale alpha by shadow.opacity, then box-blur.
      fragments.push(
        `[ovsh_${id}]geq=r='${R}':g='${G}':b='${B}':a='alpha(X,Y)',` +
        `colorchannelmixer=aa=${sOpacity},` +
        `boxblur=${blurR}:${blurR}[ovshb_${id}]`
      )
      // Composite blurred shadow onto transparent backdrop at the offset position.
      fragments.push(
        `[ovtrans_${id}][ovshb_${id}]overlay=${sOffX}:${sOffY}[ovshlayer_${id}]`
      )
      // Composite sharp element on top of shadow layer.
      fragments.push(
        `[ovshlayer_${id}][ovsrc_${id}]overlay=0:0[ovcombined_${id}]`
      )
      // Apply existing transform subchain to the combined element+shadow unit,
      // then emit the final overlay onto the canvas exactly as before.
      // When transformFragment is '' (identity — no scale/rotation/keyframes),
      // we must still emit a valid filter between the two labels; `null` is the
      // ffmpeg passthrough filter that copies frames unchanged.
      const shadowTransform = transformFragment !== '' ? transformFragment : 'null'
      fragments.push(
        `[ovcombined_${id}]${shadowTransform}[${ovStreamLabel}]`
      )
    } else {
      // BYTE-IDENTICAL path — no shadow: emit the exact pre-3.36 fragments.
      // The per-overlay chain: scale to base pixel size → format=rgba → transform.
      // After the transform the frame is full-canvas (W×H) RGBA, so overlay=0:0
      // pastes it correctly.
      const ovChain = `scale=${ov.pxW}:${ov.pxH},format=rgba${transformFragment}`
      fragments.push(
        `[${ov.inputIdx}:v]${ovChain}[${ovStreamLabel}]`
      )
    }

    fragments.push(
      `[${prevLabel}][${ovStreamLabel}]overlay=0:0:enable='between(t,${startSec},${endSec})'[${newLabel}]`
    )
    prevLabel = newLabel
  }
  return { graph: fragments.join(';'), finalLabel: prevLabel }
}

// ---------------------------------------------------------------------------
// Phase 3.32 — adjustment layer stitching.
// ---------------------------------------------------------------------------

/**
 * Apply a sorted list of adjustment layers (time-gated color grades) to the
 * composited video + overlays stream, producing a new label. The function is
 * modeled byte-for-byte on `stitchCaptions` / `stitchOverlays`:
 *   - When `layers` is empty, returns `{ graph: '', finalLabel: inputLabel }`
 *     so `buildExportPlan` can skip the fragment entirely (byte-identical gate).
 *   - When every layer's `adjustmentLayerToFfmpeg` call returns '' (neutral),
 *     the same passthrough is returned.
 *   - Each non-neutral layer emits one labelled filter fragment:
 *       [prevLabel]<grade_fragment>[vadjN]
 *     where every individual filter inside `<grade_fragment>` already carries
 *     `:enable='between(t,startSec,endSec)'` (injected by `adjustmentLayerToFfmpeg`).
 *   - No new ffmpeg inputs are added — adjustment layers are pure filter
 *     expressions over the existing composite stream.
 *
 * `layers` MUST be pre-sorted ascending by `startMs` (guaranteed by
 * `getAdjustmentLayers`). `hueSatAvailable` is forwarded to
 * `adjustmentLayerToFfmpeg` to gate the `huesaturation` filter.
 */
function stitchAdjustments(
  inputLabel: string,
  layers: AdjustmentLayer[],
  hueSatAvailable: boolean,
  canvasWidth: number,
  canvasHeight: number
): { graph: string; finalLabel: string } {
  const fragments: string[] = []
  let prevLabel = inputLabel
  let adjCount = 0

  for (const layer of layers) {
    const startSec = layer.startMs / 1000
    const endSec = layer.endMs / 1000
    const frag = adjustmentLayerToFfmpeg(layer, startSec, endSec, hueSatAvailable)
    if (frag === '') continue // neutral layer — skip
    const newLabel = `vadj${adjCount}`
    adjCount++
    const transform = getAdjustmentLayerTransform(layer)
    if (isIdentityTransform(transform)) {
      fragments.push(`[${prevLabel}]${frag}[${newLabel}]`)
      prevLabel = newLabel
      continue
    }
    const scale = Math.max(
      MIN_TRANSFORM_SCALE,
      Math.min(1, Number.isFinite(transform.scale) ? transform.scale : 1)
    )
    const w = Math.max(2, Math.round(canvasWidth * scale))
    const h = Math.max(2, Math.round(canvasHeight * scale))
    const rawX = Math.round((canvasWidth - w) / 2 + transform.x * canvasWidth)
    const rawY = Math.round((canvasHeight - h) / 2 + transform.y * canvasHeight)
    const x = Math.max(0, Math.min(Math.max(0, canvasWidth - w), rawX))
    const y = Math.max(0, Math.min(Math.max(0, canvasHeight - h), rawY))
    const opacity = Math.max(
      0,
      Math.min(1, Number.isFinite(transform.opacity) ? transform.opacity : 1)
    )
    const baseLabel = `vadj${adjCount}base`
    const srcLabel = `vadj${adjCount}src`
    const gradeLabel = `vadj${adjCount}grade`
    const cropLabel = `vadj${adjCount}crop`
    const mirrorLabel = `vadj${adjCount}mirror`
    const alphaLabel = `vadj${adjCount}alpha`
    const cropChain = `crop=${w}:${h}:${x}:${y}`
    const mirrorChain =
      layer.mirrorX === true || layer.mirrorY === true
        ? `[${cropLabel}]${[
            layer.mirrorX === true ? 'hflip' : '',
            layer.mirrorY === true ? 'vflip' : ''
          ]
            .filter(Boolean)
            .join(',')}[${mirrorLabel}]`
        : ''
    const effectLabel = mirrorChain ? mirrorLabel : cropLabel
    const alphaChain =
      opacity < 0.999
        ? `[${effectLabel}]format=rgba,colorchannelmixer=aa=${opacity.toFixed(
            3
          )}[${alphaLabel}]`
        : ''
    const overlayInput = opacity < 0.999 ? alphaLabel : effectLabel
    fragments.push(
      [
        `[${prevLabel}]split=2[${baseLabel}][${srcLabel}]`,
        `[${srcLabel}]${frag}[${gradeLabel}]`,
        `[${gradeLabel}]${cropChain}[${cropLabel}]`,
        mirrorChain,
        alphaChain,
        `[${baseLabel}][${overlayInput}]overlay=${x}:${y}:enable='between(t,${startSec.toFixed(
          3
        )},${endSec.toFixed(3)})'[${newLabel}]`
      ]
        .filter(Boolean)
        .join(';')
    )
    prevLabel = newLabel
  }

  if (fragments.length === 0) {
    return { graph: '', finalLabel: inputLabel }
  }
  return { graph: fragments.join(';'), finalLabel: prevLabel }
}

/**
 * Phase 3.35 — progress bar overlay.
 *
 * Wraps `progressBarToFfmpeg` in the same pattern as `stitchAdjustments`:
 * - Null cfg or totalSec <= 0 → graph:'', finalLabel:inputLabel (byte-identical gate).
 * - Non-null cfg → graph:[inputLabel]<drawbox chain>[vprog], finalLabel:'vprog'.
 * The progress bar adds NO new ffmpeg inputs (pure drawbox filter).
 */
function stitchProgressBar(
  inputLabel: string,
  cfg: ProgressBarConfig | null,
  totalSec: number
): { graph: string; finalLabel: string } {
  if (!cfg || totalSec <= 0) return { graph: '', finalLabel: inputLabel }
  const frag = progressBarToFfmpeg(cfg, totalSec)
  if (frag === '') return { graph: '', finalLabel: inputLabel }
  return { graph: `[${inputLabel}]${frag}[vprog]`, finalLabel: 'vprog' }
}

/** Stitch all audio: per-segment chains then amix across the lot. */
function stitchAudio(
  segments: AudioSegment[],
  project: Project,
  options: { inputHasAudio?: (inputIdx: number) => boolean; denoiseAvailable?: boolean; deEsserAvailable?: boolean } = {}
): { graph: string; finalLabel: string | null } {
  if (segments.length === 0) return { graph: '', finalLabel: null }

  // Split into role buckets (voice / bgm / sfx / unrouted).
  const segByLabel: { label: string; role: string | null; isBgm: boolean }[] = []
  const fragments: string[] = []

  for (const seg of segments) {
    const isVoice = seg.track.role === 'voice'
    const isBgm = seg.track.role === 'bgm'
    const isMuted = seg.track.muted || seg.clip.isMuted
    if (isMuted) continue
    const built = buildAudioSegmentChain(seg, {
      inputHasAudio: options.inputHasAudio,
      denoiseAvailable: options.denoiseAvailable,
      deEsserAvailable: options.deEsserAvailable
    })
    if (!built) continue
    fragments.push(built.fragment)
    segByLabel.push({
      label: built.out,
      role: seg.track.role ?? null,
      isBgm: isBgm
    })
    void isVoice
  }

  if (segByLabel.length === 0) return { graph: '', finalLabel: null }

  // Mix voice tracks first (so we can use them as the sidechain).
  const voiceLabels = segByLabel.filter((s) => s.role === 'voice').map((s) => s.label)
  const bgmLabels = segByLabel.filter((s) => s.role === 'bgm').map((s) => s.label)
  const otherLabels = segByLabel
    .filter((s) => s.role !== 'voice' && s.role !== 'bgm')
    .map((s) => s.label)

  const mixed: string[] = []

  // Voice bus.
  let voiceBus: string | null = null
  if (voiceLabels.length === 1) {
    voiceBus = voiceLabels[0]
  } else if (voiceLabels.length > 1) {
    voiceBus = 'voicebus'
    fragments.push(
      `${voiceLabels.map((l) => `[${l}]`).join('')}amix=inputs=${voiceLabels.length}:duration=longest[${voiceBus}]`
    )
  }

  // BGM bus.
  let bgmBus: string | null = null
  if (bgmLabels.length === 1) {
    bgmBus = bgmLabels[0]
  } else if (bgmLabels.length > 1) {
    bgmBus = 'bgmbus'
    fragments.push(
      `${bgmLabels.map((l) => `[${l}]`).join('')}amix=inputs=${bgmLabels.length}:duration=longest[${bgmBus}]`
    )
  }

  // Sidechain ducking — only if both voice + bgm exist and any BGM track
  // declares duckTarget='voice'.
  const bgmTrack = project.tracks.find(
    (t) => t.role === 'bgm' && t.duckTarget === 'voice'
  )
  if (voiceBus && bgmBus && bgmTrack) {
    const duckDb = bgmTrack.duckingDb ?? DEFAULT_DUCKING_DB
    // sidechaincompress threshold/ratio approximation; we also explicitly
    // attenuate the BGM by the requested dB amount via `volume` post-mix
    // because sidechaincompress' makeup gain math is fiddly.
    const linear = Math.pow(10, duckDb / 20)
    fragments.push(
      // We need TWO copies of voice: one for the final mix and one as sidechain.
      `[${voiceBus}]asplit=2[voicemix][voicesc];` +
        `[${bgmBus}][voicesc]sidechaincompress=threshold=0.05:ratio=8:attack=10:release=200[bgmduck];` +
        `[bgmduck]volume=${linear.toFixed(4)}[bgmducked]`
    )
    mixed.push('voicemix', 'bgmducked')
  } else {
    if (voiceBus) mixed.push(voiceBus)
    if (bgmBus) mixed.push(bgmBus)
  }
  for (const l of otherLabels) mixed.push(l)

  // Final amix.
  let finalLabel: string
  if (mixed.length === 1) {
    finalLabel = mixed[0]
  } else {
    finalLabel = 'afinal'
    fragments.push(
      `${mixed.map((l) => `[${l}]`).join('')}amix=inputs=${mixed.length}:duration=longest[${finalLabel}]`
    )
  }

  return { graph: fragments.join(';'), finalLabel }
}

// ---------------------------------------------------------------------------
// Plan builder — combines video + audio graphs, returns argv + filterGraph.
// ---------------------------------------------------------------------------
interface ExportPlan {
  argv: string[]
  filterGraph: string
  inputs: string[]
  outputPath: string
  videoSegmentCount: number
}

function buildExportPlan(
  project: Project,
  presetKey: ExportPresetKey,
  outputPath: string,
  options: {
    xfadeAvailable?: boolean
    /**
     * Set of input indices (matching the assembled `inputs[]` order from
     * `collectSegments`) that carry an audio stream. When omitted, every
     * input is assumed to have audio — fine for the plan-only IPC, but
     * the runtime export path passes a probed set so ffmpeg 6's strict
     * stream-spec validation doesn't blow up.
     */
    inputsWithAudio?: Set<number>
    /**
     * Override the video encoder. Default = preset.codec (libx264). When
     * set to a HW encoder (h264_amf/nvenc/qsv/videotoolbox), the argv is
     * adjusted: preset name is mapped, and we switch from CRF to VBR. Even
     * the CPU path uses VBR today (the original code never set CRF), so the
     * change is encoder-specific only around -preset / -q:v.
     */
    codec?: AllowedCodec
    /**
     * Pre-rendered caption PNGs keyed by `caption.id`. Each entry contributes
     * a `-loop 1 -t <dur> -i <pngPath>` input followed by an `overlay` filter
     * (see `stitchCaptions`). The map's `inputIdx` MUST match the actual
     * argv input ordering — the caller is responsible for assigning indices
     * based on `inputs.length` BEFORE registering them here. The plan-only
     * IPC omits this map (drawtext fallback path runs).
     */
    captionPngs?: CaptionPngMap
    /**
     * Phase 3.8 — pre-resolved overlay PNGs keyed by `overlayClip.id`. Each
     * entry contributes a `-loop 1 -t <endSec> -i <pngPath>` input followed
     * by per-overlay filter chains + an `overlay` filter (see
     * `stitchOverlays`). Input indices MUST start at
     * `probedInputs.length + captionPngs.size`. Absent → no overlay inputs,
     * the filter graph is byte-identical to pre-Phase-3.8.
     */
    overlayPngs?: OverlayPngMap
    /**
     * Phase 4 — whether the bundled ffmpeg supports the `afftdn` filter.
     * When false, per-clip noise reduction is silently skipped (audio graph
     * is byte-identical to pre-Phase-4). Defaults to true when omitted so
     * the plan-only IPC and unit tests see the full graph without probing.
     */
    denoiseAvailable?: boolean
    /**
     * Phase 3.39 — whether the bundled ffmpeg supports the `deesser` filter.
     * When false, voiceEnhanceToFfmpeg uses the firequalizer fallback for
     * de-essing. Core filters (loudnorm, acompressor, equalizer, highpass)
     * are always present and need no probe. Defaults to true when omitted so
     * the plan-only IPC and unit tests see the deesser path without probing.
     */
    deEsserAvailable?: boolean
    /**
     * Phase 3.12 — whether the bundled ffmpeg supports the `huesaturation`
     * filter. When false, per-clip HSL secondary grading is silently skipped
     * (video graph is byte-identical to pre-Phase-3.12 for those clips).
     * Curves are unaffected (curves= is always present). Defaults to true
     * when omitted so the plan-only IPC and unit tests see the full graph
     * without probing.
     */
    hueSatAvailable?: boolean
    /**
     * Phase 3.38 — whether vidstabtransform is available. When true,
     * stabilize-enabled clips use the 2nd-pass vidstabtransform filter with
     * pre-computed .trf data from stabilizeTrfMap. Defaults to false so the
     * plan-only IPC emits deshake= instead (honest: plan can't run 1st pass).
     */
    vidstabAvailable?: boolean
    /**
     * Phase 3.38 — whether deshake is available (single-pass fallback).
     * Defaults to true so the plan-only IPC emits deshake= for stabilize clips.
     */
    deshakeAvailable?: boolean
    /**
     * Phase 3.38 — map from clipId → absolute .trf path produced by the
     * vidstabdetect 1st pass. Required when vidstabAvailable is true.
     */
    stabilizeTrfMap?: ReadonlyMap<string, string>
  } = {}
): ExportPlan {
  const preset = PRESETS[presetKey]
  if (!preset) throw new Error(`[export] unknown preset: ${presetKey}`)

  const { videoTrackLayers, videoSegments, audioSegments, inputs } = collectSegments(project, preset.fps)
  if (videoSegments.length === 0) {
    throw new Error('[export] no video clips on timeline')
  }

  const xfadeAvailable = options.xfadeAvailable ?? true
  const hueSatAvailable = options.hueSatAvailable ?? true
  const vidstabAvailable = options.vidstabAvailable ?? false
  const deshakeAvailable = options.deshakeAvailable ?? true
  const stabilizeTrfMap = options.stabilizeTrfMap
  const captionPngs = options.captionPngs
  const overlayPngs = options.overlayPngs
  const { graph: videoGraph, finalLabel: stitchedVideoLabel } = stitchVideo(
    videoTrackLayers,
    preset,
    xfadeAvailable,
    captionPngs,
    hueSatAvailable,
    project,
    vidstabAvailable,
    deshakeAvailable,
    stabilizeTrfMap
  )

  // Phase 3.8: composite overlay PNGs BELOW captions (spec §3.3 pipeline order:
  // stitchVideo → stitchOverlays → stitchCaptions). No-op when overlayPngs is
  // absent / empty — the label passes through unchanged.
  // Phase 3.13: project is passed so stitchOverlays can resolve motionTrackId
  // for overlay clips.
  const { graph: overlayGraph, finalLabel: afterOverlayLabel } = overlayPngs && overlayPngs.size > 0
    ? stitchOverlays(stitchedVideoLabel, overlayPngs, preset, project)
    : { graph: '', finalLabel: stitchedVideoLabel }

  // Phase 3.32: apply adjustment layers AFTER overlays, BEFORE captions.
  // Captions sit above the grade so subtitle text is never tinted.
  // When there are no (non-neutral) adjustment layers, afterAdjustLabel ===
  // afterOverlayLabel and adjustGraph === '' — the filter_complex is
  // byte-identical to pre-3.32 projects.
  const adjustmentLayers = getAdjustmentLayers(project)
  const { graph: adjustGraph, finalLabel: afterAdjustLabel } =
    adjustmentLayers.length > 0
      ? stitchAdjustments(
          afterOverlayLabel,
          adjustmentLayers,
          hueSatAvailable,
          preset.width,
          preset.height
        )
      : { graph: '', finalLabel: afterOverlayLabel }

  // Composite caption PNGs onto the stitched video. No-op when captionPngs
  // is undefined / empty — in that case all captions used the drawtext path
  // and are already baked into per-segment frames.
  // Phase 3.9: stitchCaptions receives preset so animation sub-chains can
  // reference canvas W/H/fps for zoompan and slide distance computations.
  const { graph: captionGraph, finalLabel: videoLabel } = captionPngs
    ? stitchCaptions(afterAdjustLabel, captionPngs, preset)
    : { graph: '', finalLabel: afterAdjustLabel }

  // Phase 3.35 — progress bar draws ON TOP of everything (captions included).
  const { graph: progressGraph, finalLabel: finalVideoLabel } = stitchProgressBar(
    videoLabel,
    getProgressBar(project),
    getProjectTotalMs(project) / 1000
  )

  const inputsWithAudio = options.inputsWithAudio
  const inputHasAudio = inputsWithAudio
    ? (idx: number): boolean => inputsWithAudio.has(idx)
    : undefined
  const { graph: audioGraph, finalLabel: audioLabel } = stitchAudio(
    audioSegments,
    project,
    { inputHasAudio, denoiseAvailable: options.denoiseAvailable, deEsserAvailable: options.deEsserAvailable }
  )

  // Combine. If no audio, still emit a silent stream for compliance with
  // mobile players that expect both tracks.
  const filterFragments: string[] = []
  if (videoGraph) filterFragments.push(videoGraph)
  if (overlayGraph) filterFragments.push(overlayGraph)
  if (adjustGraph) filterFragments.push(adjustGraph)
  if (captionGraph) filterFragments.push(captionGraph)
  if (progressGraph) filterFragments.push(progressGraph)
  if (audioGraph) filterFragments.push(audioGraph)

  let useAudioLabel = audioLabel
  if (!useAudioLabel) {
    // Synthesize 0.5s of silence repeated forever — `anullsrc`.
    filterFragments.push(
      `anullsrc=channel_layout=stereo:sample_rate=44100[silentaudio]`
    )
    useAudioLabel = 'silentaudio'
  }

  const filterGraph = filterFragments.join(';')

  // Build argv directly — bypasses runner's buildArgv which doesn't support
  // multi-input + map flags. We invoke through runFfmpegJob with extraArgs
  // would be too constrained; instead we use the lower-level spawnFfmpeg.
  // → Actually: easier to invoke the runner with extra map args, but the
  // runner currently doesn't support them. So we craft a FfmpegRunSpec that
  // includes inputs[] + filterGraph and add an `-map` via extraArgs.
  //   But extraArgs allow-list rejects `-map`. We'll use an ad-hoc spawn
  // in runExport() that mirrors the runner's safety checks.
  // For the *plan* we just record argv-preview.
  const codec: AllowedCodec = options.codec ?? preset.codec
  const mappedPreset = mapPresetForCodec(preset.preset, codec)
  const presetFlag = presetFlagForCodec(codec)

  const argv: string[] = []
  argv.push('-hide_banner', '-y', '-nostdin')
  for (const p of inputs) {
    argv.push('-i', p)
  }
  // Caption PNG inputs. Each PNG is treated as a 1-frame still that we loop
  // with `-loop 1` so ffmpeg generates a video stream from it; `-t <dur>`
  // bounds how long the loop is sourced for. The actual visibility window
  // is enforced by the overlay's `enable=between(t,...)` expression, so the
  // -t value just needs to be ≥ the caption's endMs to avoid stream EOF
  // before the overlay's last enabled frame. We use the caption's endSec to
  // keep things tight (a much larger value works too but wastes nothing).
  // Phase 3.8 — overlay PNG inputs. Must appear BEFORE caption PNG inputs in
  // argv so that inputIdx assignment (overlays after media, captions after
  // overlays) is consistent with the map construction in runExport.
  if (overlayPngs && overlayPngs.size > 0) {
    const ordered = Array.from(overlayPngs.values()).sort(
      (a, b) => a.inputIdx - b.inputIdx
    )
    for (const ov of ordered) {
      const durSec = Math.max(0.1, ov.endMs / 1000)
      argv.push('-loop', '1', '-t', durSec.toFixed(3), '-i', ov.pngPath)
    }
  }
  if (captionPngs) {
    // Phase 3.9: iterate STEPS (not top-level caps), because typewriter captions
    // contribute multiple inputs. Collect all steps across all captions, sort
    // by inputIdx to guarantee argv order matches the assigned indices.
    const allSteps: Array<{ inputIdx: number; pngPath: string; endMs: number }> = []
    for (const cap of captionPngs.values()) {
      for (const step of cap.steps) {
        allSteps.push({ inputIdx: step.inputIdx, pngPath: step.pngPath, endMs: cap.endMs })
      }
    }
    allSteps.sort((a, b) => a.inputIdx - b.inputIdx)
    for (const s of allSteps) {
      const durSec = Math.max(0.1, s.endMs / 1000)
      argv.push('-loop', '1', '-t', durSec.toFixed(3), '-i', s.pngPath)
    }
  }
  argv.push('-filter_complex', filterGraph)
  argv.push('-map', `[${finalVideoLabel}]`)
  argv.push('-map', `[${useAudioLabel}]`)
  argv.push('-c:v', codec)
  if (mappedPreset !== null) {
    argv.push(presetFlag, mappedPreset)
  } else if (codec === 'h264_videotoolbox' || codec === 'hevc_videotoolbox') {
    // VideoToolbox uses -q:v 1-100 (lower = better). Map x264 preset roughly:
    //   veryfast → 70, medium → 60, slow → 50. Default 60.
    let qv = 60
    if (
      preset.preset === 'veryfast' ||
      preset.preset === 'faster' ||
      preset.preset === 'fast' ||
      preset.preset === 'superfast' ||
      preset.preset === 'ultrafast'
    ) {
      qv = 70
    } else if (preset.preset === 'slow' || preset.preset === 'slower' || preset.preset === 'veryslow') {
      qv = 50
    }
    argv.push('-q:v', String(qv))
  }
  argv.push('-b:v', `${preset.vBitrateKbps}k`)
  argv.push('-maxrate', `${Math.round(preset.vBitrateKbps * 1.2)}k`)
  argv.push('-bufsize', `${preset.vBitrateKbps * 2}k`)
  argv.push('-pix_fmt', 'yuv420p')
  argv.push('-r', String(preset.fps))
  argv.push('-c:a', 'aac')
  argv.push('-b:a', `${preset.aBitrateKbps}k`)
  argv.push('-movflags', '+faststart')
  argv.push('-progress', 'pipe:2', '-nostats')
  argv.push(outputPath)

  return {
    argv,
    filterGraph,
    inputs,
    outputPath,
    videoSegmentCount: videoSegments.length
  }
}

// ---------------------------------------------------------------------------
// Runtime: spawn ffmpeg directly. Mirrors runner.ts safety checks.
// (We can't reuse runFfmpegJob because it doesn't accept -map argv directly.)
// ---------------------------------------------------------------------------
async function ensureExportDir(): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'exports')
  await mkdir(dir, { recursive: true })
  return dir
}

async function writeDebugLog(argv: string[], filterGraph: string): Promise<string> {
  const dir = await ensureExportDir()
  const logPath = path.join(dir, 'last-export-cmd.txt')
  const text = [
    '# Last export command',
    `# ${new Date().toISOString()}`,
    '',
    '## argv',
    JSON.stringify(argv, null, 2),
    '',
    '## filter graph',
    filterGraph,
    ''
  ].join('\n')
  await writeFile(logPath, text, 'utf-8')
  return logPath
}

/**
 * Probe the output file for dimensions / duration / bitrate via ffprobe-like
 * parsing of ffmpeg's own `-i ...` output (we don't want a second native
 * binary dependency from this module). Best-effort: if parsing fails, the
 * fields are simply omitted.
 */
function probeOutput(
  ffmpegPath: string,
  filePath: string
): Promise<{
  durationMs?: number
  width?: number
  height?: number
  vBitrate?: number
  aBitrate?: number
}> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024)
    })
    proc.on('close', () => {
      const out: ReturnType<typeof probeOutput> extends Promise<infer R> ? R : never = {}
      const dm = /Duration:\s+(\d+):(\d+):([\d.]+)/.exec(stderr)
      if (dm) {
        const hh = Number(dm[1])
        const mm = Number(dm[2])
        const ss = Number(dm[3])
        out.durationMs = Math.round((hh * 3600 + mm * 60 + ss) * 1000)
      }
      const vm = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr)
      if (vm) {
        out.width = Number(vm[1])
        out.height = Number(vm[2])
      }
      const vb = /Video:.*?(\d+) kb\/s/.exec(stderr)
      if (vb) out.vBitrate = Number(vb[1])
      const ab = /Audio:.*?(\d+) kb\/s/.exec(stderr)
      if (ab) out.aBitrate = Number(ab[1])
      resolve(out as never)
    })
    proc.on('error', () => resolve({}))
  })
}

/**
 * Phase 3.28 — extracted composite-export body.  This is the VERBATIM body
 * of the old `runExport`, lifted into a named function so that the GIF branch
 * can call it for pass 0 with a temporary output path.  The mp4 export path
 * calls it unchanged — argv/filter_complex is byte-identical.
 *
 * `safeOutput` is the already-resolved, already-allowed output path.  The
 * caller is responsible for calling `allowPath(outputPath)` +
 * `assertPathAllowed(outputPath, 'output')` before passing it in.
 */
async function runCompositeExport(
  project: Project,
  options: ExportRunOptions,
  safeOutput: string
): Promise<ExportRunResult> {
  const ffmpegPath = resolveFfmpegPath()

  // Allow + validate all media input paths and the output path.
  for (const m of Object.values(project.media)) {
    if (m && typeof m.path === 'string') allowPath(m.path)
  }

  // Decide encoder. If the renderer asked for HW accel, probe capabilities
  // and use the preferred HW encoder; otherwise stick with libx264. We also
  // fall back to libx264 when the probe says the preferred encoder IS
  // libx264 (no HW found) — so the renderer can flip the flag freely.
  let chosenCodec: AllowedCodec = 'libx264'
  if (options.useHardwareAccel) {
    try {
      const caps = await probeCapabilities()
      chosenCodec = caps.preferred ?? 'libx264'
    } catch {
      chosenCodec = 'libx264'
    }
  }

  const xfadeAvailable = await probeXfadeAvailable(ffmpegPath)
  const denoiseAvailable = await probeAfftdnAvailable(ffmpegPath)
  const deEsserAvailable = await probeDeesserAvailable(ffmpegPath)
  const hueSatAvailable = await probeHueSaturationAvailable(ffmpegPath)
  // Phase 3.38 — probe vidstab / deshake availability.
  // deshakeAvailable is only evaluated when vidstab is absent (fallback only).
  const vidstabAvailable = await probeVidstabAvailable(ffmpegPath)
  const deshakeAvailable = vidstabAvailable ? false : await probeDeshakeAvailable(ffmpegPath)

  // Probe each unique input path for audio presence. We do this in the
  // runtime path (not in buildPlan) because the plan-only IPC just needs
  // a representative filter graph for UI inspection; the real run, however,
  // must avoid `[N:a:0?]` (rejected by ffmpeg 6) and only emit chains for
  // inputs that actually have an audio stream.
  const { inputs: probedInputs } = collectSegments(project, PRESETS[options.presetKey]?.fps ?? 30) as { inputs: string[] }
  const inputsWithAudio = new Set<number>()
  for (let i = 0; i < probedInputs.length; i++) {
    const p = probedInputs[i]
    try {
      const hasAudio = await probeHasAudio(ffmpegPath, p)
      if (hasAudio) inputsWithAudio.add(i)
    } catch {
      // On probe failure, conservatively assume no audio — better to drop
      // the audio chain than to fail the entire export.
    }
  }

  // Phase 3.38 — vidstabdetect 1st-pass loop.
  // Runs BEFORE caption/overlay pre-render so that the .trf files are ready
  // when buildExportPlan assembles the filter graph.
  // BYTE-IDENTICAL GATE: collectStabilizeJobs returns [] for a project with
  // no stabilize-enabled clips → the loop body never executes → no IPC events
  // → no spawns → filter graph is bit-identical to pre-Phase-3.38.
  const stabilizeTrfMap = new Map<string, string>()  // clipId → trfPath
  if (vidstabAvailable) {
    const stabJobs = collectStabilizeJobs(project)
    for (let j = 0; j < stabJobs.length; j++) {
      emitStabilizeProgress(options.jobId, j, stabJobs.length, 0)
      try {
        const trf = await runVidstabDetectPass(ffmpegPath, stabJobs[j], (pct) =>
          emitStabilizeProgress(options.jobId, j, stabJobs.length, pct)
        )
        stabilizeTrfMap.set(stabJobs[j].clipId, trf)
      } catch (err) {
        console.warn('[export] vidstabdetect failed for clip', stabJobs[j].clipId, err)
      }
    }
    if (stabJobs.length > 0) emitStabilizeProgress(options.jobId, stabJobs.length, stabJobs.length, 100)
  }
  // Allow all .trf paths so assertPathAllowed in buildExportPlan passes.
  for (const trf of stabilizeTrfMap.values()) allowPath(trf)

  // Pre-render caption PNGs. Each PNG is canvas-sized and includes the
  // caption baked into its final visual position. Failures degrade
  // gracefully — captions whose render failed (or all captions when sharp
  // is unavailable) fall back to drawtext via the legacy code path. The
  // PNG inputs are appended AFTER the media inputs so the existing input
  // indices for video/audio segments remain stable.
  resetCaptionRenderStats()
  const captionPngs: CaptionPngMap = new Map()
  try {
    const preset = PRESETS[options.presetKey]
    if (preset) {
      const canvasW = preset.width
      const canvasH = preset.height
      // Gather all caption clips from all caption tracks.
      const allCaptions: CaptionClip[] = []
      for (const t of project.tracks) {
        if (t.kind !== 'caption') continue
        for (const c of t.clips) {
          if (isCaptionClip(c)) allCaptions.push(c)
        }
      }
      // Caption inputs follow media inputs. Walk in deterministic order.
      // Phase 3.9: typewriter captions render N stepped PNGs (one per step);
      // all other captions render a single PNG. Input indices are assigned
      // consecutively across ALL steps of ALL captions.
      let nextInputIdx = probedInputs.length
      for (const cap of allCaptions) {
        const anim = getCaptionAnimation(cap)
        const { inMs: animInMs, outMs: animOutMs } = getCaptionAnimWindows(cap)
        const isTypewriter = anim !== null && anim.entrance === 'typewriter'

        // ---------------------------------------------------------------
        // KARAOKE branch — gated entirely on getCaptionKaraoke non-null.
        // When getCaptionKaraoke returns null (disabled / no words / absent)
        // this block is entirely skipped and the caption takes the existing
        // typewriter or non-typewriter path — byte-identical invariant.
        // ---------------------------------------------------------------
        const karaoke = getCaptionKaraoke(cap)
        if (karaoke !== null) {
          const words = resolveCaptionWords(cap)
          // words.length >= 1 guaranteed by getCaptionKaraoke returning non-null.
          const wordCount = words.length
          // Cap step count to MAX_CAPTION_KARAOKE_STEPS.
          // When wordCount > MAX, group ceil(len/MAX) words per step so the
          // step count stays at MAX (mirrors the typewriter groupSize logic).
          const N = Math.min(wordCount, MAX_CAPTION_KARAOKE_STEPS)
          const groupSize = Math.ceil(wordCount / N)
          const steps: CaptionStep[] = []
          let allOk = true

          for (let k = 0; k < N; k++) {
            // The active word for this step is the first word in the group.
            const karaokeActiveIndex = k * groupSize
            const result = await renderCaptionToFile(
              cap,
              canvasW,
              canvasH,
              { karaoke, karaokeActiveIndex }
            )
            if (!result) { allOk = false; break }
            allowPath(result.pngPath)
            const stepInputIdx = nextInputIdx++

            // Visibility window for step k:
            //   visStartMs = cap.startMs + words[firstWordOfStep_k].startMs
            //                (for k === 0: cap.startMs so the caption shows from
            //                 the very beginning, before any word has been spoken)
            //   visEndMs   = cap.startMs + words[firstWordOfStep_(k+1)].startMs
            //                (for the final step: cap.endMs)
            const firstWordIdx = k * groupSize
            const nextFirstWordIdx = (k + 1) * groupSize
            const visStartMs =
              k === 0
                ? cap.startMs
                : cap.startMs + words[firstWordIdx].startMs
            const visEndMs =
              k === N - 1
                ? cap.endMs
                : cap.startMs + words[Math.min(nextFirstWordIdx, wordCount - 1)].startMs

            steps.push({
              pngPath: result.pngPath,
              inputIdx: stepInputIdx,
              visStartMs,
              visEndMs
            })
          }

          if (!allOk || steps.length === 0) {
            // Render failure — fall through to typewriter/plain path below.
            // Undo the inputIdx advances for any steps we did allocate so
            // later indices remain consistent. Since we haven't pushed to
            // captionPngs yet, we just roll back nextInputIdx.
            nextInputIdx -= steps.length
            // Fall through to typewriter / non-typewriter path.
          } else {
            // Allow all step PNG paths (idempotent; some already allowed above).
            for (const s of steps) allowPath(s.pngPath)

            captionPngs.set(cap.id, {
              pngPath: steps[0].pngPath,
              inputIdx: steps[0].inputIdx,
              startMs: cap.startMs,
              endMs: cap.endMs,
              cached: false, // individual steps may be cached; we don't aggregate
              animation: anim,
              animInMs,
              animOutMs,
              steps
            })
            continue // karaoke handled — skip typewriter / non-typewriter branches
          }
        }

        if (isTypewriter) {
          // ---------------------------------------------------------------
          // TYPEWRITER: render N stepped PNGs, each with a truncated spans
          // array (spans.slice(0, k)). Step k is visible on:
          //   [startMs + k*inMs/N, startMs + (k+1)*inMs/N)
          // The final step extends through endMs.
          // N = min(spans.length, MAX_CAPTION_TYPEWRITER_STEPS).
          // For >12 spans, group ceil(len/N) spans per step.
          // ---------------------------------------------------------------
          const spanCount = cap.spans.length
          if (spanCount === 0) continue // no spans — skip
          const N = Math.min(spanCount, MAX_CAPTION_TYPEWRITER_STEPS)
          const groupSize = Math.ceil(spanCount / N)
          const steps: CaptionStep[] = []
          let allOk = true

          for (let k = 0; k < N; k++) {
            const spanEnd = Math.min(spanCount, (k + 1) * groupSize)
            const truncatedCap = { ...cap, spans: cap.spans.slice(0, spanEnd) }
            const result = await renderCaptionToFile(truncatedCap, canvasW, canvasH)
            if (!result) { allOk = false; break }
            allowPath(result.pngPath)
            const stepInputIdx = nextInputIdx++
            // Step k: [startMs + k*inMs/N, startMs + (k+1)*inMs/N)
            // Final step: extends to endMs.
            const visStartMs = cap.startMs + Math.floor(k * animInMs / N)
            const visEndMs = k === N - 1
              ? cap.endMs
              : cap.startMs + Math.floor((k + 1) * animInMs / N)
            steps.push({ pngPath: result.pngPath, inputIdx: stepInputIdx, visStartMs, visEndMs })
          }

          if (!allOk || steps.length === 0) continue // fallback to drawtext

          // Allow all step PNG paths (some may already be allowed above, but idempotent).
          for (const s of steps) allowPath(s.pngPath)

          captionPngs.set(cap.id, {
            pngPath: steps[0].pngPath,
            inputIdx: steps[0].inputIdx,
            startMs: cap.startMs,
            endMs: cap.endMs,
            cached: false, // individual steps may be cached but we don't aggregate
            animation: anim,
            animInMs,
            animOutMs,
            steps
          })
        } else {
          // ---------------------------------------------------------------
          // Non-typewriter (including null animation): single PNG.
          // ---------------------------------------------------------------
          const result = await renderCaptionToFile(cap, canvasW, canvasH)
          if (!result) continue // sharp unavailable / render error — drawtext fallback
          allowPath(result.pngPath)
          const stepInputIdx = nextInputIdx++
          captionPngs.set(cap.id, {
            pngPath: result.pngPath,
            inputIdx: stepInputIdx,
            startMs: cap.startMs,
            endMs: cap.endMs,
            cached: result.cached,
            animation: anim,
            animInMs,
            animOutMs,
            steps: [{
              pngPath: result.pngPath,
              inputIdx: stepInputIdx,
              visStartMs: cap.startMs,
              visEndMs: cap.endMs
            }]
          })
        }
      }
    }
  } catch (err) {
    // Render-side errors must NEVER fail the whole export. Log + continue
    // with the empty map (drawtext fallback handles every caption).
    console.warn(
      '[export] caption pre-render encountered an error; falling back to drawtext:',
      err instanceof Error ? err.message : String(err)
    )
    captionPngs.clear()
  }
  if (captionPngs.size > 0) {
    const stats = getCaptionRenderStats()
    console.log(
      `[export] captions: ${captionPngs.size} rendered, cacheHits=${stats.cacheHits}, misses=${stats.cacheMisses}, errors=${stats.errors}`
    )
  }

  // Phase 3.8 — Pre-resolve overlay PNGs. Overlay inputs are placed AFTER
  // media inputs and BEFORE caption inputs so captionPngs indices remain
  // offset by (probedInputs.length + overlayPngs.size).
  //
  // Spec §3.5 invariant: if collectOverlays returns [] (no overlay tracks /
  // clips), overlayPngs stays empty and the entire overlay code path is a
  // no-op — the filter graph + argv are byte-identical to pre-Phase-3.8.
  const overlayPngs: OverlayPngMap = new Map()
  try {
    const overlayPreset = PRESETS[options.presetKey]
    if (overlayPreset) {
      const canvasW = overlayPreset.width
      const canvasH = overlayPreset.height
      const allOverlays = collectOverlays(project)
      // Overlay inputs follow media inputs directly; start index = media count.
      let nextOverlayIdx = probedInputs.length
      for (const ov of allOverlays) {
        let pngPath: string | null = null
        if (ov.source.type === 'image') {
          // User image — use source.path directly; no rendering needed.
          pngPath = ov.source.path
          if (!pngPath || !existsSync(pngPath)) {
            console.warn(`[export] overlay image not found: ${pngPath ?? '(null)'} — skipping`)
            continue
          }
        } else if (ov.source.type === 'sticker') {
          pngPath = resolveBundledStickerPath(ov.source.stickerId)
          if (!pngPath) {
            console.warn(`[export] bundled sticker not found: ${ov.source.stickerId} — skipping`)
            continue
          }
        } else if (ov.source.type === 'shape') {
          const { w: wFrac, h: hFrac } = getOverlayBaseSize(ov)
          const pxW = Math.round(wFrac * canvasW)
          const pxH = Math.round(hFrac * canvasH)
          pngPath = await renderOverlayShapeToFile(ov.source.style, pxW, pxH)
          if (!pngPath) {
            // sharp unavailable or degenerate size — skip gracefully.
            console.warn(`[export] shape overlay render failed for clip ${ov.id} — skipping`)
            continue
          }
        }
        if (!pngPath) continue
        allowPath(pngPath)
        const { w: wFrac, h: hFrac } = getOverlayBaseSize(ov)
        overlayPngs.set(ov.id, {
          pngPath,
          inputIdx: nextOverlayIdx++,
          startMs: ov.startMs,
          endMs: ov.endMs,
          pxW: Math.round(wFrac * canvasW),
          pxH: Math.round(hFrac * canvasH),
          clip: ov
        })
      }
    }
  } catch (err) {
    // Overlay errors must NEVER fail the whole export.
    console.warn(
      '[export] overlay pre-render encountered an error; overlays will be skipped:',
      err instanceof Error ? err.message : String(err)
    )
    overlayPngs.clear()
  }
  if (overlayPngs.size > 0) {
    console.log(`[export] overlays: ${overlayPngs.size} resolved`)
  }

  // Re-compute caption input indices now that we know overlayPngs.size. The
  // caption-render loop above assumed indices start at probedInputs.length,
  // but overlays occupy that range. Shift every captionPng's inputIdx AND
  // every step's inputIdx up by the number of overlay inputs.
  // Phase 3.9: typewriter captions have multiple steps — ALL step inputIdx
  // values must be shifted, not just the top-level cap.inputIdx.
  if (overlayPngs.size > 0 && captionPngs.size > 0) {
    for (const cap of captionPngs.values()) {
      cap.inputIdx += overlayPngs.size
      for (const step of cap.steps) {
        step.inputIdx += overlayPngs.size
      }
    }
  }

  let plan: ExportPlan
  try {
    plan = buildExportPlan(project, options.presetKey, safeOutput, {
      xfadeAvailable,
      denoiseAvailable,
      deEsserAvailable,
      hueSatAvailable,
      vidstabAvailable,
      deshakeAvailable,
      stabilizeTrfMap: stabilizeTrfMap.size > 0 ? stabilizeTrfMap : undefined,
      inputsWithAudio,
      codec: chosenCodec,
      overlayPngs: overlayPngs.size > 0 ? overlayPngs : undefined,
      captionPngs: captionPngs.size > 0 ? captionPngs : undefined
    })
  } catch (err) {
    return {
      jobId: options.jobId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      usedEncoder: chosenCodec
    }
  }

  // Allow + validate each input.
  for (const i of plan.inputs) {
    allowPath(i)
    assertPathAllowed(i, 'input')
  }

  const logPath = await writeDebugLog(plan.argv, plan.filterGraph)

  // Use the existing runner — it accepts inputs[] + filterGraph and emits
  // progress events. We pass an extraArgs subset of map flags via a small
  // shim: temporarily insert `-map` argv before spawning. Since runner's
  // buildArgv doesn't accept arbitrary -map, we spawn ourselves but reuse
  // the runner's progress-event infrastructure by going through it.
  //
  // → After review: runner.ts is rigid. For Phase 2.6 we accept duplication
  //   and spawn here directly. We still emit `ffmpeg:progress` events on the
  //   same channel so the UI binds without extra wiring.
  const result = await spawnFfmpegDirect(ffmpegPath, plan.argv, options.jobId)
  if (!result.ok) {
    return {
      jobId: options.jobId,
      ok: false,
      error: result.error ?? 'export failed',
      debugLogPath: logPath,
      usedEncoder: chosenCodec
    }
  }
  if (!existsSync(safeOutput)) {
    return {
      jobId: options.jobId,
      ok: false,
      error: 'output file missing after run',
      debugLogPath: logPath,
      usedEncoder: chosenCodec
    }
  }
  const probe = await probeOutput(ffmpegPath, safeOutput)
  const resolvedCoverMs = resolveCoverMs(project.coverMs, probe.durationMs ?? 0)
  const coverPath = await extractCoverFrame(ffmpegPath, safeOutput, resolvedCoverMs)
  return {
    jobId: options.jobId,
    ok: true,
    outputPath: safeOutput,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    vBitrate: probe.vBitrate,
    aBitrate: probe.aBitrate,
    debugLogPath: logPath,
    usedEncoder: chosenCodec,
    coverPath
  }
}

// ---------------------------------------------------------------------------
// Phase 3.28 — GIF export (2-pass: composite mp4 → palettegen/paletteuse GIF)
// ---------------------------------------------------------------------------

/**
 * GIF filter graph. Resamples to a 480 px longest-edge square, builds an
 * optimised palette from the diff stream, then uses sierra2_4a dithering with
 * rectangle diff-mode for tight per-frame deltas.
 *
 * Resolution: fit the longest edge to 480 px (portrait Reels = 480 wide);
 * the scale filter uses conditional if(gt(iw,ih),...) so it handles both
 * landscape and portrait.
 */
const GIF_FILTER =
  "fps=15,scale='if(gt(iw,ih),480,-2)':'if(gt(iw,ih),-2,480)':flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle"

/** Hard-trim GIFs longer than this to avoid enormous files. */
const GIF_MAX_DURATION_MS = 30_000

async function exportGif(
  project: Project,
  options: ExportRunOptions,
  ffmpegPath: string,
  safeGifOutput: string
): Promise<ExportRunResult> {
  // Coerce the output extension to .gif — the gif muxer is extension-selected.
  const gifExt = path.extname(safeGifOutput).toLowerCase()
  const coercedGifOutput =
    gifExt === '.gif'
      ? safeGifOutput
      : safeGifOutput.slice(0, safeGifOutput.length - gifExt.length) + '.gif'
  if (coercedGifOutput !== safeGifOutput) {
    allowPath(coercedGifOutput)
  }

  // Temp composite mp4 lives next to the gif output.
  const exportDir = path.dirname(coercedGifOutput)
  const tempVideo = path.join(exportDir, `gif-temp-${options.jobId}.mp4`)
  allowPath(tempVideo)

  const cleanupTemp = async (): Promise<void> => {
    try {
      await unlink(tempVideo)
    } catch {
      // ignore — file may not exist if pass 0 never created it
    }
  }

  // Determine total exported duration for the 30s hard-trim.
  // We walk all clips and take the maximum endMs as a proxy for total duration.
  let maxEndMs = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if ('endMs' in clip && typeof clip.endMs === 'number') {
        if (clip.endMs > maxEndMs) maxEndMs = clip.endMs
      }
    }
  }

  // Pass 0 — composite render to temp mp4.
  // Override outputPath in options so runCompositeExport writes to tempVideo.
  let composite: ExportRunResult
  try {
    composite = await runCompositeExport(
      project,
      { ...options, outputPath: tempVideo },
      tempVideo
    )
  } catch (err) {
    await cleanupTemp()
    return {
      jobId: options.jobId,
      ok: false,
      error: `GIF pass 0 (composite) threw: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  if (!composite.ok) {
    await cleanupTemp()
    return {
      jobId: options.jobId,
      ok: false,
      error: `GIF pass 0 (composite) failed: ${composite.error ?? 'unknown'}`,
      debugLogPath: composite.debugLogPath
    }
  }

  // Pass 1 — palettegen/paletteuse conversion to .gif.
  const pass1Argv: string[] = [
    '-hide_banner', '-y', '-nostdin',
    // Hard-trim to GIF_MAX_DURATION_MS when needed.
    ...(maxEndMs > GIF_MAX_DURATION_MS ? ['-t', String(GIF_MAX_DURATION_MS / 1000)] : []),
    '-i', tempVideo,
    '-filter_complex', GIF_FILTER,
    '-loop', '0',
    '-an',
    '-progress', 'pipe:2',
    '-nostats',
    coercedGifOutput
  ]

  let pass1Result: { ok: boolean; error?: string }
  try {
    pass1Result = await spawnFfmpegDirect(ffmpegPath, pass1Argv, options.jobId)
  } catch (err) {
    await cleanupTemp()
    return {
      jobId: options.jobId,
      ok: false,
      error: `GIF pass 1 (palettegen) threw: ${err instanceof Error ? err.message : String(err)}`,
      debugLogPath: composite.debugLogPath
    }
  }

  await cleanupTemp()

  if (!pass1Result.ok) {
    return {
      jobId: options.jobId,
      ok: false,
      error: `GIF pass 1 (palettegen) failed: ${pass1Result.error ?? 'unknown'}`,
      debugLogPath: composite.debugLogPath
    }
  }

  if (!existsSync(coercedGifOutput)) {
    return {
      jobId: options.jobId,
      ok: false,
      error: 'GIF output file missing after pass 1',
      debugLogPath: composite.debugLogPath
    }
  }

  const probe = await probeOutput(ffmpegPath, coercedGifOutput)
  return {
    jobId: options.jobId,
    ok: true,
    outputPath: coercedGifOutput,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    debugLogPath: composite.debugLogPath,
    usedEncoder: composite.usedEncoder
    // No coverPath for GIF.
  }
}

async function runExport(
  project: Project,
  options: ExportRunOptions
): Promise<ExportRunResult> {
  const ffmpegPath = resolveFfmpegPath()

  // Allow + validate all media input paths and the output path.
  for (const m of Object.values(project.media)) {
    if (m && typeof m.path === 'string') allowPath(m.path)
  }
  allowPath(options.outputPath)
  const safeOutput = assertPathAllowed(options.outputPath, 'output')

  // Phase 3.28 — GIF branch. Intercept before the composite path so that
  // buildExportPlan is NEVER called with 'gif'. The 5 mp4 presets continue
  // into runCompositeExport unchanged — byte-identical invariant holds.
  if (options.presetKey === 'gif') {
    return await exportGif(project, options, ffmpegPath, safeOutput)
  }

  return runCompositeExport(project, options, safeOutput)
}

// ---------------------------------------------------------------------------
// Cover-frame extraction — best-effort second pass after the main encode.
// A failure here NEVER propagates to the main export result.
// ---------------------------------------------------------------------------
async function extractCoverFrame(
  ffmpegPath: string,
  outputMp4: string,
  coverMs: number
): Promise<string | undefined> {
  try {
    const coverPath = path.join(
      path.dirname(outputMp4),
      path.basename(outputMp4, path.extname(outputMp4)) + '_cover.jpg'
    )
    allowPath(coverPath)
    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn(
        ffmpegPath,
        [
          '-hide_banner',
          '-y',
          '-ss', (coverMs / 1000).toFixed(3),
          '-i', outputMp4,
          '-frames:v', '1',
          '-q:v', '2',
          coverPath
        ],
        { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }
      )
      proc.on('error', () => resolve(false))
      proc.on('close', (code) => resolve(code === 0))
    })
    if (ok && existsSync(coverPath)) return coverPath
    return undefined
  } catch (err) {
    console.warn('[export] extractCoverFrame failed:', err)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Direct spawn — emits ffmpeg:progress events on the existing channel.
// ---------------------------------------------------------------------------
const activeExportJobs = new Map<string, ReturnType<typeof spawn>>()

function spawnFfmpegDirect(
  ffmpegPath: string,
  argv: string[],
  jobId: string
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    activeExportJobs.set(jobId, proc)
    let stderrLog = ''
    let stderrBuf = ''
    const STDERR_LOG_LIMIT = 32 * 1024
    let totalDurationMs: number | null = null
    let lastEmit = 0
    const EMIT_INTERVAL = 250
    let outTimeMs: number | undefined
    let fpsVal: number | undefined
    let speedVal: number | undefined

    const emit = (done = false, message?: string, cancelled = false): void => {
      const now = Date.now()
      if (!done && now - lastEmit < EMIT_INTERVAL) return
      lastEmit = now
      const percent =
        totalDurationMs && outTimeMs != null
          ? Math.min(100, Math.max(0, (outTimeMs / totalDurationMs) * 100))
          : 0
      try {
        // Lazy require avoids importing webContents at module load (saves
        // about 6KB and keeps unit testing simpler).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { webContents } = require('electron') as typeof import('electron')
        for (const wc of webContents.getAllWebContents()) {
          if (wc.isDestroyed()) continue
          wc.send(IPC_CHANNELS.ffmpeg.progress, {
            jobId,
            percent,
            fps: fpsVal,
            speed: speedVal,
            currentTimeMs: outTimeMs,
            done,
            cancelled,
            message
          })
        }
      } catch {
        // ignore
      }
    }

    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      stderrLog += chunk
      if (stderrLog.length > STDERR_LOG_LIMIT) {
        stderrLog = stderrLog.slice(-STDERR_LOG_LIMIT)
      }
      stderrBuf += chunk
      if (totalDurationMs == null) {
        const m = /Duration:\s+(\d+):(\d+):([\d.]+)/.exec(stderrBuf)
        if (m) {
          totalDurationMs = Math.round(
            (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
          )
        }
      }
      let idx: number
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).trim()
        stderrBuf = stderrBuf.slice(idx + 1)
        if (!line) continue
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const key = line.slice(0, eq).trim()
        const value = line.slice(eq + 1).trim()
        if (key === 'out_time_ms' || key === 'out_time_us') {
          const n = Number(value)
          if (Number.isFinite(n)) outTimeMs = Math.round(n / 1000)
        } else if (key === 'fps') {
          const n = Number(value)
          if (Number.isFinite(n)) fpsVal = n
        } else if (key === 'speed') {
          const m = /([\d.]+)x/.exec(value)
          if (m) speedVal = Number(m[1])
        }
        emit()
      }
    })
    proc.on('error', (err) => {
      activeExportJobs.delete(jobId)
      emit(true, err.message)
      resolve({ ok: false, error: err.message })
    })
    proc.on('close', (code, signal) => {
      activeExportJobs.delete(jobId)
      if (code === 0) {
        emit(true)
        resolve({ ok: true })
      } else {
        const tail = stderrLog.split(/\r?\n/).slice(-12).join('\n')
        const reason = signal ? `signal ${signal}` : `exit ${code}`
        emit(true, `ffmpeg failed (${reason})`)
        resolve({ ok: false, error: `ffmpeg failed (${reason}): ${tail}` })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// IPC registration.
// ---------------------------------------------------------------------------
export function registerExportHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.exporter.run,
    async (_event, project: Project, options: ExportRunOptions): Promise<ExportRunResult> => {
      if (!project || !options || !options.jobId || !options.outputPath) {
        return { jobId: options?.jobId ?? 'unknown', ok: false, error: 'bad arguments' }
      }
      try {
        return await runExport(project, options)
      } catch (err) {
        return {
          jobId: options.jobId,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.exporter.buildPlan,
    async (
      _event,
      project: Project,
      presetKey: ExportPresetKey,
      outputPath: string
    ): Promise<ExportBuildPlanResult> => {
      // Phase 3.28 — GIF short-circuit. buildExportPlan is NEVER called with
      // 'gif'; we return a synthetic result that describes the 2-pass approach
      // so that the diagnostic UI does not crash.
      if (presetKey === 'gif') {
        return {
          ok: true,
          argvPreview: '[GIF 2-pass: pass0=composite-mp4 pass1=palettegen/paletteuse]',
          filterGraph: GIF_FILTER,
          inputs: [],
          videoSegmentCount: 0
        }
      }
      try {
        // Allow paths so assertPathAllowed in plan can pass.
        for (const m of Object.values(project.media)) {
          if (m && typeof m.path === 'string') allowPath(m.path)
        }
        allowPath(outputPath)
        const ffmpegPath = resolveFfmpegPath()
        const xfadeAvailable = await probeXfadeAvailable(ffmpegPath)
        const hueSatAvailablePlan = await probeHueSaturationAvailable(ffmpegPath)
        const deEsserAvailablePlan = await probeDeesserAvailable(ffmpegPath)
        // Phase 3.38 — buildPlan cannot run a vidstabdetect 1st pass, so
        // vidstabAvailable=false, deshakeAvailable=true. This makes any
        // stabilize-enabled clip emit the deshake= fragment in the plan
        // preview (honest: it's the single-pass alternative). Real encode
        // uses runCompositeExport which overrides both based on live probes.
        const plan = buildExportPlan(project, presetKey, outputPath, {
          xfadeAvailable,
          hueSatAvailable: hueSatAvailablePlan,
          deEsserAvailable: deEsserAvailablePlan,
          vidstabAvailable: false,
          deshakeAvailable: true,
          stabilizeTrfMap: new Map()
        })
        return {
          ok: true,
          argvPreview: plan.argv.join(' '),
          filterGraph: plan.filterGraph,
          inputs: plan.inputs,
          videoSegmentCount: plan.videoSegmentCount
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.exporter.revealFile, async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return
    try {
      shell.showItemInFolder(filePath)
    } catch {
      // ignore
    }
  })

  ipcMain.handle(IPC_CHANNELS.exporter.openFile, async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return
    try {
      await shell.openPath(filePath)
    } catch {
      // ignore
    }
  })
}

// Test-only helpers (exported for unit / e2e via dynamic require). Keep these
// minimal so the production surface stays focused.
export const __test = {
  buildExportPlan,
  escapeDrawtext,
  atempoChain,
  denoiseChain,
  retouchChain,
  keyframeExpr,
  collectSegments,
  collectOverlays,
  stitchVideo,
  stitchVideoTrack,
  compositeLayers,
  stitchAudio,
  stitchAdjustments,
  stitchCaptions,
  stitchOverlays,
  buildTransformSubchain,
  mapPresetForCodec,
  presetFlagForCodec,
  voiceEnhanceToFfmpeg,
  getVoiceEnhance
}
