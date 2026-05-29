import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CAPTION_POP_START_SCALE,
  CAPTION_SLIDE_FRAC,
  KARAOKE_DIM_OPACITY,
  KARAOKE_POP_SCALE,
  blurRegionBlurRadiusPx,
  blurRegionMosaicBlockPx,
  findMotionTrack,
  getActiveWordIndex,
  getCaptionAnimWindows,
  getCaptionAnimation,
  getCaptionBackgroundSize,
  getCaptionKaraoke,
  getCaptionTextShadow,
  getCaptionTextStroke,
  getAdjustmentLayerFadeFactor,
  getAdjustmentLayers,
  getAdjustmentLayerTransformAt,
  getCanvasBackground,
  getClipBlurRegions,
  getClipColorAdjust,
  getClipCropRect,
  getClipCurves,
  getClipRetouch,
  getClipStabilize,
  getVisualEffect,
  getFilmLook,
  getOverlayBaseSize,
  getOverlayShadow,
  getPreviewGuides,
  getProgressBar,
  getProjectTotalMs,
  MAX_PREVIEW_GUIDES,
  DEFAULT_PREVIEW_GUIDE_FRAC,
  PROGRESS_BAR_TRACK_OPACITY,
  resolveClipCurves,
  resolveColorAdjust,
  getSpeedAt,
  getTrackPositionAt,
  getTransformAt,
  hasFreezeFrames,
  CAPTION_FONT_FAMILIES,
  hasSpeedCurve,
  hasTranscriptDeletions,
  isCaptionClip,
  isClipReversed,
  isIdentityTransform,
  isMediaClip,
  isOverlayClip,
  MIN_TRACK_SOURCE_SIZE,
  resolveCaptionWords,
  sourceOffsetForTimelineOffset,
  type CaptionClip,
  type CaptionKaraoke,
  type CaptionSpan,
  type CaptionStyle,
  type Clip,
  type ClipTransform,
  type OverlayClip,
  type Project,
  type ShapeStyle,
  type Track,
  type VideoAudioClip
} from '../../../shared/project'
import type { CustomCaptionFont } from '../../../shared/ipc'
import {
  colorAdjustToCss,
  filmToneToCss,
  filterPresetToCss,
  sampleCurveTable,
  visualEffectToCss
} from '../../../shared/filterPresets'
import { useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import { useTrackingStore } from '../store/tracking'
import { toMediaUrl } from '../lib/mediaUrl'
import { SocialPreviewOverlay } from './SocialPreviewOverlay'
import {
  dbToLinear,
  getPreviewAudioGraph,
  installAutoResume
} from '../lib/audioGraph'

// ---------------------------------------------------------------------------
// Phase 3.35 — convert a validated `#rrggbb` hex to an `rgba()` string at the
// given opacity (used for the progress-bar track). `getProgressBar` already
// guarantees the color is a valid 6-digit hex, so parsing cannot fail.
// ---------------------------------------------------------------------------
function hexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

function injectCustomCaptionFonts(fonts: CustomCaptionFont[]): void {
  if (typeof document === 'undefined') return
  const id = 'reels-custom-caption-fonts'
  let styleEl = document.getElementById(id) as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = id
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = fonts
    .map(
      (font) =>
        `@font-face{font-family:'${font.familyName}';src:url("${toMediaUrl(font.path)}") format('${font.format}');font-weight:400 900;font-style:normal;font-display:swap;}`
    )
    .join('\n')
}

// ---------------------------------------------------------------------------
// Source-time mapping (Phase 2.3 speed-aware; Phase 3.10 curve-aware;
// Phase 3.16 freeze-aware).
//
// timelineMs → source media currentTime, factoring playback speed and the
// clip's trim window.
//
//   constant: currentTime = ((timelineMs-startMs)*speed + trimInMs) / 1000
//             playbackRate = speed
//   curve OR
//   freeze:   currentTime = (sourceOffsetForTimelineOffset(...) + trimInMs)/1000
//             playbackRate = getSpeedAt(clip, sourceOffset)  (instantaneous)
//
// Phase 3.16 — a clip with freeze frames (even one without a speed curve)
// takes the `sourceOffsetForTimelineOffset` path: that resolver returns a
// HELD constant sourceMs during a freeze plateau, so the <video> currentTime
// parks on the frozen frame for the freeze's duration. The constant path is
// byte-identical to the pre-3.10 formula for any clip with NEITHER a speed
// curve NOR freeze frames.
//
// Phase 3.17 — a clip with transcript deletions ALSO takes the
// `sourceOffsetForTimelineOffset` path: that resolver is deletion-aware, so a
// timeline offset past a deleted range maps to the compacted source position
// (the preview skips deleted source during playback). A clip with NONE of
// speed/freeze/deletions keeps the byte-identical linear path.
// ---------------------------------------------------------------------------
export function clipSourceTimeSec(clip: VideoAudioClip, timelineMs: number): number {
  if (hasSpeedCurve(clip) || hasFreezeFrames(clip) || hasTranscriptDeletions(clip)) {
    // Curve, freeze and/or deletion clip — map the elapsed TIMELINE offset
    // through the deletion-aware inverse mapping to the consumed SOURCE offset
    // (from trimInMs). During a freeze plateau this is a held constant; past a
    // deletion it jumps over the removed source.
    const sourceOffsetMs = sourceOffsetForTimelineOffset(
      clip,
      timelineMs - clip.startMs
    )
    return (sourceOffsetMs + clip.trimInMs) / 1000
  }
  const speed = clip.speed ?? 1
  const offsetMs = (timelineMs - clip.startMs) * speed
  // 리버스 / 역재생 — a reversed clip mirrors the trimmed source window:
  // playhead 0 → end of source, playhead end → start of source. Reverse is
  // mutually exclusive with curve/freeze/deletions, so this branch always
  // owns the reversed case. A <video> cannot play backwards natively, so the
  // per-tick currentTime seek IS the reverse playback (choppy but correct).
  if (isClipReversed(clip)) {
    const srcDur = Math.max(0, clip.trimOutMs - clip.trimInMs)
    const revOffset = Math.min(srcDur, Math.max(0, srcDur - offsetMs))
    return (clip.trimInMs + revOffset) / 1000
  }
  return (offsetMs + clip.trimInMs) / 1000
}

/**
 * Effective playback rate for a clip's <video>/<audio> element. For a curve
 * clip the rate tracks the INSTANTANEOUS curve speed at the playhead (so the
 * preview ramps), which is why `timelineMs` is needed; pass the playhead.
 * For a non-curve clip the constant `speed` is returned (timelineMs ignored)
 * — byte-identical to the pre-3.10 behavior.
 *
 * Phase 3.16 — a freeze-only clip (no speed curve) also routes through the
 * freeze-aware mapping: `getSpeedAt` on a freeze-only clip resolves to the
 * constant `speed`, and the held frame is produced by `clipSourceTimeSec`
 * parking `currentTime`, so the rate stays correct on either side of a
 * freeze plateau without a separate branch.
 */
export function clipPlaybackRate(
  clip: VideoAudioClip,
  timelineMs?: number
): number {
  if (
    (hasSpeedCurve(clip) ||
      hasFreezeFrames(clip) ||
      hasTranscriptDeletions(clip)) &&
    timelineMs !== undefined
  ) {
    const sourceOffsetMs = sourceOffsetForTimelineOffset(
      clip,
      timelineMs - clip.startMs
    )
    return getSpeedAt(clip, sourceOffsetMs)
  }
  return clip.speed ?? 1
}

interface PreviewCanvasProps {
  project: Project
  /** Playhead position (ms). Captions visible when startMs <= playheadMs < endMs. */
  playheadMs: number
}

interface ScopedAdjustmentRegion {
  id: string
  filter: string
  transform: ClipTransform
  mirrorX?: boolean
  mirrorY?: boolean
}

// ---------------------------------------------------------------------------
// Active-clip resolution.
// ---------------------------------------------------------------------------

/** A single resolved video layer at a given playhead position. */
export interface VideoLayer {
  clip: VideoAudioClip
  track: Track
  /** 0-based index in the bottom→top stack (= position among video tracks
   *  that currently have an active clip). */
  layerIndex: number
}

/**
 * Resolve EVERY video-track media clip active at `ms`, in track order
 * (bottom → top — later tracks render on top). At most one clip per track
 * (first hit wins, mirroring the audio resolver's same-track determinism).
 */
function activeVideoLayers(project: Project, ms: number): VideoLayer[] {
  const out: VideoLayer[] = []
  for (const t of project.tracks) {
    if (t.kind !== 'video') continue
    for (const c of t.clips) {
      if (isMediaClip(c) && ms >= c.startMs && ms < c.endMs) {
        out.push({ clip: c, track: t, layerIndex: out.length })
        // First hit per track only — same-track overlap is degenerate.
        break
      }
    }
  }
  return out
}

/**
 * Return the active media clip on every audio-kind track that has one at
 * `ms`. Returned in stable track order so React `key`s stay aligned. Unlike
 * the old single-audio path, we no longer pick "the first audio track" —
 * the whole point of Phase 4-WebAudio is to mix multiple simultaneously.
 */
function activeAudioClips(
  project: Project,
  ms: number
): Array<{ clip: VideoAudioClip; track: Track }> {
  const out: Array<{ clip: VideoAudioClip; track: Track }> = []
  for (const t of project.tracks) {
    if (t.kind !== 'audio') continue
    for (const c of t.clips) {
      if (isMediaClip(c) && ms >= c.startMs && ms < c.endMs) {
        out.push({ clip: c, track: t })
        // Same-track overlap is currently last-write-wins by design; the
        // store usually prevents overlaps but we still take the first hit
        // per track to stay deterministic.
        break
      }
    }
  }
  return out
}

function previewVideoSrc(path: string, key: string): string {
  return `${toMediaUrl(path)}?previewVideo=${encodeURIComponent(key)}`
}

function refreshVideoPoster(video: HTMLVideoElement): void {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return
  try {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    video.poster = canvas.toDataURL('image/jpeg', 0.82)
  } catch {
    /* Cross-origin or decoder race; poster is best-effort preview fallback. */
  }
}

const PLAYBACK_WATCHDOG_INTERVAL_MS = 250
const PLAYBACK_STALL_MS = 750
const PLAYBACK_STALL_EPS_SEC = 0.015
const PLAYBACK_DRIFT_SEEK_SEC = 1.15

interface MediaPlaybackHealth {
  currentTime: number
  checkedAt: number
}

function setMediaTime(el: HTMLMediaElement, targetSec: number): void {
  if (!Number.isFinite(targetSec)) return
  try {
    el.currentTime = Math.max(0, targetSec)
  } catch {
    /* Media may not be seekable until metadata arrives; retry next tick. */
  }
}

function retryMediaPlay(el: HTMLMediaElement): void {
  try {
    const p = el.play()
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        /* Autoplay / decoder readiness rejection; watchdog retries. */
      })
    }
  } catch {
    /* Defensive: HTMLMediaElement.play can throw synchronously in tests. */
  }
}

function elementLooksStalled(
  key: string,
  el: HTMLMediaElement,
  health: Map<string, MediaPlaybackHealth>,
  now: number
): boolean {
  const prev = health.get(key)
  const ct = Number.isFinite(el.currentTime) ? el.currentTime : 0
  if (!prev) {
    health.set(key, { currentTime: ct, checkedAt: now })
    return false
  }
  const moved = Math.abs(ct - prev.currentTime) > PLAYBACK_STALL_EPS_SEC
  if (moved) {
    health.set(key, { currentTime: ct, checkedAt: now })
    return false
  }
  const stalledFor = now - prev.checkedAt
  return stalledFor >= PLAYBACK_STALL_MS
}

/**
 * True when any track has solo=true. In that mode, non-soloed audio-bearing
 * tracks render silent (mirrors typical DAW behavior).
 */
function anyTrackSoloed(project: Project): boolean {
  for (const t of project.tracks) if (t.solo) return true
  return false
}

/** Is a track audible right now (mute + solo combined)? */
function trackAudible(track: Track | undefined, soloMode: boolean): boolean {
  if (!track) return true
  if (track.muted) return false
  if (soloMode && !track.solo) return false
  return true
}

/** True iff any voice-role track currently has a media clip at the playhead. */
function voiceActiveAt(project: Project, ms: number): boolean {
  for (const t of project.tracks) {
    if (t.role !== 'voice') continue
    if (t.muted) continue
    for (const c of t.clips) {
      if (isMediaClip(c) && ms >= c.startMs && ms < c.endMs) {
        if (c.isMuted) continue
        return true
      }
    }
  }
  return false
}

/** Volume contribution from clip's gainDb, fades, and mute. */
function clipGain(clip: VideoAudioClip, ms: number): number {
  if (clip.isMuted) return 0
  const dur = Math.max(1, clip.endMs - clip.startMs)
  const offset = Math.max(0, Math.min(dur, ms - clip.startMs))
  let env = 1
  if (clip.fadeInMs && offset < clip.fadeInMs) {
    env = offset / clip.fadeInMs
  } else if (clip.fadeOutMs && offset > dur - clip.fadeOutMs) {
    env = Math.max(0, (dur - offset) / clip.fadeOutMs)
  }
  const db = clip.gainDb ?? 0
  const linear = db === 0 ? 1 : Math.pow(10, db / 20)
  return Math.max(0, Math.min(2, env * linear))
}

function captionsAtTime(project: Project, t: number): CaptionClip[] {
  const out: CaptionClip[] = []
  for (const track of project.tracks) {
    if (track.kind !== 'caption') continue
    for (const c of track.clips) {
      if (!isCaptionClip(c)) continue
      if (t >= c.startMs && t < c.endMs) out.push(c)
    }
  }
  return out
}

/**
 * Resolve every OverlayClip active at `ms` across all overlay tracks, in
 * track order (later tracks composite on top). Phase 3.8.
 */
