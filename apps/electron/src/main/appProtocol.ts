import { app, net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

/**
 * Custom `app://` protocol for serving the production renderer bundle.
 *
 * Why: when the renderer is loaded via `file://` (the default with
 * `loadFile(...)`), Chromium's media element URL safety check rejects custom
 * schemes like `media://` as video/audio sources ("MEDIA_ELEMENT_ERROR:
 * Media load rejected by URL safety check"). Serving the renderer from an
 * `app://` origin sidesteps this — cross-origin requests from `app://` to
 * other privileged custom schemes (`media://`) are permitted by Blink's
 * media loader.
 *
 * Security: every request path is resolved + prefix-checked against the
 * packaged renderer directory. No traversal escape, no other paths served.
 */

export const APP_PROTOCOL = 'app'

export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: false
      }
    }
  ])
}

/** Where the renderer bundle lives in dev (`out/renderer/`) and packaged (`resources/app.asar/out/renderer/`). */
function rendererRoot(): string {
  // electron-builder packs `out/**/*` into app.asar; `__dirname` at runtime is
  // `<app.asar>/out/main` (or in dev `out/main`). So the renderer is at
  // `../renderer` relative to the main bundle.
  return path.join(__dirname, '..', 'renderer')
}

export function registerAppProtocolHandler(): void {
  const root = path.resolve(rendererRoot())
  protocol.handle(APP_PROTOCOL, (request) => {
    try {
      const url = new URL(request.url)
      // URL shape: `app://./index.html` or `app://./assets/foo-abc.js`
      // The hostname will be `.` (or empty); pathname carries the relative path.
      let rel = decodeURIComponent(url.pathname || '/')
      if (rel.startsWith('/')) rel = rel.slice(1)
      if (!rel) rel = 'index.html'
      const resolved = path.resolve(root, rel)
      if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        return new Response('forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(resolved).toString())
    } catch {
      return new Response('bad request', { status: 400 })
    }
  })
}

/** The loadURL target for production. */
export function getRendererLoadUrl(): string {
  return `${APP_PROTOCOL}://./index.html`
}

// Make typecheck happy in dev — `app` is imported but only used to keep the
// import side-effecting for electron type resolution.
void app
