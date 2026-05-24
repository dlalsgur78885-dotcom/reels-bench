/**
 * Phase 3.52 — Auto-Reframe.
 *
 * Detects faces in each video clip's media via MediaPipe FaceDetector
 * (lazy-loaded from CDN), then writes per-clip `transformKeyframes` that
 * translate the clip's COVER-fit rendition so the face stays centered (or
 * shifted to a rule-of-thirds target) inside the project canvas.
 *
 * Architecture mirrors `autoEdit.ts`:
 *   - `runAutoReframe(opts, cb)` is the orchestrator; it pauses zundo's
 *     temporal sub-store and pushes ONE snapshot back so the whole pass is a
 *     single undo step.
 *   - Frame stepping reuses `tracking/frameStepper.stepClipFrames` (rVFC + a
 *     headless `seeked` fallback).
 *   - The MediaPipe detector is lazy-loaded from a CDN and memoized per
 *     module load; tests inject a `__reelsAutoReframeMockDetector` window
 *     hook to bypass the real model.
 *
 * The PURE math (`computeReframeTransform`, `stitchFaceTrack`,
 * `buildKeyframesFromTrack`) is DOM-free and unit-tested directly.
 *
 * Renderer-only — no main / shared / IPC change.
 */
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import {
  isClipLocked,
  isMediaClip,
  type ClipTransform,
  type Project,
  type TransformKeyframe,
  type VideoAudioClip
} from '../../../shared/project'
import { useProjectStore } from '../store/project'
import { toMediaUrl } from './mediaUrl'
import { stepClipFrames } from './tracking/frameStepper'

// ---------------------------------------------------------------------------
// MediaPipe detector — lazy CDN load + reset-on-failure.
// ---------------------------------------------------------------------------

const BLAZE_FACE_SHORT_RANGE_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
const WASM_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'

let detectorPromise: Promise<FaceDetector> | null = null

async function getDetector(): Promise<FaceDetector> {
  if (detectorPromise) return detectorPromise
  detectorPromise = (async (): Promise<FaceDetector> => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_CDN)
    return FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: BLAZE_FACE_SHORT_RANGE_URL,
        delegate: 'GPU'
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.4
    })
  })().catch((err) => {
    // Reset so the next call retries. Otherwise a transient network error
    // would permanently break the feature.
    detectorPromise = null
    throw err
  })
  return detectorPromise
}

