/**
 * Emoji & sticker library (Phase 3.25).
 *
 * Pure data — NO binary assets. Each emoji is a unicode char; each graphic
 * sticker is an inline SVG string. At add-time the renderer rasterizes the
 * glyph / SVG onto a `<canvas>` (Chromium renders color emoji + SVG natively),
 * persists the PNG to `userData/sticker-assets/`, and adds a normal IMAGE
 * `OverlayClip`. Export consumes it like any imported image — no export change.
 *
 * IMPORTANT: every `id` here is a STABLE forever-key — it is the dedupe cache
 * key AND the on-disk PNG filename stem. Never rename or renumber an id.
 */

/** Square render resolution for a rasterized emoji/sticker PNG (transparent). */
export const STICKER_RASTER_PX = 320

export type StickerCategory =
  | 'faces'
  | 'reactions'
  | 'gestures'
  | 'objects'
  | 'graphic'

/** Korean labels for the picker section headers. */
export const STICKER_CATEGORY_LABELS: Record<StickerCategory, string> = {
  faces: '표정',
  reactions: '반응',
  gestures: '제스처',
  objects: '오브젝트',
  graphic: '그래픽 스티커'
}

/** An emoji entry — rasterized from its unicode char at add-time. */
export interface EmojiItem {
  /** Stable id — dedupe key + PNG filename stem. `/^[a-z0-9-]{1,64}$/`. */
  id: string
  /** The unicode emoji character. */
  char: string
  /** Korean label / tooltip. */
  label: string
  category: StickerCategory
}

/** A graphic sticker — authored as a standalone inline SVG markup string. */
export interface GraphicSticker {
  /** Stable id — dedupe key + PNG filename stem. `/^[a-z0-9-]{1,64}$/`. */
  id: string
  label: string
  category: 'graphic'
  /** Self-contained SVG document, `viewBox="0 0 320 320"`, no external refs. */
  svg: string
}

// ---------------------------------------------------------------------------
// Emoji library — ~48 entries across 4 categories.
// ---------------------------------------------------------------------------

function emojiGroup(
  category: StickerCategory,
  rows: ReadonlyArray<readonly [string, string, string]>
): EmojiItem[] {
  return rows.map(([id, char, label]) => ({ id, char, label, category }))
}

export const EMOJI_LIBRARY: readonly EmojiItem[] = [
  ...emojiGroup('faces', [
    ['emoji-grin', '😀', '활짝 웃음'],
    ['emoji-heart-eyes', '😍', '하트 눈'],
    ['emoji-cool', '😎', '선글라스'],
    ['emoji-hold-tears', '🥹', '감동'],
    ['emoji-sob', '😭', '펑펑 울음'],
    ['emoji-rage', '😡', '화남'],
    ['emoji-think', '🤔', '생각'],
    ['emoji-sweat-smile', '😅', '식은땀'],
    ['emoji-party-face', '🥳', '파티 얼굴'],
    ['emoji-scream', '😱', '비명'],
    ['emoji-roll-eyes', '🙄', '눈 굴림'],
    ['emoji-smirk', '😏', '능글']
  ]),
  ...emojiGroup('reactions', [
    ['emoji-fire', '🔥', '불꽃'],
    ['emoji-heart', '❤️', '하트'],
    ['emoji-thumbs-up', '👍', '좋아요'],
    ['emoji-thumbs-down', '👎', '싫어요'],
    ['emoji-hundred', '💯', '백점'],
    ['emoji-sparkles', '✨', '반짝'],
    ['emoji-party', '🎉', '축하'],
    ['emoji-star', '⭐', '별'],
    ['emoji-collision', '💥', '폭발'],
    ['emoji-eyes', '👀', '눈'],
    ['emoji-sparkle-heart', '💖', '반짝 하트'],
    ['emoji-zap', '⚡', '번개']
  ]),
  ...emojiGroup('gestures', [
    ['emoji-clap', '👏', '박수'],
    ['emoji-raised-hands', '🙌', '만세'],
    ['emoji-call-me', '🤙', '전화해'],
    ['emoji-victory', '✌️', '브이'],
    ['emoji-heart-hands', '🫶', '손하트'],
    ['emoji-ok-hand', '👌', '오케이'],
    ['emoji-point-down', '👇', '아래 가리킴'],
    ['emoji-point-up2', '👆', '위 가리킴'],
    ['emoji-point-right', '👉', '오른쪽 가리킴'],
    ['emoji-point-left', '👈', '왼쪽 가리킴'],
    ['emoji-point-up', '☝️', '위로'],
    ['emoji-pray', '🙏', '부탁']
  ]),
  ...emojiGroup('objects', [
    ['emoji-pin', '📌', '핀'],
    ['emoji-bulb', '💡', '아이디어'],
    ['emoji-alarm', '⏰', '알람'],
    ['emoji-gift', '🎁', '선물'],
    ['emoji-cart', '🛒', '장바구니'],
    ['emoji-megaphone', '📢', '확성기'],
    ['emoji-check-mark', '✅', '체크'],
    ['emoji-cross-mark', '❌', '엑스'],
    ['emoji-warning', '⚠️', '경고'],
    ['emoji-bell', '🔔', '알림'],
    ['emoji-speech', '💬', '말풍선'],
    ['emoji-question', '❓', '물음표']
  ])
]

