import type { MediaAsset } from '../../../shared/project'
import { newId, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'

export interface ImportCallbacks {
  /** Called after probe + thumbnail + store-add succeeds for one file. */
  onAssetReady?: (asset: MediaAsset, dataUri: string) => void
  /** Per-file error reporter. Does NOT abort the rest. */
  onError?: (filePath: string, message: string) => void
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/**
 * Probe + thumbnail + store-add a single already-local file path. Shared by
 * `importFilesByPath` and `importFromUrl`. The path MUST already be on the
 * ffmpeg allowlist (dialog-picked, drag-dropped+allowed, or downloaded by the
 * main process which allowlists automatically).
 *
 * Returns the created asset, or throws so the caller can surface the error.
 */
export async function ingestLocalFile(
  filePath: string,
  opts?: { displayName?: string; fileSizeBytes?: number }
): Promise<{ asset: MediaAsset; dataUri?: string }> {
  const probe = await window.electron.media.probe(filePath)
  const id = newId()
  const fileName = opts?.displayName ?? basename(filePath)

  const atMs =
    probe.kind === 'image' || probe.kind === 'audio'
      ? 0
      : Math.min(1000, Math.max(0, probe.durationMs - 100))

  let thumbnailPath: string | undefined
  let dataUri: string | undefined
  if (probe.kind !== 'audio') {
    try {
      const thumb = await window.electron.media.generateThumbnail(filePath, {
        atMs,
        mediaId: id
      })
      thumbnailPath = thumb.path
      dataUri = thumb.dataUri
    } catch (err) {
      console.warn('[import] thumbnail failed', filePath, err)
    }
  }

  const asset: MediaAsset = {
    id,
    path: filePath,
    kind: probe.kind,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    codec: probe.codec,
    thumbnailPath,
    importedAt: Date.now(),
    fileName,
    fileSizeBytes: opts?.fileSizeBytes ?? 0
  }
  useProjectStore.getState().addMedia(asset)

  // Fire-and-forget waveform for anything carrying audio.
  if (probe.kind === 'audio' || probe.kind === 'video') {
    void window.electron.media
      .generateWaveform(filePath, { mediaId: id })
      .then((wf) => {
        useProjectStore.getState().updateMediaWaveform(id, wf.path)
        useTimelineUi.getState().setWaveformUri(id, wf.dataUri)
      })
      .catch((err: unknown) => {
        console.warn('[import] waveform failed', filePath, err)
      })
  }

  return { asset, dataUri }
}

export interface UrlImportResult {
  ok: boolean
  asset?: MediaAsset
  dataUri?: string
  error?: string
}

/**
 * Download a remote https media URL to local userData via the main process,
 * then run the standard ingest pipeline. Used by the remote-source import
 * buttons (video library, internal reels, TTS audio).
 *
 * The download IPC validates the URL (https-only, no localhost / raw IP) and
 * allowlists the resulting path, so probe / thumbnail / ffmpeg accept it.
 * NEVER throws — resolves with `{ ok: false, error }` on any failure.
 */
export async function importFromUrl(
  url: string,
  opts?: { suggestedName?: string; displayName?: string }
): Promise<UrlImportResult> {
  try {
    if (!/^https:\/\//i.test(url)) {
      return { ok: false, error: 'https URL이 아닙니다' }
    }
    const dl = await window.electron.download.downloadVideoToTemp(
      url,
      opts?.suggestedName
    )
    if (!dl.ok) {
      return { ok: false, error: `다운로드 실패 (${dl.error})` }
    }
    const { asset, dataUri } = await ingestLocalFile(dl.localPath, {
      displayName: opts?.displayName,
      fileSizeBytes: dl.sizeBytes
    })
    return { ok: true, asset, dataUri }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

async function fileSize(filePath: string): Promise<number> {
  // We don't have a generic fs:stat IPC in scope; if absent, return 0.
  // (Future Phase-2.2 can wire a fs:stat handler.)
  void filePath
  return 0
}

/**
 * Sequentially ingest a list of absolute file paths:
 *   1) allowPath (drag-drop paths haven't been picked via dialog)
 *   2) probe metadata
 *   3) generate thumbnail
 *   4) add to store
 *
 * Errors on one file do not abort the rest.
 */
export async function importFilesByPath(
  paths: string[],
  callbacks: ImportCallbacks = {}
): Promise<MediaAsset[]> {
  const added: MediaAsset[] = []
  const addMedia = useProjectStore.getState().addMedia

  for (const filePath of paths) {
    try {
      await window.electron.fs.allowPath(filePath)

      const probe = await window.electron.media.probe(filePath)
      const id = newId()

      const fileName = basename(filePath)
      const size = await fileSize(filePath)

      // Generate thumbnail; pick a sensible frame (1s in, or 0 for image/audio).
      const atMs =
        probe.kind === 'image' || probe.kind === 'audio'
          ? 0
          : Math.min(1000, Math.max(0, probe.durationMs - 100))

      let thumbnailPath: string | undefined
      let dataUri: string | undefined

      if (probe.kind !== 'audio') {
        try {
          const thumb = await window.electron.media.generateThumbnail(filePath, {
            atMs,
            mediaId: id
          })
          thumbnailPath = thumb.path
          dataUri = thumb.dataUri
        } catch (err) {
          // Thumbnail failure is non-fatal — log and continue.
          console.warn('[import] thumbnail failed', filePath, err)
        }
      }

      const asset: MediaAsset = {
        id,
        path: filePath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        thumbnailPath,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: size
      }
      addMedia(asset)
      added.push(asset)
      if (dataUri && callbacks.onAssetReady) {
        callbacks.onAssetReady(asset, dataUri)
      }

      // Fire-and-forget waveform generation for any clip carrying audio
      // (audio media + video files — video tracks may still want a waveform
      // strip on the timeline). Failures are non-fatal.
      if (probe.kind === 'audio' || probe.kind === 'video') {
        void window.electron.media
          .generateWaveform(filePath, { mediaId: id })
          .then((wf) => {
            useProjectStore.getState().updateMediaWaveform(id, wf.path)
            useTimelineUi.getState().setWaveformUri(id, wf.dataUri)
          })
          .catch((err: unknown) => {
            console.warn('[import] waveform failed', filePath, err)
          })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[import] failed', filePath, err)
      callbacks.onError?.(filePath, msg)
    }
  }

  return added
}
