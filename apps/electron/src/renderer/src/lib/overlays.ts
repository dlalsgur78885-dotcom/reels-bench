// Phase 3.8 — overlay element factories + helpers.
//
// Pure builders for fresh OverlayClip instances (shape / image / sticker).
// Renderer-side; importable from OverlayLibrary, the store, and tests.
import { ulid } from 'ulid'
import {
  DEFAULT_OVERLAY_MS,
  DEFAULT_SHAPE_STYLE,
  type OverlayClip,
  type OverlaySource,
  type ShapeKind,
  type ShapeStyle
} from '../../../shared/project'

/** Default base size (fraction of a canvas dimension) for a fresh shape. */
export const DEFAULT_SHAPE_WIDTH_FRAC = 0.3
export const DEFAULT_SHAPE_HEIGHT_FRAC = 0.3
/** A line overlay is wide + thin by default. */
export const DEFAULT_LINE_WIDTH_FRAC = 0.4
export const DEFAULT_LINE_HEIGHT_FRAC = 0.02
/** Default base size for a fresh image overlay (width fraction; height is
 *  derived from the image's intrinsic aspect ratio). */
export const DEFAULT_IMAGE_WIDTH_FRAC = 0.35

/**
 * Build a fresh OverlayClip wrapping `source`, placed at `startMs` for
 * `DEFAULT_OVERLAY_MS`. `trackId` is filled in by the store's `addOverlay`
 * (it may pass a placeholder — the store re-targets to the overlay track).
 */
export function makeOverlayClip(opts: {
  source: OverlaySource
  startMs: number
  trackId?: string
  baseWidthFrac: number
  baseHeightFrac: number
  durationMs?: number
}): OverlayClip {
  const start = Math.max(0, Math.round(opts.startMs))
  const dur = Math.max(100, Math.round(opts.durationMs ?? DEFAULT_OVERLAY_MS))
  return {
    id: ulid(),
    kind: 'overlay',
    trackId: opts.trackId ?? '',
    startMs: start,
    endMs: start + dur,
    source: opts.source,
    baseWidthFrac: opts.baseWidthFrac,
    baseHeightFrac: opts.baseHeightFrac
  }
}

/** Build a fresh shape OverlayClip for the given shape kind at `startMs`. */
export function makeShapeOverlay(shape: ShapeKind, startMs: number): OverlayClip {
  const style: ShapeStyle = { ...DEFAULT_SHAPE_STYLE, shape }
  const isLine = shape === 'line'
  return makeOverlayClip({
    source: { type: 'shape', style },
    startMs,
    baseWidthFrac: isLine ? DEFAULT_LINE_WIDTH_FRAC : DEFAULT_SHAPE_WIDTH_FRAC,
    baseHeightFrac: isLine ? DEFAULT_LINE_HEIGHT_FRAC : DEFAULT_SHAPE_HEIGHT_FRAC
  })
}

/**
 * Build a fresh image OverlayClip. `naturalWidth`/`naturalHeight` drive the
 * aspect-correct base height (the base WIDTH is fixed at
 * DEFAULT_IMAGE_WIDTH_FRAC; height scales so the on-canvas box matches the
 * image's intrinsic ratio). A non-positive natural size falls back to square.
 */
export function makeImageOverlay(opts: {
  path: string
  naturalWidth: number
  naturalHeight: number
  startMs: number
}): OverlayClip {
  const nw = Number.isFinite(opts.naturalWidth) ? opts.naturalWidth : 0
  const nh = Number.isFinite(opts.naturalHeight) ? opts.naturalHeight : 0
  const aspect = nw > 0 && nh > 0 ? nw / nh : 1
  const baseWidthFrac = DEFAULT_IMAGE_WIDTH_FRAC
  // Height in canvas-fraction terms = width-fraction / aspect, because the
  // canvas is taller than wide for reels; keeping width fixed and deriving
  // height keeps the element visually proportioned for typical (1:1..16:9)
  // images. Clamped lightly so a wild aspect can't produce a degenerate box.
  const baseHeightFrac = Math.max(0.03, Math.min(1.5, baseWidthFrac / aspect))
  return makeOverlayClip({
    source: {
      type: 'image',
      path: opts.path,
      naturalWidth: nw,
      naturalHeight: nh
    },
    startMs: opts.startMs,
    baseWidthFrac,
    baseHeightFrac
  })
}

/** Build a fresh bundled-sticker OverlayClip. */
export function makeStickerOverlay(stickerId: string, startMs: number): OverlayClip {
  return makeOverlayClip({
    source: { type: 'sticker', stickerId },
    startMs,
    baseWidthFrac: DEFAULT_SHAPE_WIDTH_FRAC,
    baseHeightFrac: DEFAULT_SHAPE_HEIGHT_FRAC
  })
}

/** Short human label for an overlay source — used by Timeline clip blocks. */
export function overlaySourceLabel(source: OverlaySource): string {
  if (source.type === 'image') return '🖼 이미지'
  if (source.type === 'sticker') return `✨ 스티커`
  switch (source.style.shape) {
    case 'rectangle':
      return '🟦 사각형'
    case 'ellipse':
      return '⬭ 원'
    case 'line':
      return '➖ 선'
    default:
      return '🟦 도형'
  }
}