/** For tests — drop the cached detector so the next run re-loads. */
export function disposeAutoReframeDetector(): void {
  if (detectorPromise) {
    detectorPromise
      .then((d) => {
        try {
          d.close()
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* ignore */
      })
  }
  detectorPromise = null
}

// ---------------------------------------------------------------------------
// Pure math (DOM-free, unit-testable).
// ---------------------------------------------------------------------------

/** One face detection scaled into [0,1] of the SOURCE-frame coordinate. */
export interface FaceBox {
  /** Face center, fraction of source width (0=left edge, 1=right edge). */
  xFrac: number
  /** Face center, fraction of source height (0=top, 1=bottom). */
  yFrac: number
  /** Face area / source area, in [0,1]. */
  areaFrac: number
  /** Detector score (already filtered above minDetectionConfidence). */
  score: number
}

/** A per-frame face sample (with `null` when no face was found that frame). */
export interface FaceFrameSample {
  atMs: number
  face: FaceBox | null
}

/**
 * Map a face position in the SOURCE frame to a `ClipTransform` that keeps
 * that face at `target` (default canvas center) once the clip's COVER fit
 * is applied.
 *
 * Coordinate model — the editor's `ClipTransform.x`/`y` are FRACTIONS of the
 * canvas (1.0 = full canvas width / height of translation). The clip is
 * rendered cover-fit to the canvas, so we first compute the cover scale
 * (max ratio so the source fully covers the canvas), then compute the
 * fractional shift that lands the face on the target.
 */
export function computeReframeTransform(
  source: { width: number; height: number },
  canvas: { width: number; height: number },
  face: { xFrac: number; yFrac: number },
  target: { x: number; y: number } = { x: 0.5, y: 0.5 }
): ClipTransform {
  const Sw = Math.max(1, source.width)
  const Sh = Math.max(1, source.height)
  const Cw = Math.max(1, canvas.width)
  const Ch = Math.max(1, canvas.height)

  const containK = Math.min(Cw / Sw, Ch / Sh)
  const coverK = Math.max(Cw / Sw, Ch / Sh)
  const scale = coverK / containK // >= 1 — the extra zoom cover applies

  const SwCov = Sw * coverK
  const ShCov = Sh * coverK

  // Offset that lands `face` on `target` in canvas-fraction units.
  let xFrac = target.x - 0.5 - (face.xFrac - 0.5) * (SwCov / Cw)
  let yFrac = target.y - 0.5 - (face.yFrac - 0.5) * (ShCov / Ch)

  // Clamp so the cover never reveals gutters.
  const xSlack = (SwCov - Cw) / (2 * Cw)
  const ySlack = (ShCov - Ch) / (2 * Ch)
  // If there's no slack on an axis (axis perfectly fits) the shift collapses.
  const xSlackAbs = Math.max(0, xSlack)
  const ySlackAbs = Math.max(0, ySlack)
  xFrac = Math.max(-xSlackAbs, Math.min(xSlackAbs, xFrac))
  yFrac = Math.max(-ySlackAbs, Math.min(ySlackAbs, yFrac))

  return {
    x: xFrac,
    y: yFrac,
    scale,
    rotation: 0,
    opacity: 1
  }
}

/** Detection algorithm uses Euclidean distance in source-fraction space. */
const MAX_TRACK_JUMP_FRAC = 0.25

/**
 * Greedy stitching: for each frame, pick the detection whose center is
 * closest to the previous chosen face (within `MAX_TRACK_JUMP_FRAC`). The
 * first frame picks the LARGEST detection. Returns an array (same length
 * as input) with `null` for frames where the closest face exceeded the
 * jump cap (treated as a missed frame; later interpolation may fill it).
 */
export function stitchFaceTrack(
  perFrame: ReadonlyArray<{ atMs: number; faces: FaceBox[] }>
): FaceFrameSample[] {
  const out: FaceFrameSample[] = []
  let prev: FaceBox | null = null
  for (const f of perFrame) {
    if (f.faces.length === 0) {
      out.push({ atMs: f.atMs, face: null })
      continue
    }
    let chosen: FaceBox | null = null
    if (prev === null) {
      // First valid frame — biggest face wins.
      chosen = f.faces.reduce(
        (best, cur) => (cur.areaFrac > best.areaFrac ? cur : best),
        f.faces[0]
      )
    } else {
      // Subsequent — closest to previous chosen, within the jump cap.
      let bestDist = Infinity
      for (const cand of f.faces) {
        const dx = cand.xFrac - prev.xFrac
        const dy = cand.yFrac - prev.yFrac
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < bestDist) {
          bestDist = d
          chosen = cand
        }
      }
      if (bestDist > MAX_TRACK_JUMP_FRAC) chosen = null
    }
    out.push({ atMs: f.atMs, face: chosen })
    if (chosen) prev = chosen
  }
  // Drop leading/trailing nulls (no in-between interpolation guesses).
  let start = 0
  while (start < out.length && out[start].face === null) start += 1
  let end = out.length - 1
  while (end >= 0 && out[end].face === null) end -= 1
  if (end < start) return []
  const trimmed = out.slice(start, end + 1)
  // Linear-interpolate single-frame nulls between two valid neighbors.
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i].face !== null) continue
    // find next valid
    let j = i + 1
    while (j < trimmed.length && trimmed[j].face === null) j += 1
    if (j >= trimmed.length) break
    const left = trimmed[i - 1]?.face
    const right = trimmed[j].face
    if (!left || !right) {
      i = j - 1
      continue
    }
    const span = j - i + 1 // frames between left and right (inclusive)
    for (let k = i; k < j; k++) {
      const t = (k - (i - 1)) / span
      trimmed[k] = {
        atMs: trimmed[k].atMs,
        face: {
          xFrac: left.xFrac + (right.xFrac - left.xFrac) * t,
          yFrac: left.yFrac + (right.yFrac - left.yFrac) * t,
          areaFrac: left.areaFrac + (right.areaFrac - left.areaFrac) * t,
          score: Math.min(left.score, right.score)
        }
      }
    }
    i = j - 1
  }
  return trimmed
}

/** Identity-transform near-zero deltas — within this is a no-op keyframe. */
const IDENTITY_EPSILON = 0.005

function isNearIdentity(t: ClipTransform): boolean {
  return (
    Math.abs(t.x) < IDENTITY_EPSILON &&
    Math.abs(t.y) < IDENTITY_EPSILON &&
    Math.abs(t.scale - 1) < IDENTITY_EPSILON
  )
}

/**
 * Build `transformKeyframes` from a stitched face track. Returns `[]` when
 * the resulting curve never deviates from identity beyond `IDENTITY_EPSILON`
 * (e.g. same-aspect source + canvas with a near-centered face — a no-op
 * clip whose export is byte-identical).
 */
