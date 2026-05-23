// Phase 3.25 — emoji / graphic-sticker rasterizer.
//
// Renderer-side helpers that turn a unicode emoji char or an inline SVG string
// into a transparent PNG (Chromium renders color emoji + SVG natively on a
// `<canvas>`), persist it via `overlay.saveSticker`, and add a normal IMAGE
// `OverlayClip`. Export consumes it like any imported image — no export change.
import { STICKER_RASTER_PX } from '../../../shared/bundledStickers'
import { useProjectStore } from '../store/project'
import { makeImageOverlay } from './overlays'

/** Color-emoji font stack — first available wins per platform. */
const EMOJI_FONT_STACK =
  '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif'

/** Create a fresh transparent square canvas at the sticker render resolution. */
function makeCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = STICKER_RASTER_PX
  canvas.height = STICKER_RASTER_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d 컨텍스트를 만들 수 없습니다')
  return { canvas, ctx }
}

/** Encode the canvas as PNG bytes (transparent). */
function canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('PNG 인코딩에 실패했습니다'))
        return
      }
      blob.arrayBuffer().then(resolve, reject)
    }, 'image/png')
  })
}

/**
 * Rasterize a unicode emoji `char` onto a transparent square canvas and return
 * the PNG bytes. Drawn centered with a small baseline nudge so the glyph sits
 * visually centered across emoji fonts.
 */
export async function rasterizeEmoji(char: string): Promise<ArrayBuffer> {
  const s = STICKER_RASTER_PX
  const { canvas, ctx } = makeCanvas()
  ctx.clearRect(0, 0, s, s)
  ctx.font = `${Math.round(s * 0.76)}px ${EMOJI_FONT_STACK}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(char, s / 2, s / 2 + s * 0.04)
  return canvasToPng(canvas)
}

/**
 * Rasterize an inline SVG markup string onto a transparent square canvas and
 * return the PNG bytes. The SVG is loaded as an `<img>` via a data-URL.
 */
export function rasterizeSvg(svg: string): Promise<ArrayBuffer> {
  const s = STICKER_RASTER_PX
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = (): void => {
      try {
        const { canvas, ctx } = makeCanvas()
        ctx.clearRect(0, 0, s, s)
        ctx.drawImage(img, 0, 0, s, s)
        canvasToPng(canvas).then(resolve, reject)
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    img.onerror = (): void => reject(new Error('SVG 이미지를 불러오지 못했습니다'))
    img.src =
      'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  })
}

// ---------------------------------------------------------------------------
// Session rasterize cache — each asset rasterizes at most once per session.
// ---------------------------------------------------------------------------

const rasterCache = new Map<string, ArrayBuffer>()

/**
 * Rasterize `assetId` via `fn`, caching the result for the rest of the session
 * so re-adding the same emoji/sticker reuses the already-encoded PNG bytes.
 */
export async function getOrRasterize(
  assetId: string,
  fn: () => Promise<ArrayBuffer>
): Promise<ArrayBuffer> {
  const cached = rasterCache.get(assetId)
  if (cached) return cached
  const bytes = await fn()
  rasterCache.set(assetId, bytes)
  return bytes
}

/**
 * Persist the rasterized PNG `bytes` for `assetId` and append a normal IMAGE
 * `OverlayClip` at `startMs`. The asset is square, so both natural dimensions
 * are `STICKER_RASTER_PX`.
 */
export async function addEmojiOrStickerOverlay(opts: {
  assetId: string
  bytes: ArrayBuffer
  startMs: number
}): Promise<void> {
  const res = await window.electron.overlay.saveSticker(opts.assetId, opts.bytes)
  if (!res.ok) throw new Error(res.error)
  useProjectStore.getState().addOverlay(
    makeImageOverlay({
      path: res.path,
      naturalWidth: STICKER_RASTER_PX,
      naturalHeight: STICKER_RASTER_PX,
      startMs: opts.startMs
    })
  )
}
