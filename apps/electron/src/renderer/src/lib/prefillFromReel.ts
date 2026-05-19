/**
 * Phase 3.3 — one-click prefill from an analyzed reel.
 *
 * Orchestrates:
 *   1. metadata + analysis fetch (parallel)
 *   2. video download to local userData (with FB ad re-scrape fallback)
 *   3. media probe + thumbnail
 *   4. addMedia → addClip on the first video track
 *   5. bulk captions from Whisper sentences
 *   6. beat data → timelineUi (if pro_audio carries it)
 *
 * Caller (PrefillDialog) drives `onProgress` for UI feedback. The function
 * NEVER throws — failures resolve with `{ ok: false, error }` so the UI
 * can show a toast without try/catch noise at the call site.
 */
import { ulid } from 'ulid'
import {
  getReelAnalysis,
  getReelMetadata,
  getReelVideoUrl,
  type ReelAnalysis,
  type ReelMetadata,
  type WhisperSentence
} from './api'
import { makeStyleFromPreset } from './captionPresets'
import type { CaptionClip, MediaAsset } from '../../../shared/project'
import { newId, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'

export interface PrefillProgressFn {
  (step: string): void
}

export interface PrefillSuccess {
  ok: true
  shortcode: string
  mediaId: string
  videoClipId: string
  captionsAdded: number
  beatsAdded: number
  durationMs: number
  bgmSegmentsDetected: number
  emotionsDetected: number
}

export interface PrefillFailure {
  ok: false
  error: string
  /** Step where we stopped, for surfacing in toasts/logs. */
  step?: string
}

export type PrefillResult = PrefillSuccess | PrefillFailure

// ---------------------------------------------------------------------------
// Defensive pro_audio mapping.
// ---------------------------------------------------------------------------
// The Vercel backend serves whatever JSON sits in reels_pro_audio.pro_audio.
// Across migrations we've seen at least two shapes:
//   (A) start/end strings ("HH:MM:SS.mmm" or "12.345") — current Gemini3 path
//   (B) start_sec/end_sec numbers — older draft
// And beat data has been seen as:
//   - pro_audio.bpm: number
//   - pro_audio.beat_timeline: Array<number | { time_sec, strength }>
//   - pro_audio.beats: Array<number | { t, strength }>
// We accept all of the above and silently skip what we can't parse.

function parseTimeSec(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  // HH:MM:SS(.ms) or MM:SS(.ms)
  if (s.includes(':')) {
    const parts = s.split(':').map((p) => Number(p))
    if (parts.some((n) => !Number.isFinite(n))) return null
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    return null
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

interface SniffedAudio {
  bpm: number | null
  beatTimesMs: number[]
  bgmSegmentsCount: number
  emotionsCount: number
}

function sniffProAudio(raw: unknown): SniffedAudio {
  const out: SniffedAudio = {
    bpm: null,
    beatTimesMs: [],
    bgmSegmentsCount: 0,
    emotionsCount: 0
  }
  if (!raw || typeof raw !== 'object') return out
  const pa = raw as Record<string, unknown>

  // BPM (number or string).
  if (typeof pa.bpm === 'number' && Number.isFinite(pa.bpm)) {
    out.bpm = pa.bpm
  } else if (typeof pa.bpm === 'string') {
    const n = Number(pa.bpm)
    if (Number.isFinite(n)) out.bpm = n
  }

  // Beats — try several shapes.
  const beatSource =
    (Array.isArray(pa.beat_timeline) && pa.beat_timeline) ||
    (Array.isArray(pa.beats) && pa.beats) ||
    null
  if (Array.isArray(beatSource)) {
    for (const item of beatSource) {
      let sec: number | null = null
      if (typeof item === 'number') sec = item
      else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        sec =
          parseTimeSec(o.time_sec) ??
          parseTimeSec(o.time) ??
          parseTimeSec(o.t) ??
          parseTimeSec(o.start) ??
          parseTimeSec(o.start_sec)
      }
      if (sec !== null && sec >= 0 && Number.isFinite(sec)) {
        out.beatTimesMs.push(Math.round(sec * 1000))
      }
    }
    out.beatTimesMs.sort((a, b) => a - b)
  }

  if (Array.isArray(pa.bgm_segments)) {
    out.bgmSegmentsCount = pa.bgm_segments.length
  }
  if (Array.isArray(pa.emotion_timeline)) {
    out.emotionsCount = pa.emotion_timeline.length
  } else if (Array.isArray(pa.audio_emotions)) {
    out.emotionsCount = pa.audio_emotions.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Whisper sentence → caption clip.
// ---------------------------------------------------------------------------
function sentenceToCaption(
  seg: WhisperSentence,
  trackId: string,
  fallbackDurationMs: number
): CaptionClip | null {
  const text = (seg.text ?? '').trim()
  if (!text) return null
  let startMs = Math.round((Number(seg.start) || 0) * 1000)
  let endMs = Math.round((Number(seg.end) || 0) * 1000)
  if (!Number.isFinite(startMs) || startMs < 0) startMs = 0
  if (!Number.isFinite(endMs) || endMs <= startMs) {
    endMs = startMs + Math.max(500, fallbackDurationMs)
  }
  return {
    id: newId(),
    kind: 'caption',
    trackId,
    startMs,
    endMs,
    spans: [{ text }],
    style: makeStyleFromPreset('bottom-center')
  }
}

function isFbAdShortcode(sc: string): boolean {
  return /^fb_/i.test(sc)
}

function safeProgress(fn: PrefillProgressFn | undefined, step: string): void {
  try {
    fn?.(step)
  } catch {
    // never let UI progress callbacks break the flow
  }
}

// ---------------------------------------------------------------------------
// Main entry.
// ---------------------------------------------------------------------------
export async function prefillFromReel(
  shortcode: string,
  onProgress?: PrefillProgressFn
): Promise<PrefillResult> {
  if (!shortcode || typeof shortcode !== 'string') {
    return { ok: false, error: 'invalid shortcode' }
  }

  // 1) metadata + analysis in parallel
  safeProgress(onProgress, '메타데이터 가져오는 중...')
  let metadata: ReelMetadata
  let analysis: ReelAnalysis
  try {
    const [md, an] = await Promise.all([
      getReelMetadata(shortcode),
      getReelAnalysis(shortcode)
    ])
    metadata = md
    analysis = an
  } catch (err) {
    return {
      ok: false,
      step: 'metadata',
      error: err instanceof Error ? err.message : String(err)
    }
  }

  let videoUrl = metadata.video_url || ''
  if (!videoUrl) {
    return { ok: false, step: 'metadata', error: '비디오 URL이 없습니다' }
  }

  // 2) download video to local userData
  safeProgress(onProgress, '비디오 다운로드 중...')
  let downloadResult = await window.electron.download.downloadVideoToTemp(
    videoUrl,
    `${shortcode}.mp4`
  )

  // FB ad URL expiry — re-scrape via getReelVideoUrl once.
  if (
    !downloadResult.ok &&
    downloadResult.httpStatus === 403 &&
    isFbAdShortcode(shortcode)
  ) {
    safeProgress(onProgress, '비디오 URL 재발급 중...')
    const fresh = await getReelVideoUrl(shortcode)
    if (fresh && fresh !== videoUrl) {
      videoUrl = fresh
      downloadResult = await window.electron.download.downloadVideoToTemp(
        videoUrl,
        `${shortcode}.mp4`
      )
    }
  }

  if (!downloadResult.ok) {
    return {
      ok: false,
      step: 'download',
      error: `비디오 다운로드 실패 (${downloadResult.error})`
    }
  }
  const localPath = downloadResult.localPath

  // 3) probe + thumbnail
  safeProgress(onProgress, '미디어 import 중...')
  let probeResult
  try {
    probeResult = await window.electron.media.probe(localPath)
  } catch (err) {
    return {
      ok: false,
      step: 'probe',
      error: err instanceof Error ? err.message : String(err)
    }
  }

  const mediaId = newId()
  let thumbnailPath: string | undefined
  try {
    const thumb = await window.electron.media.generateThumbnail(localPath, {
      atMs: Math.min(1000, Math.max(0, probeResult.durationMs - 100)),
      mediaId
    })
    thumbnailPath = thumb.path
  } catch (err) {
    // Thumbnail is non-fatal — log and continue.
    console.warn('[prefill] thumbnail failed', err)
  }

  const authorTag = metadata.author_username
    ? ` - ${metadata.author_username}`
    : ''
  const asset: MediaAsset = {
    id: mediaId,
    path: localPath,
    kind: probeResult.kind,
    durationMs: probeResult.durationMs,
    width: probeResult.width,
    height: probeResult.height,
    codec: probeResult.codec,
    thumbnailPath,
    importedAt: Date.now(),
    fileName: `${shortcode}${authorTag}`,
    fileSizeBytes: downloadResult.sizeBytes
  }

  const store = useProjectStore.getState()
  store.addMedia(asset)

  // 4) place on first video track
  safeProgress(onProgress, '비디오 트랙에 배치 중...')
  const project = useProjectStore.getState().project
  const videoTrack = project.tracks.find((t) => t.kind === 'video')
  if (!videoTrack) {
    return {
      ok: false,
      step: 'addClip',
      error: '비디오 트랙이 없습니다'
    }
  }

  const videoClipId = ulid()
  store.addClip({
    id: videoClipId,
    kind: 'media',
    mediaId,
    trackId: videoTrack.id,
    startMs: 0,
    endMs: probeResult.durationMs,
    trimInMs: 0,
    trimOutMs: probeResult.durationMs,
    speed: 1
  })

  // 5) captions from Whisper sentences — bulk
  safeProgress(onProgress, '자막 생성 중...')
  const captionTrackId = useProjectStore.getState().getCaptionTrackId()
  let captionsAdded = 0
  if (captionTrackId && analysis.sentences.length > 0) {
    const built: CaptionClip[] = []
    for (const seg of analysis.sentences) {
      const c = sentenceToCaption(seg, captionTrackId, 1500)
      if (c) built.push(c)
    }
    if (built.length > 0) {
      useProjectStore.getState().addCaptions(built)
      captionsAdded = built.length
    }
  }

  // 6) beat data + bpm → timelineUi
  safeProgress(onProgress, '비트 데이터 적용 중...')
  const sniffed = sniffProAudio(analysis.pro_audio)
  let beatsAdded = 0
  if (sniffed.beatTimesMs.length > 0) {
    // Mark as 'detected' so the Editor's metronome regen effect won't
    // overwrite real timestamps when bpm is set on the next line.
    useTimelineUi.getState().setBeats(sniffed.beatTimesMs, 'detected')
    useTimelineUi.getState().setBeatSnapEnabled(true)
    beatsAdded = sniffed.beatTimesMs.length
  }
  if (sniffed.bpm !== null) {
    useTimelineUi.getState().setBpm(sniffed.bpm)
  }

  // Optional: dev-only sniff of the raw pro_audio shape so we can document
  // what we actually receive on a real reel. Guarded so it only fires when
  // there *is* a pro_audio blob.
  if (analysis.pro_audio && typeof console !== 'undefined') {
    try {
      const keys = Object.keys(analysis.pro_audio as object)
      console.debug('[prefill] pro_audio keys:', keys)
    } catch {
      // ignore
    }
  }

  safeProgress(onProgress, '완료')
  return {
    ok: true,
    shortcode,
    mediaId,
    videoClipId,
    captionsAdded,
    beatsAdded,
    durationMs: probeResult.durationMs,
    bgmSegmentsDetected: sniffed.bgmSegmentsCount,
    emotionsDetected: sniffed.emotionsCount
  }
}
