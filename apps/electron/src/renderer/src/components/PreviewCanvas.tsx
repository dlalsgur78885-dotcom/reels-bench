import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CAPTION_POP_START_SCALE,
  CAPTION_SLIDE_FRAC,
  getCaptionAnimWindows,
  getCaptionAnimation,
  getClipColorAdjust,
  getClipCropRect,
  getOverlayBaseSize,
  getSpeedAt,
  getTransformAt,
  hasSpeedCurve,
  isCaptionClip,
  isMediaClip,
  isOverlayClip,
  sourceOffsetForTimelineOffset,
  type CaptionClip,
  type CaptionSpan,
  type CaptionStyle,
  type Clip,
  type OverlayClip,
  type Project,
  type ShapeStyle,
  type Track,
  type VideoAudioClip
} from '../../../shared/project'
import { colorAdjustToCss, filterPresetToCss } from '../../../shared/filterPresets'
import { useTimelineUi } from '../store/timelineUi'
import { toMediaUrl } from '../lib/mediaUrl'
import { SocialPreviewOverlay } from './SocialPreviewOverlay'
import {
  dbToLinear,
  getPreviewAudioGraph,
  installAutoResume
} from '../lib/audioGraph'

// ---------------------------------------------------------------------------
// Source-time mapping (Phase 2.3 speed-aware; Phase 3.10 curve-aware).
//
// timelineMs → source media currentTime, factoring playback speed and the
// clip's trim window.
//
//   constant: currentTime = ((timelineMs-startMs)*speed + trimInMs) / 1000
//             playbackRate = speed
//   curve:    currentTime = (sourceOffsetForTimelineOffset(...) + trimInMs)/1000
//             playbackRate = getSpeedAt(clip, sourceOffset)  (instantaneous)
//
// The constant path is byte-identical to the pre-3.10 formula for any clip
// without an active speed curve.
// ---------------------------------------------------------------------------
export function clipSourceTimeSec(clip: VideoAudioClip, timelineMs: number): number {
  if (hasSpeedCurve(clip)) {
    // Curve clip — map the elapsed TIMELINE offset through the inverse speed
    // integral to the consumed SOURCE offset (from trimInMs).
    const sourceOffsetMs = sourceOffsetForTimelineOffset(
      clip,
      timelineMs - clip.startMs
    )
    return (sourceOffsetMs + clip.trimInMs) / 1000
  }
  const speed = clip.speed ?? 1
  const offsetMs = (timelineMs - clip.startMs) * speed
  return (offsetMs + clip.trimInMs) / 1000
}

/**
 * Effective playback rate for a clip's <video>/<audio> element. For a curve
 * clip the rate tracks the INSTANTANEOUS curve speed at the playhead (so the
 * preview ramps), which is why `timelineMs` is needed; pass the playhead.
 * For a non-curve clip the constant `speed` is returned (timelineMs ignored)
 * — byte-identical to the pre-3.10 behavior.
 */