export function buildKeyframesFromTrack(
  track: ReadonlyArray<FaceFrameSample>,
  source: { width: number; height: number },
  canvas: { width: number; height: number },
  target: { x: number; y: number } = { x: 0.5, y: 0.5 }
): TransformKeyframe[] {
  const raw: TransformKeyframe[] = []
  for (const s of track) {
    if (!s.face) continue
    const t = computeReframeTransform(source, canvas, s.face, target)
    raw.push({ atMs: Math.max(0, Math.round(s.atMs)), transform: t })
  }
  if (raw.length === 0) return []
  // Dedup adjacent near-identical samples.
  const dedup: TransformKeyframe[] = []
  for (const kf of raw) {
    const last = dedup[dedup.length - 1]
    if (
      last &&
      Math.abs(kf.transform.x - last.transform.x) < IDENTITY_EPSILON &&
      Math.abs(kf.transform.y - last.transform.y) < IDENTITY_EPSILON &&
      Math.abs(kf.transform.scale - last.transform.scale) < IDENTITY_EPSILON
    ) {
      continue
    }
    dedup.push(kf)
  }
  // No-op detection — every keyframe within epsilon of identity → empty.
  if (dedup.every((kf) => isNearIdentity(kf.transform))) return []
  // Ensure the >= 2 invariant the store enforces — if the face is rock-still
  // we'd otherwise collapse to a single kf and the store would drop it. Pair
  // the surviving kf with a clone at the LAST sample's atMs so the keyframe
  // track spans the clip and the static transform applies throughout.
  if (dedup.length === 1) {
    const only = dedup[0]
    const lastAtMs = raw[raw.length - 1].atMs
    if (lastAtMs > only.atMs) {
      dedup.push({
        atMs: lastAtMs,
        transform: { ...only.transform }
      })
    }
  }
  return dedup
}

// ---------------------------------------------------------------------------
// Detector adapter — abstracts MediaPipe so tests can inject a mock.
// ---------------------------------------------------------------------------

export type DetectFn = (
  frame: ImageData,
  atMs: number
) => Promise<FaceBox[]>

interface MockDetectorHook {
  __reelsAutoReframeMockDetector?: DetectFn
}

function getDetectFn(): Promise<DetectFn> {
  const w = window as unknown as MockDetectorHook
  if (typeof w.__reelsAutoReframeMockDetector === 'function') {
    const mock = w.__reelsAutoReframeMockDetector
    return Promise.resolve(mock)
  }
  return getDetector().then((detector) => {
    return async (frame: ImageData, _atMs: number): Promise<FaceBox[]> => {
      // MediaPipe's detect() accepts an HTMLCanvasElement / OffscreenCanvas
      // / ImageBitmap / video. We wrap the ImageData into a small <canvas>
      // and hand it over.
      const c = document.createElement('canvas')
      c.width = frame.width
      c.height = frame.height
      const ctx = c.getContext('2d')
      if (!ctx) return []
      ctx.putImageData(frame, 0, 0)
      const result = detector.detect(c)
      const out: FaceBox[] = []
      const Sw = frame.width || 1
      const Sh = frame.height || 1
      for (const d of result.detections ?? []) {
        const bb = d.boundingBox
        if (!bb) continue
        const cx = bb.originX + bb.width / 2
        const cy = bb.originY + bb.height / 2
        const score = d.categories?.[0]?.score ?? 0
        out.push({
          xFrac: cx / Sw,
          yFrac: cy / Sh,
          areaFrac: (bb.width * bb.height) / (Sw * Sh),
          score
        })
      }
      return out
    }
  })
}

// ---------------------------------------------------------------------------
// Per-clip face detection — creates a hidden <video>, steps frames, calls
// the (real or mock) detector.
// ---------------------------------------------------------------------------

export interface DetectFacesInClipOptions {
  framesPerClip: number
  minScore: number
  detect: DetectFn
  signal?: AbortSignal
}

interface PerFrameDetections {
  atMs: number
  faces: FaceBox[]
}

