/**
 * Collage / split-screen layout presets (Phase 3.18).
 *
 * A layout is a set of CELL rectangles tiling the canvas; "apply layout" writes
 * each clip's `transform` + `cropRect` so it FILLS its cell. Pure data + pure
 * math — no runtime imports beyond the shared transform/crop types — so the
 * cell→placement helper is fully unit-testable. Export reads only the resulting
 * `transform`/`cropRect`; this module is never imported by the export graph.
 */
import type { ClipTransform, CropRect } from './project'

/** One layout cell — TOP-LEFT origin, canvas fractions (0,0 = top-left). */
export interface LayoutCell {
  x: number
  y: number
  w: number
  h: number
}

export type LayoutPresetId =
  | '2up-h'
  | '2up-v'
  | '3up-h'
  | '3up-v'
  | 'grid-2x2'
  | 'pip-tr'
  | 'pip-br'
  | '1plus2-v'
  // Phase 3.65 — second batch.
  | '4up-h'
  | '4up-v'
  | 'grid-3x3'
  | 'pip-tl'
  | 'pip-bl'
  | '2plus1-h'
  | '1plus3-v'
  | '3plus1-v'
  | 'L-shape-tr'
  | 'T-top'
  | '5up-1big'
  | '6up-2x3'

export interface LayoutPreset {
  id: LayoutPresetId
  /** Korean label for the picker. */
  label: string
  /** Ordered cells; clip i occupies cells[i]. */
  cells: LayoutCell[]
}

/** Inter-cell gap as a fraction (0 in v1 — gaps are a future apply-time inset). */
export const LAYOUT_GAP_FRAC = 0

export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  {
    id: '2up-h',
    label: '좌우 분할',
    cells: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 }
    ]
  },
  {
    id: '2up-v',
    label: '상하 분할',
    cells: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 }
    ]
  },
  {
    id: '3up-h',
    label: '3분할 가로',
    cells: [
      { x: 0, y: 0, w: 1 / 3, h: 1 },
      { x: 1 / 3, y: 0, w: 1 / 3, h: 1 },
      { x: 2 / 3, y: 0, w: 1 / 3, h: 1 }
    ]
  },
  {
    id: '3up-v',
    label: '3분할 세로',
    cells: [
      { x: 0, y: 0, w: 1, h: 1 / 3 },
      { x: 0, y: 1 / 3, w: 1, h: 1 / 3 },
      { x: 0, y: 2 / 3, w: 1, h: 1 / 3 }
    ]
  },
  {
    id: 'grid-2x2',
    label: '2×2 격자',
    cells: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
    ]
  },
  {
    id: 'pip-tr',
    label: 'PiP 우상단',
    cells: [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 0.62, y: 0.04, w: 0.34, h: 0.22 }
    ]
  },
  {
    id: 'pip-br',
    label: 'PiP 우하단',
    cells: [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 0.62, y: 0.74, w: 0.34, h: 0.22 }
    ]
  },
  {
    id: '1plus2-v',
    label: '1+2 분할',
    cells: [
      { x: 0, y: 0, w: 1, h: 0.6 },
      { x: 0, y: 0.6, w: 0.5, h: 0.4 },
      { x: 0.5, y: 0.6, w: 0.5, h: 0.4 }
    ]
  },
  // Phase 3.65 — second batch.
  {
    id: '4up-h',
    label: '4분할 가로',
    cells: [
      { x: 0, y: 0, w: 0.25, h: 1 },
      { x: 0.25, y: 0, w: 0.25, h: 1 },
      { x: 0.5, y: 0, w: 0.25, h: 1 },
      { x: 0.75, y: 0, w: 0.25, h: 1 }
    ]
  },
  {
    id: '4up-v',
    label: '4분할 세로',
    cells: [
      { x: 0, y: 0, w: 1, h: 0.25 },
      { x: 0, y: 0.25, w: 1, h: 0.25 },
      { x: 0, y: 0.5, w: 1, h: 0.25 },
      { x: 0, y: 0.75, w: 1, h: 0.25 }
    ]
  },
  {
    id: 'grid-3x3',
    label: '3×3 격자',
    cells: [
      { x: 0, y: 0, w: 1 / 3, h: 1 / 3 },
      { x: 1 / 3, y: 0, w: 1 / 3, h: 1 / 3 },
      { x: 2 / 3, y: 0, w: 1 / 3, h: 1 / 3 },
      { x: 0, y: 1 / 3, w: 1 / 3, h: 1 / 3 },
      { x: 1 / 3, y: 1 / 3, w: 1 / 3, h: 1 / 3 },
      { x: 2 / 3, y: 1 / 3, w: 1 / 3, h: 1 / 3 },
      { x: 0, y: 2 / 3, w: 1 / 3, h: 1 / 3 },
      { x: 1 / 3, y: 2 / 3, w: 1 / 3, h: 1 / 3 },
      { x: 2 / 3, y: 2 / 3, w: 1 / 3, h: 1 / 3 }
    ]
  },
  {
    id: 'pip-tl',
    label: 'PiP 좌상단',
    cells: [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 0.04, y: 0.04, w: 0.34, h: 0.22 }
    ]
  },
  {
    id: 'pip-bl',
    label: 'PiP 좌하단',
    cells: [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 0.04, y: 0.74, w: 0.34, h: 0.22 }
    ]
  },
  {
    id: '2plus1-h',
    label: '좌 2 + 우 1',
    cells: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 1 }
    ]
  },
  {
    id: '1plus3-v',
    label: '상 1 + 하 3',
    cells: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1 / 3, h: 0.5 },
      { x: 1 / 3, y: 0.5, w: 1 / 3, h: 0.5 },
      { x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 }
    ]
  },
  {
    id: '3plus1-v',
    label: '상 3 + 하 1',
    cells: [
      { x: 0, y: 0, w: 1 / 3, h: 0.5 },
      { x: 1 / 3, y: 0, w: 1 / 3, h: 0.5 },
      { x: 2 / 3, y: 0, w: 1 / 3, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 }
    ]
  },
  {
    id: 'L-shape-tr',
    label: 'L자 (우상단 큰)',
    cells: [
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 }
    ]
  },
  {
    id: 'T-top',
    label: 'T자 (상단 와이드)',
    cells: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
    ]
  },
  {
    id: '5up-1big',
    label: '좌 1 + 우 4',
    cells: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.25, h: 0.5 },
      { x: 0.75, y: 0, w: 0.25, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.25, h: 0.5 },
      { x: 0.75, y: 0.5, w: 0.25, h: 0.5 }
    ]
  },
  {
    id: '6up-2x3',
    label: '2×3 격자',
    cells: [
      { x: 0, y: 0, w: 1 / 3, h: 0.5 },
      { x: 1 / 3, y: 0, w: 1 / 3, h: 0.5 },
      { x: 2 / 3, y: 0, w: 1 / 3, h: 0.5 },
      { x: 0, y: 0.5, w: 1 / 3, h: 0.5 },
      { x: 1 / 3, y: 0.5, w: 1 / 3, h: 0.5 },
      { x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 }
    ]
  }
]

