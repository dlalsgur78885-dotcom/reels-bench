/**
 * Caption PNG renderer — pure module.
 *
 * Renders a `CaptionClip` to a PNG buffer using SVG + Sharp. The goal is
 * visual parity with the `PreviewCanvas` overlay (DOM div + CSS) so the
 * exported MP4 looks identical to the editor preview.
 *
 * Architecture:
 *   - Caption styles are translated to an SVG document. SVG covers everything
 *     the preview does: gradients (`linearGradient`), multi-layer glow
 *     (`feGaussianBlur` stacks), font choice (embedded @font-face), and
 *     rounded backgrounds (`rect` with `rx`).
 *   - Sharp renders the SVG to PNG via librsvg. Sharp is loaded lazily and
 *     wrapped in a `safeLoadSharp()` helper so a missing/broken native binding
 *     doesn't crash the whole export pipeline — `renderCaptionFrame` returns
 *     `null` and the caller falls back to ffmpeg's drawtext path.
 *   - Output PNGs are cached on disk under `userData/captions-cache/<hash>.png`,
 *     keyed by `(spans, style, canvasW, canvasH)`. Captions are static per
 *     clip in MVP — no per-frame animation — so a single PNG per caption
 *     suffices and the cache is highly effective across re-exports.
 *
 * Phase 5+ candidates (NOT implemented now):
 *   - Pulse / typewriter animation → render N PNGs per clip keyed by time.
 *   - Per-glyph emphasis transforms (rotate, scale) → SVG `<tspan>` with
 *     `transform-origin`.
 *   - Vector caption export via `-i caption.svg` directly (saves PNG round-trip).
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CaptionClip,
  CaptionPreset,
  CaptionSpan,
  CaptionStyle
} from '../../shared/project'

// ---------------------------------------------------------------------------
// Font discovery. The Korean Bold font is bundled under `build/fonts/`.
// In dev we resolve relative to the source tree; in a packaged build the
// asset lives under `resources/build/fonts/` (electron-builder copies the
// `build/` directory in via the `directories.buildResources` option). When
// not found, the renderer falls back to no embedded @font-face and uses
// librsvg's default font matching (which on Windows usually picks Arial /
// Malgun Gothic — Korean rendering still works, fidelity drops slightly).
// ---------------------------------------------------------------------------

let cachedFontDataUri: string | null | undefined

function resolveFontPath(): string | null {
  // Dev: src/main → ../../build/fonts/Pretendard-Bold.otf
  // Packaged: resourcesPath/build/fonts/Pretendard-Bold.otf (asar-unpacked
  //   is not needed because we *read* the file at runtime — it can live
  //   inside the asar; readFileSync supports asar transparently).
  const candidates: string[] = []
  try {
    // dev — file lives next to the app source root
    candidates.push(
      path.resolve(__dirname, '..', '..', '..', 'build', 'fonts', 'Pretendard-Bold.otf')
    )
  } catch {
    /* ignore */
  }
  try {
    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, 'build', 'fonts', 'Pretendard-Bold.otf')
      )
      candidates.push(
        path.join(process.resourcesPath, 'fonts', 'Pretendard-Bold.otf')
      )
    }
  } catch {
    /* ignore */
  }
  try {
    // electron-vite "out" build relative path
    candidates.push(
      path.resolve(__dirname, '..', '..', 'build', 'fonts', 'Pretendard-Bold.otf')
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

function getFontDataUri(): string | null {
  if (cachedFontDataUri !== undefined) return cachedFontDataUri
  const fontPath = resolveFontPath()
  if (!fontPath) {
    cachedFontDataUri = null
    return null
  }
  try {
    const buf = readFileSync(fontPath)
    cachedFontDataUri = `data:font/otf;base64,${buf.toString('base64')}`
    return cachedFontDataUri
  } catch {
    cachedFontDataUri = null
    return null
  }
}

// ---------------------------------------------------------------------------
// Sharp — lazy + safe load. The native binding might be missing on a fresh
// install (e.g. cross-arch). When it can't be loaded we return null and the
// caller falls back to drawtext.
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
    // Log once. Don't throw — caller handles the null and emits drawtext.
    console.warn(
      '[captions/render] sharp unavailable; falling back to drawtext:',
      err instanceof Error ? err.message : String(err)
    )
    cachedSharp = null
    return null
  }
}

