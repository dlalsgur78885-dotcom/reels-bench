/**
 * Phase 3.13 — motion-tracking job store (transient).
 *
 * Owns the lifecycle of ONE motion-tracking job at a time (the NCC tracker is
 * CPU-bound — running several at once would only thrash). Modelled on
 * `aiJobs.ts`: a small Zustand store of transient state, NOT persisted, NOT in
 * the project's zundo history.
 *
 * Responsibilities:
 *  - hold the draw-mode flag + the draw target clip (PreviewCanvas reads these
 *    to render the box-draw overlay);
 *  - on `beginTrackJob`, spin up the tracker Web Worker, create a hidden
 *    `<video>` loaded with the clip's media, step it frame-by-frame via
 *    `stepClipFrames`, and feed each frame to the worker;
 *  - accumulate the worker's `point` messages, and on `done` write the finished
 *    `MotionTrack` into the project store via `setMotionTrack`.
 *
 * The worker + the hidden video are torn down on done/cancel/error.
 */
import { create } from 'zustand'
import { ulid } from 'ulid'
import {
  DEFAULT_TRACK_SAMPLE_PERIOD_MS,
  getClipMotionTracks,
  type MotionTrack,
  type MotionTrackStatus,
  type TrackPoint,
  type VideoAudioClip
} from '../../../shared/project'
import { useProjectStore } from './project'
import { toMediaUrl } from '../lib/mediaUrl'
import { estimateFrameCount, stepClipFrames } from '../lib/tracking/frameStepper'
import type {
  TrackerInMsg,
  TrackerOutMsg
} from '../lib/tracking/trackerWorker'

/** Status of the live tracking job (transient — distinct from MotionTrackStatus). */
export type TrackJobStatus = 'idle' | 'preparing' | 'tracking' | 'done' | 'error'

interface TrackingState {
  /** Local job id (ulid) — null when no job is running. */
  jobId: string | null
  /** The media clip currently being tracked. */
  clipId: string | null
  status: TrackJobStatus
  /** 0..100 progress of the running job. */
  percent: number
  /** Last error message (when status === 'error'). */
  error: string | null
  /** True while the PreviewCanvas box-draw overlay is armed. */
  drawMode: boolean
  /** The clip the box-draw overlay will attach a new track to. */
  drawClipId: string | null

  /**
   * Begin tracking `rect` (canvas-relative fractions) on the given media clip.
   * Spins up the worker + frame-stepping loop. No-op when a job is already
   * running (one at a time — CPU-bound).
   */
  beginTrackJob(clipId: string, rect: { x: number; y: number; w: number; h: number }): void
  /** Cancel the running job — aborts the frame loop + tears down the worker. */
  cancelTrackJob(): void
  /** Arm / disarm the box-draw overlay (optionally for a specific clip). */
  setDrawMode(on: boolean, clipId?: string | null): void
}

// ---------------------------------------------------------------------------
// Live job resources — kept module-scoped (NOT in the store) so they survive
// re-renders and never get structurally cloned by zundo.
// ---------------------------------------------------------------------------
let worker: Worker | null = null
let abort: AbortController | null = null
let hiddenVideo: HTMLVideoElement | null = null
/** Points accumulated for the in-flight job, by atMs (ascending insert order). */
let accumulatedPoints: TrackPoint[] = []
/** sourceRect of the in-flight job. */
let jobSourceRect: { x: number; y: number; w: number; h: number } | null = null
/** Number of tracks already on the clip — drives the new track's name. */
let jobTrackOrdinal = 0

/** Tear down all live job resources. Safe to call repeatedly. */
function teardown(): void {
  if (abort) {
    abort.abort()
    abort = null
  }
  if (worker) {
    try {
      worker.postMessage({ type: 'cancel' } satisfies TrackerInMsg)
    } catch {
      /* worker may already be dead */
    }
    worker.terminate()
    worker = null
  }
  if (hiddenVideo) {
    try {
      hiddenVideo.pause()
      hiddenVideo.removeAttribute('src')
      hiddenVideo.load()
      hiddenVideo.remove()
    } catch {
      /* defensive */
    }
    hiddenVideo = null
  }
  accumulatedPoints = []
  jobSourceRect = null
}

