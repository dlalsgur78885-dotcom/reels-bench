/**
 * Phase 3.13 — motion-tracking Web Worker.
 *
 * A renderer-side NCC (normalized cross-correlation) template-matching tracker.
 * NO new npm dependency — pure ImageData math.
 *
 * Algorithm (see `NccTracker` below):
 *  - `init`: downscale the first frame to ~640px longest edge, extract the
 *    grayscale reference patch inside the user-drawn box, remember its
 *    normalized center.
 *  - each `frame`: downscale, search a bounded window around the last known
 *    position for the integer offset whose patch best NCC-correlates with the
 *    template; optional coarse 0.9/1.0/1.1× multi-scale pass recovers `scale`.
 *  - report a confidence (the peak NCC value, 0..1). When confidence stays
 *    below a floor for several consecutive frames the object is considered
 *    lost — the track is finished as `'partial'`.
 *  - the template is periodically refreshed toward the current patch so slow
 *    appearance changes (lighting, slight rotation) don't drift the tracker.
 *
 * The `Tracker` interface keeps the matcher swappable: a heavier tracker
 * (optical flow, a WASM model) can replace `NccTracker` without touching the
 * message protocol.
 *
 * Caller wiring (see store/tracking.ts):
 *   new Worker(new URL('./trackerWorker.ts', import.meta.url), { type:'module' })
 * Vite (electron-vite renderer build) bundles this URL form into its own
 * worker chunk automatically — no electron.vite.config change required.
 */

import type { MotionTrackStatus, TrackPoint } from '../../../../shared/project'

// ---------------------------------------------------------------------------
// Message protocol (mirrors the harness contract exactly).
// ---------------------------------------------------------------------------
export type TrackerInMsg =
  | {
      type: 'init'
      rect: { x: number; y: number; w: number; h: number }
      frame: ImageData
      /** Optional expected total frame count — drives the progress %. */
      expectedFrames?: number
    }
  | { type: 'frame'; atMs: number; frame: ImageData }
  | { type: 'finish' }
  | { type: 'cancel' }

export type TrackerOutMsg =
  | { type: 'progress'; percent: number; atMs: number }
  | { type: 'point'; point: TrackPoint; confidence: number }
  | { type: 'done'; status: MotionTrackStatus }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Tracker abstraction — keeps the NCC matcher swappable.
// ---------------------------------------------------------------------------

/** One tracker update result. x/y are canvas-relative center fractions. */
export interface TrackerResult {
  x: number
  y: number
  scale: number
  /** Peak NCC correlation, 0..1. Higher = more confident. */
  confidence: number
}

export interface Tracker {
  /** Seed the template from the user-drawn box on the first frame. */
  init(firstFrame: ImageData, rect: { x: number; y: number; w: number; h: number }): void
  /** Track the object into a subsequent frame. */
  update(frame: ImageData): TrackerResult
}

// ---------------------------------------------------------------------------
// Tuning constants.
// ---------------------------------------------------------------------------
/** Longest-edge target for the downscaled working frame (speed). */
const WORK_MAX_EDGE = 640
/** Search window half-size as a fraction of the patch size (each axis). */
const SEARCH_RADIUS_FRAC = 0.6
/** Hard cap on the search window half-size in working px. */
const SEARCH_RADIUS_MAX = 48
/** NCC peak below this counts as a "low-confidence" frame. */
const CONFIDENCE_FLOOR = 0.4
/** Consecutive low-confidence frames before the object is declared lost. */
const LOST_STREAK_LIMIT = 6
/** Template refresh: blend factor toward the current patch when confident. */
const TEMPLATE_REFRESH_ALPHA = 0.15
/** Only refresh the template when the peak NCC is at least this strong. */
const TEMPLATE_REFRESH_MIN_CONF = 0.7
/** Coarse multi-scale candidates for `scale` recovery (nice-to-have). */
const SCALE_CANDIDATES = [0.9, 1.0, 1.1] as const
/** Patch is sampled on a fixed grid of this many cells per axis (cheap NCC). */
const PATCH_GRID = 24

/** A grayscale patch sampled on a fixed PATCH_GRID×PATCH_GRID grid. */
interface GrayPatch {
  /** PATCH_GRID*PATCH_GRID grayscale samples (0..255). */
  data: Float32Array
  /** Mean of `data`. */
  mean: number
  /** sqrt(sum((v-mean)^2)) — the L2 norm of the zero-mean patch. */
  norm: number
}

/** A downscaled grayscale working frame. */
interface GrayFrame {
  data: Float32Array
  width: number
  height: number
}

// ---------------------------------------------------------------------------
// Frame helpers.
// ---------------------------------------------------------------------------

/** Downscale an ImageData to a grayscale Float32 buffer (~WORK_MAX_EDGE edge). */
function toGrayFrame(img: ImageData): GrayFrame {
  const longest = Math.max(img.width, img.height)
  const k = longest > WORK_MAX_EDGE ? WORK_MAX_EDGE / longest : 1
  const w = Math.max(1, Math.round(img.width * k))
  const h = Math.max(1, Math.round(img.height * k))
  const out = new Float32Array(w * h)
  const src = img.data
  const sw = img.width
  // Nearest-neighbour sampling — fast and good enough for template matching.
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / k))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / k))
      const i = (sy * sw + sx) * 4
      // Rec.601 luma.
      out[y * w + x] =
        0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]
    }
  }
  return { data: out, width: w, height: h }
}