// ---------------------------------------------------------------------------
// SVG escape — text content & attributes. SVG XML rules: '&', '<', '>', '"'
// must be entity-encoded. Apostrophes inside attribute values too when the
// attribute is quoted with the same character; we use double quotes for
// attributes throughout, so apostrophes pass through fine.
// ---------------------------------------------------------------------------
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Style → SVG. Each preset returns a builder function that produces a
// complete <svg>...</svg> string given the rendered spans and box metrics.
// Approach: estimate text width with a per-glyph heuristic (broad assumption
// — librsvg layouts the text accurately, so we only need a *bounding box*
// that fits; padding/centering is then handled by SVG text-anchor and the
// surrounding <rect>).
// ---------------------------------------------------------------------------

/** Approximate text width in px for a given font size. Used for centering
 *  + sizing the background rect. Heuristic: ~0.55em per ASCII char, ~1.0em
 *  per CJK ideograph. Not pixel-perfect, but the SVG renderer's text-anchor
 *  takes care of final placement; this just sizes the background. */
function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x1100 && code <= 0xffdc) {
      // Hangul, CJK Unified, Hangul Syllables, fullwidth, etc.
      w += fontSize * 1.0
    } else if (ch === ' ') {
      w += fontSize * 0.3
    } else {
      w += fontSize * 0.55
    }
  }
  return w
}

/** Map per-span CSS into SVG `<tspan>` attributes. */
function spanToTspan(
  span: CaptionSpan,
  style: CaptionStyle,
  defaultFill: string
): string {
  const attrs: Record<string, string> = {}
  const props: string[] = []
  let fill = span.color ?? defaultFill
  let bg: string | null = null

  if (span.emphasis === 'bold') {
    attrs['font-weight'] = '900'
  } else if (span.emphasis === 'highlight') {
    bg = '#ffd400'
    fill = '#1a1a1a'
  } else if (span.emphasis === 'pulse') {
    // No animation in static PNG; just emphasize by weight.
    attrs['font-weight'] = '900'
  }
  // Highlight background-mode also affects spans (per renderer).
  if (style.background === 'highlight' && span.emphasis !== 'highlight') {
    bg = 'rgba(255,212,0,0.85)'
    fill = '#111'
  }
  attrs['fill'] = fill
  // Per-tspan background isn't a standard SVG feature — librsvg ignores
  // `background-color`. Emulate via a slight stroke if highlighted.
  if (bg) {
    // Heuristic: thin matching stroke gives a visible "fill behind text" feel.
    // Not pixel-equivalent to the DOM <span> background, but readable.
    attrs['style'] = `paint-order:stroke fill;stroke:${bg};stroke-width:0.6em`
  }
  const tspanAttrs = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeXml(v)}"`)
    .join(' ')
  void props
  return `<tspan ${tspanAttrs}>${escapeXml(span.text)}</tspan>`
}

/** Concatenate spans into the SVG text body with spaces between. */
function buildSpansBody(
  spans: CaptionSpan[],
  style: CaptionStyle,
  defaultFill: string
): string {
  if (spans.length === 0) return ''
  return spans
    .map((s, i) => {
      const tspan = spanToTspan(s, style, defaultFill)
      // Insert a literal space tspan between spans so word breaks survive.
      return i > 0 ? `<tspan xml:space="preserve" fill="${escapeXml(defaultFill)}"> </tspan>${tspan}` : tspan
    })
    .join('')
}