// ---------------------------------------------------------------------------
// Graphic stickers — ~16 entries, authored as inline SVG strings.
// ---------------------------------------------------------------------------

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">'

/** A bold arrow pointing up, rotated `deg` about the center. */
function arrowSvg(deg: number): string {
  const path =
    '<path d="M160 38 L286 184 L214 184 L214 286 L106 286 L106 184 L34 184 Z" ' +
    'fill="#ffd400" stroke="#161616" stroke-width="16" stroke-linejoin="round"/>'
  return `${SVG_OPEN}<g transform="rotate(${deg} 160 160)">${path}</g></svg>`
}

/** A rounded-rect badge with centered bold text. */
function badgeSvg(text: string, fill: string, fontSize = 78): string {
  return (
    `${SVG_OPEN}` +
    '<rect x="20" y="104" width="280" height="112" rx="26" ' +
    `fill="${fill}" stroke="#161616" stroke-width="10"/>` +
    `<text x="160" y="160" font-family="Arial, 'Malgun Gothic', sans-serif" ` +
    `font-size="${fontSize}" font-weight="900" fill="#ffffff" ` +
    'text-anchor="middle" dominant-baseline="central">' +
    text +
    '</text></svg>'
  )
}

/** A regular N-point star / burst polygon path. */
function burstSvg(): string {
  const cx = 160
  const cy = 160
  const spikes = 12
  const outer = 142
  const inner = 70
  const pts: string[] = []
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = (Math.PI * i) / spikes - Math.PI / 2
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`)
  }
  return (
    `${SVG_OPEN}<polygon points="${pts.join(' ')}" ` +
    'fill="#ff3b30" stroke="#161616" stroke-width="12" stroke-linejoin="round"/></svg>'
  )
}

export const GRAPHIC_STICKERS: readonly GraphicSticker[] = [
  { id: 'sticker-arrow-up', label: '화살표 위', category: 'graphic', svg: arrowSvg(0) },
  { id: 'sticker-arrow-down', label: '화살표 아래', category: 'graphic', svg: arrowSvg(180) },
  { id: 'sticker-arrow-left', label: '화살표 왼쪽', category: 'graphic', svg: arrowSvg(270) },
  { id: 'sticker-arrow-right', label: '화살표 오른쪽', category: 'graphic', svg: arrowSvg(90) },
  { id: 'sticker-badge-new', label: 'NEW 배지', category: 'graphic', svg: badgeSvg('NEW', '#ff3b30') },
  { id: 'sticker-badge-sale', label: 'SALE 배지', category: 'graphic', svg: badgeSvg('SALE', '#0a84ff', 70) },
  { id: 'sticker-badge-hot', label: 'HOT 배지', category: 'graphic', svg: badgeSvg('HOT', '#ff9500') },
  { id: 'sticker-badge-tip', label: '꿀팁 배지', category: 'graphic', svg: badgeSvg('꿀팁', '#34c759', 72) },
  {
    id: 'sticker-speech',
    label: '말풍선',
    category: 'graphic',
    svg:
      `${SVG_OPEN}<path d="M44 56 H276 a24 24 0 0 1 24 24 V196 a24 24 0 0 1 -24 24 ` +
      'H148 L96 272 V220 H44 a24 24 0 0 1 -24 -24 V80 a24 24 0 0 1 24 -24 Z" ' +
      'fill="#ffffff" stroke="#161616" stroke-width="14" stroke-linejoin="round"/></svg>'
  },
  { id: 'sticker-burst', label: '폭발 스타', category: 'graphic', svg: burstSvg() },
  {
    id: 'sticker-check',
    label: '체크',
    category: 'graphic',
    svg:
      `${SVG_OPEN}<circle cx="160" cy="160" r="132" fill="#34c759" ` +
      'stroke="#161616" stroke-width="14"/>' +
      '<path d="M96 166 L142 212 L228 110" fill="none" stroke="#ffffff" ' +
      'stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  },
  {
    id: 'sticker-cross',
    label: '엑스',
    category: 'graphic',
    svg:
      `${SVG_OPEN}<circle cx="160" cy="160" r="132" fill="#ff3b30" ` +
      'stroke="#161616" stroke-width="14"/>' +
      '<path d="M112 112 L208 208 M208 112 L112 208" fill="none" stroke="#ffffff" ' +
      'stroke-width="34" stroke-linecap="round"/></svg>'
  },
  {
    id: 'sticker-ring',
    label: '강조 링',
    category: 'graphic',
    svg:
      `${SVG_OPEN}<circle cx="160" cy="160" r="120" fill="none" ` +
      'stroke="#ffd400" stroke-width="26"/></svg>'
  },
  {
    id: 'sticker-star',
    label: '별',
    category: 'graphic',
    svg:
      `${SVG_OPEN}<path d="M160 30 L201 122 L300 132 L226 198 L248 296 L160 245 ` +
      'L72 296 L94 198 L20 132 L119 122 Z" fill="#ffd400" stroke="#161616" ' +
      'stroke-width="14" stroke-linejoin="round"/></svg>'
  },
  {
    id: 'sticker-heart',
    label: '하트',
    category: 'graphic',
    svg:
      `${SVG_OPEN}<path d="M160 278 L52 168 a64 64 0 0 1 108 -84 a64 64 0 0 1 108 84 Z" ` +
      'fill="#ff2d55" stroke="#161616" stroke-width="14" stroke-linejoin="round"/></svg>'
  },
  {
    id: 'sticker-swipe-up',
    label: '위로 스와이프',
    category: 'graphic',
    svg:
      `${SVG_OPEN}<path d="M160 70 L228 156 L182 156 L182 250 L138 250 L138 156 ` +
      'L92 156 Z" fill="#ffffff" stroke="#161616" stroke-width="14" ' +
      'stroke-linejoin="round"/>' +
      '<text x="160" y="298" font-family="Arial, sans-serif" font-size="34" ' +
      'font-weight="800" fill="#ffffff" stroke="#161616" stroke-width="6" ' +
      'paint-order="stroke" text-anchor="middle">SWIPE</text></svg>'
  }
]

/** Look up an emoji by id. */
export function getEmojiItem(id: string): EmojiItem | undefined {
  return EMOJI_LIBRARY.find((e) => e.id === id)
}

/** Look up a graphic sticker by id. */
export function getGraphicSticker(id: string): GraphicSticker | undefined {
  return GRAPHIC_STICKERS.find((s) => s.id === id)
}
