/**
 * Overlay PNG renderer — Phase 3.8.
 *
 * Two responsibilities:
 *   1. `renderOverlayShapeToFile` — compile a ShapeStyle + pixel dimensions
 *      into a transparent PNG via SVG+Sharp, with on-disk hash cache under
 *      `userData/overlays-cache/<hash>.png`. Mirrors the captions/render.ts
 *      pattern precisely so the graceful-degradation behaviour is consistent.
 *
 *   2. `resolveBundledStickerPath` — map a sticker id (from BUNDLED_STICKERS)
 *      to an absolute path under `build/stickers/`, searching both the dev
 *      source tree and the packaged `process.resourcesPath` location.
 *      BUNDLED_STICKERS is currently empty so this function is never hot in
 *      practice — it is implemented for forward-compat so future sticker art
 *      slots in without export.ts changes.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BUNDLED_STICKERS, type ShapeStyle } from '../../shared/project'

// ---------------------------------------------------------------------------
// Sharp — lazy + safe load. Mirrors captions/render.ts exactly.
// ---------------------------------------------------------------------------
type SharpModule = typeof import('sharp')
let cachedSharp: SharpModule | null | undefined

function safeLoadSharp(): SharpModule | null {
  if (cachedSharp !== undefined) return cachedSharp
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('sharp') as SharpModule
    cachedSharp = mod
    return mod
  } catch (err) {
    console.warn(
      '[overlays/render] sharp unavailable; shape overlays will be skipped:',
      err instanceof Error ? err.message : String(err)
    )
    cachedSharp = null
    return null
  }
}

// ---------------------------------------------------------------------------
// SVG builder — one SVG per ShapeKind.
// ---------------------------------------------------------------------------

/** Escape an attribute value for use inside SVG double-quoted attributes. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Build an SVG document for the given shape style at pixel dimensions pxW x pxH.
 * The document is fully transparent except for the shape itself, so ffmpeg's
 * overlay filter composites it correctly over RGBA video.
 */
function buildShapeSvg(style: ShapeStyle, pxW: number, pxH: number): string {
  // Clamp stroke width to avoid negative values from untrusted IPC data.
  const sw = Math.max(0, Number.isFinite(style.strokeWidth) ? style.strokeWidth : 0)
  const fillOpacity = Math.min(1, Math.max(0, Number.isFinite(style.fillOpacity) ? style.fillOpacity : 1))
  const fill = style.fill === 'none' ? 'none' : escapeAttr(style.fill)
  const stroke = style.stroke === 'none' ? 'none' : escapeAttr(style.stroke)
  const cr = Math.max(0, Number.isFinite(style.cornerRadius) ? style.cornerRadius : 0)

  // Inset the shape by half the stroke width so strokes aren't clipped by the canvas edge.
  const inset = sw / 2

  let shapeEl: string
  if (style.shape === 'rectangle') {
    const x = inset
    const y = inset
    const w = Math.max(0, pxW - sw)
    const h = Math.max(0, pxH - sw)
    const rx = Math.min(cr, w / 2, h / 2)
    shapeEl = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${stroke}" stroke-width="${sw}"/>`
  } else if (style.shape === 'ellipse') {
    const cx = pxW / 2
    const cy = pxH / 2
    const rx = Math.max(0, pxW / 2 - inset)
    const ry = Math.max(0, pxH / 2 - inset)
    shapeEl = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${stroke}" stroke-width="${sw}"/>`
  } else {
    // 'line' — horizontal line from left-center to right-center of the bounding box.
    const y = pxH / 2
    shapeEl = `<line x1="${inset}" y1="${y}" x2="${pxW - inset}" y2="${y}" stroke="${stroke}" stroke-width="${sw}"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}" viewBox="0 0 ${pxW} ${pxH}">${shapeEl}</svg>`
}

// ---------------------------------------------------------------------------
// On-disk cache.
// ---------------------------------------------------------------------------

async function getOverlayCacheDir(): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'overlays-cache')
  await mkdir(dir, { recursive: true })
  return dir
}