interface RenderContext {
  /** Final scaled font size in px (relative to actual canvas height). */
  fontSize: number
  /** Estimated total text width in px (used for background box sizing). */
  textWidthPx: number
  /** Canvas dimensions. */
  canvasWidth: number
  canvasHeight: number
  /** Vertical center of the caption baseline in canvas px. */
  baselineY: number
  /** Spans body, already in SVG <tspan>...</tspan> form. */
  spansBody: string
  /** Plain joined text for fallback estimations. */
  plainText: string
  /** Pretendard @font-face block (data: URI), or "" if font missing. */
  fontFace: string
  /** Resolved font-family stack to reference from text elements. */
  fontFamily: string
  /** Style + clip metadata. */
  style: CaptionStyle
  spans: CaptionSpan[]
}

/** Per-preset SVG builders. Each returns the full <svg> document. */
type PresetBuilder = (ctx: RenderContext) => string

const BUILDERS: Record<CaptionPreset, PresetBuilder> = {
  'bottom-center': (ctx) => {
    // White text + soft shadow. Matches PreviewCanvas:
    //   color: '#fff', textShadow: '0 2px 4px rgba(0,0,0,0.7)'
    const { fontSize, canvasWidth, canvasHeight, baselineY, fontFace, fontFamily } = ctx
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
<defs>
<style>${fontFace}
.t{font-family:${fontFamily};font-weight:700;font-size:${fontSize}px;}</style>
<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
<feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="black" flood-opacity="0.7"/>
</filter>
</defs>
${withSolidBg(ctx, '#fff', 'rgba(0,0,0,0)')}
<g filter="url(#shadow)"><text x="${canvasWidth / 2}" y="${baselineY}" class="t" fill="#fff" text-anchor="middle">${ctx.spansBody}</text></g>
</svg>`
  },

  neon: (ctx) => {
    // White text + 4-layer cyan glow.
    //   text-shadow: 0 0 6px #0ff, 0 0 12px #0ff, 0 0 24px #00bfff, 0 0 36px #00bfff
    const { fontSize, canvasWidth, canvasHeight, baselineY, fontFace, fontFamily } = ctx
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
<defs>
<style>${fontFace}
.t{font-family:${fontFamily};font-weight:900;font-size:${fontSize}px;}</style>
<filter id="neon" x="-30%" y="-30%" width="160%" height="160%">
<feGaussianBlur in="SourceAlpha" stdDeviation="2" result="b1"/>
<feFlood flood-color="#00ffff" result="c1"/>
<feComposite in="c1" in2="b1" operator="in" result="g1"/>
<feGaussianBlur in="SourceAlpha" stdDeviation="4" result="b2"/>
<feFlood flood-color="#00ffff" result="c2"/>
<feComposite in="c2" in2="b2" operator="in" result="g2"/>
<feGaussianBlur in="SourceAlpha" stdDeviation="8" result="b3"/>
<feFlood flood-color="#00bfff" result="c3"/>
<feComposite in="c3" in2="b3" operator="in" result="g3"/>
<feGaussianBlur in="SourceAlpha" stdDeviation="12" result="b4"/>
<feFlood flood-color="#00bfff" result="c4"/>
<feComposite in="c4" in2="b4" operator="in" result="g4"/>
<feMerge>
<feMergeNode in="g4"/><feMergeNode in="g3"/><feMergeNode in="g2"/><feMergeNode in="g1"/>
<feMergeNode in="SourceGraphic"/>
</feMerge>
</filter>
</defs>
${withSolidBg(ctx, '#fff', 'rgba(0,0,0,0)')}
<g filter="url(#neon)"><text x="${canvasWidth / 2}" y="${baselineY}" class="t" fill="#ffffff" text-anchor="middle">${ctx.spansBody}</text></g>
</svg>`
  },

  'block-bold': (ctx) => {
    // Dark rounded rect + bold white text. Matches the renderer's "solid" bg
    // with !youtube-yellow → rgba(0,0,0,0.78), padding 0.25em 0.6em, radius 6.
    const { fontSize, canvasWidth, canvasHeight, baselineY, fontFace, fontFamily } = ctx
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
<defs>
<style>${fontFace}
.t{font-family:${fontFamily};font-weight:900;font-size:${fontSize}px;}</style>
</defs>
${withSolidBg(ctx, '#fff', 'rgba(0,0,0,0.78)')}
<text x="${canvasWidth / 2}" y="${baselineY}" class="t" fill="#ffffff" text-anchor="middle">${ctx.spansBody}</text>
</svg>`
  },

  'minimal-white': (ctx) => {
    // Thin white text + subtle shadow.
    //   color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.6)'
    const { fontSize, canvasWidth, canvasHeight, baselineY, fontFace, fontFamily } = ctx
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
<defs>
<style>${fontFace}
.t{font-family:${fontFamily};font-weight:400;font-size:${fontSize}px;}</style>
<filter id="msh" x="-10%" y="-10%" width="120%" height="120%">
<feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="black" flood-opacity="0.6"/>
</filter>
</defs>
${withSolidBg(ctx, '#fff', 'rgba(0,0,0,0)')}
<g filter="url(#msh)"><text x="${canvasWidth / 2}" y="${baselineY}" class="t" fill="#ffffff" text-anchor="middle">${ctx.spansBody}</text></g>
</svg>`
  },

  'youtube-yellow': (ctx) => {
    // Black solid bg + #ffd400 text + 2px black drop shadow.
    const { fontSize, canvasWidth, canvasHeight, baselineY, fontFace, fontFamily } = ctx
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
<defs>
<style>${fontFace}
.t{font-family:${fontFamily};font-weight:900;font-size:${fontSize}px;}</style>
</defs>
${withSolidBg(ctx, '#ffd400', '#000000')}
<text x="${canvasWidth / 2}" y="${baselineY}" class="t" fill="#ffd400" text-anchor="middle">${ctx.spansBody}</text>
</svg>`
  },

  'tiktok-rounded': (ctx) => {
    // Pill: rgba(0,0,0,0.7), radius 999, padding 0.2em 0.9em.
    const { fontSize, canvasWidth, canvasHeight, baselineY, fontFace, fontFamily } = ctx
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
<defs>
<style>${fontFace}
.t{font-family:${fontFamily};font-weight:800;font-size:${fontSize}px;}</style>
</defs>
${withPillBg(ctx, 'rgba(0,0,0,0.7)')}
<text x="${canvasWidth / 2}" y="${baselineY}" class="t" fill="#ffffff" text-anchor="middle">${ctx.spansBody}</text>
</svg>`
  },

  gradient: (ctx) => {
    // Linear gradient fill: rose → gold → cyan.
    //   background: linear-gradient(90deg, #ff5e8a, #ffce4e, #4ed1ff)
    //   WebkitBackgroundClip: text → SVG: text fill="url(#g)"
    const { fontSize, canvasWidth, canvasHeight, baselineY, fontFace, fontFamily } = ctx
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
<defs>
<style>${fontFace}
.t{font-family:${fontFamily};font-weight:900;font-size:${fontSize}px;}</style>
<linearGradient id="gradFill" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="#ff5e8a"/>
<stop offset="0.5" stop-color="#ffce4e"/>
<stop offset="1" stop-color="#4ed1ff"/>
</linearGradient>
</defs>
${withSolidBg(ctx, '#fff', 'rgba(0,0,0,0)')}
<text x="${canvasWidth / 2}" y="${baselineY}" class="t" fill="url(#gradFill)" text-anchor="middle">${ctx.spansBody}</text>
</svg>`
  }
}

// withSolidBg: when style.background === 'solid', draw a rounded rect behind
// the text in the second arg (bgColor). The first arg is the text fill, used
// only when we want to override the per-preset default — currently the
// builders pass their final text color and ignore this.
function withSolidBg(ctx: RenderContext, _textColor: string, bgColor: string): string {
  if (ctx.style.background !== 'solid' || bgColor === 'rgba(0,0,0,0)') return ''
  const { canvasWidth, baselineY, fontSize, textWidthPx } = ctx
  // padding 0.25em 0.6em ⇒ horizontal pad 0.6em, vertical 0.25em
  const padX = fontSize * 0.6
  const padY = fontSize * 0.25
  const w = textWidthPx + padX * 2
  const h = fontSize * 1.25 + padY * 2 // 1.25em line-height
  const x = canvasWidth / 2 - w / 2
  // baseline sits ~0.8em from the top of the line box; rect top = baseline - 0.8em - padY
  const y = baselineY - fontSize * 0.85 - padY
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="6" ry="6" fill="${bgColor}"/>`
}

function withPillBg(ctx: RenderContext, bgColor: string): string {
  if (ctx.style.background !== 'pill') return ''
  const { canvasWidth, baselineY, fontSize, textWidthPx } = ctx
  const padX = fontSize * 0.9
  const padY = fontSize * 0.2
  const w = textWidthPx + padX * 2
  const h = fontSize * 1.25 + padY * 2
  const x = canvasWidth / 2 - w / 2
  const y = baselineY - fontSize * 0.85 - padY
  const r = h / 2
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${r}" ry="${r}" fill="${bgColor}"/>`
}

// ---------------------------------------------------------------------------
// Hash key — stable across runs. We hash the structurally-relevant fields:
// spans (text + emphasis + color), style, canvasW, canvasH.
// ---------------------------------------------------------------------------
function makeCacheKey(
  caption: Pick<CaptionClip, 'spans' | 'style'>,
  canvasWidth: number,
  canvasHeight: number
): string {
  const payload = JSON.stringify({
    spans: caption.spans.map((s) => ({
      t: s.text,
      e: s.emphasis ?? null,
      c: s.color ?? null
    })),
    style: caption.style,
    w: canvasWidth,
    h: canvasHeight,
    // Version key — bump to invalidate cache after rendering changes ship.
    v: 1
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 24)
}

// ---------------------------------------------------------------------------
// Cache filesystem layout.
// ---------------------------------------------------------------------------
async function getCacheDir(): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'captions-cache')
  await mkdir(dir, { recursive: true })
  return dir
}

