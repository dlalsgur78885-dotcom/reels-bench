/**
 * Phase 3.13 — frame stepper for motion tracking.
 *
 * Walks a clip's <video> element frame-by-frame and yields one decoded
 * `ImageData` per sample. Each step:
 *   1. set `video.currentTime` to the next sample time;
 *   2. await the next `requestVideoFrameCallback` (rVFC) — which fires once the
 *      browser has actually presented a new frame;
 *   3. read the rVFC metadata's `mediaTime` for the ACTUAL presented timestamp
 *      (this — not the requested time — becomes `TrackPoint.atMs`);
 *   4. `drawImage` the element onto an offscreen canvas and `getImageData`.
 *
 * Sampling is bounded by the clip's TRIMMED source window and spaced at
 * roughly `DEFAULT_TRACK_SAMPLE_PERIOD_MS`. An `AbortSignal` aborts mid-walk.
 *
 * rVFC is Chromium-native (Electron renderer) so no polyfill is needed; we
 * only declare the type locally since it isn't in the default DOM lib.
 */

import {
  DEFAULT_TRACK_SAMPLE_PERIOD_MS,
  type VideoAudioClip
} from '../../../../shared/project'

// ---------------------------------------------------------------------------
// `requestVideoFrameCallback` typing. The current TS DOM lib already declares
// `requestVideoFrameCallback` / `cancelVideoFrameCallback` on HTMLVideoElement,
// so we reuse the lib's metadata type and only treat the methods as possibly
// absent at RUNTIME (older / non-Chromium environments) without re-declaring
// them (re-declaring as optional conflicts with the lib's non-optional decl).
// ---------------------------------------------------------------------------

/** One decoded sample yielded by the stepper. */
export interface SteppedFrame {
  /** Clip-RELATIVE presented timestamp in ms (from the rVFC `mediaTime`). */
  atMs: number
  /** Decoded RGBA pixels of the presented frame. */
  frame: ImageData
}

export interface StepClipOptions {
  /** Aborts the walk between samples. */
  signal?: AbortSignal
  /** Sample spacing in ms — defaults to DEFAULT_TRACK_SAMPLE_PERIOD_MS. */
  samplePeriodMs?: number
  /**
   * Downscale cap for the offscreen capture canvas (longest edge). The worker
   * downsamples again internally; capping here keeps getImageData cheap.
   */
  maxCaptureEdge?: number
}

/** Default longest-edge cap for the capture canvas. */
const DEFAULT_CAPTURE_EDGE = 960

/** Resolve the clip's trimmed SOURCE window in ms (what the tracker sees). */
function trimmedSourceWindow(clip: VideoAudioClip): {
  startSec: number
  endSec: number
} {
  const inMs = Math.max(0, clip.trimInMs ?? 0)
  const outMs = clip.trimOutMs ?? inMs
  const endMs = Math.max(inMs, outMs)
  return { startSec: inMs / 1000, endSec: endMs / 1000 }
}

/** Estimate how many samples a full walk of `clip` will yield. */
export function estimateFrameCount(
  clip: VideoAudioClip,
  samplePeriodMs: number = DEFAULT_TRACK_SAMPLE_PERIOD_MS
): number {
  const { startSec, endSec } = trimmedSourceWindow(clip)
  const spanMs = Math.max(0, (endSec - startSec) * 1000)
  return Math.max(1, Math.floor(spanMs / Math.max(1, samplePeriodMs)))
}

/**
 * How long to wait for `requestVideoFrameCallback` to fire before falling
 * back to the `seeked`-event path. rVFC requires the compositor to actually
 * present a frame to the display pipeline. In headless Electron (CI / test
 * environment) the compositor does not render, so rVFC never fires even
 * though it is registered successfully. The real visible-window app sees rVFC
 * fire within ~1 compositor tick (~16 ms), so a 200 ms timeout is
 * effectively instant in production while reliably unblocking the headless
 * path (video seeks still complete quickly in headless).
 */
const RVFC_TIMEOUT_MS = 200

/** Synthesize a VideoFrameCallbackMetadata-shaped object from currentTime. */
function syntheticMetadata(video: HTMLVideoElement): VideoFrameCallbackMetadata {
  const now = performance.now()
  return {
    mediaTime: video.currentTime,
    presentedFrames: 0,
    width: video.videoWidth,
    height: video.videoHeight,
    presentationTime: now,
    expectedDisplayTime: now
  } as VideoFrameCallbackMetadata
}