/**
 * Sample a PATCH_GRID×PATCH_GRID grayscale patch from `frame`, centered at
 * (cxFrac,cyFrac) (frame-relative fractions), spanning wFrac×hFrac of the
 * frame. Returns null when the box would fall fully outside the frame.
 */
function samplePatch(
  frame: GrayFrame,
  cxFrac: number,
  cyFrac: number,
  wFrac: number,
  hFrac: number
): GrayPatch | null {
  const fw = frame.width
  const fh = frame.height
  const halfW = (wFrac * fw) / 2
  const halfH = (hFrac * fh) / 2
  const cx = cxFrac * fw
  const cy = cyFrac * fh
  if (halfW < 0.5 || halfH < 0.5) return null
  const data = new Float32Array(PATCH_GRID * PATCH_GRID)
  let sum = 0
  for (let gy = 0; gy < PATCH_GRID; gy++) {
    // Map grid cell center → frame px.
    const fy = cy - halfH + ((gy + 0.5) / PATCH_GRID) * (2 * halfH)
    const sy = Math.min(fh - 1, Math.max(0, Math.round(fy)))
    for (let gx = 0; gx < PATCH_GRID; gx++) {
      const fx = cx - halfW + ((gx + 0.5) / PATCH_GRID) * (2 * halfW)
      const sx = Math.min(fw - 1, Math.max(0, Math.round(fx)))
      const v = frame.data[sy * fw + sx]
      data[gy * PATCH_GRID + gx] = v
      sum += v
    }
  }
  const mean = sum / data.length
  let sq = 0
  for (let i = 0; i < data.length; i++) {
    const d = data[i] - mean
    sq += d * d
  }
  const norm = Math.sqrt(sq)
  return { data, mean, norm }
}

/** Normalized cross-correlation of two equally-shaped patches, in [-1, 1]. */
function ncc(a: GrayPatch, b: GrayPatch): number {
  if (a.norm < 1e-6 || b.norm < 1e-6) return 0
  let dot = 0
  const an = a.mean
  const bn = b.mean
  for (let i = 0; i < a.data.length; i++) {
    dot += (a.data[i] - an) * (b.data[i] - bn)
  }
  return dot / (a.norm * b.norm)
}

// ---------------------------------------------------------------------------
// NccTracker — the default template-matching tracker.
// ---------------------------------------------------------------------------
class NccTracker implements Tracker {
  /** Reference template (refreshed slowly while confident). */
  private template: GrayPatch | null = null
  /** Last known object center (canvas-relative fractions). */
  private cx = 0.5
  private cy = 0.5
  /** Object box size as canvas-relative fractions (from sourceRect). */
  private wFrac = 0.1
  private hFrac = 0.1
  /** Current scale multiplier vs. the source box. */
  private scale = 1

  init(
    firstFrame: ImageData,
    rect: { x: number; y: number; w: number; h: number }
  ): void {
    const frame = toGrayFrame(firstFrame)
    this.cx = rect.x + rect.w / 2
    this.cy = rect.y + rect.h / 2
    this.wFrac = Math.max(0.01, rect.w)
    this.hFrac = Math.max(0.01, rect.h)
    this.scale = 1
    this.template = samplePatch(frame, this.cx, this.cy, this.wFrac, this.hFrac)
  }

