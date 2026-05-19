import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
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

/**
 * Call AFTER app.whenReady() (uses electron.net.fetch under the hood). The
 * handler validates the decoded path against the same allowlist used by
 * ffmpeg / probe IO. Range requests are handled transparently by net.fetch
 * which is required for HTMLMediaElement seeking.
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
    return net.fetch(pathToFileURL(decoded).toString())
  })
}
