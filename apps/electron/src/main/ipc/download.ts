/**
 * Phase 3.3 — prefill flow video download.
 *
 * Main-process video downloader. The renderer can't fetch IG/FB CDN URLs
 * directly because:
 *   1) CSP `connect-src` doesn't whitelist the CDN.
 *   2) The CDN often serves CORS-restricted responses.
 *
 * So the renderer asks main to fetch the URL and stream it to disk in
 * `userData/imports/<sanitized>.mp4`. The downloaded file path is
 * registered on the ffmpeg allowlist so subsequent media.probe / ffmpeg.run
 * calls accept it.
 *
 * Security:
 *   - URL must parse as https:// (no http, no file:, no localhost).
 *   - Output path is computed by main (never trusts the renderer).
 *   - Max size cap (default 500 MB) to defend against runaway downloads.
 *   - Per-job timeout (default 90 s).
 */
import { app, ipcMain, net } from 'electron'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { IPC_CHANNELS, type DownloadResult } from '../../shared/ipc'
import { allowPath } from '../ffmpeg/security'

const MAX_BYTES = 500 * 1024 * 1024 // 500 MB hard cap
const DEFAULT_TIMEOUT_MS = 90_000

function importsDir(): string {
  return path.join(app.getPath('userData'), 'imports')
}

async function ensureImportsDir(): Promise<string> {
  const dir = importsDir()
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Strip the shortcode/name down to a safe filename component. We DELIBERATELY
 * do not preserve dots from the suggestedName except for the trailing
 * extension because IG shortcodes never contain dots.
 */
function sanitizeName(name: string | undefined, fallback: string): string {
  const raw = (name && name.trim()) || fallback
  // Split base/ext so we can keep a clean .mp4-like extension.
  const dot = raw.lastIndexOf('.')
  const base = dot > 0 ? raw.slice(0, dot) : raw
  const ext = dot > 0 ? raw.slice(dot) : '.mp4'
  const safeBase = base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'video'
  const safeExt = /^\.[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toLowerCase() : '.mp4'
  return safeBase + safeExt
}

function validateUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
    throw new Error('[download] url required')
  }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('[download] invalid url')
  }
  if (u.protocol !== 'https:') {
    throw new Error('[download] only https:// allowed')
  }
  const host = u.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    throw new Error('[download] localhost not allowed')
  }
  // Block raw IPs to avoid SSRF to internal ranges. We can't perfectly
  // resolve here, but blocking literal IPs covers the obvious cases.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    throw new Error('[download] raw IP host not allowed')
  }
  return u.toString()
}

interface DownloadOpts {
  /** Override the default timeout (ms). */
  timeoutMs?: number
}

async function downloadOnce(
  url: string,
  destPath: string,
  opts: DownloadOpts = {}
): Promise<{ bytes: number; status: number }> {
  const timeoutMs = Math.min(
    Math.max(5_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    600_000
  )

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // electron.net.fetch shares the session's protocol handlers/cookies.
    // Falls back to global fetch if unavailable (very old Electron).
    const fetchFn: typeof fetch =
      (net as { fetch?: typeof fetch }).fetch?.bind(net) ?? fetch
    const r = await fetchFn(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // IG/FB CDN occasionally returns 403 on bot-y UA strings. Mirror
        // a Chrome desktop UA — same one Electron uses by default.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    })
    if (!r.ok) {
      return { bytes: 0, status: r.status }
    }

    // Pre-flight content-length cap.
    const lenHeader = r.headers.get('content-length')
    if (lenHeader) {
      const len = Number(lenHeader)
      if (Number.isFinite(len) && len > MAX_BYTES) {
        throw new Error(`[download] content-length ${len} exceeds ${MAX_BYTES}`)
      }
    }

    if (!r.body) {
      throw new Error('[download] no response body')
    }

    // Stream to disk with a running byte cap.
    let bytes = 0
    const sink = createWriteStream(destPath)
    // Convert Web ReadableStream → Node stream for pipeline.
    const nodeStream = Readable.fromWeb(
      r.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
    )
    nodeStream.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > MAX_BYTES) {
        nodeStream.destroy(new Error(`[download] exceeded ${MAX_BYTES} bytes`))
      }
    })
    await pipeline(nodeStream, sink)
    return { bytes, status: r.status }
  } finally {
    clearTimeout(timer)
  }
}

export function registerDownloadHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.download.downloadVideoToTemp,
    async (_event, rawUrl: unknown, suggestedName?: unknown): Promise<DownloadResult> => {
      let url: string
      try {
        url = validateUrl(rawUrl)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }

      const fileName = sanitizeName(
        typeof suggestedName === 'string' ? suggestedName : undefined,
        `video-${Date.now()}.mp4`
      )

      try {
        const dir = await ensureImportsDir()
        const destPath = path.join(dir, fileName)

        // Clean a stale file with the same name (defensive — atomic-ish).
        if (existsSync(destPath)) {
          try {
            await unlink(destPath)
          } catch {
            // ignore — overwrite below
          }
        }

        const result = await downloadOnce(url, destPath)

        if (result.status === 403) {
          return {
            ok: false,
            error: 'http_403',
            httpStatus: 403
          }
        }
        if (result.status && result.status >= 400) {
          return {
            ok: false,
            error: `http_${result.status}`,
            httpStatus: result.status
          }
        }

        // Sanity check the file actually landed.
        if (!existsSync(destPath)) {
          return { ok: false, error: 'file_missing_after_download' }
        }
        const st = await stat(destPath)
        if (st.size < 1024) {
          // Suspiciously small — most likely an HTML error page slipped past.
          try {
            await unlink(destPath)
          } catch {
            // ignore
          }
          return { ok: false, error: 'file_too_small' }
        }

        // Allowlist the path for subsequent media.probe / ffmpeg.run.
        allowPath(destPath)

        return {
          ok: true,
          localPath: destPath,
          sizeBytes: st.size
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
}
