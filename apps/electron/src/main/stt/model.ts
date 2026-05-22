/**
 * GGML model provisioning for STT.
 *
 * The whisper.cpp model is NOT vendored (it is ~148 MB). On first transcription
 * it is downloaded from the registry URL into `userData/models/`, checksum-
 * verified, and reused thereafter. A module-level promise guards against two
 * concurrent transcriptions both kicking off a download.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { SttModelKey } from '../../shared/ipc'
import {
  MODEL_REGISTRY,
  resolveModelPath,
  SttTaggedError,
  type ModelRegistryEntry
} from './binary'

/** Progress callback: bytes streamed so far / total expected. */
export type ModelDownloadProgress = (downloaded: number, total: number) => void

/** Compute the SHA-256 of a file as lowercase hex. */
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

/** Defense-in-depth: only https URLs may be fetched (URL is a constant today). */
function assertHttpsUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new SttTaggedError('model_download_failed', `[stt] invalid model url: ${raw}`)
  }
  if (u.protocol !== 'https:') {
    throw new SttTaggedError(
      'model_download_failed',
      `[stt] model url must be https:// (got ${u.protocol})`
    )
  }
  return u
}

/**
 * Stream a single https GET to `destPath`, following up to `maxRedirects`
 * redirects. Emits byte progress. Rejects with `model_download_failed` on any
 * network/HTTP error.
 */
function downloadToFile(
  url: string,
  destPath: string,
  expectedTotal: number,
  onProgress: ModelDownloadProgress,
  maxRedirects = 5
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const u = assertHttpsUrl(url)
    const req = httpsGet(
      u,
      {
        headers: {
          'User-Agent': 'ReelsStudio-STT/1.0',
          Accept: 'application/octet-stream'
        }
      },
      (res) => {
        const status = res.statusCode ?? 0
        // Follow redirects (HF resolve URLs 302 to a CDN).
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (maxRedirects <= 0) {
            reject(
              new SttTaggedError('model_download_failed', '[stt] too many redirects')
            )
            return
          }
          const next = new URL(res.headers.location, u).toString()
          downloadToFile(next, destPath, expectedTotal, onProgress, maxRedirects - 1)
            .then(resolve)
            .catch(reject)
          return
        }
        if (status !== 200) {
          res.resume()
          reject(
            new SttTaggedError(
              'model_download_failed',
              `[stt] model download HTTP ${status}`
            )
          )
          return
        }

        const headerTotal = Number(res.headers['content-length'])
        const total =
          Number.isFinite(headerTotal) && headerTotal > 0
            ? headerTotal
            : expectedTotal

        let downloaded = 0
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.byteLength
          onProgress(downloaded, total)
        })

        const sink = createWriteStream(destPath)
        pipeline(res, sink)
          .then(() => resolve())
          .catch((err: unknown) =>
            reject(
              new SttTaggedError(
                'model_download_failed',
                `[stt] model stream failed: ${err instanceof Error ? err.message : String(err)}`
              )
            )
          )
      }
    )
    req.on('error', (err) => {
      reject(
        new SttTaggedError(
          'model_download_failed',
          `[stt] model download error: ${err.message}`
        )
      )
    })
    // Defensive overall timeout (10 min — the file is ~148 MB).
    req.setTimeout(10 * 60 * 1000, () => {
      req.destroy(new Error('timeout'))
    })
  })
}

// Single in-flight download per process. Keyed by model so a future 'small'
// model doesn't collide with 'base'.
const inFlight = new Map<SttModelKey, Promise<string>>()

async function provision(
  model: SttModelKey,
  entry: ModelRegistryEntry,
  onProgress: ModelDownloadProgress
): Promise<string> {
  const finalPath = resolveModelPath(model)
  const partPath = finalPath + '.part'

  // Fast path: already present AND checksum matches.
  if (existsSync(finalPath)) {
    try {
      const digest = await sha256File(finalPath)
      if (digest === entry.sha256) return finalPath
      // Corrupt/stale file — drop it and re-download.
      await unlink(finalPath).catch(() => undefined)
    } catch {
      await unlink(finalPath).catch(() => undefined)
    }
  }

  await mkdir(path.dirname(finalPath), { recursive: true })
  // Clear any stale partial.
  if (existsSync(partPath)) await unlink(partPath).catch(() => undefined)

  await downloadToFile(entry.url, partPath, entry.sizeBytes, onProgress)

  // Verify size + checksum before promoting.
  let digest: string
  try {
    digest = await sha256File(partPath)
  } catch (err) {
    await unlink(partPath).catch(() => undefined)
    throw new SttTaggedError(
      'model_download_failed',
      `[stt] could not hash downloaded model: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (digest !== entry.sha256) {
    await unlink(partPath).catch(() => undefined)
    throw new SttTaggedError(
      'model_checksum_failed',
      `[stt] model SHA-256 mismatch (expected ${entry.sha256}, got ${digest})`
    )
  }

  // Atomic-ish promote.
  await rename(partPath, finalPath)
  return finalPath
}

/**
 * Ensure the GGML model is present + verified on disk; return its path.
 * Downloads it on first use. A single download is shared across concurrent
 * callers via `inFlight`.
 */
export function ensureModel(
  model: SttModelKey,
  onProgress: ModelDownloadProgress
): Promise<string> {
  const entry = MODEL_REGISTRY[model]
  if (!entry) {
    return Promise.reject(
      new SttTaggedError('model_missing', `[stt] unknown model: ${model}`)
    )
  }
  const existing = inFlight.get(model)
  if (existing) return existing

  const task = provision(model, entry, onProgress).finally(() => {
    inFlight.delete(model)
  })
  inFlight.set(model, task)
  return task
}

/** Synchronous best-effort status check (no checksum) for `stt:modelStatus`. */
export async function modelStatusOnDisk(
  model: SttModelKey
): Promise<{ present: boolean; sizeBytes?: number }> {
  const finalPath = resolveModelPath(model)
  if (!existsSync(finalPath)) return { present: false }
  try {
    const st = await stat(finalPath)
    return { present: true, sizeBytes: st.size }
  } catch {
    return { present: false }
  }
}