function makeShapeCacheKey(style: ShapeStyle, pxW: number, pxH: number): string {
  const payload = JSON.stringify({
    shape: style.shape,
    fill: style.fill,
    fillOpacity: style.fillOpacity,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    cornerRadius: style.cornerRadius,
    w: pxW,
    h: pxH,
    // Version key — bump to bust cache after SVG rendering changes.
    v: 1
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 24)
}

// ---------------------------------------------------------------------------
// Public API — shape rendering.
// ---------------------------------------------------------------------------

/**
 * Render a ShapeStyle to a transparent PNG at the given pixel dimensions and
 * return the absolute on-disk path.  Returns `null` when:
 *   - Sharp is unavailable (native binding missing)
 *   - pxW or pxH are <= 0 / non-finite (degenerate size)
 *   - Sharp throws during render or cache write fails
 *
 * The caller (export.ts) treats null as "skip this overlay gracefully".
 */
export async function renderOverlayShapeToFile(
  style: ShapeStyle,
  pxW: number,
  pxH: number
): Promise<string | null> {
  // Reject degenerate dimensions — zero-size sharp inputs crash.
  if (!Number.isFinite(pxW) || !Number.isFinite(pxH) || pxW <= 0 || pxH <= 0) {
    console.warn(`[overlays/render] degenerate shape dimensions ${pxW}x${pxH} — skipping`)
    return null
  }

  const sharp = safeLoadSharp()
  if (!sharp) return null

  const hash = makeShapeCacheKey(style, Math.round(pxW), Math.round(pxH))
  const dir = await getOverlayCacheDir()
  const pngPath = path.join(dir, `${hash}.png`)

  if (existsSync(pngPath)) {
    return pngPath
  }

  const svg = buildShapeSvg(style, Math.round(pxW), Math.round(pxH))
  let buf: Buffer
  try {
    buf = await sharp(Buffer.from(svg)).png().toBuffer()
  } catch (err) {
    console.warn(
      '[overlays/render] sharp render failed for shape:',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }

  try {
    await writeFile(pngPath, buf)
    return pngPath
  } catch (err) {
    console.warn(
      '[overlays/render] cache write failed:',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API — bundled sticker path resolution.
// ---------------------------------------------------------------------------

/**
 * Resolve a bundled sticker id to an absolute PNG path.
 *
 * Search order (mirrors resolveFontPath in captions/render.ts):
 *   1. Dev: __dirname → ../../build/stickers/<assetFile>
 *   2. Packaged: process.resourcesPath/build/stickers/<assetFile>
 *   3. Packaged alt: process.resourcesPath/stickers/<assetFile>
 *   4. electron-vite out: __dirname → ../build/stickers/<assetFile>
 *
 * Returns null when the sticker id is unknown (not in BUNDLED_STICKERS) or
 * when the resolved file doesn't exist on disk. Export skips the overlay.
 */
export function resolveBundledStickerPath(stickerId: string): string | null {
  const sticker = BUNDLED_STICKERS.find((s) => s.id === stickerId)
  if (!sticker) return null

  const candidates: string[] = []
  try {
    candidates.push(
      path.resolve(__dirname, '..', '..', '..', 'build', 'stickers', sticker.assetFile)
    )
  } catch {
    /* ignore */
  }
  try {
    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, 'build', 'stickers', sticker.assetFile)
      )
      candidates.push(
        path.join(process.resourcesPath, 'stickers', sticker.assetFile)
      )
    }
  } catch {
    /* ignore */
  }
  try {
    candidates.push(
      path.resolve(__dirname, '..', '..', 'build', 'stickers', sticker.assetFile)
    )
  } catch {
    /* ignore */
  }

  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Test-only helpers.
// ---------------------------------------------------------------------------
export const __test = {
  buildShapeSvg,
  makeShapeCacheKey,
  safeLoadSharp
}