async function detectFacesInClip(
  clip: VideoAudioClip,
  mediaPath: string,
  opts: DetectFacesInClipOptions
): Promise<{ frames: PerFrameDetections[] }> {
  const signal = opts.signal
  const frameCount = Math.max(2, Math.min(24, Math.floor(opts.framesPerClip)))
  const inMs = Math.max(0, clip.trimInMs ?? 0)
  const outMs = Math.max(inMs, clip.trimOutMs ?? inMs)
  const trimmedSpanMs = Math.max(0, outMs - inMs)
  const samplePeriodMs = Math.max(1, trimmedSpanMs / frameCount)

  // Hidden transient <video>. Mirrors autoColorAnalysis.ts.
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

  const frames: PerFrameDetections[] = []

  try {
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

    // Build an abort-aware race promise so a long-running detect call can be
    // unblocked by `signal.abort()`.
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new DOMException('aborted', 'AbortError'))
            return
          }
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          )
        })
      : null

    let collected = 0
    for await (const { atMs: rawAtMs, frame } of stepClipFrames(video, clip, {
      signal,
      samplePeriodMs
    })) {
      if (signal?.aborted) break
      // If the stepper's reported atMs hasn't advanced from the last sample
      // (headless decoder may stall the first <video> element on iteration 0
      // → every yielded frame reports mediaTime=0), fall back to a synthetic
      // clip-relative atMs derived from the sample cadence. This keeps the
      // resulting keyframe track spanning the clip's full duration even
      // when the decoder can't deliver distinct presented frames.
      const prev = frames[frames.length - 1]?.atMs ?? -1
      const atMs =
        rawAtMs > prev
          ? rawAtMs
          : Math.round((collected) * samplePeriodMs)
      let faces: FaceBox[] = []
      try {
        const detectP = opts.detect(frame, atMs)
        faces = abortPromise
          ? await Promise.race([detectP, abortPromise])
          : await detectP
      } catch (err) {
        // Per-frame detector failure (or cancellation) bubbles to the caller.
        throw err
      }
      const filtered = faces.filter((f) => f.score >= opts.minScore)
      frames.push({ atMs, faces: filtered })
      collected += 1
      if (collected >= frameCount) break
    }
  } finally {
    try {
      video.pause()
      video.removeAttribute('src')
      video.load()
      video.remove()
    } catch {
      /* defensive */
    }
  }

  return { frames }
}

// ---------------------------------------------------------------------------
// Orchestrator — mirrors runAutoEdit's one-undo-step harness.
// ---------------------------------------------------------------------------

export interface AutoReframeOptions {
  /** Frames sampled per clip (default 8, allowed 2..24). */
  framesPerClip: number
  /** Skip clips that already have transformKeyframes. */
  preserveExisting: boolean
  /** Optional rule-of-thirds target (defaults to canvas center). */
  target?: { x: number; y: number }
  /** Minimum detector score to accept a face. */
  minScore?: number
}

export interface AutoReframeSummary {
  /** Number of video media clips inspected. */
  clipsScanned: number
  /** Clips that ended up with new keyframes written. */
  clipsReframed: number
  /** Clips skipped because they already had keyframes (preserveExisting). */
  clipsPreserved: number
  /** Clips where no usable face was detected. */
  clipsNoFace: number
  /** Clips skipped because they were locked. */
  clipsLocked: number
}

export type AutoReframePhase =
  | 'preparing'
  | 'loadingModel'
  | 'sampling'
  | 'done'
  | 'error'
  | 'cancelled'

export interface AutoReframeCallbacks {
  onPhase: (phase: AutoReframePhase) => void
  /** Per-clip progress with the currently-processing clip name. */
  onProgress: (done: number, total: number, currentClipName: string) => void
  shouldCancel: () => boolean
}

/** Resolved video-media-clip handle. */
interface ReframeClipHandle {
  id: string
  trackId: string
  mediaPath: string
  name: string
  /** Source dims as stored in `media` — what the editor actually renders. */
  sourceWidth: number
  sourceHeight: number
}

function resolveVideoClips(project: Project): ReframeClipHandle[] {
  const out: ReframeClipHandle[] = []
  for (const t of project.tracks) {
    if (t.kind !== 'video') continue
    for (const c of t.clips) {
      if (!isMediaClip(c)) continue
      const media = project.media[c.mediaId]
      if (!media || media.kind !== 'video' || !media.path) continue
      out.push({
        id: c.id,
        trackId: t.id,
        mediaPath: media.path,
        name: media.fileName || media.path,
        sourceWidth: media.width || 1,
        sourceHeight: media.height || 1
      })
    }
  }
  return out
}

function findClip(clipId: string): VideoAudioClip | null {
  const project = useProjectStore.getState().project
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.id === clipId && isMediaClip(c)) return c
    }
  }
  return null
}

