/**
 * Phase 5 — voice recording.
 *
 * Captures microphone audio in the renderer with `MediaRecorder`, hands the
 * resulting blob bytes to the main process (which writes the file under
 * `userData/recordings/` and allowlists it), then runs the standard media
 * ingest pipeline and drops a clip onto an audio track at the playhead.
 *
 * The whole flow is wrapped so the caller only deals with a small state
 * machine: `start()` → `stop()` → result. Errors never throw out of `stop()`.
 */
import type { VideoAudioClip } from '../../../shared/project'
import { ingestLocalFile } from './mediaImport'
import { newId, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'

export interface VoiceRecorder {
  /** Stop capture, persist + ingest the take, and add a clip. */
  stop(): Promise<VoiceRecordResult>
  /** Abort without saving (e.g. user cancelled, or component unmounted). */
  cancel(): void
}

export type VoiceRecordResult =
  | { ok: true; clipId: string; mediaId: string; durationMs: number }
  | { ok: false; error: string }

/** Pick a MediaRecorder mimeType the current Chromium build supports. */
function pickMimeType(): { mimeType: string; ext: string } {
  const candidates: Array<{ mimeType: string; ext: string }> = [
    { mimeType: 'audio/webm;codecs=opus', ext: 'webm' },
    { mimeType: 'audio/webm', ext: 'webm' },
    { mimeType: 'audio/ogg;codecs=opus', ext: 'ogg' },
    { mimeType: 'audio/mp4', ext: 'm4a' }
  ]
  for (const c of candidates) {
    if (
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported(c.mimeType)
    ) {
      return c
    }
  }
  // Fall back to the platform default — empty mimeType lets the browser pick.
  return { mimeType: '', ext: 'webm' }
}

/**
 * Begin a microphone capture session. Resolves once the mic stream is live
 * and recording has started; rejects if permission is denied or no device is
 * available so the caller can surface a clear message.
 */
export async function startVoiceRecording(): Promise<VoiceRecorder> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new Error('이 환경에서는 마이크를 사용할 수 없습니다')
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('이 환경에서는 녹음을 지원하지 않습니다')
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const { mimeType, ext } = pickMimeType()
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream)

  const chunks: Blob[] = []
  recorder.ondataavailable = (e: BlobEvent): void => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }
  recorder.start()

  const cleanup = (): void => {
    for (const track of stream.getTracks()) {
      try {
        track.stop()
      } catch {
        // ignore
      }
    }
  }

  let finished = false

  const cancel = (): void => {
    if (finished) return
    finished = true
    try {
      if (recorder.state !== 'inactive') recorder.stop()
    } catch {
      // ignore
    }
    cleanup()
  }

  const stop = async (): Promise<VoiceRecordResult> => {
    if (finished) {
      return { ok: false, error: '이미 종료된 녹음입니다' }
    }
    finished = true
    try {
      // Wait for the recorder to flush its final chunk.
      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = (): void => {
          resolve(new Blob(chunks, { type: mimeType || 'audio/webm' }))
        }
        if (recorder.state !== 'inactive') recorder.stop()
        else resolve(new Blob(chunks, { type: mimeType || 'audio/webm' }))
      })
      cleanup()

      if (blob.size === 0) {
        return { ok: false, error: '녹음된 오디오가 없습니다' }
      }

      // Hand the raw bytes to main, which writes + allowlists the file.
      const bytes = await blob.arrayBuffer()
      const saved = await window.electron.recording.saveAudio(bytes, ext)
      if (!saved.ok) {
        return { ok: false, error: `녹음 저장 실패 (${saved.error})` }
      }

      // Standard ingest — probe + waveform + add to media store.
      const { asset } = await ingestLocalFile(saved.localPath, {
        displayName: `녹음 ${new Date().toLocaleTimeString('ko-KR')}`,
        fileSizeBytes: saved.sizeBytes
      })

      // Place the new audio clip on an audio track, at the playhead.
      const store = useProjectStore.getState()
      const audioTrackId = store.ensureAudioTrack('voice')
      const track = useProjectStore
        .getState()
        .project.tracks.find((t) => t.id === audioTrackId)
      if (!track) {
        return { ok: false, error: '오디오 트랙을 찾지 못했습니다' }
      }

      const durationMs = asset.durationMs > 0 ? asset.durationMs : 1000
      const playheadMs = useTimelineUi.getState().playheadMs
      // Find a free slot at/after the playhead so the take never overlaps.
      let startMs = Math.max(0, Math.round(playheadMs))
      const sorted = [...track.clips].sort((a, b) => a.startMs - b.startMs)
      for (const c of sorted) {
        if (startMs < c.endMs && startMs + durationMs > c.startMs) {
          startMs = c.endMs
        }
      }

      const clip: VideoAudioClip = {
        id: newId(),
        kind: 'media',
        mediaId: asset.id,
        trackId: track.id,
        startMs,
        endMs: startMs + durationMs,
        trimInMs: 0,
        trimOutMs: durationMs,
        speed: 1
      }
      store.addClip(clip)

      return {
        ok: true,
        clipId: clip.id,
        mediaId: asset.id,
        durationMs
      }
    } catch (err) {
      cleanup()
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  return { stop, cancel }
}
