/**
 * Phase 5 — voice recording.
 *
 * The renderer captures microphone audio with `MediaRecorder` (it cannot
 * write files directly under the sandbox), then hands the raw blob bytes to
 * main. Main writes them into `userData/recordings/<name>` and registers the
 * path on the ffmpeg allowlist so the standard media probe / waveform /
 * export pipeline accepts the recording exactly like any imported file.
 *
 * Security:
 *   - Output path is computed by main; the renderer never supplies a path.
 *   - The extension is sanitised to a short safe token (default `.webm`).
 *   - A hard size cap defends against a runaway/oversized payload.
 */
import { app, ipcMain } from 'electron'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { IPC_CHANNELS, type SaveRecordingResult } from '../../shared/ipc'
import { allowPath } from '../ffmpeg/security'

/** Hard cap on a single recording payload (100 MB ≈ very long voice take). */
const MAX_BYTES = 100 * 1024 * 1024

function recordingsDir(): string {
  return path.join(app.getPath('userData'), 'recordings')
}

/** Normalise a renderer-supplied extension to a short safe token. */
function safeExt(ext: unknown): string {
  if (typeof ext !== 'string') return '.webm'
  const cleaned = ext.startsWith('.') ? ext : `.${ext}`
  return /^\.[A-Za-z0-9]{1,5}$/.test(cleaned) ? cleaned.toLowerCase() : '.webm'
}

export function registerRecordingHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.recording.saveAudio,
    async (
      _event,
      rawBytes: unknown,
      rawExt: unknown
    ): Promise<SaveRecordingResult> => {
      try {
        // The renderer passes an ArrayBuffer (or a typed-array view). Anything
        // else is rejected — we never trust the payload shape blindly.
        let buf: Buffer
        if (rawBytes instanceof ArrayBuffer) {
          buf = Buffer.from(rawBytes)
        } else if (ArrayBuffer.isView(rawBytes)) {
          buf = Buffer.from(
            rawBytes.buffer,
            rawBytes.byteOffset,
            rawBytes.byteLength
          )
        } else {
          return { ok: false, error: 'invalid_payload' }
        }
        if (buf.byteLength === 0) {
          return { ok: false, error: 'empty_recording' }
        }
        if (buf.byteLength > MAX_BYTES) {
          return { ok: false, error: 'recording_too_large' }
        }

        const dir = recordingsDir()
        await mkdir(dir, { recursive: true })
        const fileName = `recording-${Date.now()}${safeExt(rawExt)}`
        const destPath = path.join(dir, fileName)
        await writeFile(destPath, buf)

        const st = await stat(destPath)
        // Allowlist for subsequent media.probe / generateWaveform / ffmpeg.
        allowPath(destPath)

        return { ok: true, localPath: destPath, sizeBytes: st.size }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
}
