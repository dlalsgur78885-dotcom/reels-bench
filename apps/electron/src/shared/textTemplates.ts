/**
 * Text templates (Phase 3.24) — a library of pre-designed caption blocks
 * (title cards, lower-thirds, CTAs, hooks) the user inserts in one click.
 *
 * A template is PURE authoring data: applying it inserts a plain `CaptionClip`
 * pre-filled with the template's spans + style (+ optional animation). Once
 * inserted it IS an ordinary caption — export, preview, the karaoke / stroke /
 * shadow features all apply unchanged. This module imports only types from
 * `./project` and is never imported by the export graph.
 */
import type { CaptionAnimation, CaptionSpan, CaptionStyle } from './project'

/** Marketer-facing categories for the template picker. */
export type TextTemplateCategory =
  | 'title'
  | 'lower-third'
  | 'cta'
  | 'hook'
  | 'list'

/** A named bundle of caption authoring data. */
export interface TextTemplate {
  /** Stable kebab-case id — React key + test selector suffix. */
  id: string
  /** Korean label shown on the picker card. */
  label: string
  category: TextTemplateCategory
  /** Sample spans pre-filled into the inserted caption (user edits afterward). */
  spans: CaptionSpan[]
  /** Full caption style — every field of `CaptionStyle`. */
  style: CaptionStyle
  /** Optional entrance/exit animation. Absent ⇒ static caption. */
  animation?: CaptionAnimation
  /** Default clip duration in ms when inserted. */
  durationMs: number
}

/** Korean category labels for the picker section headers. */
export const TEXT_TEMPLATE_CATEGORY_LABELS: Record<
  TextTemplateCategory,
  string
> = {
  title: '타이틀 / 제목',
  'lower-third': '하단 자막바',
  cta: 'CTA / 행동 유도',
  hook: '훅 / 강조',
  list: '리스트 / 번호'
}

/** One span per word — `CaptionEditor` re-splits on whitespace when edited. */
function words(text: string): CaptionSpan[] {
  return text
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => ({ text: w }))
}

/** The text-template library. */
export const TEXT_TEMPLATES: readonly TextTemplate[] = [
  {
    id: 'title-bold',
    label: '큰 제목',
    category: 'title',
    spans: words('여기에 제목'),
    style: {
      preset: 'block-bold',
      fontSize: 84,
      align: 'center',
      yPosition: 0.42,
      background: 'none',
      textStroke: { color: '#000000', width: 6 }
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 400, outMs: 300 },
    durationMs: 3000
  },
  {
    id: 'title-subtitle',
    label: '제목 + 부제목',
    category: 'title',
    spans: words('메인 제목 보조 설명을 적어주세요'),
    style: {
      preset: 'minimal-white',
      fontSize: 64,
      align: 'center',
      yPosition: 0.4,
      background: 'none',
      textShadow: { color: '#000000', offsetX: 0, offsetY: 4, blur: 6 }
    },
    animation: { entrance: 'slide-up', exit: 'fade', inMs: 450, outMs: 300 },
    durationMs: 3000
  },
  {
    id: 'lower-third-name',
    label: '이름 / 직함 바',
    category: 'lower-third',
    spans: words('홍길동 / 디렉터'),
    style: {
      preset: 'block-bold',
      fontSize: 46,
      align: 'left',
      yPosition: 0.82,
      background: 'solid'
    },
    animation: {
      entrance: 'slide-up',
      exit: 'slide-down',
      inMs: 350,
      outMs: 300
    },
    durationMs: 4000
  },
  {
    id: 'lower-third-pill',
    label: '필 자막바',
    category: 'lower-third',
    spans: words('채널 이름'),
    style: {
      preset: 'tiktok-rounded',
      fontSize: 44,
      align: 'center',
      yPosition: 0.86,
      background: 'pill'
    },
    animation: { entrance: 'fade', exit: 'fade', inMs: 300, outMs: 300 },
    durationMs: 4000
  },
  {
    id: 'cta-follow',
    label: '팔로우 유도',
    category: 'cta',
    spans: words('팔로우하세요'),
    style: {
      preset: 'block-bold',
      fontSize: 70,
      align: 'center',
      yPosition: 0.5,
      background: 'none',
      textStroke: { color: '#000000', width: 8 },
      textShadow: { color: '#00e5ff', offsetX: 0, offsetY: 0, blur: 24 }
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 350, outMs: 300 },
    durationMs: 2500
  },
  {
    id: 'cta-more',
    label: '더보기',
    category: 'cta',
    spans: words('더보기 ↓'),
    style: {
      preset: 'youtube-yellow',
      fontSize: 60,
      align: 'center',
      yPosition: 0.78,
      background: 'solid',
      textStroke: { color: '#000000', width: 5 }
    },
    animation: { entrance: 'slide-up', exit: 'fade', inMs: 350, outMs: 300 },
    durationMs: 2500
  },
  {
    id: 'cta-comment',
    label: '댓글 유도',
    category: 'cta',
    spans: words('댓글 달아주세요'),
    style: {
      preset: 'tiktok-rounded',
      fontSize: 56,
      align: 'center',
      yPosition: 0.72,
      background: 'pill',
      textShadow: { color: '#000000', offsetX: 0, offsetY: 3, blur: 4 }
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 350, outMs: 300 },
    durationMs: 2500
  },
  {
    id: 'hook-wait',
    label: '잠깐!',
    category: 'hook',
    spans: words('잠깐!'),
    style: {
      preset: 'neon',
      fontSize: 96,
      align: 'center',
      yPosition: 0.5,
      background: 'none',
      textStroke: { color: '#000000', width: 6 },
      textShadow: { color: '#ff0040', offsetX: 0, offsetY: 0, blur: 28 }
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 300, outMs: 250 },
    durationMs: 1500
  },
  {
    id: 'hook-tip',
    label: '꿀팁',
    category: 'hook',
    spans: words('꿀팁'),
    style: {
      preset: 'gradient',
      fontSize: 88,
      align: 'center',
      yPosition: 0.45,
      background: 'none',
      textStroke: { color: '#000000', width: 5 }
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 300, outMs: 300 },
    durationMs: 2000
  },
  {
    id: 'list-step',
    label: '번호 라벨',
    category: 'list',
    spans: words('① 첫 번째 단계'),
    style: {
      preset: 'minimal-white',
      fontSize: 52,
      align: 'left',
      yPosition: 0.3,
      background: 'solid',
      textShadow: { color: '#000000', offsetX: 0, offsetY: 3, blur: 4 }
    },
    animation: { entrance: 'slide-up', exit: 'fade', inMs: 350, outMs: 250 },
    durationMs: 3000
  }
]

/** Look up a template by id. */
export function getTextTemplate(id: string): TextTemplate | undefined {
  return TEXT_TEMPLATES.find((t) => t.id === id)
}
