/**
 * Auto-zoom / punch-in presets (Phase 3.31).
 *
 * A zoom preset is a named recipe of RELATIVE transform deltas. Applying one
 * writes the clip's existing `transformKeyframes` field (the export already
 * honors it) — so this is pure authoring data: no `project.ts` schema change,
 * no export change. The store action composes each preset keyframe onto the
 * clip's current static transform (scale multiplied, x/y offset added).
 *
 * Every `scaleFactor >= 1.0` — a zoom only crops, never reveals transparent
 * gutters.
 */
import type { TransformKeyframe } from './project'
import { MAX_KEYFRAMES_PER_CLIP, MIN_KEYFRAME_GAP_MS } from './project'

export type ZoomPresetId =
  | 'punch-in'
  | 'punch-in-fast'
  | 'zoom-in-slow'
  | 'zoom-out'
  | 'ken-burns'
  | 'zoom-pulse'

/** One keyframe of a preset recipe — RELATIVE deltas, not absolute transforms. */
export interface ZoomKeyframeSpec {
  /** Position in the clip, 0..1 of clip duration. */
  atFrac: number
  /** Multiplier applied to the clip's base scale. >= 1 for the zoom-in family. */
  scaleFactor: number
  /** Additive x offset (canvas-center-relative fraction). 0 = no pan. */
  xOffset: number
  /** Additive y offset. */
  yOffset: number
}

export interface ZoomPreset {
  id: ZoomPresetId
  /** Korean picker label. */
  label: string
  /** Short Korean hint. */
  description: string
  specs: ZoomKeyframeSpec[]
}

export const ZOOM_PRESETS: readonly ZoomPreset[] = [
  {
    id: 'punch-in',
    label: '펀치인',
    description: '은은하게 서서히 확대 — 토킹헤드 기본',
    specs: [
      { atFrac: 0, scaleFactor: 1.0, xOffset: 0, yOffset: 0 },
      { atFrac: 1, scaleFactor: 1.12, xOffset: 0, yOffset: 0 }
    ]
  },
  {
    id: 'punch-in-fast',
    label: '빠른 펀치인',
    description: '유지하다 마지막에 빠르게 확대 — 강조',
    specs: [
      { atFrac: 0, scaleFactor: 1.0, xOffset: 0, yOffset: 0 },
      { atFrac: 0.85, scaleFactor: 1.0, xOffset: 0, yOffset: 0 },
      { atFrac: 1, scaleFactor: 1.15, xOffset: 0, yOffset: 0 }
    ]
  },
  {
    id: 'zoom-in-slow',
    label: '천천히 줌인',
    description: '클립 내내 크게 확대',
    specs: [
      { atFrac: 0, scaleFactor: 1.0, xOffset: 0, yOffset: 0 },
      { atFrac: 1, scaleFactor: 1.25, xOffset: 0, yOffset: 0 }
    ]
  },
  {
    id: 'zoom-out',
    label: '줌아웃',
    description: '확대 상태에서 원래 크기로',
    specs: [
      { atFrac: 0, scaleFactor: 1.2, xOffset: 0, yOffset: 0 },
      { atFrac: 1, scaleFactor: 1.0, xOffset: 0, yOffset: 0 }
    ]
  },
  {
    id: 'ken-burns',
    label: '켄 번스',
    description: '느린 대각 패닝 + 살짝 확대',
    specs: [
      { atFrac: 0, scaleFactor: 1.15, xOffset: -0.06, yOffset: -0.05 },
      { atFrac: 1, scaleFactor: 1.18, xOffset: 0.06, yOffset: 0.05 }
    ]
  },
  {
    id: 'zoom-pulse',
    label: '줌 펄스',
    description: '한 번 튕기듯 확대했다 복귀 — 액센트',
    specs: [
      { atFrac: 0, scaleFactor: 1.0, xOffset: 0, yOffset: 0 },
      { atFrac: 0.5, scaleFactor: 1.08, xOffset: 0, yOffset: 0 },
      { atFrac: 1, scaleFactor: 1.0, xOffset: 0, yOffset: 0 }
    ]
  }
]

/** Look up a preset by id. */
export function getZoomPreset(id: string | null | undefined): ZoomPreset | undefined {
  return ZOOM_PRESETS.find((p) => p.id === id)
}

/**
 * Resolve a preset to a RELATIVE `TransformKeyframe[]` for a clip of the given
 * timeline duration. Each keyframe's `transform.scale` carries the recipe's
 * `scaleFactor`, `transform.x/y` carry the offsets, `rotation`/`opacity` are 0
 * (the store fills them from the clip's base transform). Guarantees: ≥ 2
 * keyframes, sorted ascending, every gap ≥ MIN_KEYFRAME_GAP_MS, count ≤
 * MAX_KEYFRAMES_PER_CLIP. Returns `[]` when the clip is too short to host 2
 * keyframes that far apart (caller treats `[]` as a no-op).
 */
export function buildZoomKeyframes(
  presetId: string,
  clipDurationMs: number
): TransformKeyframe[] {
  const preset = getZoomPreset(presetId)
  if (!preset) return []
  const dur = Number.isFinite(clipDurationMs) ? Math.max(0, clipDurationMs) : 0
  const raw: TransformKeyframe[] = preset.specs.map((s) => ({
    atMs: Math.round(Math.min(1, Math.max(0, s.atFrac)) * dur),
    transform: {
      x: s.xOffset,
      y: s.yOffset,
      scale: s.scaleFactor,
      rotation: 0,
      opacity: 0
    }
  }))
  raw.sort((a, b) => a.atMs - b.atMs)
  const out: TransformKeyframe[] = []
  for (const kf of raw) {
    const prev = out[out.length - 1]
    if (prev && kf.atMs - prev.atMs < MIN_KEYFRAME_GAP_MS) {
      out[out.length - 1] = kf // last-write-wins on a too-close pair
    } else {
      out.push(kf)
    }
    if (out.length >= MAX_KEYFRAMES_PER_CLIP) break
  }
  return out.length >= 2 ? out : []
}