export async function runAutoReframe(
  opts: AutoReframeOptions,
  cb: AutoReframeCallbacks
): Promise<AutoReframeSummary> {
  const summary: AutoReframeSummary = {
    clipsScanned: 0,
    clipsReframed: 0,
    clipsPreserved: 0,
    clipsNoFace: 0,
    clipsLocked: 0
  }

  cb.onPhase('preparing')

  const startProject = useProjectStore.getState().project
  const clips = resolveVideoClips(startProject)
  const canvasDim = {
    width: startProject.width,
    height: startProject.height
  }

  if (clips.length === 0) {
    cb.onPhase('done')
    return summary
  }

  const temporal = useProjectStore.temporal.getState()
  const preRunProject = startProject
  temporal.pause()

  // Pre-detect cancellation propagation — every per-clip stepper uses this
  // signal so a click on Cancel aborts the in-flight detection cleanly.
  const ac = new AbortController()

  // Poll the dialog's cancellation flag every 150ms so a click DURING a
  // single clip's detect pass propagates without waiting for the next
  // clip boundary.
  const cancelWatcher = setInterval(() => {
    if (cb.shouldCancel() && !ac.signal.aborted) {
      ac.abort()
    }
  }, 150)

  let cancelled = false
  let didMutate = false
  let runError: Error | null = null

  try {
    cb.onPhase('loadingModel')
    let detectFn: DetectFn
    try {
      detectFn = await getDetectFn()
    } catch (err) {
      throw err instanceof Error
        ? err
        : new Error('얼굴 감지 모델을 불러오지 못했습니다')
    }

    cb.onPhase('sampling')
    const target = opts.target ?? { x: 0.5, y: 0.5 }
    const minScore = Math.max(0, Math.min(1, opts.minScore ?? 0.4))
    const framesPerClip = Math.max(
      2,
      Math.min(24, Math.floor(opts.framesPerClip || 8))
    )

    cb.onProgress(0, clips.length, '')

    for (let i = 0; i < clips.length; i++) {
      if (cb.shouldCancel()) {
        cancelled = true
        ac.abort()
        break
      }
      const handle = clips[i]
      cb.onProgress(i, clips.length, handle.name)

      const live = findClip(handle.id)
      if (!live) {
        // Disappeared mid-run — skip.
        continue
      }

      // Per-clip lock — silently skip.
      if (isClipLocked(live)) {
        summary.clipsLocked += 1
        continue
      }

      // preserveExisting: skip a clip whose keyframe track is already populated.
      if (
        opts.preserveExisting &&
        Array.isArray(live.transformKeyframes) &&
        live.transformKeyframes.length >= 2
      ) {
        summary.clipsPreserved += 1
        continue
      }

      summary.clipsScanned += 1

      let detected: { frames: PerFrameDetections[] }
      try {
        detected = await detectFacesInClip(live, handle.mediaPath, {
          framesPerClip,
          minScore,
          detect: detectFn,
          signal: ac.signal
        })
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') {
          cancelled = true
          break
        }
        throw err
      }
      if (cb.shouldCancel()) {
        cancelled = true
        break
      }

      const track = stitchFaceTrack(detected.frames)
      if (track.length === 0 || track.every((s) => s.face === null)) {
        summary.clipsNoFace += 1
        continue
      }

      const sourceDim = {
        width: handle.sourceWidth,
        height: handle.sourceHeight
      }
      const kfs = buildKeyframesFromTrack(
        track,
        sourceDim,
        canvasDim,
        target
      )
      if (kfs.length < 2) {
        // No-op clip (same-aspect near-center → byte-identical export).
        summary.clipsNoFace += 1
        continue
      }

      useProjectStore.getState().applyAutoReframeKeyframes(handle.id, kfs)
      didMutate = true
      // applyAutoReframeKeyframes may silently no-op (e.g. clip removed since
      // resolve) — verify the write actually landed before counting.
      const after = findClip(handle.id)
      if (
        after &&
        Array.isArray(after.transformKeyframes) &&
        after.transformKeyframes.length >= 2
      ) {
        summary.clipsReframed += 1
      }
    }

    cb.onProgress(clips.length, clips.length, '')
  } catch (err) {
    runError = err instanceof Error ? err : new Error(String(err))
  } finally {
    clearInterval(cancelWatcher)
    temporal.resume()
    // Push exactly ONE undo entry only if we actually mutated, and roll back
    // any partial writes when the run hit a hard error.
    const cur = useProjectStore.getState().project
    if (runError) {
      // Hard error — restore the pre-run project so the failed pass leaves
      // ZERO partial writes. Do NOT push an undo entry.
      if (cur !== preRunProject) {
        useProjectStore.setState({ project: preRunProject })
      }
    } else if (didMutate && cur !== preRunProject) {
      useProjectStore.temporal.setState((s) => ({
        pastStates: [...s.pastStates, { project: preRunProject }].slice(-100),
        futureStates: []
      }))
    }
  }

  if (runError) {
    cb.onPhase('error')
    throw runError
  }

  cb.onPhase(cancelled ? 'cancelled' : 'done')
  return summary
}
