import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Resolve the bundled ffmpeg binary path.
 *
 * In dev, `ffmpeg-static` returns the absolute path to the executable inside
 * node_modules (e.g. `<repo>/apps/electron/node_modules/ffmpeg-static/ffmpeg.exe`).
 * In a packaged app, the binary lives inside app.asar (per electron-builder
 * defaults), but native exes can't be executed from inside an asar — so
 * electron-builder.json has `asarUnpack: ["node_modules/ffmpeg-static/**\/*"]`
 * which copies the file to `resources/app.asar.unpacked/...`. We rewrite the
 * path to point there.
 *
 * Bundled ffmpeg as of v0.2.0: 6.1.1 (gyan.dev essentials build, Windows;
 * static GPL build on Linux/macOS via ffmpeg-static@5.3.0).
 */
export function resolveFfmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ffmpegStatic = require('ffmpeg-static') as string | null

  if (!ffmpegStatic) {
    throw new Error(
      `[ffmpeg] ffmpeg-static did not return a binary path for ${process.platform}-${process.arch}`
    )
  }

  let p = ffmpegStatic

  if (app.isPackaged) {
    // ffmpeg-static returns the path inside the running app's node_modules.
    // After electron-builder asarUnpacks the binary, it lives inside
    // app.asar.unpacked. Rewrite ".../app.asar/..." → ".../app.asar.unpacked/...".
    const replaced = p.replace(
      /(.*?)[\\/]app\.asar[\\/](.*)/,
      (_match, root: string, rest: string) =>
        path.join(root, 'app.asar.unpacked', rest)
    )
    if (replaced !== p && existsSync(replaced)) {
      p = replaced
    } else if (!existsSync(p)) {
      // Fallback: look directly under resources/. ffmpeg-static lays the
      // binary at the package root, so the path is .../ffmpeg-static/<exe>.
      const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
      const guess = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'ffmpeg-static',
        exeName
      )
      if (existsSync(guess)) p = guess
    }
  }

  if (!existsSync(p)) {
    throw new Error(`[ffmpeg] binary not found at ${p}`)
  }

  return p
}

// ---------------------------------------------------------------------------
// One-shot version probe — logged at startup so the bundled ffmpeg revision is
// visible in renderer DevTools / Electron main logs. Cached after first call.
// ---------------------------------------------------------------------------
let cachedVersionLine: string | null = null

export function probeFfmpegVersion(): Promise<string> {
  if (cachedVersionLine != null) return Promise.resolve(cachedVersionLine)
  return new Promise<string>((resolve) => {
    let ffmpegPath: string
    try {
      ffmpegPath = resolveFfmpegPath()
    } catch (err) {
      cachedVersionLine = `unresolved: ${err instanceof Error ? err.message : String(err)}`
      resolve(cachedVersionLine)
      return
    }
    const proc = spawn(ffmpegPath, ['-hide_banner', '-version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 4096) stdout = stdout.slice(0, 4096)
    })
    const settle = (s: string): void => {
      if (cachedVersionLine != null) return
      cachedVersionLine = s
      resolve(s)
    }
    proc.on('error', (err) => settle(`probe error: ${err.message}`))
    proc.on('close', () => {
      const firstLine = (stdout.split(/\r?\n/)[0] || '').trim()
      settle(firstLine || 'unknown')
    })
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      settle('probe timed out')
    }, 3_000)
  })
}

export function getCachedFfmpegVersion(): string | null {
  return cachedVersionLine
}