/** Look up a preset by id. */
export function getLayoutPreset(
  id: string | null | undefined
): LayoutPreset | undefined {
  return LAYOUT_PRESETS.find((p) => p.id === id)
}

/**
 * Map a layout cell to a clip's `transform` + `cropRect` so the clip FILLS the
 * cell (cover, no letterbox). The source is cropped to the cell's pixel aspect
 * ratio (export step 3.5), then aspect-fit to the W×H canvas, then the transform
 * scales + translates that content into the cell.
 *
 * `transform.x/y` are canvas-CENTER-relative fractions; `cropRect` is in source
 * fractions. Pure — `srcW`/`srcH` are the media's natural pixel dimensions.
 */
export function cellToClipPlacement(
  cell: LayoutCell,
  canvasW: number,
  canvasH: number,
  srcW: number,
  srcH: number
): { transform: ClipTransform; cropRect: CropRect } {
  const safeCanvasW = canvasW > 0 ? canvasW : 1080
  const safeCanvasH = canvasH > 0 ? canvasH : 1920
  const safeSrcW = srcW > 0 ? srcW : safeCanvasW
  const safeSrcH = srcH > 0 ? srcH : safeCanvasH

  const cw0 = Math.max(1e-4, cell.w)
  const ch0 = Math.max(1e-4, cell.h)
  const canvasA = safeCanvasW / safeCanvasH
  const cellA = (cw0 * safeCanvasW) / (ch0 * safeCanvasH)
  const srcA = safeSrcW / safeSrcH

  // Step A — crop the source so the kept region's aspect === cellA (cover).
  let cw = 1
  let ch = 1
  if (srcA > cellA) {
    cw = cellA / srcA
  } else {
    ch = srcA / cellA
  }
  const cropRect: CropRect = {
    x: (1 - cw) / 2,
    y: (1 - ch) / 2,
    w: cw,
    h: ch
  }

  // Step B — the cropped+aspect-fit content has aspect cellA. A single uniform
  // scale makes it exactly the cell's pixel size (content aspect === cell
  // aspect by construction, so both axes scale by the same factor).
  const scale = cellA >= canvasA ? cw0 : ch0

  const transform: ClipTransform = {
    x: cell.x + cw0 / 2 - 0.5,
    y: cell.y + ch0 / 2 - 0.5,
    scale,
    rotation: 0,
    opacity: 1
  }
  return { transform, cropRect }
}
