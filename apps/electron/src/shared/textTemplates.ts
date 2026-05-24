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
  },
  // Phase 3.62 — additional title templates.
  {
    id: 'title-overlay-pill',
    label: '필 타이틀',
    category: 'title',
    spans: words('오늘의 핵심'),
    style: {
      preset: 'tiktok-rounded',
      fontSize: 72,
      align: 'center',
      yPosition: 0.18,
      background: 'pill'
    },
    animation: { entrance: 'slide-down', exit: 'fade', inMs: 400, outMs: 300 },
    durationMs: 2500
  },
  {
    id: 'title-cinematic',
    label: '시네마틱 슬레이트',
    category: 'title',
    spans: words('CHAPTER 01'),
    style: {
      preset: 'minimal-white',
      fontSize: 56,
      align: 'center',
      yPosition: 0.46,
      background: 'none',
      textStroke: { color: '#000000', width: 3 }
    },
    animation: { entrance: 'fade', exit: 'fade', inMs: 500, outMs: 500 },
    durationMs: 2500
  },
  {
    id: 'title-typewriter',
    label: '타이프라이터 제목',
    category: 'title',
    spans: words('스토리 시작'),
    style: {
      preset: 'minimal-white',
      fontSize: 60,
      align: 'center',
      yPosition: 0.5,
      background: 'none',
      textShadow: { color: '#000000', offsetX: 0, offsetY: 4, blur: 6 }
    },
    animation: { entrance: 'typewriter', exit: 'fade', inMs: 900, outMs: 300 },
    durationMs: 3500
  },
  {
    id: 'title-shadow-pop',
    label: '그림자 임팩트',
    category: 'title',
    spans: words('대박!'),
    style: {
      preset: 'block-bold',
      fontSize: 120,
      align: 'center',
      yPosition: 0.5,
      background: 'none',
      textStroke: { color: '#000000', width: 8 },
      textShadow: { color: '#ff8a00', offsetX: 0, offsetY: 0, blur: 32 }
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 250, outMs: 300 },
    durationMs: 1800
  },
  {
    id: 'title-gradient',
    label: '그라데이션 타이틀',
    category: 'title',
    spans: words('Special Edition'),
    style: {
      preset: 'gradient',
      fontSize: 78,
      align: 'center',
      yPosition: 0.42,
      background: 'none',
      textStroke: { color: '#000000', width: 5 }
    },
    animation: { entrance: 'slide-up', exit: 'fade', inMs: 400, outMs: 300 },
    durationMs: 3000
  },
  // Phase 3.62 — additional lower-third templates.
  {
    id: 'lower-third-location',
    label: '장소 표시',
    category: 'lower-third',
    spans: words('서울, 강남구'),
    style: {
      preset: 'minimal-white',
      fontSize: 38,
      align: 'left',
      yPosition: 0.88,
      background: 'solid',
      textShadow: { color: '#000000', offsetX: 0, offsetY: 2, blur: 3 }
    },
    animation: { entrance: 'slide-up', exit: 'slide-down', inMs: 300, outMs: 300 },
    durationMs: 4000
  },
  {
    id: 'lower-third-quote',
    label: '인용 자막',
    category: 'lower-third',
    spans: words('"여기에 인용 문장을 적어주세요"'),
    style: {
      preset: 'minimal-white',
      fontSize: 38,
      align: 'center',
      yPosition: 0.84,
      background: 'pill',
      textShadow: { color: '#000000', offsetX: 0, offsetY: 2, blur: 3 }
    },
    animation: { entrance: 'fade', exit: 'fade', inMs: 350, outMs: 350 },
    durationMs: 4500
  },
  {
    id: 'lower-third-handle',
    label: 'SNS 핸들 표시',
    category: 'lower-third',
    spans: words('@yourname · YouTube'),
    style: {
      preset: 'youtube-yellow',
      fontSize: 36,
      align: 'left',
      yPosition: 0.9,
      background: 'solid'
    },
    animation: { entrance: 'slide-up', exit: 'fade', inMs: 300, outMs: 300 },
    durationMs: 5000
  },
  {
    id: 'lower-third-news',
    label: '뉴스 티커',
    category: 'lower-third',
    spans: words('BREAKING — 새 소식'),
    style: {
      preset: 'block-bold',
      fontSize: 42,
      align: 'left',
      yPosition: 0.92,
      background: 'solid',
      textStroke: { color: '#000000', width: 2 }
    },
    animation: { entrance: 'slide-up', exit: 'fade', inMs: 300, outMs: 300 },
    durationMs: 4500
  },
  {
    id: 'lower-third-timestamp',
    label: '시간 표시',
    category: 'lower-third',
    spans: words('00:42'),
    style: {
      preset: 'minimal-white',
      fontSize: 34,
      align: 'right',
      yPosition: 0.08,
      background: 'pill'
    },
    animation: { entrance: 'fade', exit: 'fade', inMs: 250, outMs: 250 },
    durationMs: 6000
  },
  // Phase 3.62 — additional CTA templates.
  {
    id: 'cta-subscribe',
    label: '구독 + 좋아요',
    category: 'cta',
    spans: words('구독 + 좋아요!'),
    style: {
      preset: 'youtube-yellow',
      fontSize: 64,
      align: 'center',
      yPosition: 0.5,
      background: 'solid',
      textStroke: { color: '#000000', width: 5 }
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 300, outMs: 300 },
    durationMs: 2500
  },
  {
    id: 'cta-link-bio',
    label: '프로필 링크',
    category: 'cta',
    spans: words('프로필 링크 확인 ↑'),
    style: {
      preset: 'tiktok-rounded',
      fontSize: 50,
      align: 'center',
      yPosition: 0.2,
      background: 'pill'
    },
    animation: { entrance: 'slide-down', exit: 'fade', inMs: 350, outMs: 300 },
    durationMs: 3000
  },
  {
    id: 'cta-save',
    label: '저장하기',
    category: 'cta',
    spans: words('저장 ❤'),
    style: {
      preset: 'block-bold',
      fontSize: 70,
      align: 'center',
      yPosition: 0.6,
      background: 'none',
      textStroke: { color: '#000000', width: 6 },
      textShadow: { color: '#ff3366', offsetX: 0, offsetY: 0, blur: 20 }
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 300, outMs: 300 },
    durationMs: 2000
  },
  {
    id: 'cta-share',
    label: '공유 유도',
    category: 'cta',
    spans: words('친구에게 공유하기'),
    style: {
      preset: 'minimal-white',
      fontSize: 54,
      align: 'center',
      yPosition: 0.72,
      background: 'solid'
    },
    animation: { entrance: 'fade', exit: 'fade', inMs: 350, outMs: 350 },
    durationMs: 2800
  },
  {
    id: 'cta-swipe',
    label: '스와이프 →',
    category: 'cta',
    spans: words('스와이프 →'),
    style: {
      preset: 'neon',
      fontSize: 56,
      align: 'center',
      yPosition: 0.85,
      background: 'none',
      textShadow: { color: '#00e5ff', offsetX: 0, offsetY: 0, blur: 18 }
    },
    animation: { entrance: 'slide-up', exit: 'fade', inMs: 300, outMs: 300 },
    durationMs: 2200
  },
  // Phase 3.62 — additional hook templates.
  {
    id: 'hook-spoiler',
    label: '스포일러',
    category: 'hook',
    spans: words('결말 스포!'),
    style: {
      preset: 'neon',
      fontSize: 80,
      align: 'center',
      yPosition: 0.5,
      background: 'none',
      textStroke: { color: '#000000', width: 6 },
      textShadow: { color: '#ffe600', offsetX: 0, offsetY: 0, blur: 24 }
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 250, outMs: 250 },
    durationMs: 1800
  },
  {
    id: 'hook-warning',
    label: '경고',
    category: 'hook',
    spans: words('⚠ 주의'),
    style: {
      preset: 'block-bold',
      fontSize: 88,
      align: 'center',
      yPosition: 0.45,
      background: 'none',
      textStroke: { color: '#000000', width: 7 },
      textShadow: { color: '#ff6a00', offsetX: 0, offsetY: 0, blur: 22 }
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 250, outMs: 300 },
    durationMs: 2000
  },
  {
    id: 'hook-question',
    label: '질문 던지기',
    category: 'hook',
    spans: words('정말 그럴까?'),
    style: {
      preset: 'gradient',
      fontSize: 72,
      align: 'center',
      yPosition: 0.42,
      background: 'none',
      textStroke: { color: '#000000', width: 5 }
    },
    animation: { entrance: 'fade', exit: 'fade', inMs: 400, outMs: 400 },
    durationMs: 2500
  },
  {
    id: 'hook-shock',
    label: '충격 폭로',
    category: 'hook',
    spans: words('충격적인 진실'),
    style: {
      preset: 'block-bold',
      fontSize: 80,
      align: 'center',
      yPosition: 0.5,
      background: 'none',
      textStroke: { color: '#000000', width: 6 },
      textShadow: { color: '#ff0066', offsetX: 0, offsetY: 0, blur: 22 }
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 250, outMs: 300 },
    durationMs: 2200
  },
  {
    id: 'hook-secret',
    label: '비밀 공개',
    category: 'hook',
    spans: words('아무도 모르는 것'),
    style: {
      preset: 'neon',
      fontSize: 70,
      align: 'center',
      yPosition: 0.45,
      background: 'none',
      textStroke: { color: '#000000', width: 5 }
    },
    animation: { entrance: 'slide-up', exit: 'fade', inMs: 350, outMs: 300 },
    durationMs: 2200
  },
  // Phase 3.62 — additional list templates.
  {
    id: 'list-step-2',
    label: '단계 2',
    category: 'list',
    spans: words('② 두 번째 단계'),
    style: {
      preset: 'minimal-white',
      fontSize: 52,
      align: 'left',
      yPosition: 0.42,
      background: 'solid',
      textShadow: { color: '#000000', offsetX: 0, offsetY: 3, blur: 4 }
    },
    animation: { entrance: 'slide-up', exit: 'fade', inMs: 350, outMs: 250 },
    durationMs: 3000
  },
  {
    id: 'list-step-3',
    label: '단계 3',
    category: 'list',
    spans: words('③ 세 번째 단계'),
    style: {
      preset: 'minimal-white',
      fontSize: 52,
      align: 'left',
      yPosition: 0.54,
      background: 'solid',
      textShadow: { color: '#000000', offsetX: 0, offsetY: 3, blur: 4 }
    },
    animation: { entrance: 'slide-up', exit: 'fade', inMs: 350, outMs: 250 },
    durationMs: 3000
  },
  {
    id: 'list-bullet',
    label: '불릿 라벨',
    category: 'list',
    spans: words('• 핵심 포인트'),
    style: {
      preset: 'block-bold',
      fontSize: 56,
      align: 'left',
      yPosition: 0.36,
      background: 'none',
      textStroke: { color: '#000000', width: 4 }
    },
    animation: { entrance: 'slide-up', exit: 'fade', inMs: 350, outMs: 300 },
    durationMs: 3000
  },
  {
    id: 'list-pros',
    label: '장점 표시',
    category: 'list',
    spans: words('✓ 장점'),
    style: {
      preset: 'tiktok-rounded',
      fontSize: 50,
      align: 'left',
      yPosition: 0.4,
      background: 'solid'
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 300, outMs: 300 },
    durationMs: 2500
  },
  {
    id: 'list-cons',
    label: '단점 표시',
    category: 'list',
    spans: words('✗ 단점'),
    style: {
      preset: 'tiktok-rounded',
      fontSize: 50,
      align: 'left',
      yPosition: 0.52,
      background: 'solid'
    },
    animation: { entrance: 'pop', exit: 'fade', inMs: 300, outMs: 300 },
    durationMs: 2500
  }
]

/** Look up a template by id. */
export function getTextTemplate(id: string): TextTemplate | undefined {
  return TEXT_TEMPLATES.find((t) => t.id === id)
}