interface RenderStats {
  cacheHits: number
  cacheMisses: number
  sharpUnavailable: number
  errors: number
}

const RUN_STATS: RenderStats = {
  cacheHits: 0,
  cacheMisses: 0,
  sharpUnavailable: 0,
  errors: 0
}

export function resetCaptionRenderStats(): void {
  RUN_STATS.cacheHits = 0
  RUN_STATS.cacheMisses = 0
  RUN_STATS.sharpUnavailable = 0
  RUN_STATS.errors = 0
}

export function getCaptionRenderStats(): Readonly<RenderStats> {
  return { ...RUN_STATS }
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface RenderResult {
  /** Absolute path to the rendered PNG on disk. */
  pngPath: string
  /** Did we hit the on-disk cache? */
  cached: boolean
  /** Cache key (hash) used. */
  hash: string
}

/**
 * Build the SVG string for a caption. Pure / synchronous / testable. Doesn't
 * touch the disk or invoke Sharp.
 */
export function buildCaptionSvg(
  caption: Pick<CaptionClip, 'spans' | 'style'>,
  canvasWidth: number,
  canvasHeight: number
): string {
  const { style, spans } = caption
  // Mirror PreviewCanvas:
  //   const REF_HEIGHT = 1920
  //   const scaledFontSize = Math.max(12, style.fontSize * fittedHeight / REF_HEIGHT)
  const REF_HEIGHT = 1920
  const fontSize = Math.max(12, (style.fontSize * canvasHeight) / REF_HEIGHT)
  // yPosition: 0(top)..1(bottom). The preview uses bottom: (1-y)*100%, where
  // the box has variable height — for a clean baseline target we anchor the
  // bottom of the line box to y*canvasHeight, then subtract a small inner
  // margin so the text doesn't kiss the canvas edge.
  // baseline ≈ bottom-of-line-box - 0.2em (descender margin)
  const lineBottomY = style.yPosition * canvasHeight
  const baselineY = lineBottomY - fontSize * 0.2

  const plainText = spans.map((s) => s.text).join(' ')
  const textWidthPx = estimateTextWidth(plainText, fontSize)

  const fontDataUri = getFontDataUri()
  const fontFace = fontDataUri
    ? `@font-face{font-family:'Pretendard';src:url(${fontDataUri}) format('opentype');font-weight:bold;font-style:normal;}`
    : ''
  const fontFamily = fontDataUri
    ? "'Pretendard','Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif"
    : "'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',Arial,sans-serif"

  const defaultFill = style.preset === 'youtube-yellow' ? '#ffd400' : '#ffffff'
  const spansBody = buildSpansBody(spans, style, defaultFill)

  const ctx: RenderContext = {
    fontSize,
    textWidthPx,
    canvasWidth,
    canvasHeight,
    baselineY,
    spansBody,
    plainText,
    fontFace,
    fontFamily,
    style,
    spans
  }

  const builder = BUILDERS[style.preset] ?? BUILDERS['bottom-center']
  return builder(ctx)
}

/**
 * Render a caption clip to a PNG buffer.
 *
 * Returns `null` when Sharp can't be loaded (caller falls back to drawtext).
 * The `timeWithinClipMs` arg is reserved for future per-frame animation —
 * the MVP renders a single static PNG per caption regardless of time.
 */
export async function renderCaptionFrame(
  caption: Pick<CaptionClip, 'spans' | 'style' | 'id'>,
  canvasWidth: number,
  canvasHeight: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  timeWithinClipMs: number = 0
): Promise<Buffer | null> {
  const sharp = safeLoadSharp()
  if (!sharp) {
    RUN_STATS.sharpUnavailable++
    return null
  }
  const svg = buildCaptionSvg(caption, canvasWidth, canvasHeight)
  try {
    const buf = await sharp(Buffer.from(svg)).png().toBuffer()
    return buf
  } catch (err) {
    RUN_STATS.errors++
    console.warn(
      '[captions/render] sharp render failed:',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

/**
 * High-level entry: render (or fetch from cache) and return the on-disk path.
 * The path is suitable for passing to ffmpeg as `-i <pngPath>`.
 *
 * Returns `null` on error (Sharp missing, write failure). Caller falls back
 * to drawtext for *all* captions in that export.
 */
export async function renderCaptionToFile(
  caption: Pick<CaptionClip, 'spans' | 'style' | 'id'>,
  canvasWidth: number,
  canvasHeight: number
): Promise<RenderResult | null> {
  const hash = makeCacheKey(caption, canvasWidth, canvasHeight)
  const dir = await getCacheDir()
  const pngPath = path.join(dir, `${hash}.png`)
  if (existsSync(pngPath)) {
    RUN_STATS.cacheHits++
    return { pngPath, cached: true, hash }
  }
  RUN_STATS.cacheMisses++
  const buf = await renderCaptionFrame(caption, canvasWidth, canvasHeight, 0)
  if (!buf) return null
  try {
    await writeFile(pngPath, buf)
    return { pngPath, cached: false, hash }
  } catch (err) {
    RUN_STATS.errors++
    console.warn(
      '[captions/render] cache write failed:',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

// ---------------------------------------------------------------------------
// Test-only helpers.
// ---------------------------------------------------------------------------
export const __test = {
  buildCaptionSvg,
  makeCacheKey,
  estimateTextWidth,
  safeLoadSharp,
  getFontDataUri
}
