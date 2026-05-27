import { protocol } from 'electron'
import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import { isPathAllowed } from './ffmpeg/security'

/**
 * Custom protocol `media://` for serving local files (video/audio/image) to
 * the sandboxed renderer with webSecurity:true and contextIsolation:true.
 *
 * URL shape:
 *   media:///<encodeURIComponent(absolutePath)>
 *
 * Encoding the entire absolute path (including drive letter + slashes) as a
 * single URL-encoded path segment avoids cross-platform parsing pitfalls
 * (Windows backslashes, drive letters, host vs path ambiguity).
 *
 * Security: every request goes through `isPathAllowed`, which gates access to
 * the same allowlist used by ffmpeg/probe IO (userData, OS temp, and paths the
 * user has explicitly imported via dialog or drag-drop). No arbitrary file
 * access is granted.
 */

export const MEDIA_PROTOCOL = 'media'

/**
 * Must be called BEFORE app.whenReady() so the scheme is registered as a
 * "standard" + "secure" + "supportFetchAPI" scheme.
 */
export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
        corsEnabled: true
      }
    }
  ])
}

/** Decode a `media://...` request URL into an absolute filesystem path. */
function decodeMediaUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== `${MEDIA_PROTOCOL}:`) return null
    let p = u.pathname
    if (p.startsWith('/')) p = p.slice(1)
    if (!p) return null
    return decodeURIComponent(p)
  } catch {
    return null
  }
}

/** Construct the media:// URL for an absolute path. Mirrored on the renderer. */
export function buildMediaUrl(absPath: string): string {
  return `${MEDIA_PROTOCOL}://r/${encodeURIComponent(absPath)}`
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.webm':
      return 'video/webm'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
      return 'audio/mp4'
    case '.aac':
      return 'audio/aac'
    case '.ogg':
      return 'audio/ogg'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    default:
      return 'application/octet-stream'
  }
}

function streamResponse(filePath: string, request: Request): Response {
  const stat = statSync(filePath)
  const size = stat.size
  const range = request.headers.get('range')
  const contentType = contentTypeFor(filePath)

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match) {
      return new Response('bad range', { status: 416 })
    }
    const start = match[1] ? Number.parseInt(match[1], 10) : 0
    const end = match[2] ? Number.parseInt(match[2], 10) : size - 1
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      start >= size
    ) {
      return new Response('range not satisfiable', {
        status: 416,
        headers: {
          'Content-Range': `bytes */${size}`,
          'Accept-Ranges': 'bytes'
        }
      })
    }
    const clampedEnd = Math.min(end, size - 1)
    const body = Readable.toWeb(
      createReadStream(filePath, { start, end: clampedEnd })
    ) as ReadableStream<Uint8Array>
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(clampedEnd - start + 1),
        'Content-Range': `bytes ${start}-${clampedEnd}/${size}`,
        'Accept-Ranges': 'bytes'
      }
    })
  }

  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes'
    }
  })
}

/**
 * Call AFTER app.whenReady(). The handler validates the decoded path against
 * the same allowlist used by ffmpeg / probe IO and serves independent byte
 * range streams for HTMLMediaElement seeking.
 */
export function registerMediaProtocolHandler(): void {
  protocol.handle(MEDIA_PROTOCOL, (request) => {
    const decoded = decodeMediaUrl(request.url)
    if (!decoded) {
      return new Response('bad request', { status: 400 })
    }
    if (!isPathAllowed(decoded)) {
      return new Response('forbidden', { status: 403 })
    }
    try {
      return streamResponse(decoded, request)
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
