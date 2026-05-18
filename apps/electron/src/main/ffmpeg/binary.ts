import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Resolve the bundled ffmpeg binary path.
 *
 * In dev, `@ffmpeg-installer/ffmpeg`'s resolution returns the path inside
 * node_modules. In a packaged app, electron-builder must be configured to
 * unpack the platform-specific binary into `resources/app.asar.unpacked/`
 * (see electron-builder.json `asarUnpack`). We rewrite the path returned by
 * the installer to point inside `process.resourcesPath`.
 */
export function resolveFfmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const installer = require('@ffmpeg-installer/ffmpeg') as { path: string }
  let p = installer.path

  if (app.isPackaged) {
    // installer.path will normally include ".../node_modules/@ffmpeg-installer/..."
    // inside the asar. We rewrite to the unpacked tree.
    const replaced = p.replace(
      /(.*?)[\\/]app\.asar[\\/](.*)/,
      (_match, root: string, rest: string) =>
        path.join(root, 'app.asar.unpacked', rest)
    )
    if (replaced !== p && existsSync(replaced)) {
      p = replaced
    } else if (!existsSync(p)) {
      // Fallback: look directly under resources/
      const guess = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        '@ffmpeg-installer',
        `${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
      )
      if (existsSync(guess)) p = guess
    }
  }

  if (!existsSync(p)) {
    throw new Error(`[ffmpeg] binary not found at ${p}`)
  }

  return p
}