function overlaysAtTime(project: Project, ms: number): OverlayClip[] {
  const out: OverlayClip[] = []
  for (const track of project.tracks) {
    if (track.kind !== 'overlay') continue
    for (const c of track.clips) {
      if (!isOverlayClip(c)) continue
      if (ms >= c.startMs && ms < c.endMs) out.push(c)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Caption visual helpers (carried over from Phase 2.4).
// ---------------------------------------------------------------------------
function presetExtras(style: CaptionStyle): React.CSSProperties {
  switch (style.preset) {
    case 'neon':
      return {
        color: '#fff',
        textShadow:
          '0 0 6px #0ff, 0 0 12px #0ff, 0 0 24px #00bfff, 0 0 36px #00bfff',
        fontFamily: '"Arial Black", "Segoe UI", sans-serif'
      }
    case 'youtube-yellow':
      return {
        color: '#ffd400',
        fontFamily: '"Arial Black", "Segoe UI", sans-serif',
        textShadow: '2px 2px 0 #000'
      }
    case 'gradient':
      return {
        background: 'linear-gradient(90deg, #ff5e8a, #ffce4e, #4ed1ff)',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        WebkitTextFillColor: 'transparent',
        fontWeight: 900,
        textShadow: 'none'
      } as React.CSSProperties
    case 'block-bold':
      return {
        color: '#fff',
        fontFamily: '"Arial Black", "Segoe UI", sans-serif',
        fontWeight: 900
      }
    case 'minimal-white':
      return {
        color: '#fff',
        textShadow: '0 1px 2px rgba(0,0,0,0.6)'
      }
    case 'tiktok-rounded':
      return {
        color: '#fff',
        fontFamily: '"Segoe UI", system-ui, sans-serif',
        fontWeight: 800
      }
    case 'bottom-center':
    default:
      return {
        color: '#fff',
        textShadow: '0 2px 4px rgba(0,0,0,0.7)'
      }
  }
}

function backgroundFor(
  style: CaptionStyle,
  fittedWidth: number,
  fittedHeight: number
): React.CSSProperties {
  const { heightFrac, widthFrac } = getCaptionBackgroundSize(style)
  const extraPadX = (widthFrac * fittedWidth) / 2
  const extraPadY = (heightFrac * fittedHeight) / 2
  switch (style.background) {
    case 'solid':
      return {
        background:
          style.preset === 'youtube-yellow' ? '#000' : 'rgba(0,0,0,0.78)',
        padding:
          extraPadX === 0 && extraPadY === 0
            ? '0.25em 0.6em'
            : `calc(0.25em + ${extraPadY}px) calc(0.6em + ${extraPadX}px)`,
        borderRadius: 6
      }
    case 'pill':
      return {
        background: 'rgba(0,0,0,0.7)',
        padding:
          extraPadX === 0 && extraPadY === 0
            ? '0.2em 0.9em'
            : `calc(0.2em + ${extraPadY}px) calc(0.9em + ${extraPadX}px)`,
        borderRadius: 999
      }
    case 'highlight':
      return {
        background: 'transparent',
        padding: 0
      }
    case 'none':
    default:
      return { background: 'transparent', padding: 0 }
  }
}

/**
 * Phase 3.23 — live CSS for explicit caption outline / drop-shadow / glow.
 * Both resolvers null ⇒ returns `{}` so the spread adds nothing and the
 * caption container CSS + DOM stays byte-identical to the legacy path.
 *
 * Stroke/shadow px values are in the canvas-height ref frame (same as
 * `fontSize`), so they scale by `fittedHeight / REF_HEIGHT` exactly like
 * `scaledFontSize` does. The user shadow term is APPENDED to whatever
 * `text-shadow` the preset already emits so both composite.
 */
function textDecorationFor(
  style: CaptionStyle,
  fittedHeight: number,
  presetShadowCss: string | undefined
): React.CSSProperties {
  const stroke = getCaptionTextStroke(style)
  const shadow = getCaptionTextShadow(style)
  if (!stroke && !shadow) return {}
  const REF_HEIGHT = 1920
  const scale = fittedHeight > 0 ? fittedHeight / REF_HEIGHT : 1
  const out: React.CSSProperties = {}
  if (stroke) {
    out.WebkitTextStroke = `${stroke.width * scale}px ${stroke.color}`
    out.paintOrder = 'stroke fill'
  }
  if (shadow) {
    const userShadow = `${shadow.offsetX * scale}px ${shadow.offsetY * scale}px ${shadow.blur * scale}px ${shadow.color}`
    out.textShadow = presetShadowCss
      ? `${presetShadowCss}, ${userShadow}`
      : userShadow
  }
  return out
}

function alignToFlex(a: CaptionStyle['align']): React.CSSProperties['justifyContent'] {
  if (a === 'left') return 'flex-start'
  if (a === 'right') return 'flex-end'
  return 'center'
}

function alignToHorizontalAnchor(a: CaptionStyle['align']): React.CSSProperties {
  if (a === 'left') return { left: '5%', transform: 'translateX(0)' }
  if (a === 'right') return { right: '5%', transform: 'translateX(0)' }
  return { left: '50%', transform: 'translateX(-50%)' }
}

function useFittedRect(
  containerRef: React.RefObject<HTMLDivElement>,
  canvasAspect: number
): { width: number; height: number; top: number; left: number } {
  const [rect, setRect] = useState({ width: 0, height: 0, top: 0, left: 0 })
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const compute = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w <= 0 || h <= 0) return
      const containerAspect = w / Math.max(1, h)
      let drawW = w
      let drawH = h
      if (containerAspect > canvasAspect) {
        drawH = h
        drawW = drawH * canvasAspect
      } else {
        drawW = w
        drawH = drawW / canvasAspect
      }
      setRect({
        width: Math.max(1, Math.floor(drawW)),
        height: Math.max(1, Math.floor(drawH)),
        top: Math.floor((h - drawH) / 2),
        left: Math.floor((w - drawW) / 2)
      })
    }
    compute()
    const raf = requestAnimationFrame(compute)
    const obs = new ResizeObserver(compute)
    obs.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      obs.disconnect()
    }
  }, [containerRef, canvasAspect])
  return rect
}

/** Karaoke per-word state relative to the playhead (Phase 3.22). */
type KaraokeWordState = 'active' | 'spoken' | 'upcoming'