export const useTrackingStore = create<TrackingState>((set, get) => ({
  jobId: null,
  clipId: null,
  status: 'idle',
  percent: 0,
  error: null,
  drawMode: false,
  drawClipId: null,

  setDrawMode(on: boolean, clipId?: string | null): void {
    set({
      drawMode: on,
      drawClipId: on ? clipId ?? get().drawClipId ?? null : null
    })
  },

  beginTrackJob(clipId, rect): void {
    // One job at a time — CPU-bound.
    if (get().status === 'preparing' || get().status === 'tracking') return

    // Resolve the clip + its media from the project store.
    const project = useProjectStore.getState().project
    let clip: VideoAudioClip | null = null
    for (const t of project.tracks) {
      const found = t.clips.find((c) => c.id === clipId)
      if (found && found.kind === 'media') {
        clip = found
        break
      }
    }
    if (!clip) return
    const media = project.media[clip.mediaId]
    if (!media || media.kind === 'audio') {
      set({ status: 'error', error: '추적할 영상이 없습니다', drawMode: false })
      return
    }

    const jobId = ulid()
    accumulatedPoints = []
    jobSourceRect = { ...rect }
    jobTrackOrdinal = getClipMotionTracks(clip).length
    set({
      jobId,
      clipId,
      status: 'preparing',
      percent: 0,
      error: null,
      drawMode: false,
      drawClipId: null
    })

    // --- Spin up the tracker worker. -----------------------------------
    abort = new AbortController()
    try {
      worker = new Worker(
        new URL('../lib/tracking/trackerWorker.ts', import.meta.url),
        { type: 'module' }
      )
    } catch (err) {
      set({
        status: 'error',
        error: err instanceof Error ? err.message : '워커 생성 실패'
      })
      teardown()
      return
    }

    worker.onmessage = (ev: MessageEvent<TrackerOutMsg>): void => {
      // Ignore stale messages from a job that was already replaced.
      if (get().jobId !== jobId) return
      const msg = ev.data
      switch (msg.type) {
        case 'progress': {
          set({ percent: msg.percent })
          break
        }
        case 'point': {
          accumulatedPoints.push(msg.point)
          break
        }
        case 'done': {
          finalizeJob(jobId, msg.status)
          break
        }
        case 'error': {
          set({ status: 'error', error: msg.message, percent: 0 })
          teardown()
          break
        }
      }
    }
    worker.onerror = (ev): void => {
      if (get().jobId !== jobId) return
      set({
        status: 'error',
        error: ev.message || '워커 오류',
        percent: 0
      })
      teardown()
    }

    // --- Hidden <video> for frame stepping. ----------------------------
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    video.style.position = 'fixed'
    video.style.left = '-99999px'
    video.style.width = '1px'
    video.style.height = '1px'
    video.src = toMediaUrl(media.path)
    document.body.appendChild(video)
    hiddenVideo = video

    const samplePeriodMs = DEFAULT_TRACK_SAMPLE_PERIOD_MS
    const expectedFrames = estimateFrameCount(clip, samplePeriodMs)

    // Kick the frame-stepping loop once the video is decodable.
    const runLoop = async (): Promise<void> => {
      const clipRef = clip as VideoAudioClip
      const w = worker
      const sig = abort?.signal
      if (!w) return
      try {
        // First frame seeds the tracker template.
        let first = true
        set({ status: 'tracking' })
        for await (const { atMs, frame } of stepClipFrames(video, clipRef, {
          signal: sig,
          samplePeriodMs
        })) {
          if (get().jobId !== jobId) return
          if (first) {
            w.postMessage(
              {
                type: 'init',
                rect: jobSourceRect ?? rect,
                frame,
                expectedFrames
              } satisfies TrackerInMsg,
              [frame.data.buffer]
            )
            first = false
          } else {
            w.postMessage(
              { type: 'frame', atMs, frame } satisfies TrackerInMsg,
              [frame.data.buffer]
            )
          }
        }
        if (get().jobId !== jobId) return
        // Walk completed — tell the worker to finalize.
        if (first) {
          // No frame ever decoded.
          set({ status: 'error', error: '프레임을 읽지 못했습니다' })
          teardown()
          return
        }
        w.postMessage({ type: 'finish' } satisfies TrackerInMsg)
      } catch (err) {
        if (get().jobId !== jobId) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        set({
          status: 'error',
          error: err instanceof Error ? err.message : '추적 실패'
        })
        teardown()
      }
    }

    const onReady = (): void => {
      video.removeEventListener('loadeddata', onReady)
      void runLoop()
    }
    if (video.readyState >= 2) {
      onReady()
    } else {
      video.addEventListener('loadeddata', onReady, { once: true })
      video.addEventListener(
        'error',
        () => {
          if (get().jobId !== jobId) return
          set({ status: 'error', error: '영상 로드 실패' })
          teardown()
        },
        { once: true }
      )
    }
  },

  cancelTrackJob(): void {
    if (get().status === 'idle') return
    teardown()
    set({
      jobId: null,
      clipId: null,
      status: 'idle',
      percent: 0,
      error: null
    })
  }
}))

/**
 * Commit a finished job: build the MotionTrack from the accumulated points and
 * write it into the project store, then reset the transient job state.
 */
function finalizeJob(jobId: string, status: MotionTrackStatus): void {
  const store = useTrackingStore.getState()
  if (store.jobId !== jobId) return
  const clipId = store.clipId
  const points = accumulatedPoints.slice()
  const sourceRect = jobSourceRect ?? { x: 0, y: 0, w: 0, h: 0 }
  const ordinal = jobTrackOrdinal

  teardown()

  if (clipId && points.length >= 2) {
    const track: MotionTrack = {
      id: ulid(),
      name: `트랙 ${ordinal + 1}`,
      sourceRect,
      points,
      // A < 2-point result can never be 'complete'; the worker already
      // marks short results 'partial'/'failed'.
      status: points.length >= 2 ? status : 'failed',
      samplePeriodMs: DEFAULT_TRACK_SAMPLE_PERIOD_MS,
      createdAt: Date.now()
    }
    useProjectStore.getState().setMotionTrack(clipId, track)
  }

  useTrackingStore.setState({
    jobId: null,
    clipId: null,
    status: points.length >= 2 ? 'done' : 'error',
    percent: 100,
    error: points.length >= 2 ? null : '추적 결과가 부족합니다'
  })
}