/** Wait for the next presented video frame; resolve with its metadata. */
function nextPresentedFrame(
  video: HTMLVideoElement,
  signal?: AbortSignal
): Promise<VideoFrameCallbackMetadata> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }

    // -----------------------------------------------------------------------
    // seeked-only fallback — used when rVFC is not available (older env).
    // -----------------------------------------------------------------------
    const waitForSeeked = (): void => {
      // If the video is already at a seeked position (readyState >= 2 AND
      // the seek already completed), resolve immediately.
      if (video.readyState >= 2 && !video.seeking) {
        resolve(syntheticMetadata(video))
        return
      }
      const onSeeked = (): void => {
        cleanup()
        resolve(syntheticMetadata(video))
      }
      const onAbort = (): void => {
        cleanup()
        reject(new DOMException('aborted', 'AbortError'))
      }
      const cleanup = (): void => {
        video.removeEventListener('seeked', onSeeked)
        signal?.removeEventListener('abort', onAbort)
      }
      video.addEventListener('seeked', onSeeked, { once: true })
      signal?.addEventListener('abort', onAbort, { once: true })
    }

    if (typeof video.requestVideoFrameCallback !== 'function') {
      waitForSeeked()
      return
    }

    // -----------------------------------------------------------------------
    // rVFC path — with a timeout fallback for headless / background-tab
    // environments where the compositor does not present frames.
    // -----------------------------------------------------------------------
    let handle = 0
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let settled = false

    const settle = (meta: VideoFrameCallbackMetadata): void => {
      if (settled) return
      settled = true
      if (timeoutId !== null) clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
      resolve(meta)
    }

    const onAbort = (): void => {
      if (settled) return
      settled = true
      if (timeoutId !== null) clearTimeout(timeoutId)
      if (handle && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(handle)
      }
      reject(new DOMException('aborted', 'AbortError'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    handle = video.requestVideoFrameCallback((_now, metadata) => {
      settle(metadata)
    })

    // If rVFC has not fired within RVFC_TIMEOUT_MS, the compositor is not
    // presenting (headless or hidden window). Cancel the rVFC registration
    // and fall back to a seeked-event wait so the stepper can continue.
    timeoutId = setTimeout(() => {
      timeoutId = null
      if (settled) return
      // Cancel the pending rVFC registration.
      if (handle && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(handle)
      }
      signal?.removeEventListener('abort', onAbort)
      settled = true // prevent double-settle from this point

      // Now wait for seeked (or resolve immediately if already ready).
      if (video.readyState >= 2 && !video.seeking) {
        resolve(syntheticMetadata(video))
        return
      }
      const onSeeked2 = (): void => {
        video.removeEventListener('seeked', onSeeked2)
        signal?.removeEventListener('abort', onAbort2)
        resolve(syntheticMetadata(video))
      }
      const onAbort2 = (): void => {
        video.removeEventListener('seeked', onSeeked2)
        signal?.removeEventListener('abort', onAbort2)
        reject(new DOMException('aborted', 'AbortError'))
      }
      video.addEventListener('seeked', onSeeked2, { once: true })
      signal?.addEventListener('abort', onAbort2, { once: true })
    }, RVFC_TIMEOUT_MS)
  })
}

/**
 * Async-iterate a clip's frames. Each yielded `SteppedFrame.atMs` is
 * CLIP-RELATIVE (rVFC `mediaTime` minus the trim-in offset), so it drops
 * straight into a `TrackPoint`.
 *
 * The caller is responsible for the `<video>` element being attached to the
 * correct media source and ready (`readyState >= 2`).
 */
export async function* stepClipFrames(
  video: HTMLVideoElement,
  clip: VideoAudioClip,
  opts: StepClipOptions = {}
): AsyncGenerator<SteppedFrame, void, void> {
  const signal = opts.signal
  const samplePeriodMs = Math.max(
    1,
    opts.samplePeriodMs ?? DEFAULT_TRACK_SAMPLE_PERIOD_MS
  )
  const { startSec, endSec } = trimmedSourceWindow(clip)

  // Offscreen capture canvas — sized to the (capped) source resolution.
  const vw = video.videoWidth || 1280
  const vh = video.videoHeight || 720
  const longest = Math.max(vw, vh)
  const cap = Math.max(64, opts.maxCaptureEdge ?? DEFAULT_CAPTURE_EDGE)
  const k = longest > cap ? cap / longest : 1
  const cw = Math.max(2, Math.round(vw * k))
  const ch = Math.max(2, Math.round(vh * k))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D context unavailable for frame capture')

  // Walk source time from trim-in to trim-out at the sample cadence.
  let targetSec = startSec
  // Guard against infinite loops if rVFC stalls — never step more frames
  // than ~1.5× the estimate.
  const maxSteps = Math.ceil(((endSec - startSec) * 1000) / samplePeriodMs) + 8

  for (let step = 0; step < maxSteps && targetSec <= endSec + 1e-3; step++) {
    if (signal?.aborted) return
    try {
      video.currentTime = targetSec
    } catch {
      return
    }
    let meta: VideoFrameCallbackMetadata
    try {
      meta = await nextPresentedFrame(video, signal)
    } catch {
      // Aborted, or no frame arrived — stop the walk.
      return
    }
    if (signal?.aborted) return

    ctx.drawImage(video, 0, 0, cw, ch)
    let frame: ImageData
    try {
      frame = ctx.getImageData(0, 0, cw, ch)
    } catch {
      // Tainted canvas etc. — bail rather than yield garbage.
      return
    }

    // The ACTUAL presented timestamp (mediaTime) — clip-relative.
    const presentedSec = Number.isFinite(meta.mediaTime)
      ? meta.mediaTime
      : targetSec
    const atMs = Math.max(0, Math.round((presentedSec - startSec) * 1000))
    yield { atMs, frame }

    // Advance from the ACTUAL presented time so cadence stays honest even
    // when the decoder snapped to a nearby keyframe.
    targetSec = presentedSec + samplePeriodMs / 1000
  }
}
