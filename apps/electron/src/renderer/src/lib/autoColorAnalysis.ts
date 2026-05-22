/**
 * Auto color correction — renderer-side frame-decode glue (Phase 3.15).
 *
 * The PURE pixel-statistics math lives in `shared/autoColor.ts` (no DOM
 * dependency, fully unit-testable). This module is the renderer-only glue: it
 * decodes a handful of frames from a clip's media via a hidden transient
 * `<video>` element, runs each through `analyzeImageData`, averages the
 * per-frame stats, and maps the result to the 4-slider `ColorAdjust`.
 *
 * Frame extraction reuses the motion-tracking `stepClipFrames` walker
 * (`tracking/frameStepper.ts`) — it handles the rVFC → `seeked` headless
 * fallback and yields decoded `ImageData`. A canvas `ImageData` structurally
 * satisfies `RgbaImage`, so it feeds straight into `analyzeImageData`.
 *
 * No IPC, no main-process change, no export change — this only produces a
 * `ColorAdjust` value that the caller writes via `applyAutoColorAdjust`.
 */
import type { ColorAdjust, VideoAudioClip } from '../../../shared/project'
import {
  analyzeImageData,
  averageFrameStats,
  statsToColorAdjust,
  statsToColorMatch,
  type FrameStats
} from '../../../shared/autoColor'
import { toMediaUrl } from './mediaUrl'
import { stepClipFrames } from './tracking/frameStepper'

/** Default number of frames sampled across the clip's trimmed range. */
const DEFAULT_FRAME_COUNT = 5

export interface ComputeAutoColorOptions {
  /** Aborts the frame walk (passed straight through to the stepper). */
  signal?: AbortSignal
  /** How many frames to sample across the trimmed range (default 5). */
  frameCount?: number
}

/**
 * Decode-and-average one clip — the shared core of auto color and color match.
 *
 * Creates a hidden transient `<video>`, waits until it is decodable, steps
 * `frameCount` frames evenly across the clip's TRIMMED source range via
 * `stepClipFrames`, runs each through `analyzeImageData`, and returns the
 * averaged `FrameStats`. The hidden video is always torn down (pause / clear
 * src / detach) before returning. Pure decode glue — produces no `ColorAdjust`.
 *
 * Throws an `Error` (Korean message) if no frame could be decoded.
 */
async function analyzeClipFrames(
  clip: VideoAudioClip,
  mediaPath: string,
  opts: ComputeAutoColorOptions = {}
): Promise<FrameStats> {
  const signal = opts.signal
  const frameCount = Math.max(1, Math.floor(opts.frameCount ?? DEFAULT_FRAME_COUNT))

  // Sample evenly across the TRIMMED source window.
  const inMs = Math.max(0, clip.trimInMs ?? 0)
  const outMs = Math.max(inMs, clip.trimOutMs ?? inMs)
  const trimmedSpanMs = Math.max(0, outMs - inMs)
  const samplePeriodMs = Math.max(1, trimmedSpanMs / frameCount)

  // --- Hidden transient <video> for analysis (NOT the PreviewCanvas video). ---
  // Mirrors the tracking store's hidden-video setup.
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.style.position = 'fixed'
  video.style.left = '-99999px'
  video.style.width = '1px'
  video.style.height = '1px'
  video.src = toMediaUrl(mediaPath)
  document.body.appendChild(video)

  try {
    // Wait until the element is decodable (readyState >= 2) before stepping.
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      if (video.readyState >= 2) {
        resolve()
        return
      }
      const onReady = (): void => {
        cleanup()
        resolve()
      }
      const onError = (): void => {
        cleanup()
        reject(new Error('영상을 불러오지 못했습니다'))
      }
      const onAbort = (): void => {
        cleanup()
        reject(new DOMException('aborted', 'AbortError'))
      }
      const cleanup = (): void => {
        video.removeEventListener('loadeddata', onReady)
        video.removeEventListener('error', onError)
        signal?.removeEventListener('abort', onAbort)
      }
      video.addEventListener('loadeddata', onReady, { once: true })
      video.addEventListener('error', onError, { once: true })
      signal?.addEventListener('abort', onAbort, { once: true })
    })

    // Step frames across the trimmed range, collecting up to `frameCount` stats.
    const collected: FrameStats[] = []
    for await (const { frame } of stepClipFrames(video, clip, {
      signal,
      samplePeriodMs
    })) {
      collected.push(analyzeImageData(frame))
      if (collected.length >= frameCount) break
    }

    if (collected.length === 0) {
      throw new Error('프레임을 읽지 못했습니다')
    }

    return averageFrameStats(collected)
  } finally {
    // Always tear the hidden video down — pause, clear src, detach.
    try {
      video.pause()
      video.removeAttribute('src')
      video.load()
      video.remove()
    } catch {
      /* defensive — element may already be detached */
    }
  }
}

/**
 * Analyze `clip`'s media and return a tasteful `ColorAdjust` for the existing
 * 4 sliders. Samples `frameCount` frames evenly across the clip's TRIMMED
 * source range, averages their pixel statistics, and maps to slider values.
 *
 * Throws an `Error` (Korean message) if no frame could be decoded.
 */
export async function computeAutoColorAdjust(
  clip: VideoAudioClip,
  mediaPath: string,
  opts: ComputeAutoColorOptions = {}
): Promise<ColorAdjust> {
  return statsToColorAdjust(await analyzeClipFrames(clip, mediaPath, opts))
}

/**
 * Color match — grade `targetClip` toward a REFERENCE clip's look. Decodes and
 * averages frame statistics from BOTH clips (sequentially — one hidden
 * `<video>` at a time, target then reference), then maps the pair through
 * `statsToColorMatch` to a `ColorAdjust` that makes the target resemble the
 * reference.
 *
 * The same `AbortSignal` is threaded into both decode passes; the reference
 * pass is skipped if the signal is already aborted by the time the target pass
 * finishes.
 *
 * NOTE: this matches the reference clip's RAW decoded footage — any grade
 * already applied to the reference clip in the editor (a CSS-only preview
 * filter) is NOT reflected in its decoded pixels, so it does not influence the
 * match.
 *
 * Throws an `Error` (Korean message) if no frame could be decoded from either
 * clip.
 */
export async function computeColorMatchAdjust(
  targetClip: VideoAudioClip,
  targetPath: string,
  refClip: VideoAudioClip,
  refPath: string,
  opts: ComputeAutoColorOptions = {}
): Promise<ColorAdjust> {
  const targetStats = await analyzeClipFrames(targetClip, targetPath, opts)
  if (opts.signal?.aborted) {
    throw new DOMException('aborted', 'AbortError')
  }
  const referenceStats = await analyzeClipFrames(refClip, refPath, opts)
  return statsToColorMatch(targetStats, referenceStats)
}