  update(frame: ImageData): TrackerResult {
    const gray = toGrayFrame(frame)
    const tpl = this.template
    if (!tpl) {
      // Not initialized — treat as a total miss.
      return { x: this.cx, y: this.cy, scale: this.scale, confidence: 0 }
    }
    const fw = gray.width
    const fh = gray.height
    // Effective box size at the current scale.
    const curW = this.wFrac * this.scale
    const curH = this.hFrac * this.scale
    // Search window: bounded fraction of the patch size, capped.
    const radiusX = Math.min(
      SEARCH_RADIUS_MAX,
      Math.max(2, Math.round(curW * fw * SEARCH_RADIUS_FRAC))
    )
    const radiusY = Math.min(
      SEARCH_RADIUS_MAX,
      Math.max(2, Math.round(curH * fh * SEARCH_RADIUS_FRAC))
    )
    // Step in px — coarse for large windows to stay cheap, 1px for small.
    const stepX = radiusX > 16 ? 2 : 1
    const stepY = radiusY > 16 ? 2 : 1

    let bestNcc = -2
    let bestCx = this.cx
    let bestCy = this.cy
    let bestScale = this.scale

    const baseCxPx = this.cx * fw
    const baseCyPx = this.cy * fh

    for (const sc of SCALE_CANDIDATES) {
      const testW = this.wFrac * this.scale * sc
      const testH = this.hFrac * this.scale * sc
      for (let dy = -radiusY; dy <= radiusY; dy += stepY) {
        const cyPx = baseCyPx + dy
        const cyFrac = cyPx / fh
        if (cyFrac < 0 || cyFrac > 1) continue
        for (let dx = -radiusX; dx <= radiusX; dx += stepX) {
          const cxPx = baseCxPx + dx
          const cxFrac = cxPx / fw
          if (cxFrac < 0 || cxFrac > 1) continue
          const cand = samplePatch(gray, cxFrac, cyFrac, testW, testH)
          if (!cand) continue
          const score = ncc(tpl, cand)
          if (score > bestNcc) {
            bestNcc = score
            bestCx = cxFrac
            bestCy = cyFrac
            bestScale = this.scale * sc
          }
        }
      }
    }

    // Confidence is the peak NCC clamped into [0,1].
    const confidence = Math.max(0, Math.min(1, bestNcc))
    this.cx = bestCx
    this.cy = bestCy
    this.scale = bestScale > 0 ? bestScale : this.scale

    // Slow template refresh while strongly locked on — absorbs gradual
    // appearance change without letting a single bad frame poison it.
    if (confidence >= TEMPLATE_REFRESH_MIN_CONF) {
      const fresh = samplePatch(
        gray,
        this.cx,
        this.cy,
        this.wFrac * this.scale,
        this.hFrac * this.scale
      )
      if (fresh && fresh.norm > 1e-6) {
        const blended = new Float32Array(tpl.data.length)
        for (let i = 0; i < blended.length; i++) {
          blended[i] =
            tpl.data[i] * (1 - TEMPLATE_REFRESH_ALPHA) +
            fresh.data[i] * TEMPLATE_REFRESH_ALPHA
        }
        let sum = 0
        for (let i = 0; i < blended.length; i++) sum += blended[i]
        const mean = sum / blended.length
        let sq = 0
        for (let i = 0; i < blended.length; i++) {
          const d = blended[i] - mean
          sq += d * d
        }
        this.template = { data: blended, mean, norm: Math.sqrt(sq) }
      }
    }

    return { x: this.cx, y: this.cy, scale: this.scale, confidence }
  }
}

// ---------------------------------------------------------------------------
// Worker session — owns the tracker + lifecycle state for one job.
// ---------------------------------------------------------------------------
let tracker: Tracker | null = null
let lostStreak = 0
let started = false
/** Estimated total frame count for the progress percentage (best-effort). */
let totalFrames = 0
let processedFrames = 0
let cancelled = false

function post(msg: TrackerOutMsg): void {
  ;(self as unknown as Worker).postMessage(msg)
}

function reset(): void {
  tracker = null
  lostStreak = 0
  started = false
  totalFrames = 0
  processedFrames = 0
  cancelled = false
}

self.onmessage = (ev: MessageEvent<TrackerInMsg>): void => {
  const msg = ev.data
  try {
    switch (msg.type) {
      case 'init': {
        reset()
        tracker = new NccTracker()
        tracker.init(msg.frame, msg.rect)
        started = true
        totalFrames = Math.max(0, Math.floor(msg.expectedFrames ?? 0))
        // Emit the seed point at atMs 0 with full confidence — the template
        // matches itself exactly, by definition.
        post({
          type: 'point',
          point: {
            atMs: 0,
            x: msg.rect.x + msg.rect.w / 2,
            y: msg.rect.y + msg.rect.h / 2,
            scale: 1
          },
          confidence: 1
        })
        break
      }
      case 'frame': {
        if (cancelled) return
        if (!tracker || !started) {
          post({ type: 'error', message: 'tracker not initialized' })
          return
        }
        const res = tracker.update(msg.frame)
        processedFrames++
        post({
          type: 'point',
          point: {
            atMs: Math.max(0, msg.atMs),
            x: res.x,
            y: res.y,
            scale: res.scale
          },
          confidence: res.confidence
        })
        if (res.confidence < CONFIDENCE_FLOOR) {
          lostStreak++
        } else {
          lostStreak = 0
        }
        // Best-effort progress: the caller updates `totalFrames` via the
        // estimate baked into the first frame's atMs cadence; if unknown we
        // just report processed-count growth capped at 99%.
        const pct =
          totalFrames > 0
            ? Math.min(99, Math.round((processedFrames / totalFrames) * 100))
            : Math.min(99, processedFrames)
        post({ type: 'progress', percent: pct, atMs: Math.max(0, msg.atMs) })
        if (lostStreak >= LOST_STREAK_LIMIT) {
          // Object lost / occluded / left frame — stop early as 'partial'.
          post({ type: 'done', status: 'partial' })
          reset()
        }
        break
      }
      case 'finish': {
        if (cancelled) return
        // Reached the clip end with the object still tracked → complete.
        post({ type: 'done', status: started ? 'complete' : 'failed' })
        reset()
        break
      }
      case 'cancel': {
        cancelled = true
        reset()
        break
      }
      default: {
        post({ type: 'error', message: 'unknown message' })
      }
    }
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
    reset()
  }
}
