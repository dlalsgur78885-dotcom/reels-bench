import { useEffect, useMemo, useRef, useState } from 'react'
import {
  isCaptionClip,
  type CaptionClip,
  type CaptionSpan,
  type CaptionStyle,
  type Project
} from '../../../shared/project'

interface PreviewCanvasProps {
  project: Project
  /** Playhead position (ms). Captions visible when startMs <= playheadMs < endMs. */
  playheadMs: number
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

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

// Per-preset CSS tweaks applied on top of the base CaptionStyle settings.
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
        // gradient text fill via background-clip
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
      // Highlight is applied per-span (yellow marker behind each word).
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
  // Caption block is absolutely positioned. Horizontal anchor + translate.
  if (a === 'left') return { left: '5%', transform: 'translateX(0)' }
  if (a === 'right') return { right: '5%', transform: 'translateX(0)' }
  return { left: '50%', transform: 'translateX(-50%)' }
}

// Compute the on-screen letterboxed video rect inside the preview area.
// The video's intrinsic aspect ratio determines the inset; caption overlay
// must match exactly so position percentages reflect the visible canvas.
function useFittedRect(
  containerRef: React.RefObject<HTMLDivElement>,
  canvasAspect: number
): { width: number; height: number; top: number; left: number } {
  // Initial guess: 0 — replaced as soon as layout runs.
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
    // Force a second measurement on next frame in case layout was 0 initially.
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

// ---------------------------------------------------------------------------
// Renderable span.
// ---------------------------------------------------------------------------
function SpanView(props: {
  span: CaptionSpan
  style: CaptionStyle
}): JSX.Element {
  const { span, style } = props
  const isHighlightBg = style.background === 'highlight'

  const css: React.CSSProperties = {}

  if (span.emphasis === 'bold') {
    css.fontWeight = 800
  } else if (span.emphasis === 'highlight') {
    css.background = '#ffd400'
    css.color = '#1a1a1a'
    css.padding = '0 0.2em'
    css.borderRadius = 3
  } else if (span.emphasis === 'pulse') {
    css.animation = 'reels-pulse 0.85s ease-in-out infinite'
    css.display = 'inline-block'
  }

  if (isHighlightBg && span.emphasis !== 'highlight') {
    // TikTok-style yellow per-word marker; applied for highlight bg mode.
    css.background = 'rgba(255, 212, 0, 0.85)'
    css.color = '#111'
    css.padding = '0 0.2em'
    css.borderRadius = 3
  }

  if (span.color) {
    css.color = span.color
  }

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
// CaptionOverlay — absolutely positioned within the letterboxed video rect.
// ---------------------------------------------------------------------------
function CaptionOverlay(props: {
  caption: CaptionClip
  fittedHeight: number
}): JSX.Element {
  const { caption, fittedHeight } = props
  const { style } = caption

  // Font size: spec says "px relative to canvas height". Treat the preset
  // value as the size for a 1920-tall canvas; scale linearly for our rect.
  const REF_HEIGHT = 1920
  const scaledFontSize =
    fittedHeight > 0
      ? Math.max(12, (style.fontSize * fittedHeight) / REF_HEIGHT)
      : style.fontSize

  // yPosition: 0 = top, 1 = bottom. We anchor caption block by its bottom edge
  // for a stable "lower-third" feel. So bottom = (1 - yPosition) * 100%.
  const bottomPct = (1 - style.yPosition) * 100

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

  return (
    <div
      data-testid="caption-overlay"
      data-caption-id={caption.id}
      data-preset={style.preset}
      data-background={style.background}
      style={containerStyle}
    >
      <div style={{ display: 'inline' }}>
        {caption.spans.map((s, i) => (
          <span key={i}>
            {i > 0 && ' '}
            <SpanView span={s} style={style} />
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main PreviewCanvas component.
// ---------------------------------------------------------------------------
export function PreviewCanvas(props: PreviewCanvasProps): JSX.Element {
  const { project, playheadMs } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasAspect = project.width / Math.max(1, project.height)
  const fitted = useFittedRect(containerRef, canvasAspect)

  const activeCaptions = useMemo(
    () => captionsAtTime(project, playheadMs),
    [project, playheadMs]
  )

  // If the fitted rect hasn't computed yet, fall back to filling the container
  // so the caption overlay still has measurable size on first render.
  const hasFit = fitted.width > 0 && fitted.height > 0
  const fittedStyle: React.CSSProperties = hasFit
    ? {
        position: 'absolute',
        width: fitted.width,
        height: fitted.height,
        top: fitted.top,
        left: fitted.left,
        background: '#000',
        border: '1px solid #1a1a1a'
      }
    : {
        position: 'absolute',
        inset: 0,
        background: '#000',
        border: '1px solid #1a1a1a'
      }

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
      {/* The fitted video frame box — for Phase 2.4 we keep this as a stub
          (no real <video> element yet). The caption overlay anchors here. */}
      <div
        style={fittedStyle}
        data-testid="preview-fitted-rect"
        data-fitted-width={fitted.width}
        data-fitted-height={fitted.height}
      >
        {/* Placeholder dim text — real <video> will be wired in later phases. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#1f2937',
            fontSize: 11
          }}
        >
          미리보기 영역
        </div>

        {/* Caption overlay layer — sized to the letterboxed video rect. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none'
          }}
          data-testid="caption-overlay-layer"
        >
          {activeCaptions.map((c) => (
            <CaptionOverlay key={c.id} caption={c} fittedHeight={fitted.height} />
          ))}
        </div>

        {/* Pulse animation keyframes (scoped via global style tag). */}
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