export function clipPlaybackRate(
  clip: VideoAudioClip,
  timelineMs?: number
): number {
  if (hasSpeedCurve(clip) && timelineMs !== undefined) {
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

function backgroundFor(style: CaptionStyle): React.CSSProperties {
  switch (style.background) {
    case 'solid':
      return {
        background:
          style.preset === 'youtube-yellow' ? '#000' : 'rgba(0,0,0,0.78)',
        padding: '0.25em 0.6em',
        borderRadius: 6
      }
    case 'pill':
      return {
        background: 'rgba(0,0,0,0.7)',
        padding: '0.2em 0.9em',
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

function SpanView(props: { span: CaptionSpan; style: CaptionStyle }): JSX.Element {
  const { span, style } = props
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
  return (
    <span
      data-testid="caption-span"
      data-emphasis={span.emphasis ?? 'none'}
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
  fittedHeight: number
  playheadMs: number
}): JSX.Element {
  const { caption, fittedHeight, playheadMs } = props
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
  const containerStyle: React.CSSProperties = {
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
    ...presetExtras(style),
    ...backgroundFor(style)
  }
  // INVARIANT: an un-animated caption (anim === null) writes NEITHER `opacity`
  // nor a modified `transform` — the spread above already set `transform` via
  // alignToHorizontalAnchor, and `opacity` stays absent → rendered DOM is
  // byte-identical to the legacy path. Only when there IS animation do we
  // append the extra transform / multiply opacity onto the container.
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
  return (
    <div
      data-testid="caption-overlay"
      data-caption-id={caption.id}
      data-preset={style.preset}
      data-background={style.background}
      data-anim-entrance={anim?.entrance ?? 'none'}
      data-anim-exit={anim?.exit ?? 'none'}
      data-revealed-spans={revealSpanCount}
      style={containerStyle}
    >
      <div style={{ display: 'inline' }}>
        {caption.spans.map((s, i) => {
          // Typewriter: keep tail spans in flow (visibility:hidden — no
          // layout reflow) so only the revealed prefix is visible.
          const hidden =
            revealSpanCount !== undefined && i >= revealSpanCount
          return (
            <span
              key={i}
              style={hidden ? { visibility: 'hidden' } : undefined}
            >
              {i > 0 && ' '}
              <SpanView span={s} style={style} />
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
function OverlayShapeSvg(props: { style: ShapeStyle }): JSX.Element {
  const { style } = props
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
      style={{ display: 'block', overflow: 'visible' }}
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
}): JSX.Element {
  const { clip, playheadMs } = props
  // Phase 3.5 transform — resolved at the playhead so keyframed overlays
  // animate. Identical CSS math to the video layer.
  const t = getTransformAt(clip, playheadMs)
  const cssTransform = `translate(${t.x * 100}%, ${t.y * 100}%) scale(${
    t.scale
  }) rotate(${t.rotation}deg)`
  const { w, h } = getOverlayBaseSize(clip)
  const src = clip.source
  // Un-transformed box: centered, sized by base*Frac of the canvas. The
  // CSS transform (translate/scale/rotate) + opacity apply on top.
  const boxStyle: React.CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
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
            pointerEvents: 'none'
          }}
        />
      )}
      {src.type === 'shape' && <OverlayShapeSvg style={src.style} />}
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
  /** Media id loaded into the blurred-bg element (for src-change detection). */
  const loadedBgId = useRef<string | null>(null)
  /** Per-track currently-loaded media id (for src-change detection). */
  const loadedAudioIds = useRef<Map<string, string>>(new Map())
  /** Per-track playing state (for play/pause sync without redundant calls). */
  const audioPlaying = useRef<Map<string, boolean>>(new Map())
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

  const activeCaptions = useMemo(
    () => captionsAtTime(project, playheadMs),
    [project, playheadMs]
  )

  const activeOverlays = useMemo(
    () => overlaysAtTime(project, playheadMs),
    [project, playheadMs]
  )

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
  useEffect(() => {
    if (swapRaf.current !== null) cancelAnimationFrame(swapRaf.current)
    swapRaf.current = requestAnimationFrame(() => {
      swapRaf.current = null
      const graph = getPreviewAudioGraph()

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
            if (loadedVideoId.current.get(track.id) !== media.id) {
              v.src = toMediaUrl(media.path)
              loadedVideoId.current.set(track.id, media.id)
            }
            if (media.kind !== 'image') {
              const target = clipSourceTimeSec(activeVideo, playheadMs)
              // Skip tiny seeks that browsers can't honor anyway.
              if (Math.abs((v.currentTime || 0) - target) > 0.05) {
                try {
                  v.currentTime = Math.max(0, target)
                } catch {
                  // src may not be ready yet — ignored, will retry next tick.
                }
              }
              const rate = clipPlaybackRate(activeVideo, playheadMs)
              if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate
            }

            // Compute effective video-track gain. Use the GainNode if the
            // graph is ready; otherwise fall back to `el.volume`.
            const trackIsAudible = trackAudible(track, soloMode)
            const gain = clipGain(activeVideo, playheadMs)
            const wantAudible = trackIsAudible && gain > 0
            const effectiveGain = wantAudible ? gain : 0
            if (graph.isReady()) {
              graph.setTrackGain(track.id, effectiveGain, 20)
              // WebAudio path uses unity passthrough on `el.volume` to avoid
              // double-attenuation. But we still mirror track-mute on
              // `el.muted` so legacy DOM-readers (e.g. audio.spec.ts) see
              // the expected muted=true. Setting el.muted=true on a wrapped
              // element silences both layers consistently.
              const wantElMuted = !trackIsAudible
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
      {
        const bg = bgVideoEl.current
        if (bg) {
          if (bottomLayer) {
            const media = project.media[bottomLayer.clip.mediaId]
            if (media && media.kind !== 'audio') {
              if (loadedBgId.current !== media.id) {
                bg.src = toMediaUrl(media.path)
                bg.muted = true
                loadedBgId.current = media.id
              }
              if (media.kind !== 'image') {
                const target = clipSourceTimeSec(bottomLayer.clip, playheadMs)
                if (Math.abs((bg.currentTime || 0) - target) > 0.05) {
                  try {
                    bg.currentTime = Math.max(0, target)
                  } catch {
                    // ignore
                  }
                }
                const rate = clipPlaybackRate(bottomLayer.clip, playheadMs)
                if (Math.abs(bg.playbackRate - rate) > 0.001) {
                  bg.playbackRate = rate
                }
              }
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
            if (loadedAudioIds.current.get(track.id) !== media.id) {
              a.src = toMediaUrl(media.path)
              loadedAudioIds.current.set(track.id, media.id)
            }
            const target = clipSourceTimeSec(clip, playheadMs)
            if (Math.abs((a.currentTime || 0) - target) > 0.05) {
              try {
                a.currentTime = Math.max(0, target)
              } catch {
                // src may not be ready yet — ignored.
              }
            }
            const rate = clipPlaybackRate(clip, playheadMs)
            if (Math.abs(a.playbackRate - rate) > 0.001) a.playbackRate = rate
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
    })
    return () => {
      if (swapRaf.current !== null) {
        cancelAnimationFrame(swapRaf.current)
        swapRaf.current = null
      }
    }
  }, [
    project,
    playheadMs,
    videoTracks,
    layerByTrackId,
    bottomLayer,
    audioTracks,
    hitByTrackId,
    voiceOn,
    soloMode
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
  }, [playing, audioTracks, videoTracks])

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
        style={fittedStyle}
        data-testid="preview-fitted-rect"
        data-fitted-width={fitted.width}
        data-fitted-height={fitted.height}
      >
        {/* Blurred background <video> — fills (object-fit: cover), heavy blur
            + dimmed brightness so the aspect-mismatched gutters get the
            iconic "vertical TikTok" look instead of black bars. z-index: 0.
            Phase 3.6 — the blurred bg intentionally does NOT reflect a clip's
            cropRect (it samples the full frame); the export DOES crop the bg. */}
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
          const cssTransform = t
            ? `translate(${t.x * 100}%, ${t.y * 100}%) scale(${t.scale}) rotate(${t.rotation}deg)`
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
          const combinedFilter = clip
            ? [
                filterPresetToCss(clip.filterPreset, clip.filterIntensity ?? 1),
                colorAdjustToCss(getClipColorAdjust(clip))
              ]
                .filter((s) => s.length > 0)
                .join(' ') || 'none'
            : 'none'
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
              playsInline
              muted={false}
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
          if (!cr) return videoEl
          // Cropped path: wrap the <video> in an overflow:hidden div. The
          // wrapper carries the layer zIndex + the CSS transform/opacity; the
          // inner <video> (unchanged ref + data-* attrs — the WebAudio graph
          // wraps the element, not the div) is sized/translated above so only
          // the crop sub-rect is visible. Outermost node keyed with track.id
          // so React reconciliation stays stable across crop on/off toggles.
          return (
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
            </div>
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
            <OverlayElement key={o.id} clip={o} playheadMs={playheadMs} />
          ))}
        </div>

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
              fittedHeight={fitted.height}
              playheadMs={playheadMs}
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

// Re-export helper for tests (Editor / Timeline parity).
export type { Clip }