function SpanView(props: {
  span: CaptionSpan
  style: CaptionStyle
  /**
   * Karaoke highlight applied to this span. Present ONLY for a caption with an
   * active karaoke spec — when absent the rendered DOM/CSS is byte-identical to
   * the legacy path (CRITICAL invariant, see CaptionOverlay).
   */
  karaoke?: { spec: CaptionKaraoke; wordState: KaraokeWordState }
}): JSX.Element {
  const { span, style, karaoke } = props
  const isHighlightBg = style.background === 'highlight'
  const css: React.CSSProperties = {}
  if (span.emphasis === 'bold') css.fontWeight = 800
  else if (span.emphasis === 'highlight') {
    css.background = '#ffd400'
    css.color = '#1a1a1a'
    css.padding = '0 0.2em'
    css.borderRadius = 3
  } else if (span.emphasis === 'pulse') {
    css.animation = 'reels-pulse 0.85s ease-in-out infinite'
    css.display = 'inline-block'
  }
  if (isHighlightBg && span.emphasis !== 'highlight') {
    css.background = 'rgba(255, 212, 0, 0.85)'
    css.color = '#111'
    css.padding = '0 0.2em'
    css.borderRadius = 3
  }
  if (span.color) css.color = span.color

  // Karaoke highlight — layered LAST so it wins over emphasis/color. Only
  // touched when `karaoke` is supplied; otherwise `css` is untouched.
  if (karaoke) {
    const { spec, wordState } = karaoke
    if (wordState === 'active') {
      if (spec.highlightStyle === 'color-fill') {
        css.color = spec.highlightColor
        if (spec.highlightBox) {
          css.background = spec.highlightColor
          css.color = '#1a1a1a'
          css.padding = '0 0.2em'
          css.borderRadius = 3
        }
      } else {
        // 'scale-pop' — grow the active word in place.
        css.display = 'inline-block'
        css.transform = `scale(${KARAOKE_POP_SCALE})`
      }
    } else if (wordState === 'upcoming') {
      // Words not yet spoken are dimmed.
      css.opacity = KARAOKE_DIM_OPACITY
    }
    // 'spoken' — normal styling, no change.
  }

  return (
    <span
      data-testid="caption-span"
      data-emphasis={span.emphasis ?? 'none'}
      data-karaoke-state={karaoke?.wordState}
      style={css}
    >
      {span.text}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Caption animation (Phase 3.9) — pure preview-side resolver.
//
// Given a caption + the playhead, return the opacity multiplier and the EXTRA
// transform string to APPEND onto the caption's positioning transform (so the
// centered-caption `translateX(-50%)` survives). For a caption with no
// animation this returns { opacity:1, extraTransform:'' } and no
// revealSpanCount → the rendered DOM is byte-identical to the legacy path.
// ---------------------------------------------------------------------------
function captionAnimCss(
  caption: CaptionClip,
  playheadMs: number,
  fittedHeight: number
): { opacity: number; extraTransform: string; revealSpanCount?: number } {
  const anim = getCaptionAnimation(caption)
  if (!anim) return { opacity: 1, extraTransform: '' }

  const dur = Math.max(1, caption.endMs - caption.startMs)
  const local = playheadMs - caption.startMs
  const { inMs, outMs } = getCaptionAnimWindows(caption)
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
  // Entrance progress (0 at clip start → 1 once inMs has elapsed).
  const eIn = inMs > 0 ? clamp01(local / inMs) : 1
  // Exit progress (1 until outMs before clip end → 0 at clip end).
  const eOut = outMs > 0 ? clamp01((dur - local) / outMs) : 1

  const dist = CAPTION_SLIDE_FRAC * fittedHeight
  let opacity = 1
  let translateY = 0
  let scalePart = ''
  let revealSpanCount: number | undefined

  // ---- Entrance ----
  switch (anim.entrance) {
    case 'fade':
      opacity *= eIn
      break
    case 'slide-up':
      // Starts below its final position, rises into place.
      translateY += (1 - eIn) * dist
      break
    case 'slide-down':
      // Starts above its final position, drops into place.
      translateY += (1 - eIn) * -dist
      break
    case 'pop':
      scalePart = ` scale(${
        CAPTION_POP_START_SCALE + (1 - CAPTION_POP_START_SCALE) * eIn
      })`
      opacity *= eIn
      break
    case 'typewriter':
      revealSpanCount = Math.ceil(eIn * caption.spans.length)
      break
    case 'none':
    default:
      break
  }

  // ---- Exit ----
  switch (anim.exit) {
    case 'fade':
      opacity *= eOut
      break
    case 'slide-up':
      // Drifts upward as it leaves.
      translateY += (1 - eOut) * -dist
      break
    case 'slide-down':
      // Drifts downward as it leaves.
      translateY += (1 - eOut) * dist
      break
    case 'none':
    default:
      break
  }

  const parts: string[] = []
  if (translateY !== 0) parts.push(`translateY(${translateY}px)`)
  if (scalePart) parts.push(scalePart.trim())
  return { opacity, extraTransform: parts.join(' '), revealSpanCount }
}

function CaptionOverlay(props: {
  caption: CaptionClip
  fittedWidth: number
  fittedHeight: number
  playheadMs: number
  project: Project
  customFonts: CustomCaptionFont[]
}): JSX.Element {
  const { caption, fittedWidth, fittedHeight, playheadMs, project, customFonts } = props
  const { style } = caption
  const REF_HEIGHT = 1920
  const scaledFontSize =
    fittedHeight > 0
      ? Math.max(12, (style.fontSize * fittedHeight) / REF_HEIGHT)
      : style.fontSize
  const bottomPct = (1 - style.yPosition) * 100
  const anim = getCaptionAnimation(caption)
  const { opacity, extraTransform, revealSpanCount } = captionAnimCss(
    caption,
    playheadMs,
    fittedHeight
  )
  // Phase 3.13 — track-aware caption position. ONLY when the caption binds to
  // a resolvable ≥2-point motion track do we override the static anchoring
  // (bottom% + align-based left/right) with the tracked center. INVARIANT: an
  // unbound caption (no motionTrackId, or a dangling id) → trackPos is null →
  // the static path runs untouched, byte-identical legacy DOM.
  // Phase 3.22 — karaoke (word-level highlight). `getCaptionKaraoke` returns
  // null for any caption without an ACTIVE karaoke spec + resolvable words —
  // in that case `karaokeSpec` stays null, no per-word state is computed, and
  // nothing is passed to SpanView (byte-identical legacy DOM, see invariant).
  const karaokeSpec = getCaptionKaraoke(caption)
  let karaokeActiveIndex = -1
  if (karaokeSpec) {
    const localMs = playheadMs - caption.startMs
    karaokeActiveIndex = getActiveWordIndex(
      resolveCaptionWords(caption),
      localMs
    )
  }
  const boundTrack = caption.motionTrackId
    ? findMotionTrack(project, caption.motionTrackId)
    : null
  const trackPos =
    boundTrack && boundTrack.points.length >= 2
      ? getTrackPositionAt(boundTrack, playheadMs - caption.startMs)
      : null
  // Phase 3.23 — explicit outline / drop-shadow / glow. `presetExtras` may
  // emit its own `textShadow`; the user shadow is appended onto it so both
  // composite. `textDecorationFor` returns `{}` when neither resolver fires —
  // the spread is then a no-op and the container CSS is byte-identical.
  const presetCss = presetExtras(style)
  // User-picked font wins over preset's hardcoded font. Pretendard (the legacy
  // default) is left implicit so byte-identical preview is preserved when no
  // pick is made. Resolver mirrors main/captions/render.ts so preview matches
  // the exported PNG: picked family leads, then system Korean fallbacks, then
  // Pretendard. This keeps non-default Korean choices visibly different even
  // when the exact selected font is not installed.
  if (style.fontFamilyId?.startsWith('custom:')) {
    const customFont = customFonts.find((f) => f.id === style.fontFamilyId)
    if (customFont) {
      presetCss.fontFamily = `'${customFont.familyName}','Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR','Pretendard',sans-serif`
    }
  } else if (style.fontFamilyId && style.fontFamilyId !== 'pretendard') {
    const entry = CAPTION_FONT_FAMILIES.find((f) => f.id === style.fontFamilyId)
    if (entry) {
      presetCss.fontFamily = `${entry.stack},'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR','Pretendard',sans-serif`
    }
  }
  const presetShadowCss =
    typeof presetCss.textShadow === 'string' ? presetCss.textShadow : undefined
  const textDecoration = textDecorationFor(style, fittedHeight, presetShadowCss)
  const containerStyle: React.CSSProperties = trackPos
    ? {
        // Track-bound path — center the caption on the tracked point.
        position: 'absolute',
        left: `${trackPos.x * 100}%`,
        top: `${trackPos.y * 100}%`,
        transform: 'translate(-50%, -50%)',
        width: 'max-content',
        maxWidth: '90%',
        pointerEvents: 'none',
        display: 'flex',
        justifyContent: alignToFlex(style.align),
        textAlign: style.align,
        fontSize: scaledFontSize,
        lineHeight: 1.25,
        fontWeight: 700,
        letterSpacing: 0.2,
        whiteSpace: 'normal',
        wordBreak: 'keep-all',
        ...presetCss,
        ...textDecoration,
        ...backgroundFor(style, fittedWidth, fittedHeight)
      }
    : {
        position: 'absolute',
        bottom: `${bottomPct}%`,
        width: 'max-content',
        maxWidth: '90%',
        pointerEvents: 'none',
        display: 'flex',
        justifyContent: alignToFlex(style.align),
        textAlign: style.align,
        fontSize: scaledFontSize,
        lineHeight: 1.25,
        fontWeight: 700,
        letterSpacing: 0.2,
        whiteSpace: 'normal',
        wordBreak: 'keep-all',
        ...alignToHorizontalAnchor(style.align),
        ...presetCss,
        ...textDecoration,
        ...backgroundFor(style, fittedWidth, fittedHeight)
      }
  // INVARIANT: an un-animated, unbound caption writes NEITHER `opacity` nor a
  // modified `transform` beyond alignToHorizontalAnchor's — rendered DOM is
  // byte-identical to the legacy path. When there IS animation we append the
  // extra transform / multiply opacity onto the container.
  if (anim) {
    const baseTransform =
      typeof containerStyle.transform === 'string'
        ? containerStyle.transform
        : ''
    containerStyle.transform = extraTransform
      ? `${baseTransform} ${extraTransform}`.trim()
      : baseTransform
    containerStyle.opacity = opacity
  }
  // audit #10 — STT-flagged low-confidence captions get a dotted underline
  // (color-blind safe: shape carries the signal, not hue) + a native tooltip
  // explaining what it means. Manual / unflagged captions render unchanged.
  if (caption.lowConfidence) {
    containerStyle.textDecoration = 'underline dotted #fbbf24'
    containerStyle.textDecorationThickness = 2
    containerStyle.textUnderlineOffset = 4
  }
  return (
    <div
      data-testid="caption-overlay"
      data-caption-id={caption.id}
      data-preset={style.preset}
      data-background={style.background}
      data-anim-entrance={anim?.entrance ?? 'none'}
      data-anim-exit={anim?.exit ?? 'none'}
      data-revealed-spans={revealSpanCount}
      data-motion-track-id={trackPos ? caption.motionTrackId : undefined}
      data-karaoke-active-index={
        karaokeSpec ? karaokeActiveIndex : undefined
      }
      data-text-stroke={getCaptionTextStroke(style) ? 'on' : undefined}
      data-text-shadow={getCaptionTextShadow(style) ? 'on' : undefined}
      data-low-confidence={caption.lowConfidence ? 'true' : undefined}
      title={
        caption.lowConfidence
          ? '낮은 신뢰도 — 검토 권장'
          : undefined
      }
      style={containerStyle}
    >
      <div style={{ display: 'inline' }}>
        {caption.spans.map((s, i) => {
          // Typewriter: keep tail spans in flow (visibility:hidden — no
          // layout reflow) so only the revealed prefix is visible.
          const hidden =
            revealSpanCount !== undefined && i >= revealSpanCount
          // Karaoke per-word state — span index vs the active word index.
          // Only built when a karaoke spec is active; otherwise SpanView is
          // called with no `karaoke` prop → byte-identical legacy DOM.
          const karaokeProp = karaokeSpec
            ? {
                spec: karaokeSpec,
                wordState: (i === karaokeActiveIndex
                  ? 'active'
                  : i < karaokeActiveIndex
                    ? 'spoken'
                    : 'upcoming') as KaraokeWordState
              }
            : undefined
          return (
            <span
              key={i}
              style={hidden ? { visibility: 'hidden' } : undefined}
            >
              {i > 0 && ' '}
              <SpanView span={s} style={style} karaoke={karaokeProp} />
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overlay element renderer (Phase 3.8) — image/sticker → <img>, shape → SVG.
// Positioned with the SAME CSS transform math as a video layer.
// ---------------------------------------------------------------------------
function OverlayShapeSvg(props: {
  style: ShapeStyle
  shadowFilter?: string
}): JSX.Element {
  const { style, shadowFilter } = props
  // viewBox is a fixed 100×100 unit box — the parent element supplies the
  // actual on-canvas size, so the SVG just scales to fill. strokeWidth is in
  // canvas px (pre-scale); we map it into viewBox units roughly via the box.
  const VB = 100
  const sw = Math.max(0, style.strokeWidth)
  const hasStroke = style.stroke !== 'none' && sw > 0
  const fill = style.fill === 'none' ? 'none' : style.fill
  const common = {
    fill,
    fillOpacity: style.fillOpacity,
    stroke: hasStroke ? style.stroke : 'none',
    strokeWidth: hasStroke ? sw : 0,
    vectorEffect: 'non-scaling-stroke' as const
  }
  return (
    <svg
      viewBox={`0 0 ${VB} ${VB}`}
      preserveAspectRatio="none"
      width="100%"
      height="100%"
      style={{ display: 'block', overflow: 'visible', filter: shadowFilter }}
    >
      {style.shape === 'rectangle' && (
        <rect
          x={0}
          y={0}
          width={VB}
          height={VB}
          rx={Math.max(0, style.cornerRadius)}
          ry={Math.max(0, style.cornerRadius)}
          {...common}
        />
      )}
      {style.shape === 'ellipse' && (
        <ellipse cx={VB / 2} cy={VB / 2} rx={VB / 2} ry={VB / 2} {...common} />
      )}
      {style.shape === 'line' && (
        <line
          x1={0}
          y1={VB / 2}
          x2={VB}
          y2={VB / 2}
          stroke={style.stroke === 'none' ? style.fill : style.stroke}
          strokeWidth={Math.max(1, sw || 4)}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  )
}

function OverlayElement(props: {
  clip: OverlayClip
  playheadMs: number
  project: Project
  fittedHeight: number
}): JSX.Element {
  const { clip, playheadMs, project, fittedHeight } = props
  // Phase 3.5 transform — resolved at the playhead so keyframed overlays
  // animate. Identical CSS math to the video layer.
  const t = getTransformAt(clip, playheadMs)
  // Phase 3.13 — track-aware position override. ONLY when the overlay binds
  // to a resolvable ≥2-point motion track do we shift the base box to the
  // tracked center. INVARIANT: an unbound overlay (no motionTrackId, or a
  // dangling id) keeps the centered 50%/50% box — byte-identical legacy DOM.
  const boundTrack = clip.motionTrackId
    ? findMotionTrack(project, clip.motionTrackId)
    : null
  // Track positions are clip-relative; the overlay clip's own startMs maps
  // the global playhead into the same clip-relative space the track uses.
  const trackPos =
    boundTrack && boundTrack.points.length >= 2
      ? getTrackPositionAt(boundTrack, playheadMs - clip.startMs)
      : null
  const cssTransform = `translate(${t.x * 100}%, ${t.y * 100}%) scale(${
    t.scale
  }) rotate(${t.rotation}deg)`
  const { w, h } = getOverlayBaseSize(clip)
  const src = clip.source
  // Defensive: a malformed clip (e.g. persisted from a stale test run) may
  // lack `source` entirely. Bail rather than crash the whole React tree —
  // an absent overlay is a no-op visual.
  if (!src || typeof (src as { type?: unknown }).type !== 'string') {
    return <></>
  }
  // Phase 3.36 — drop shadow. Null ⇒ NO `filter` key written at all so the
  // overlay DOM stays byte-identical to the pre-feature path. Offsets/blur are
  // canvas px in the 1920-height ref frame (same as caption shadow), so they
  // scale into preview-fitted px by `fittedHeight / REF_HEIGHT`. CSS blur
  // radius is `blur / 2` to visually match export's `boxblur`.
  const shadow = getOverlayShadow(clip)
  const REF_HEIGHT = 1920
  const shadowScale = fittedHeight > 0 ? fittedHeight / REF_HEIGHT : 1
  const shadowFilter: string | undefined = shadow
    ? `drop-shadow(${shadow.offsetX * shadowScale}px ${
        shadow.offsetY * shadowScale
      }px ${(shadow.blur / 2) * shadowScale}px ${hexToRgba(
        shadow.color,
        shadow.opacity
      )})`
    : undefined
  // Un-transformed box: centered, sized by base*Frac of the canvas. The
  // CSS transform (translate/scale/rotate) + opacity apply on top.
  const boxStyle: React.CSSProperties = {
    position: 'absolute',
    left: trackPos ? `${trackPos.x * 100}%` : '50%',
    top: trackPos ? `${trackPos.y * 100}%` : '50%',
    width: `${w * 100}%`,
    height: `${h * 100}%`,
    // Center first, then apply the clip transform.
    transform: `translate(-50%, -50%) ${cssTransform}`,
    transformOrigin: 'center center',
    opacity: t.opacity,
    pointerEvents: 'none'
  }
  return (
    <div
      style={boxStyle}
      data-testid="overlay-element"
      data-overlay-id={clip.id}
      data-overlay-type={src.type}
      data-motion-track-id={trackPos ? clip.motionTrackId : undefined}
    >
      {(src.type === 'image' || src.type === 'sticker') && (
        <img
          src={
            src.type === 'image'
              ? toMediaUrl(src.path)
              : // Bundled stickers resolve to an asset URL; BUNDLED_STICKERS
                // is empty for now so this path is dormant.
                ''
          }
          alt=""
          draggable={false}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            pointerEvents: 'none',
            filter: shadowFilter
          }}
        />
      )}
      {src.type === 'shape' && (
        <OverlayShapeSvg style={src.style} shadowFilter={shadowFilter} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Motion-track box-draw overlay (Phase 3.13).
//
// Rendered as a direct child of the fitted-rect ONLY while the tracking store's
// drawMode is on. Mouse down/move/up rubber-bands a rectangle; on mouse-up the
// pixel rect is converted to canvas fractions (the fitted-rect IS the canvas,
// so a fraction is simply pixel / fitted-size), the MIN_TRACK_SOURCE_SIZE floor
// is enforced, and beginTrackJob is fired. Exits draw mode afterwards.
// ---------------------------------------------------------------------------
function MotionTrackDrawLayer(props: { zIndex: number }): JSX.Element {
  const { zIndex } = props
  const drawClipId = useTrackingStore((s) => s.drawClipId)
  const beginTrackJob = useTrackingStore((s) => s.beginTrackJob)
  const setDrawMode = useTrackingStore((s) => s.setDrawMode)
  const layerRef = useRef<HTMLDivElement>(null)
  // Rubber-band state — pixel coords relative to this layer.
  const [drag, setDrag] = useState<{
    x0: number
    y0: number
    x1: number
    y1: number
  } | null>(null)

  const rectPx = drag
    ? {
        left: Math.min(drag.x0, drag.x1),
        top: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0)
      }
    : null

  const onDown = (e: React.MouseEvent): void => {
    const el = layerRef.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const x = e.clientX - box.left
    const y = e.clientY - box.top
    setDrag({ x0: x, y0: y, x1: x, y1: y })
  }
  const onMove = (e: React.MouseEvent): void => {
    if (!drag) return
    const el = layerRef.current
    if (!el) return
    const box = el.getBoundingClientRect()
    setDrag({
      ...drag,
      x1: e.clientX - box.left,
      y1: e.clientY - box.top
    })
  }
  const onUp = (): void => {
    const el = layerRef.current
    if (!el || !drag) {
      setDrag(null)
      return
    }
    const box = el.getBoundingClientRect()
    const w = box.width || 1
    const h = box.height || 1
    // Pixel rect → canvas fractions (the layer fills the canvas exactly).
    let fx = Math.min(drag.x0, drag.x1) / w
    let fy = Math.min(drag.y0, drag.y1) / h
    let fw = Math.abs(drag.x1 - drag.x0) / w
    let fh = Math.abs(drag.y1 - drag.y0) / h
    setDrag(null)
    // Enforce the minimum source size on each axis.
    if (fw < MIN_TRACK_SOURCE_SIZE) fw = MIN_TRACK_SOURCE_SIZE
    if (fh < MIN_TRACK_SOURCE_SIZE) fh = MIN_TRACK_SOURCE_SIZE
    // Clamp the box fully inside the canvas after the floor.
    fx = Math.min(Math.max(0, fx), 1 - fw)
    fy = Math.min(Math.max(0, fy), 1 - fh)
    if (drawClipId) {
      beginTrackJob(drawClipId, { x: fx, y: fy, w: fw, h: fh })
    } else {
      // No target clip — just leave draw mode.
      setDrawMode(false)
    }
  }

  return (
    <div
      ref={layerRef}
      data-testid="motion-track-draw-layer"
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={() => drag && onUp()}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex,
        cursor: 'crosshair',
        background: 'rgba(0,0,0,0.18)'
      }}
    >
      {rectPx && (
        <div
          data-testid="motion-track-draw-rect"
          style={{
            position: 'absolute',
            left: rectPx.left,
            top: rectPx.top,
            width: rectPx.width,
            height: rectPx.height,
            border: '2px solid #10b981',
            background: 'rgba(16,185,129,0.15)',
            pointerEvents: 'none'
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main PreviewCanvas — wires real <video> + N <audio> elements to the
// playhead via the WebAudio routing graph.
//
// Phase 4-WebAudio change: instead of one shared <audio> element, we render
// one <audio> per audio-kind track in the project. Each is wrapped exactly
// once via `previewAudioGraph.attach(el, trackId)` and routed through its
// track GainNode → masterGain → destination, so multiple audio clips can
// play simultaneously and ducking ramps are click-free.
// ---------------------------------------------------------------------------
export function PreviewCanvas(props: PreviewCanvasProps): JSX.Element {
  const { project, playheadMs } = props
  const playing = useTimelineUi((s) => s.playing)
  // Phase 6 — SNS 플랫폼 미리보기. Transient UI state; never touches the
  // project / export. 'none' (default) renders no chrome.
  const socialPlatform = useTimelineUi((s) => s.socialPreviewPlatform)
  // Phase 3.13 — motion-track draw mode + the target clip for the box-draw
  // overlay. Transient tracking-store state; never persisted.
  const trackingDrawMode = useTrackingStore((s) => s.drawMode)
  const trackingDrawClipId = useTrackingStore((s) => s.drawClipId)
  const [customCaptionFonts, setCustomCaptionFonts] = useState<CustomCaptionFont[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasAspect = project.width / Math.max(1, project.height)
  const fitted = useFittedRect(containerRef, canvasAspect)

  /**
   * One foreground <video> per VIDEO TRACK, indexed by trackId. A video
   * element carries audio routed through the WebAudio graph, so — exactly
   * like the per-audio-track elements — it must stay mounted across clip
   * changes on its track to honor the wrap-once invariant.
   */
  const videoEls = useRef<Map<string, HTMLVideoElement>>(new Map())
  /**
   * Background video element — same source as the BOTTOM-most layer, but
   * rendered as a blurred cover behind so non-matching aspect ratios show
   * the iconic "vertical TikTok" blurred gutters instead of black bars.
   */
  const bgVideoEl = useRef<HTMLVideoElement | null>(null)
  /** One <audio> per audio track, indexed by trackId. */
  const audioEls = useRef<Map<string, HTMLAudioElement>>(new Map())
  /** Per-video-track currently-loaded media id (for src-change detection). */
  const loadedVideoId = useRef<Map<string, string>>(new Map())
  /**
   * Previous playheadMs — used to detect "user scrub" (seek bar click /
   * keyboard skip) vs natural rAF progression. Natural progression is
   * ~16ms/tick at playbackRate 1; anything > 100ms is a user-driven jump
   * that needs an explicit currentTime sync.
   */
  const prevPlayheadMs = useRef<number | null>(null)
  /** Media id loaded into the blurred-bg element (for src-change detection). */
  const loadedBgId = useRef<string | null>(null)
  /** Per-track currently-loaded media id (for src-change detection). */
  const loadedAudioIds = useRef<Map<string, string>>(new Map())
  /** Per-track playing state (for play/pause sync without redundant calls). */
  const audioPlaying = useRef<Map<string, boolean>>(new Map())
  /** Last observed media clocks used to recover when the transport keeps
      ticking but a DOM media element / decoder stalls. */
  const mediaHealth = useRef<Map<string, MediaPlaybackHealth>>(new Map())
  const swapRaf = useRef<number | null>(null)

  const videoLayers = useMemo(
    () => activeVideoLayers(project, playheadMs),
    [project, playheadMs]
  )
  const audioHits = useMemo(
    () => activeAudioClips(project, playheadMs),
    [project, playheadMs]
  )

  const soloMode = useMemo(() => anyTrackSoloed(project), [project])
  const voiceOn = useMemo(
    () => voiceActiveAt(project, playheadMs),
    [project, playheadMs]
  )

  // All video tracks in the project — we render one <video> element per
  // track so the same WebAudio source survives across clip changes on that
  // track (mirrors the per-audio-track strategy; wrap-once invariant).
  const videoTracks = useMemo(
    () => project.tracks.filter((t) => t.kind === 'video'),
    [project]
  )

  // Map trackId → active video layer at the playhead (or undefined).
  const layerByTrackId = useMemo(() => {
    const map = new Map<string, VideoLayer>()
    for (const l of videoLayers) map.set(l.track.id, l)
    return map
  }, [videoLayers])

  // The TOP-most layer drives the legacy data-testid="preview-video"
  // attribute (export.spec.ts queries it for data-filter-preset). The
  // BOTTOM-most layer feeds the blurred background.
  const topLayer = videoLayers.length > 0 ? videoLayers[videoLayers.length - 1] : null
  const bottomLayer = videoLayers.length > 0 ? videoLayers[0] : null

  // Layer stacking (z-index). Video layers occupy zIndex 1..(1 +
  // videoTracks.length - 1). The OVERLAY layer (Phase 3.8) composites just
  // above every video layer; the CAPTION layer sits one above the overlay
  // layer so captions always stay on top of stickers/shapes.
  const overlayZIndex = 1 + Math.max(1, videoTracks.length)
  const captionZIndex = overlayZIndex + 1
  // SNS platform chrome (Phase 6) composites ABOVE captions so the user sees
  // exactly what gets covered by the platform UI.
  const socialZIndex = captionZIndex + 1

  // Phase 3.35 — progress bar overlay. Resolved via the locked contract
  // helpers: `getProgressBar` returns null for absent / disabled configs
  // (legacy projects → byte-identical DOM). The bar fills 0→100% over the
  // whole-video duration; it composites ABOVE everything (captions, social
  // chrome) so it is never buried.
  const progressBar = useMemo(() => {
    const cfg = getProgressBar(project)
    if (!cfg) return null
    const totalMs = getProjectTotalMs(project)
    if (!(totalMs > 0)) return null
    const rawPct = (playheadMs / totalMs) * 100
    const pct = Math.max(0, Math.min(100, Number.isFinite(rawPct) ? rawPct : 0))
    return { cfg, pct }
  }, [project, playheadMs])

  // Phase 3.43 — preview-only horizontal guideline rules. Resolved via
  // `getPreviewGuides` (sanitized: sorted/clamped/deduped). Empty array →
  // the whole overlay block is gated out → byte-identical DOM (no
  // `preview-guides-layer` element emitted). Pure preview decoration; never
  // read by export.ts.
  const previewGuides = useMemo(() => getPreviewGuides(project), [project])

  // Phase 3.44 — canvas backdrop fill. Resolved defensively via
  // `getCanvasBackground` (absent / invalid → `{ kind: 'blur' }`, today's
  // legacy default → byte-identical preview DOM gate). Switches the backdrop
  // element below: 'blur' → keep the existing <video data-testid=
  // "preview-video-bg"> (byte-identical), other kinds → render a <div> with
  // the same testid + a solid background color.
  const canvasBg = useMemo(() => getCanvasBackground(project), [project])
  const multiVideoPreview = videoLayers.length > 1

  useEffect(() => {
    let cancelled = false
    const ext = window.electron?.captionFonts
    if (!ext) return
    void ext.list().then((fonts) => {
      if (cancelled) return
      setCustomCaptionFonts(fonts)
      injectCustomCaptionFonts(fonts)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const activeCaptions = useMemo(
    () => captionsAtTime(project, playheadMs),
    [project, playheadMs]
  )

  const activeOverlays = useMemo(
    () => overlaysAtTime(project, playheadMs),
    [project, playheadMs]
  )

  // Phase 3.32/slide 18 — adjustment-layer preview grade. Identity layers
  // still apply to the whole fitted rect. Resized/moved layers emit a scoped
  // backdrop-filter rectangle so the grade only affects that region.
  // Multiple overlapping layers concatenate in startMs order (getAdjustment-
  // Layers already sorts + drops neutral layers). Outside every layer the
  // result is empty → the `filter` property is omitted → byte-identical
  // preview. Curves go through a chained SVG feComponentTransfer per layer.
  const adjustmentGrade = useMemo(() => {
    const layers = getAdjustmentLayers(project).filter(
      (l) => playheadMs >= l.startMs && playheadMs < l.endMs
    )
    if (layers.length === 0) {
      return {
        filter: '',
        curveSvgs: [] as JSX.Element[],
        count: 0,
        regions: [] as ScopedAdjustmentRegion[]
      }
    }
    const parts: string[] = []
    const curveSvgs: JSX.Element[] = []
    const regions: ScopedAdjustmentRegion[] = []
    const CURVE_STEPS = 33
    const curveTable = (pts: { x: number; y: number }[]): string =>
      sampleCurveTable(pts, CURVE_STEPS)
        .map((v) => v.toFixed(4))
        .join(' ')
    for (const layer of layers) {
      const layerParts: string[] = []
      // pptx11 슬라이드 23 — fade 영역에선 filterIntensity / colorAdjust 를
      // 0..1 factor 로 곱해 점진 적용. fadeIn/Out 둘 다 0 이면 factor=1.
      // curves / HSL 은 비선형 보간 비용 때문에 full strength 유지 (export
      // pipeline 도 동일 정책).
      const fadeFactor = getAdjustmentLayerFadeFactor(layer, playheadMs)
      const preset = filterPresetToCss(
        layer.filterPreset,
        (layer.filterIntensity ?? 1) * fadeFactor
      )
      if (preset) layerParts.push(preset)
      const rawCa = resolveColorAdjust(layer.colorAdjust)
      const scaledCa = rawCa
        ? {
            brightness: rawCa.brightness * fadeFactor,
            contrast: rawCa.contrast * fadeFactor,
            saturation: rawCa.saturation * fadeFactor,
            temperature: rawCa.temperature * fadeFactor
          }
        : null
      const ca = colorAdjustToCss(scaledCa)
      if (ca) layerParts.push(ca)
      const curves = resolveClipCurves(layer.curves)
      if (curves) {
        const filterId = `adj-curve-${layer.id}`
        layerParts.push(`url(#${filterId})`)
        curveSvgs.push(
          <svg
            key={filterId}
            data-testid="adjustment-curve-filter-svg"
            data-layer-id={layer.id}
            aria-hidden="true"
            width={0}
            height={0}
            style={{ position: 'absolute', width: 0, height: 0 }}
          >
            <defs>
              <filter id={filterId} colorInterpolationFilters="sRGB">
                <feComponentTransfer>
                  <feFuncR type="table" tableValues={curveTable(curves.red)} />
                  <feFuncG
                    type="table"
                    tableValues={curveTable(curves.green)}
                  />
                  <feFuncB type="table" tableValues={curveTable(curves.blue)} />
                </feComponentTransfer>
                <feComponentTransfer>
                  <feFuncR
                    type="table"
                    tableValues={curveTable(curves.master)}
                  />
                  <feFuncG
                    type="table"
                    tableValues={curveTable(curves.master)}
                  />
                  <feFuncB
                    type="table"
                    tableValues={curveTable(curves.master)}
                  />
                </feComponentTransfer>
              </filter>
            </defs>
          </svg>
        )
      }
      const transform = getAdjustmentLayerTransformAt(layer, playheadMs)
      if (!isIdentityTransform(transform)) {
        regions.push({
          id: layer.id,
          filter: layerParts.join(' '),
          transform,
          mirrorX: layer.mirrorX,
          mirrorY: layer.mirrorY
        })
      } else {
        parts.push(...layerParts)
      }
    }
    return {
      filter: parts.join(' '),
      curveSvgs,
      count: layers.length,
      regions
    }
  }, [project, playheadMs])

  // All audio tracks in the project — we render an <audio> element per
  // track so the same WebAudio source survives across clip changes on that
  // track (avoids the wrap-once invariant problem).
  const audioTracks = useMemo(
    () => project.tracks.filter((t) => t.kind === 'audio'),
    [project]
  )

  // Map trackId → active hit at the playhead (or null if no clip there).
  const hitByTrackId = useMemo(() => {
    const map = new Map<string, { clip: VideoAudioClip; track: Track }>()
    for (const h of audioHits) map.set(h.track.id, h)
    return map
  }, [audioHits])

  const latestPlaybackState = useRef({
    project,
    playheadMs,
    videoTracks,
    layerByTrackId,
    bottomLayer,
    audioTracks,
    hitByTrackId,
    multiVideoPreview,
    canvasBgKind: canvasBg.kind
  })

  useEffect(() => {
    latestPlaybackState.current = {
      project,
      playheadMs,
      videoTracks,
      layerByTrackId,
      bottomLayer,
      audioTracks,
      hitByTrackId,
      multiVideoPreview,
      canvasBgKind: canvasBg.kind
    }
  }, [
    project,
    playheadMs,
    videoTracks,
    layerByTrackId,
    bottomLayer,
    audioTracks,
    hitByTrackId,
    multiVideoPreview,
    canvasBg.kind
  ])

  // -----------------------------------------------------------------------
  // Install the one-shot user-gesture listener so AudioContext.resume()
  // fires the first time the user clicks or presses a key anywhere. The
  // hook is idempotent across remounts; the listeners are `once: true`.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const cleanup = installAutoResume()
    return cleanup
  }, [])

  // -----------------------------------------------------------------------
  // Wrap each <audio> element through the WebAudio graph once on mount.
  // The graph caches per-element so it's safe to call attach() on every
  // tick — but we keep it to mount/cleanup for clarity.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const graph = getPreviewAudioGraph()
    // Re-attach each <video> element (it carries audio too — embedded VO
    // etc.) to its OWN video-track GainNode.
    for (const t of videoTracks) {
      const el = videoEls.current.get(t.id)
      if (el) graph.attach(el, t.id)
    }
    // Re-attach each <audio> element to its track's GainNode.
    for (const t of audioTracks) {
      const el = audioEls.current.get(t.id)
      if (el) graph.attach(el, t.id)
    }
  }, [audioTracks, videoTracks])

  // -----------------------------------------------------------------------
  // Sync <video> / <audio> src + currentTime + playbackRate to the playhead.
  // Throttled via a single rAF batch so scrubbing doesn't thrash the elements.
  //
  // Per-track gains are routed through the WebAudio graph using a 20ms
  // linear ramp (click-free) rather than `el.volume` mutation.
  // -----------------------------------------------------------------------
  // 0.2.10 — rAF wrap 제거. 이전엔 매 tick(playheadMs 변경) effect fire →
  // cleanup에서 cancelAnimationFrame 호출 → 다음 fire에서 또 cancel → 영원히
  // rAF callback 실행 안 됨. 결과: clip A가 자기 endMs 지나도 src 교체 안
  // 되고 video element가 원본 끝까지 자연 재생. clip B 화면 안 나옴(슬라이드
  // 6 사용자 진단). 매 tick fire는 React batching이 이미 throttle하니 inline
  // 실행이 안전. swapRaf ref + cleanup 제거.
  useEffect(() => {
    {
      const graph = getPreviewAudioGraph()
      // Detect "user scrub" — playhead jumped by > 1000ms in a single tick.
      // Natural rAF is ~16ms; even a slow React rerender batch caps around
      // 200ms. 1000ms only fires for genuine seek-bar clicks / keyboard
      // skip — never natural playback. Anything below = native engine 1x
      // 자연 재생에 무간섭 (anti-seek-storm).
      const prev = prevPlayheadMs.current
      const isUserScrub =
        prev !== null && Math.abs(playheadMs - prev) > 1000
      prevPlayheadMs.current = playheadMs

      // ----- VIDEO TRACKS — one <video> element per track (layer stack) -----
      for (const track of videoTracks) {
        const v = videoEls.current.get(track.id)
        if (!v) continue
        const layer = layerByTrackId.get(track.id)
        // Always make sure this element is wired (cheap; cached).
        graph.attach(v, track.id)

        if (layer) {
          const activeVideo = layer.clip
          const media = project.media[activeVideo.mediaId]
          if (media && media.kind !== 'audio') {
            const srcChanged = loadedVideoId.current.get(track.id) !== media.id
            if (srcChanged) {
              v.src = previewVideoSrc(media.path, `track:${track.id}`)
              loadedVideoId.current.set(track.id, media.id)
              // 명시 load() — preload="auto"와 함께 browser가 frame data를
              // 즉시 fetch 시작. 슬라이드 6 (두 번째 클립으로 넘어가도
              // 첫 클립 마지막 프레임 freeze) 해결 보강.
              try {
                v.load()
              } catch {
                /* ignore */
              }
              // 0.2.11 — src 교체 분기 안에서 currentTime + playbackRate를
              // initial set. 0.2.10에서 매 tick override가 native engine과
              // fight → fast-forward + freeze 사고. 이제 src 교체 시점에만
              // 명시 sync하고 그 후는 native 자연 재생에 맡김.
              if (media.kind !== 'image') {
                const initialTarget = clipSourceTimeSec(activeVideo, playheadMs)
                try {
                  v.currentTime = Math.max(0, initialTarget)
                } catch {
                  /* src not ready — onLoadedData/onCanPlay will retry */
                }
                const initialRate = clipPlaybackRate(activeVideo, playheadMs)
                if (Math.abs(v.playbackRate - initialRate) > 0.001) {
                  v.playbackRate = initialRate
                }
              }
              // 0.2.7 — src 교체 + load()는 <video>를 paused 상태로 reset.
              // play/pause useEffect는 deps([playing, audioTracks, videoTracks])
              // 변경에만 fire → src 교체만으론 re-trigger 안 됨. 재생 중이면
              // 새 src에 직접 play() — slide 6 추가 증상 "스페이스 눌러야
              // 두 번째 영상이 재생됨" 해결.
              if (playing) {
                if (multiVideoPreview) v.muted = true
                v.play().catch(() => {
                  /* autoplay rejection / src not ready — silently ignored;
                     load() 완료 후 next tick에서 다시 시도 가능 */
                })
              }
            } else if (media.kind !== 'image') {
              // src 안 바뀐 일반 tick — native engine이 1x 자연 재생 중.
              // CRITICAL (0.2.11→0.2.12): 평범한 clip에 대해 매 tick currentTime
              // override는 절대 금지. probe 결과 매 16ms set이 video 내부 seek
              // 가 끝나기 전 또 set → ct가 prev=0 stuck → frame 영원히 안
              // 진행. native engine 1x 자연 재생에 전부 맡김. drift는 자연
              // 누적되지만 small (60fps, 16ms/tick) → 시각적 영향 없음.
              // curve/freeze/deletion clip은 mapping이 비선형이라 매 tick
              // sync가 필수 (그 경우만 seek 매 tick 수행).
              const needsTightSync =
                hasSpeedCurve(activeVideo) ||
                hasFreezeFrames(activeVideo) ||
                hasTranscriptDeletions(activeVideo)
              if (needsTightSync) {
                const target = clipSourceTimeSec(activeVideo, playheadMs)
                if (Math.abs((v.currentTime || 0) - target) > 0.08) {
                  try {
                    v.currentTime = Math.max(0, target)
                  } catch {
                    /* src 아직 안 ready — 다음 tick에 재시도 */
                  }
                }
                const rate = clipPlaybackRate(activeVideo, playheadMs)
                if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate
              }
              else if (isUserScrub) {
                // 사용자 scrub — playhead가 한 tick에 100ms+ 점프. native
                // 재생과 무관하니 즉시 sync. 평범 재생 시엔 이 분기 안 들어옴.
                const target = clipSourceTimeSec(activeVideo, playheadMs)
                try {
                  v.currentTime = Math.max(0, target)
                } catch {
                  /* src 아직 안 ready */
                }
              }
              // 그 외 평범한 clip은 currentTime/playbackRate 둘 다 안 건드림.
              // src 교체 시 initial seek + native engine 1x 자연 재생만 사용.
            }

            // Compute effective video-track gain. Use the GainNode if the
            // graph is ready; otherwise fall back to `el.volume`.
            const trackIsAudible = trackAudible(track, soloMode)
            const gain = clipGain(activeVideo, playheadMs)
            const wantAudible = !multiVideoPreview && trackIsAudible && gain > 0
            const effectiveGain = wantAudible ? gain : 0
            if (graph.isReady()) {
              graph.setTrackGain(track.id, effectiveGain, 20)
              // WebAudio path uses unity passthrough on `el.volume` to avoid
              // double-attenuation. In multi-video preview, keep DOM video
              // elements muted too; Chromium can otherwise treat simultaneous
              // audible <video> playback differently even when the GainNode is
              // ramped to zero, which makes layout preview frames stall.
              const wantElMuted = multiVideoPreview || !trackIsAudible
              if (v.muted !== wantElMuted) v.muted = wantElMuted
              if (Math.abs(v.volume - 1) > 0.005) v.volume = 1
            } else {
              // Fallback path (AudioContext failed): drive el.volume directly.
              if (v.muted !== !wantAudible) v.muted = !wantAudible
              const targetVol = Math.max(0, Math.min(1, gain))
              if (Math.abs(v.volume - targetVol) > 0.005) v.volume = targetVol
            }
          } else if (loadedVideoId.current.has(track.id)) {
            v.removeAttribute('src')
            v.load()
            loadedVideoId.current.delete(track.id)
          }
        } else if (loadedVideoId.current.has(track.id)) {
          v.pause()
          v.removeAttribute('src')
          v.load()
          loadedVideoId.current.delete(track.id)
          if (graph.isReady()) graph.setTrackGain(track.id, 0, 20)
        }
      }

      // ----- BLURRED BACKGROUND — follows the BOTTOM-most layer -----
      // Phase 3.44 — only run when the canvas backdrop IS the blur backdrop.
      // For solid kinds ('black' / 'white' / 'color') the backdrop element is
      // a <div>, not a <video>, so `bgVideoEl.current` is null AND we have
      // nothing to load → skip the entire block.
      if (canvasBg.kind === 'blur') {
        const bg = bgVideoEl.current
        if (bg) {
          if (bottomLayer) {
            const media = project.media[bottomLayer.clip.mediaId]
            if (media && media.kind !== 'audio') {
              const bgSrcChanged = loadedBgId.current !== media.id
              if (bgSrcChanged) {
                bg.src = previewVideoSrc(media.path, 'background')
                bg.muted = true
                loadedBgId.current = media.id
                if (media.kind !== 'image') {
                  // initial seek 1회만 — 그 후엔 native engine에 맡김.
                  const initialTarget = clipSourceTimeSec(bottomLayer.clip, playheadMs)
                  try { bg.currentTime = Math.max(0, initialTarget) } catch {}
                  const initialRate = clipPlaybackRate(bottomLayer.clip, playheadMs)
                  if (Math.abs(bg.playbackRate - initialRate) > 0.001) {
                    bg.playbackRate = initialRate
                  }
                }
              } else if (media.kind !== 'image' && isUserScrub) {
                // 사용자 scrub만 explicit sync (same threshold as main video).
                const target = clipSourceTimeSec(bottomLayer.clip, playheadMs)
                try { bg.currentTime = Math.max(0, target) } catch {}
              }
              // curve/freeze/deletion clip은 main video 분기에서 처리. bg는
              // 시각적 보조라 약간의 drift 허용 (사용자 체감 X).
            } else if (loadedBgId.current !== null) {
              bg.removeAttribute('src')
              bg.load()
              loadedBgId.current = null
            }
          } else if (loadedBgId.current !== null) {
            bg.pause()
            bg.removeAttribute('src')
            bg.load()
            loadedBgId.current = null
          }
        }
      }

      // ----- AUDIO-ONLY TRACKS — one element per track -----
      for (const track of audioTracks) {
        const a = audioEls.current.get(track.id)
        if (!a) continue
        const hit = hitByTrackId.get(track.id)
        // Always make sure this element is wired (cheap; cached).
        graph.attach(a, track.id)

        if (hit) {
          const { clip } = hit
          const media = project.media[clip.mediaId]
          // Load src + sync currentTime/playbackRate only when the media is
          // actually an audio asset. (A video media on an audio track is
          // a degenerate state that shouldn't normally occur.)
          if (media && media.kind === 'audio') {
            const aSrcChanged = loadedAudioIds.current.get(track.id) !== media.id
            if (aSrcChanged) {
              a.src = toMediaUrl(media.path)
              loadedAudioIds.current.set(track.id, media.id)
              const initialTarget = clipSourceTimeSec(clip, playheadMs)
              try { a.currentTime = Math.max(0, initialTarget) } catch {}
              const initialRate = clipPlaybackRate(clip, playheadMs)
              if (Math.abs(a.playbackRate - initialRate) > 0.001) a.playbackRate = initialRate
              // 0.2.11 — src 교체 직후 paused 상태가 됨 (HTMLMediaElement spec:
              // resource selection algorithm sets paused=true). play/pause sync
              // effect는 audioTracks/playing이 안 바뀌면 안 fire하므로 트랙
              // 이동 시 새 src가 재생되지 않거나 이전 트랙의 stale 버퍼와
              // 충돌 (pptx11 slide 4: BGM 4→BGM 3 이동 시 TTS 들림). 명시적
              // play() + onCanPlay 핸들러로 cold src 보장.
              if (playing) {
                a.play().catch(() => {
                  /* src not ready — onCanPlay will retry */
                })
              }
            } else {
              const needsTightSync =
                hasSpeedCurve(clip) || hasFreezeFrames(clip) || hasTranscriptDeletions(clip)
              if (needsTightSync) {
                const target = clipSourceTimeSec(clip, playheadMs)
                if (Math.abs((a.currentTime || 0) - target) > 0.08) {
                  try { a.currentTime = Math.max(0, target) } catch {}
                }
                const rate = clipPlaybackRate(clip, playheadMs)
                if (Math.abs(a.playbackRate - rate) > 0.001) a.playbackRate = rate
              } else if (isUserScrub) {
                const target = clipSourceTimeSec(clip, playheadMs)
                try { a.currentTime = Math.max(0, target) } catch {}
              }
            }
          }

          // Gain math runs unconditionally so the per-track GainNode
          // reflects the intent (track mute, ducking, solo) — even if the
          // referenced media couldn't be loaded for some reason. This also
          // matters for tests that exercise ducking with a video fixture
          // dropped onto the audio track.
          let g = clipGain(clip, playheadMs)
          if (
            track.role === 'bgm' &&
            track.duckTarget === 'voice' &&
            voiceOn
          ) {
            const duckDb = track.duckingDb ?? -12
            g = g * dbToLinear(duckDb)
          }
          const audible = trackAudible(track, soloMode)
          const effective = audible ? g : 0
          if (graph.isReady()) {
            graph.setTrackGain(track.id, effective, 20)
            // Mirror track-mute on `el.muted` for legacy DOM-readers,
            // unity volume so the GainNode is the sole attenuator.
            const wantElMuted = !audible
            if (a.muted !== wantElMuted) a.muted = wantElMuted
            if (Math.abs(a.volume - 1) > 0.005) a.volume = 1
          } else {
            // Fallback — direct el.volume control.
            const wantMuted = !audible || effective === 0
            if (a.muted !== wantMuted) a.muted = wantMuted
            const clamped = Math.max(0, Math.min(1, effective))
            if (Math.abs(a.volume - clamped) > 0.005) a.volume = clamped
          }
        } else {
          // No clip at playhead on this track → silence it. Don't unload
          // the element — keep the source wired so we don't violate the
          // wrap-once invariant later when a new clip starts.
          if (graph.isReady()) {
            graph.setTrackGain(track.id, 0, 20)
          }
          // Mirror silence on the element too so DOM-readers see muted.
          if (!a.muted) a.muted = true
          if (loadedAudioIds.current.has(track.id)) {
            // Pause to stop the source playing in the background.
            try {
              a.pause()
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
    // (no cleanup — inline run, see 0.2.10 comment above)
  }, [
    project,
    playheadMs,
    videoTracks,
    layerByTrackId,
    bottomLayer,
    audioTracks,
    hitByTrackId,
    voiceOn,
    soloMode,
    multiVideoPreview,
    canvasBg.kind,
    // playing — swap 시 새 src에 자동 play() 호출하려면 effect closure가
    // 최신 playing 값을 봐야 함. closure-stale 방지.
    playing
  ])

  // -----------------------------------------------------------------------
  // Play / pause sync with transport state. Each <audio> element + the
  // <video> element are toggled together so all routed sources advance in
  // lockstep with the playhead.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const bg = bgVideoEl.current
    if (playing) {
      // Play every video-layer element that currently has a source.
      for (const track of videoTracks) {
        const v = videoEls.current.get(track.id)
        if (!v) continue
        if (loadedVideoId.current.get(track.id)) {
          if (multiVideoPreview) v.muted = true
          v.play().catch(() => {
            /* autoplay rejection / src not ready — silently ignored */
          })
        }
      }
      if (bg && loadedBgId.current) {
        bg.play().catch(() => {
          /* ignore */
        })
      }
      // Play every audio element that currently has a source.
      for (const track of audioTracks) {
        const a = audioEls.current.get(track.id)
        if (!a) continue
        if (loadedAudioIds.current.get(track.id)) {
          a.play().catch(() => {
            /* ignore */
          })
          audioPlaying.current.set(track.id, true)
        }
      }
    } else {
      for (const track of videoTracks) {
        videoEls.current.get(track.id)?.pause()
      }
      bg?.pause()
      for (const track of audioTracks) {
        const a = audioEls.current.get(track.id)
        a?.pause()
        audioPlaying.current.set(track.id, false)
      }
    }
  }, [playing, audioTracks, videoTracks, multiVideoPreview])

  // -----------------------------------------------------------------------
  // Playback watchdog / reconcile.
  //
  // The transport rAF owns `playheadMs`, while Chromium owns actual
  // <video>/<audio> decoding. Project mutations (layout, undo, adjustment
  // edits) can reset media elements to paused/stalled even though the store
  // still says playing=true. In that failure mode the timeline keeps moving
  // but preview/TTS/BGM are frozen. While playing, periodically verify the
  // active DOM media elements are advancing; if not, seek them back to the
  // store playhead and retry play().
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!playing) {
      mediaHealth.current.clear()
      return
    }

    const graph = getPreviewAudioGraph()
    let cancelled = false

    const reconcile = (): void => {
      if (cancelled) return
      void graph.resume()
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const state = latestPlaybackState.current

      for (const track of state.videoTracks) {
        const layer = state.layerByTrackId.get(track.id)
        const v = videoEls.current.get(track.id)
        if (!layer || !v) continue
        const media = state.project.media[layer.clip.mediaId]
        if (!media || media.kind === 'audio' || media.kind === 'image') continue
        if (!v.src) continue

        if (v.readyState === HTMLMediaElement.HAVE_NOTHING) {
          try { v.load() } catch {}
        }

        const key = `video:${track.id}`
        const target = clipSourceTimeSec(layer.clip, state.playheadMs)
        const stalled = elementLooksStalled(key, v, mediaHealth.current, now)
        const drift = Math.abs((v.currentTime || 0) - target)
        const shouldSeek =
          stalled ||
          drift > PLAYBACK_DRIFT_SEEK_SEC ||
          (v.paused && !v.ended && Number.isFinite(target))

        if (shouldSeek) {
          setMediaTime(v, target)
        }
        if (v.paused && !v.ended) {
          if (state.multiVideoPreview) v.muted = true
          retryMediaPlay(v)
        }
      }

      if (state.canvasBgKind === 'blur' && state.bottomLayer && bgVideoEl.current) {
        const bg = bgVideoEl.current
        const media = state.project.media[state.bottomLayer.clip.mediaId]
        if (media && media.kind !== 'audio' && media.kind !== 'image' && bg.src) {
          const key = 'video:bg'
          const target = clipSourceTimeSec(state.bottomLayer.clip, state.playheadMs)
          const stalled = elementLooksStalled(key, bg, mediaHealth.current, now)
          if (stalled || Math.abs((bg.currentTime || 0) - target) > PLAYBACK_DRIFT_SEEK_SEC) {
            setMediaTime(bg, target)
          }
          if (bg.paused && !bg.ended) retryMediaPlay(bg)
        }
      }

      for (const track of state.audioTracks) {
        const hit = state.hitByTrackId.get(track.id)
        const a = audioEls.current.get(track.id)
        if (!hit || !a) continue
        const media = state.project.media[hit.clip.mediaId]
        if (!media || media.kind !== 'audio' || !a.src) continue

        if (a.readyState === HTMLMediaElement.HAVE_NOTHING) {
          try { a.load() } catch {}
        }

        const key = `audio:${track.id}`
        const target = clipSourceTimeSec(hit.clip, state.playheadMs)
        const stalled = elementLooksStalled(key, a, mediaHealth.current, now)
        const drift = Math.abs((a.currentTime || 0) - target)
        if (
          stalled ||
          drift > PLAYBACK_DRIFT_SEEK_SEC ||
          (a.paused && !a.ended && Number.isFinite(target))
        ) {
          setMediaTime(a, target)
        }
        if (a.paused && !a.ended) {
          retryMediaPlay(a)
          audioPlaying.current.set(track.id, true)
        }
      }
    }

    const initial = window.setTimeout(reconcile, 0)
    const interval = window.setInterval(reconcile, PLAYBACK_WATCHDOG_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [playing])

  const hasFit = fitted.width > 0 && fitted.height > 0
  const fittedStyle: React.CSSProperties = hasFit
    ? {
        position: 'absolute',
        width: fitted.width,
        height: fitted.height,
        top: fitted.top,
        left: fitted.left,
        background: '#000',
        border: '1px solid #1a1a1a',
        overflow: 'hidden'
      }
    : {
        position: 'absolute',
        inset: 0,
        background: '#000',
        border: '1px solid #1a1a1a',
        overflow: 'hidden'
      }

  // The legacy "primary" <audio> element used by data-testid="preview-audio"
  // consumers (timeline.spec.ts expects exactly count 1). Always tag the
  // FIRST audio track's element (or render a placeholder if none exists) so
  // the legacy selector resolves regardless of whether a clip is active.
  const legacyPrimaryTrackId = audioTracks[0]?.id ?? null

  // -----------------------------------------------------------------------
  // Per-track audio element ref callbacks must be STABLE across renders.
  // If we use an inline `ref={(node) => {...}}`, React calls the previous
  // ref with `null` on every render before invoking the new one — which
  // would trigger detach()/re-attach() on every render and run afoul of
  // the WRAP-ONCE invariant (createMediaElementSource throws on the second
  // wrap of the same HTMLMediaElement).
  //
  // We cache one ref callback per trackId. Each callback closes over the
  // trackId and references the singleton graph + audioEls map by closure.
  // -----------------------------------------------------------------------
  const audioRefCache = useRef<
    Map<string, (node: HTMLAudioElement | null) => void>
  >(new Map())
  const getAudioRef = useCallback(
    (trackId: string): ((node: HTMLAudioElement | null) => void) => {
      const cached = audioRefCache.current.get(trackId)
      if (cached) return cached
      const cb = (node: HTMLAudioElement | null): void => {
        if (node) {
          audioEls.current.set(trackId, node)
        } else {
          // Genuine unmount (track removed). Detach to free graph slot.
          const prev = audioEls.current.get(trackId)
          if (prev) {
            getPreviewAudioGraph().detach(prev)
            audioEls.current.delete(trackId)
          }
          // Drop the cached ref callback so a re-added track gets a fresh
          // one if needed.
          audioRefCache.current.delete(trackId)
        }
      }
      audioRefCache.current.set(trackId, cb)
      return cb
    },
    []
  )

  // -----------------------------------------------------------------------
  // Per-video-track <video> element ref callbacks. Identical strategy to
  // getAudioRef above: <video> elements ALSO carry audio routed through the
  // WebAudio graph, so they must be wrapped exactly once. A stable, cached
  // ref callback per trackId prevents detach()/re-attach() churn (which
  // would violate the wrap-once invariant of createMediaElementSource).
  // -----------------------------------------------------------------------
  const videoRefCache = useRef<
    Map<string, (node: HTMLVideoElement | null) => void>
  >(new Map())
  const getVideoRef = useCallback(
    (trackId: string): ((node: HTMLVideoElement | null) => void) => {
      const cached = videoRefCache.current.get(trackId)
      if (cached) return cached
      const cb = (node: HTMLVideoElement | null): void => {
        if (node) {
          videoEls.current.set(trackId, node)
        } else {
          // Genuine unmount (video track removed). Detach to free graph slot.
          const prev = videoEls.current.get(trackId)
          if (prev) {
            getPreviewAudioGraph().detach(prev)
            videoEls.current.delete(trackId)
          }
          loadedVideoId.current.delete(trackId)
          // Drop the cached ref callback so a re-added track gets a fresh one.
          videoRefCache.current.delete(trackId)
        }
      }
      videoRefCache.current.set(trackId, cb)
      return cb
    },
    []
  )

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      data-testid="preview-canvas"
    >
      <div
        style={
          // Phase 3.32 — when an adjustment layer is active at the playhead,
          // its composed grade is applied as a CSS `filter` on the whole
          // fitted-rect. When inactive, NO `filter` key is added → the style
          // object + DOM stay byte-identical to the pre-feature preview.
          adjustmentGrade.filter
            ? { ...fittedStyle, filter: adjustmentGrade.filter }
            : fittedStyle
        }
        data-testid="preview-fitted-rect"
        data-fitted-width={fitted.width}
        data-fitted-height={fitted.height}
        data-adjustment-active={adjustmentGrade.count > 0 ? 'true' : 'false'}
        data-adjustment-layer-count={adjustmentGrade.count}
      >
        {/* Phase 3.32 — hidden SVG curve filters for active adjustment
            layers. Emitted ONLY when a layer carries non-identity curves, so
            the DOM stays byte-identical when no layer grade is active. */}
        {adjustmentGrade.curveSvgs}
        {adjustmentGrade.count > 0 && (
          <div
            data-testid="preview-adjustment-active"
            data-adjustment-layer-count={adjustmentGrade.count}
            aria-hidden="true"
            style={{ position: 'absolute', width: 0, height: 0 }}
          />
        )}
        {/* Blurred background <video> — fills (object-fit: cover), heavy blur
            + dimmed brightness so the aspect-mismatched gutters get the
            iconic "vertical TikTok" look instead of black bars. z-index: 0.
            Phase 3.6 — the blurred bg intentionally does NOT reflect a clip's
            cropRect (it samples the full frame); the export DOES crop the bg.
            Phase 3.44 — switched on `canvasBg.kind`. 'blur' keeps the legacy
            <video> element verbatim (byte-identical DOM gate); the solid
            kinds ('black' / 'white' / 'color') render a <div> with the SAME
            data-testid, absolute positioning and z-index so the layer stack
            still composites correctly. */}
        {canvasBg.kind === 'blur' ? (
          <video
            ref={bgVideoEl}
            data-testid="preview-video-bg"
            aria-hidden="true"
            playsInline
            muted={true}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(40px) brightness(0.55)',
              transform: 'scale(1.15)', // hide the blur ring at edges
              zIndex: 0,
              pointerEvents: 'none',
              background: '#000'
            }}
          />
        ) : (
          <div
            data-testid="preview-video-bg"
            data-canvas-bg-kind={canvasBg.kind}
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              zIndex: 0,
              pointerEvents: 'none',
              background:
                canvasBg.kind === 'black'
                  ? '#000000'
                  : canvasBg.kind === 'white'
                    ? '#ffffff'
                    : canvasBg.color ?? '#000000'
            }}
          />
        )}
        {/* Video layer stack — one <video> per video TRACK. object-fit:
            contain preserves the source aspect ratio inside the letterbox.
            zIndex = 1 + layerIndex so later tracks composite on top; the
            caption overlay sits above all layers. Each element stays mounted
            across clip changes (wrap-once invariant — see getVideoRef).
            The TOP-most layer additionally carries the legacy
            data-testid="preview-video" attribute so existing E2E selectors
            (export.spec.ts → data-filter-preset) keep resolving. */}
        {videoTracks.map((track, trackIdx) => {
          const layer = layerByTrackId.get(track.id)
          const isTop = topLayer?.track.id === track.id
          const trackIsAudible = trackAudible(track, soloMode)
          // zIndex: video tracks with no active clip still render a (blank)
          // element — base it on the track's ordinal so the stack stays
          // stable, but active layers always sit at 1 + layerIndex.
          const zIndex = layer ? 1 + layer.layerIndex : 1 + trackIdx
          const clip = layer?.clip
          // Phase 3.5 — resolve the effective transform AT the playhead so
          // keyframed clips animate during scrub/playback. For a static clip
          // getTransformAt falls back to the Phase 3 getClipTransform path.
          const t = clip ? getTransformAt(clip, playheadMs) : null
          const visualEffect = clip ? getVisualEffect(clip) : null
          const visualEffectTransform =
            visualEffect === 'mirror-h'
              ? ' scaleX(-1)'
              : visualEffect === 'mirror-v'
                ? ' scaleY(-1)'
                : ''
          const cssTransform = t
            ? `translate(${t.x * 100}%, ${t.y * 100}%) scale(${t.scale}) rotate(${t.rotation}deg)${visualEffectTransform}`
            : undefined
          // Phase 3.6 — a non-null crop rect means we must show ONLY the
          // sub-region. cr is null for un-cropped clips (identity/absent) →
          // the <video> is rendered exactly as before (no wrapper) so the DOM
          // stays byte-identical for the regression-critical specs.
          const cr = clip ? getClipCropRect(clip) : null
          // Phase 3.7 — manual color-adjust STACKS on top of the filter
          // preset. Compute the combined CSS `filter` string ONCE here so the
          // cropped + non-cropped paths stay in lockstep. INVARIANT: for a
          // clip with no `colorAdjust`, colorAdjustToCss(null) === '' → it is
          // dropped → the string is byte-identical to the prior preset-only
          // value (regression-critical — see export.spec.ts).
          // Phase 3.12 — tone curves. CSS `filter:` cannot do curves, so we
          // emit a hidden SVG <filter> with two chained feComponentTransfer
          // stages (per-channel curve, then master curve) and reference it via
          // url(#curve-<id>). INVARIANT: when getClipCurves(clip) is null we
          // append NOTHING — the `filter:` string + DOM stay byte-identical to
          // the pre-Phase-3.12 value (regression-critical — see export.spec).
          const clipCurves = clip ? getClipCurves(clip) : null
          // 리터치 / 뷰티 — the preview cannot do edge-preserving smoothing;
          // approximate with a deliberately tiny CSS blur (export-accurate,
          // preview-approximate — like blur regions / HSL). Intensity 1..100
          // maps to blur 0.018..1.8px. INVARIANT: when getClipRetouch(clip) is
          // null we append NOTHING — the `.filter(...)` below drops it so the
          // `filter:` string + DOM stay byte-identical for a retouch-off clip.
          const rt = clip ? getClipRetouch(clip) : null
          // Phase 3.37 — film look (vignette / grain / faded tone). TONE is
          // previewed as a cheap CSS approximation appended to combinedFilter
          // (filmToneToCss returns '' for 'none'/null → dropped by the
          // .filter(...) below so a look-less clip stays byte-identical).
          // VIGNETTE is a sibling radial-gradient overlay (rendered below).
          // GRAIN is export-only — no honest CSS primitive. INVARIANT: when
          // getFilmLook(clip) is null nothing is added — DOM byte-identical.
          const filmLook = clip ? getFilmLook(clip) : null
          const combinedFilter = clip
            ? [
                filterPresetToCss(clip.filterPreset, clip.filterIntensity ?? 1),
                colorAdjustToCss(getClipColorAdjust(clip)),
                clipCurves ? `url(#curve-${clip.id})` : '',
                rt !== null ? `blur(${((rt / 100) * 1.8).toFixed(2)}px)` : '',
                filmToneToCss(filmLook?.toneId),
                visualEffectToCss(visualEffect)
              ]
                .filter((s) => s.length > 0)
                .join(' ') || 'none'
            : 'none'
          // Vignette overlay — rendered only when strength > 0. Opacity scales
          // vignette/100 up to ~0.7. The radial-gradient fills the clip rect;
          // it is placed inside the same crop/transform wrapper as the clip so
          // it tracks crop + transform. `extraTransform` is non-empty only for
          // the un-cropped path (there the <video> itself carries the CSS
          // transform — no wrapper — so the vignette must mirror it).
          const vignetteBg =
            filmLook && filmLook.vignette > 0
              ? `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${(
                  (filmLook.vignette / 100) *
                  0.7
                ).toFixed(3)}) 100%)`
              : null
          const makeVignette = (
            withTransform: boolean
          ): JSX.Element | null =>
            vignetteBg ? (
              <div
                key={`${track.id}-vignette`}
                data-testid="preview-vignette"
                aria-hidden
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                  zIndex: zIndex + 1,
                  background: vignetteBg,
                  ...(withTransform
                    ? {
                        display: layer ? undefined : 'none',
                        transformOrigin: 'center center',
                        transform: cssTransform,
                        opacity: t ? t.opacity : 1
                      }
                    : null)
                }}
              />
            ) : null
          const videoEl = (
            <video
              key={track.id}
              ref={getVideoRef(track.id)}
              // The TOP-most active layer carries the legacy
              // data-testid="preview-video" (export.spec.ts depends on it);
              // every other layer carries data-testid="preview-video-layer".
              // A separate `data-preview-video-layer` marker is set on ALL
              // layers (incl. the top) so layer-counting tests can select the
              // whole stack with [data-preview-video-layer].
              data-testid={isTop ? 'preview-video' : 'preview-video-layer'}
              data-preview-video-layer="true"
              data-track-id={track.id}
              data-layer-index={layer ? layer.layerIndex : -1}
              data-track-audible={trackIsAudible ? 'true' : 'false'}
              data-filter-preset={clip?.filterPreset ?? 'none'}
              data-color-adjust={
                clip && getClipColorAdjust(clip) ? 'true' : 'false'
              }
              data-film-look={filmLook ? 'true' : 'false'}
              data-visual-effect={visualEffect ?? 'none'}
              data-stabilize={
                clip && getClipStabilize(clip) ? 'true' : 'false'
              }
              playsInline
              muted={false}
              // 0.2.6 — 두 번째 클립으로 넘어갈 때 첫 클립 마지막 프레임
              // 에서 멈추는 버그(슬라이드 6) 해결: preload="auto"로 새 src
              // 가 metadata만이 아닌 video data까지 적극 prefetch. 기본값
              // preload="metadata"는 frame 데이터를 첫 재생 시점에야 받기
              // 시작 → 그 buffering 동안 이전 frame 화면 freeze.
              preload="auto"
              // 0.2.8 — `loadeddata` (frame data 첫 도달) + `canplay`
              // (재생 가능 상태) 두 이벤트 모두에 자동 play() 시도. swap
              // useEffect의 즉시 play()가 src 교체 직후엔 readyState=HAVE_
              // NOTHING 이라 reject되는 케이스를 capture. playing이 false
              // 면 (사용자가 pause 했음) 자동 재생 안 함.
              onLoadedData={(e) => {
                refreshVideoPoster(e.currentTarget)
                if (playing) {
                  if (multiVideoPreview) e.currentTarget.muted = true
                  ;(e.currentTarget as HTMLVideoElement).play().catch(() => {})
                }
              }}
              onCanPlay={(e) => {
                refreshVideoPoster(e.currentTarget)
                if (
                  playing &&
                  (e.currentTarget as HTMLVideoElement).paused
                ) {
                  if (multiVideoPreview) e.currentTarget.muted = true
                  ;(e.currentTarget as HTMLVideoElement).play().catch(() => {})
                }
              }}
              style={
                cr
                  ? {
                      // Cropped path: the <video> is oversized + translated
                      // inside the crop wrapper so the kept sub-rect fills it.
                      // CSS transform + opacity move ONTO the wrapper instead.
                      position: 'absolute',
                      width: `${100 / cr.w}%`,
                      height: `${100 / cr.h}%`,
                      left: `${(-cr.x * 100) / cr.w}%`,
                      top: `${(-cr.y * 100) / cr.h}%`,
                      objectFit: 'contain',
                      background: 'transparent',
                      filter: combinedFilter
                    }
                  : {
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      background: 'transparent',
                      zIndex,
                      display: layer ? undefined : 'none',
                      transformOrigin: 'center center',
                      transform: cssTransform,
                      opacity: t ? t.opacity : 1,
                      filter: combinedFilter
                    }
              }
            />
          )
          // Phase 3.11 — mosaic / blur regions. A non-empty list means we
          // overlay one masking div per region as a DIRECT CHILD of the
          // fitted-rect (NOT inside the crop-wrapper — a child there would be
          // double-transformed). INVARIANT: when getClipBlurRegions(clip) is
          // [] we render NOTHING new — the existing DOM stays byte-identical.
          const blurRegions = clip ? getClipBlurRegions(clip) : []
          const blurLayer =
            clip && blurRegions.length > 0 ? (
              <div
                key={`${track.id}-blur`}
                data-testid="blur-region-layer"
                data-track-id={track.id}
                data-region-count={blurRegions.length}
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                  zIndex
                }}
              >
                {blurRegions.map((region) => {
                  // BLUR → real CSS backdrop blur. MOSAIC → there is no CSS
                  // pixelate primitive, so we APPROXIMATE it with a heavy
                  // backdrop blur scaled off the export block size (like
                  // filterPresetToCss approximates the export LUT). The
                  // export does a TRUE mosaic; preview ≈ export.
                  const MOSAIC_K = 0.6
                  const radiusPx =
                    region.effect === 'blur'
                      ? blurRegionBlurRadiusPx(region)
                      : MOSAIC_K *
                        blurRegionMosaicBlockPx(
                          region,
                          project.width,
                          project.height
                        )
                  const blurCss = `blur(${radiusPx}px)`
                  // Phase 3.13 — track-aware position override. ONLY when the
                  // region binds to a resolvable ≥2-point motion track on
                  // THIS clip do we replace the static left/top with the
                  // tracked center. INVARIANT: an unbound region (no
                  // motionTrackId, or a dangling id) takes the static path
                  // below — byte-identical legacy DOM.
                  const boundTrack = region.motionTrackId
                    ? findMotionTrack(project, region.motionTrackId)
                    : null
                  const trackPos =
                    boundTrack && boundTrack.points.length >= 2
                      ? getTrackPositionAt(
                          boundTrack,
                          playheadMs - clip.startMs
                        )
                      : null
                  // center → top-left.
                  const leftCss = trackPos
                    ? `${(trackPos.x - region.w / 2) * 100}%`
                    : `${region.x * 100}%`
                  const topCss = trackPos
                    ? `${(trackPos.y - region.h / 2) * 100}%`
                    : `${region.y * 100}%`
                  // Phase 3.14 — 'remove' (object removal) regions cannot be
                  // inpainted in the preview. Instead of a backdrop blur we
                  // render a NEUTRAL hatched placeholder + a "제거 영역" label
                  // that signals the area will be erased on export (preview is
                  // approximate). INVARIANT: 'mosaic'/'blur' regions take the
                  // backdrop-filter path below — byte-identical legacy DOM.
                  if (region.effect === 'remove') {
                    return (
                      <div
                        key={region.id}
                        data-testid="blur-region"
                        data-region-id={region.id}
                        data-region-effect={region.effect}
                        data-region-shape={region.shape}
                        data-motion-track-id={
                          trackPos ? region.motionTrackId : undefined
                        }
                        style={{
                          position: 'absolute',
                          left: leftCss,
                          top: topCss,
                          width: `${region.w * 100}%`,
                          height: `${region.h * 100}%`,
                          overflow: 'hidden',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          border: '1px dashed rgba(255,255,255,0.55)',
                          backgroundColor: 'rgba(20,20,20,0.45)',
                          backgroundImage:
                            'repeating-linear-gradient(' +
                            '45deg,' +
                            'rgba(255,255,255,0.16) 0px,' +
                            'rgba(255,255,255,0.16) 6px,' +
                            'rgba(255,255,255,0) 6px,' +
                            'rgba(255,255,255,0) 12px)'
                        }}
                      >
                        <span
                          data-testid="blur-region-remove-label"
                          style={{
                            fontSize: 11,
                            lineHeight: 1.2,
                            color: 'rgba(255,255,255,0.9)',
                            background: 'rgba(0,0,0,0.55)',
                            padding: '1px 6px',
                            borderRadius: 3,
                            whiteSpace: 'nowrap',
                            pointerEvents: 'none'
                          }}
                        >
                          제거 영역
                        </span>
                      </div>
                    )
                  }
                  return (
                    <div
                      key={region.id}
                      data-testid="blur-region"
                      data-region-id={region.id}
                      data-region-effect={region.effect}
                      data-region-shape={region.shape}
                      data-motion-track-id={
                        trackPos ? region.motionTrackId : undefined
                      }
                      style={{
                        position: 'absolute',
                        left: leftCss,
                        top: topCss,
                        width: `${region.w * 100}%`,
                        height: `${region.h * 100}%`,
                        overflow: 'hidden',
                        borderRadius: region.shape === 'ellipse' ? '50%' : 0,
                        backdropFilter: blurCss,
                        WebkitBackdropFilter: blurCss
                      }}
                    />
                  )
                })}
              </div>
            ) : null

          // Phase 3.12 — hidden SVG <filter> hosting the clip's tone curves.
          // Two chained feComponentTransfer stages = per-channel curve, then
          // master curve (master ∘ red/green/blue) — exact, no manual table
          // composition. INVARIANT: emitted ONLY when clipCurves is non-null,
          // so the DOM stays byte-identical for un-graded clips. The <svg> is
          // zero-size + aria-hidden — it only carries the filter definition.
          const CURVE_STEPS = 33
          const curveTable = (pts: { x: number; y: number }[]): string =>
            sampleCurveTable(pts, CURVE_STEPS)
              .map((v) => v.toFixed(4))
              .join(' ')
          const curveFilterSvg =
            clip && clipCurves ? (
              <svg
                key={`${track.id}-curve`}
                data-testid="curve-filter-svg"
                data-clip-id={clip.id}
                aria-hidden="true"
                width={0}
                height={0}
                style={{ position: 'absolute', width: 0, height: 0 }}
              >
                <defs>
                  <filter
                    id={`curve-${clip.id}`}
                    colorInterpolationFilters="sRGB"
                  >
                    {/* Stage 1 — per-channel R/G/B curves. */}
                    <feComponentTransfer>
                      <feFuncR
                        type="table"
                        tableValues={curveTable(clipCurves.red)}
                      />
                      <feFuncG
                        type="table"
                        tableValues={curveTable(clipCurves.green)}
                      />
                      <feFuncB
                        type="table"
                        tableValues={curveTable(clipCurves.blue)}
                      />
                    </feComponentTransfer>
                    {/* Stage 2 — master curve applied to all channels. */}
                    <feComponentTransfer>
                      <feFuncR
                        type="table"
                        tableValues={curveTable(clipCurves.master)}
                      />
                      <feFuncG
                        type="table"
                        tableValues={curveTable(clipCurves.master)}
                      />
                      <feFuncB
                        type="table"
                        tableValues={curveTable(clipCurves.master)}
                      />
                    </feComponentTransfer>
                  </filter>
                </defs>
              </svg>
            ) : null

          if (!cr) {
            // Un-cropped path. When the clip has no blur regions AND no tone
            // curves AND no vignette, return the bare <video> exactly as
            // before (byte-identical DOM). Otherwise emit the extras
            // alongside it. The vignette mirrors the <video>'s CSS transform
            // (the <video> carries it directly — no wrapper on this path).
            const vignetteEl = makeVignette(true)
            if (!blurLayer && !curveFilterSvg && !vignetteEl) return videoEl
            return (
              <Fragment key={track.id}>
                {videoEl}
                {curveFilterSvg}
                {blurLayer}
                {vignetteEl}
              </Fragment>
            )
          }
          // Cropped path: wrap the <video> in an overflow:hidden div. The
          // wrapper carries the layer zIndex + the CSS transform/opacity; the
          // inner <video> (unchanged ref + data-* attrs — the WebAudio graph
          // wraps the element, not the div) is sized/translated above so only
          // the crop sub-rect is visible. Outermost node keyed with track.id
          // so React reconciliation stays stable across crop on/off toggles.
          // The blur layer (Phase 3.11) is emitted as a SIBLING of the crop
          // wrapper (direct child of the fitted-rect) so it is NOT
          // double-transformed by the wrapper's CSS transform.
          const cropWrapper = (
            <div
              key={track.id}
              data-testid="preview-crop-wrapper"
              data-track-id={track.id}
              data-crop-active="true"
              style={{
                position: 'absolute',
                inset: 0,
                overflow: 'hidden',
                zIndex,
                display: layer ? undefined : 'none',
                transformOrigin: 'center center',
                transform: cssTransform,
                opacity: t ? t.opacity : 1
              }}
            >
              {videoEl}
              {/* Vignette lives INSIDE the crop wrapper so it tracks both
                  the crop sub-rect and the wrapper's CSS transform. No own
                  transform here — the wrapper already applies it. */}
              {makeVignette(false)}
            </div>
          )
          if (!blurLayer && !curveFilterSvg) return cropWrapper
          return (
            <Fragment key={track.id}>
              {cropWrapper}
              {curveFilterSvg}
              {blurLayer}
            </Fragment>
          )
        })}
        {/* One <audio> per audio track. Wrapped exactly once by the
            WebAudio graph (see audioGraph.ts wrap-once invariant), so the
            element can stay mounted across clip-changes on that track.
            The FIRST audio track always carries the legacy
            data-testid="preview-audio" attribute so existing E2E selectors
            (timeline.spec.ts etc.) keep working. */}
        {audioTracks.map((t) => {
          const isPrimary = legacyPrimaryTrackId === t.id
          const isAudible = trackAudible(t, soloMode)
          const ducking =
            t.role === 'bgm' && t.duckTarget === 'voice' && voiceOn
              ? 'true'
              : 'false'
          return (
            <audio
              key={t.id}
              ref={getAudioRef(t.id)}
              data-testid={isPrimary ? 'preview-audio' : 'preview-audio-track'}
              data-track-id={t.id}
              data-track-role={t.role ?? 'none'}
              data-track-audible={isAudible ? 'true' : 'false'}
              data-ducking={ducking}
              // 0.2.11 — <video>와 동일하게 cold src 자동 재생. swap effect
              // 즉시 play()가 readyState=HAVE_NOTHING로 reject되는 케이스를
              // capture (pptx11 slide 4 트랙 이동 시 stale 버퍼 충돌 방지).
              onLoadedData={(e) => {
                if (playing) (e.currentTarget as HTMLAudioElement).play().catch(() => {})
              }}
              onCanPlay={(e) => {
                if (playing && (e.currentTarget as HTMLAudioElement).paused) {
                  ;(e.currentTarget as HTMLAudioElement).play().catch(() => {})
                }
              }}
            />
          )
        })}
        {/* Back-compat shim: if no audio track exists at all, render a
            zero-source preview-audio element so legacy tests that look for
            [data-testid="preview-audio"] still find a node. (Default
            projects always have voice+BGM, so this almost never fires.) */}
        {audioTracks.length === 0 && (
          <audio
            data-testid="preview-audio"
            data-track-audible="true"
            data-ducking="false"
          />
        )}

        {/* Overlay layer (Phase 3.8) — image stickers + vector shapes.
            Composites ABOVE every video layer, BELOW the caption layer.
            Always rendered (even when empty) so layer-counting tests can
            select it; pointer events disabled (preview is non-interactive). */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: overlayZIndex
          }}
          data-testid="overlay-layer"
        >
          {activeOverlays.map((o) => (
            <OverlayElement
              key={o.id}
              clip={o}
              playheadMs={playheadMs}
              project={project}
              fittedHeight={fitted.height}
            />
          ))}
        </div>

        {adjustmentGrade.regions.map((region) => (
          <div
            key={region.id}
            data-testid="preview-adjustment-region"
            data-layer-id={region.id}
            data-transform-active="true"
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              zIndex: captionZIndex - 1,
              transformOrigin: 'center center',
              transform: `translate(${region.transform.x * 100}%, ${
                region.transform.y * 100
              }%) scale(${region.transform.scale}) scaleX(${
                region.mirrorX ? -1 : 1
              }) scaleY(${region.mirrorY ? -1 : 1}) rotate(${
                region.transform.rotation
              }deg)`,
              opacity: region.transform.opacity,
              backdropFilter: region.filter || 'none',
              WebkitBackdropFilter: region.filter || 'none',
              background: 'rgba(0,0,0,0.001)'
            }}
          />
        ))}

        {/* Placeholder when no video clip is at the playhead on ANY layer. */}
        {videoLayers.length === 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#1f2937',
              fontSize: 11,
              zIndex: captionZIndex
            }}
            data-testid="preview-placeholder-empty"
          >
            재생 헤드 위치에 클립이 없습니다
          </div>
        )}

        {/* Caption overlay — sits above EVERY video layer. z-index is
            recomputed off the layer count so adding video tracks never
            buries the captions. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: captionZIndex
          }}
          data-testid="caption-overlay-layer"
        >
          {activeCaptions.map((c) => (
            <CaptionOverlay
              key={c.id}
              caption={c}
              fittedWidth={fitted.width}
              fittedHeight={fitted.height}
              playheadMs={playheadMs}
              project={project}
              customFonts={customCaptionFonts}
            />
          ))}
        </div>

        {/* SNS platform-preview chrome (Phase 6) — a non-interactive visual
            guide layered above everything else. Renders nothing when the
            selected platform is '없음' (none). It never affects the video,
            captions, transforms, or the export pipeline. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: socialZIndex
          }}
          data-testid="social-preview-layer"
        >
          <SocialPreviewOverlay platform={socialPlatform} />
        </div>

        {/* Motion-track markers (Phase 3.13) — a faint box at the tracked
            position for every ≥2-point track on a video layer active at the
            playhead. Purely diagnostic; never affects export. */}
        {videoLayers.map(({ clip }) => {
          const tracks = clip.motionTracks
          if (!Array.isArray(tracks) || tracks.length === 0) return null
          return tracks.map((mt) => {
            if (mt.points.length < 2) return null
            const pos = getTrackPositionAt(mt, playheadMs - clip.startMs)
            if (!pos) return null
            const bw = mt.sourceRect.w * (pos.scale || 1)
            const bh = mt.sourceRect.h * (pos.scale || 1)
            return (
              <div
                key={`${clip.id}-${mt.id}`}
                data-testid="motion-track-marker"
                data-track-id={mt.id}
                data-clip-id={clip.id}
                style={{
                  position: 'absolute',
                  left: `${(pos.x - bw / 2) * 100}%`,
                  top: `${(pos.y - bh / 2) * 100}%`,
                  width: `${bw * 100}%`,
                  height: `${bh * 100}%`,
                  border: '1px dashed rgba(16,185,129,0.65)',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
                  pointerEvents: 'none',
                  zIndex: socialZIndex + 1
                }}
              />
            )
          })
        })}

        {/* Motion-track box-draw overlay (Phase 3.13). Rendered ONLY while the
            tracking store's drawMode is armed; sits above everything so the
            user can rubber-band a box over the current frame. */}
        {trackingDrawMode && trackingDrawClipId && (
          <MotionTrackDrawLayer zIndex={socialZIndex + 2} />
        )}

        {/* Phase 3.35 — progress bar overlay. Renders ONLY when
            `getProgressBar` is non-null (enabled config) AND the project has a
            positive total duration. For legacy / disabled projects this whole
            block is absent → byte-identical DOM. The track + fill composite
            above EVERYTHING else (captions, social chrome, motion markers). */}
        {progressBar && (
          <div
            data-testid="preview-progress-bar-track"
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              ...(progressBar.cfg.position === 'top'
                ? { top: 0 }
                : { bottom: 0 }),
              height: `${progressBar.cfg.heightFrac * 100}%`,
              background: hexToRgba(
                progressBar.cfg.color,
                PROGRESS_BAR_TRACK_OPACITY
              ),
              pointerEvents: 'none',
              zIndex: socialZIndex + 3
            }}
          >
            <div
              data-testid="preview-progress-bar-fill"
              data-progress-pct={progressBar.pct}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                height: '100%',
                width: `${progressBar.pct}%`,
                background: progressBar.cfg.color,
                pointerEvents: 'none'
              }}
            />
          </div>
        )}

        {/* Phase 3.43 — preview-only horizontal guideline rules. Rendered ONLY
            when the sanitized list is non-empty; for legacy / cleared projects
            this whole block is absent → byte-identical DOM (the preview gate).
            Pure preview decoration: never read by export.ts. Composites one
            above the progress bar so the lines are visible over the bar fill. */}
        {previewGuides.length > 0 && (
          <div
            data-testid="preview-guides-layer"
            data-guide-count={previewGuides.length}
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              zIndex: socialZIndex + 4
            }}
          >
            {previewGuides.map((yFrac, idx) => (
              <div
                key={`guide-${idx}-${yFrac.toFixed(4)}`}
                data-testid="preview-guide-line"
                data-guide-index={idx}
                data-guide-y-frac={yFrac.toFixed(4)}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: `${yFrac * 100}%`,
                  height: 0,
                  borderTop: '1px dashed #f59e0b',
                  pointerEvents: 'none'
                }}
              >
                <span
                  data-testid="preview-guide-label"
                  style={{
                    position: 'absolute',
                    top: -8,
                    right: 4,
                    padding: '0 4px',
                    background: 'rgba(13,13,13,0.78)',
                    border: '1px solid rgba(245,158,11,0.5)',
                    borderRadius: 3,
                    color: '#f59e0b',
                    fontSize: 9,
                    lineHeight: '14px',
                    fontFamily: 'monospace',
                    pointerEvents: 'none',
                    userSelect: 'none'
                  }}
                >
                  {Math.round(yFrac * 100)}%
                </span>
              </div>
            ))}
          </div>
        )}

        <style>{`
          @keyframes reels-pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.12); }
          }
        `}</style>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phase 3.43 — preview-only horizontal guideline rules: corner control.
