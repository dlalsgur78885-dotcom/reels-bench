/**
 * Phase 3.68 — speed-curve presets.
 *
 * A speed-curve preset is a named recipe of `(atFrac, speed)` pairs that
 * `buildSpeedKeyframes` resolves into a clip-specific `SpeedKeyframe[]` (the
 * editor's existing per-clip speedKeyframes field; export already piecewise-
 * unrolls the curve into segments). Pure data + pure math — same model as
 * `zoomPresets.ts`. Applying writes only `speedKeyframes`; no schema change.
 *
 * Every `speed` value is pre-clamped to [MIN_CLIP_SPEED, MAX_CLIP_SPEED] at
 * build time so an invalid recipe can never slip past the store.
 */
import type { SpeedKeyframe } from './project'
import { MAX_CLIP_SPEED, MIN_CLIP_SPEED } from './project'

export type SpeedPresetId =
  | 'speed-up'
  | 'slow-down'
  | 'ramp-up'
  | 'ramp-down'
  | 'bullet-time'
  | 'flash-forward'
  | 'reverse-ramp'
  | 'forward-ramp'
  | 'punch-stop'
  | 'kick-off'
  | 'oscillate'
  | 'staccato'
  | 'ease-cruise'

export interface SpeedKeyframeSpec {
  /** Position in the clip's SOURCE window, 0..1. */
  atFrac: number
  speed: number
}

export interface SpeedPreset {
  id: SpeedPresetId
  /** Korean picker label. */
  label: string
  /** Short Korean hint. */
  description: string
  specs: SpeedKeyframeSpec[]
}

export const SPEED_PRESETS: readonly SpeedPreset[] = [
  {
    id: 'speed-up',
    label: '점점 빨리',
    description: '일정한 가속 — 1× → 2×',
    specs: [
      { atFrac: 0, speed: 1 },
      { atFrac: 1, speed: 2 }
    ]
  },
  {
    id: 'slow-down',
    label: '점점 느리게',
    description: '1× → 0.5×',
    specs: [
      { atFrac: 0, speed: 1 },
      { atFrac: 1, speed: 0.5 }
    ]
  },
  {
    id: 'ramp-up',
    label: '슬로 → 노말 → 패스트',
    description: '느린 진입 → 정상 → 가속',
    specs: [
      { atFrac: 0, speed: 0.5 },
      { atFrac: 0.5, speed: 1 },
      { atFrac: 1, speed: 2 }
    ]
  },
  {
    id: 'ramp-down',
    label: '패스트 → 노말 → 슬로',
    description: '빠르게 시작 → 점점 슬로',
    specs: [
      { atFrac: 0, speed: 2 },
      { atFrac: 0.5, speed: 1 },
      { atFrac: 1, speed: 0.5 }
    ]
  },
  {
    id: 'bullet-time',
    label: '불릿 타임',
    description: '중간에 슬로모션 — 1× → 0.3× → 1×',
    specs: [
      { atFrac: 0, speed: 1 },
      { atFrac: 0.45, speed: 0.3 },
      { atFrac: 0.55, speed: 0.3 },
      { atFrac: 1, speed: 1 }
    ]
  },
  {
    id: 'flash-forward',
    label: '플래시 포워드',
    description: '중간만 빠르게 — 1× → 3× → 1×',
    specs: [
      { atFrac: 0, speed: 1 },
      { atFrac: 0.45, speed: 3 },
      { atFrac: 0.55, speed: 3 },
      { atFrac: 1, speed: 1 }
    ]
  },
  {
    id: 'reverse-ramp',
    label: '리버스 램프',
    description: '빠르게 시작 → 천천히 끝 (2× → 0.5×)',
    specs: [
      { atFrac: 0, speed: 2 },
      { atFrac: 1, speed: 0.5 }
    ]
  },
  {
    id: 'forward-ramp',
    label: '포워드 램프',
    description: '천천히 시작 → 빠르게 끝 (0.5× → 2×)',
    specs: [
      { atFrac: 0, speed: 0.5 },
      { atFrac: 1, speed: 2 }
    ]
  },
  {
    id: 'punch-stop',
    label: '펀치 스톱',
    description: '끝에서 멈춤 — 임팩트',
    specs: [
      { atFrac: 0, speed: 1 },
      { atFrac: 0.85, speed: 1 },
      { atFrac: 1, speed: 0.1 }
    ]
  },
  {
    id: 'kick-off',
    label: '킥 오프',
    description: '느린 시작 → 정상 속도로 튕김',
    specs: [
      { atFrac: 0, speed: 0.3 },
      { atFrac: 0.15, speed: 1 },
      { atFrac: 1, speed: 1 }
    ]
  },
  {
    id: 'oscillate',
    label: '오실레이트',
    description: '속도가 흔들림 — 1× → 2× → 0.5× → 1×',
    specs: [
      { atFrac: 0, speed: 1 },
      { atFrac: 0.33, speed: 2 },
      { atFrac: 0.66, speed: 0.5 },
      { atFrac: 1, speed: 1 }
    ]
  },
  {
    id: 'staccato',
    label: '스타카토',
    description: '정상 ↔ 빠름 반복',
    specs: [
      { atFrac: 0, speed: 1 },
      { atFrac: 0.25, speed: 3 },
      { atFrac: 0.5, speed: 1 },
      { atFrac: 0.75, speed: 3 },
      { atFrac: 1, speed: 1 }
    ]
  },
  {
    id: 'ease-cruise',
    label: '이즈 크루즈',
    description: '느린 진입 → 부드러운 유지',
    specs: [
      { atFrac: 0, speed: 0.6 },
      { atFrac: 0.2, speed: 1 },
      { atFrac: 1, speed: 1 }
    ]
  }
]

export function getSpeedPreset(
  id: string | null | undefined
): SpeedPreset | undefined {
  return SPEED_PRESETS.find((p) => p.id === id)
}

/**
 * Resolve a preset to a `SpeedKeyframe[]` for a clip whose SOURCE window is
 * `sourceDurationMs` long (== `trimOutMs - trimInMs`). Every `atMs` is
 * source-relative (matches `SpeedKeyframe.atMs` semantics). The result is
 * sorted ascending, deduped on identical `atMs`, and every `speed` clamped.
 * Returns `[]` when fewer than 2 valid keyframes survive (caller treats
 * `[]` as "fall back to constant speed").
 */
export function buildSpeedKeyframes(
  presetId: string,
  sourceDurationMs: number
): SpeedKeyframe[] {
  const preset = getSpeedPreset(presetId)
  if (!preset) return []
  const dur = Number.isFinite(sourceDurationMs)
    ? Math.max(0, sourceDurationMs)
    : 0
  if (dur < 1) return []
  const raw: SpeedKeyframe[] = preset.specs.map((s) => ({
    atMs: Math.round(Math.max(0, Math.min(1, s.atFrac)) * dur),
    speed: Math.max(
      MIN_CLIP_SPEED,
      Math.min(MAX_CLIP_SPEED, Number.isFinite(s.speed) ? s.speed : 1)
    )
  }))
  raw.sort((a, b) => a.atMs - b.atMs)
  const out: SpeedKeyframe[] = []
  for (const kf of raw) {
    const prev = out[out.length - 1]
    if (prev && kf.atMs === prev.atMs) {
      out[out.length - 1] = kf // dedup on tie — last write wins
    } else {
      out.push(kf)
    }
  }
  return out.length >= 2 ? out : []
}