//
// A small button + popover that lives in the preview-area top-right corner
// (mounted by Editor.tsx alongside `SocialPreviewSelector`). Pure preview
// chrome — every mutation routes through the project store's preview-guide
// actions (`setPreviewGuides` / `addPreviewGuide` / `removePreviewGuide` /
// `updatePreviewGuide`). The store collapses an empty list to absent so the
// overlay layer stays byte-identical to legacy projects.
// ---------------------------------------------------------------------------
export function PreviewGuidesControl(): JSX.Element {
  const project = useProjectStore((s) => s.project)
  const addPreviewGuide = useProjectStore((s) => s.addPreviewGuide)
  const removePreviewGuide = useProjectStore((s) => s.removePreviewGuide)
  const updatePreviewGuide = useProjectStore((s) => s.updatePreviewGuide)
  const setPreviewGuides = useProjectStore((s) => s.setPreviewGuides)
  const guides = useMemo(() => getPreviewGuides(project), [project])
  const [open, setOpen] = useState(false)

  const atCap = guides.length >= MAX_PREVIEW_GUIDES

  return (
    <div
      data-testid="preview-guides-control"
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 4,
        position: 'relative'
      }}
    >
      <button
        type="button"
        data-testid="toggle-preview-guides"
        title="미리보기 위에 가로 가이드라인을 추가합니다 (내보내기에는 영향 없음)"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(13, 13, 13, 0.82)',
          border: '1px solid #2a2a2a',
          borderRadius: 6,
          padding: '4px 8px',
          color: '#cbd5e1',
          fontSize: 11,
          cursor: 'pointer',
          whiteSpace: 'nowrap'
        }}
      >
        <span aria-hidden="true" style={{ opacity: 0.85 }}>
          ⎯
        </span>
        <span>가이드라인 ({guides.length})</span>
      </button>
      {open && (
        <div
          data-testid="preview-guides-popover"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            minWidth: 240,
            maxWidth: 320,
            background: 'rgba(13, 13, 13, 0.94)',
            border: '1px solid #2a2a2a',
            borderRadius: 6,
            padding: 8,
            color: '#cbd5e1',
            fontSize: 11,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            boxShadow: '0 4px 14px rgba(0,0,0,0.55)'
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8
            }}
          >
            <button
              type="button"
              data-testid="add-preview-guide"
              disabled={atCap}
              onClick={() => {
                if (atCap) return
                addPreviewGuide(DEFAULT_PREVIEW_GUIDE_FRAC)
              }}
              style={{
                background: atCap ? '#1f2937' : '#2563eb',
                color: atCap ? '#6b7280' : '#f5f5f5',
                border: '1px solid #374151',
                borderRadius: 4,
                padding: '3px 8px',
                fontSize: 11,
                cursor: atCap ? 'not-allowed' : 'pointer'
              }}
            >
              + 추가
            </button>
            {guides.length >= 2 && (
              <button
                type="button"
                data-testid="clear-preview-guides"
                onClick={() => setPreviewGuides([])}
                style={{
                  background: 'transparent',
                  color: '#94a3b8',
                  border: '1px solid #374151',
                  borderRadius: 4,
                  padding: '3px 8px',
                  fontSize: 11,
                  cursor: 'pointer'
                }}
              >
                모두 지우기
              </button>
            )}
          </div>
          {guides.length === 0 ? (
            <div
              data-testid="preview-guides-empty"
              style={{ color: '#6b7280', padding: '4px 2px' }}
            >
              가이드라인이 없습니다. &quot;+ 추가&quot;를 누르세요.
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                maxHeight: 240,
                overflowY: 'auto'
              }}
            >
              {guides.map((yFrac, idx) => (
                <div
                  key={`row-${idx}`}
                  data-testid="preview-guide-row"
                  data-guide-index={idx}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '44px 1fr auto',
                    alignItems: 'center',
                    gap: 6
                  }}
                >
                  <span
                    data-testid="preview-guide-row-label"
                    style={{
                      fontFamily: 'monospace',
                      color: '#f59e0b',
                      fontSize: 11,
                      textAlign: 'right'
                    }}
                  >
                    {Math.round(yFrac * 100)}%
                  </span>
                  <input
                    type="range"
                    data-testid="preview-guide-slider"
                    min={0}
                    max={1}
                    step={0.01}
                    value={yFrac}
                    onChange={(e) => {
                      const next = parseFloat(e.target.value)
                      if (Number.isFinite(next)) {
                        updatePreviewGuide(idx, next)
                      }
                    }}
                    style={{ width: '100%' }}
                  />
                  <button
                    type="button"
                    data-testid="remove-preview-guide"
                    onClick={() => removePreviewGuide(idx)}
                    title="삭제"
                    style={{
                      background: 'transparent',
                      color: '#ef4444',
                      border: '1px solid #374151',
                      borderRadius: 4,
                      padding: '1px 6px',
                      fontSize: 11,
                      cursor: 'pointer'
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Re-export helper for tests (Editor / Timeline parity).
export type { Clip }
