import { useEffect, useMemo, useRef, useState } from 'react'
import {
  isCaptionClip,
  isMediaClip,
  type CaptionClip,
  type CaptionSpan,
  type CaptionStyle,
  type Clip,
  type Project,
  type Track,
  type VideoAudioClip
} from '../../../shared/project'
import { useTimelineUi } from '../store/timelineUi'
import { toMediaUrl } from '../lib/mediaUrl'

// ---------------------------------------------------------------------------
// Source-time mapping (Phase 2.3 speed-aware).
//
// timelineMs → source media currentTime, factoring playback speed and the
// clip's trim window.
//
//   currentTime = ((timelineMs - clip.startMs) * speed + clip.trimInMs) / 1000
//   playbackRate = speed
// ---------------------------------------------------------------------------
export function clipSourceTimeSec(clip: VideoAudioClip, timelineMs: number): number {
  const speed = clip.speed ?? 1
  const offsetMs = (timelineMs - clip.startMs) * speed
  return (offsetMs + clip.trimInMs) / 1000
}

export function clipPlaybackRate(clip: VideoAudioClip): number {
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
function videoClipAt(
  project: Project,
  ms: number
): { clip: VideoAudioClip; track: Track } | null {
  for (const t of project.tracks) {
    if (t.kind !== 'video') continue
    for (const c of t.clips) {
      if (isMediaClip(c) && ms >= c.startMs && ms < c.endMs)
        return { clip: c, track: t }
    }
  }
  return null
}

function audioClipAt(
  project: Project,
  ms: number
): { clip: VideoAudioClip; track: Track } | null {
  for (const t of project.tracks) {
    if (t.kind !== 'audio') continue
    for (const c of t.clips) {
      if (isMediaClip(c) && ms >= c.startMs && ms < c.endMs)
        return { clip: c, track: t }
    }
  }
  return null
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

function CaptionOverlay(props: {
  caption: CaptionClip
  fittedHeight: number
}): JSX.Element {
  const { caption, fittedHeight } = props
  const { style } = caption
  const REF_HEIGHT = 1920
  const scaledFontSize =
    fittedHeight > 0
      ? Math.max(12, (style.fontSize * fittedHeight) / REF_HEIGHT)
      : style.fontSize
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
// Main PreviewCanvas — wires real <video> + <audio> elements to the playhead.
// ---------------------------------------------------------------------------
export function PreviewCanvas(props: PreviewCanvasProps): JSX.Element {
  const { project, playheadMs } = props
  const playing = useTimelineUi((s) => s.playing)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasAspect = project.width / Math.max(1, project.height)
  const fitted = useFittedRect(containerRef, canvasAspect)

  const videoEl = useRef<HTMLVideoElement | null>(null)
  const audioEl = useRef<HTMLAudioElement | null>(null)
  const loadedVideoId = useRef<string | null>(null)
  const loadedAudioId = useRef<string | null>(null)
  const swapRaf = useRef<number | null>(null)

  const activeVideoHit = useMemo(
    () => videoClipAt(project, playheadMs),
    [project, playheadMs]
  )
  const activeAudioHit = useMemo(
    () => audioClipAt(project, playheadMs),
    [project, playheadMs]
  )
  const activeVideo = activeVideoHit?.clip ?? null
  const activeAudio = activeAudioHit?.clip ?? null
  const activeVideoTrack = activeVideoHit?.track
  const activeAudioTrack = activeAudioHit?.track

  const soloMode = useMemo(() => anyTrackSoloed(project), [project])
  const videoAudible = trackAudible(activeVideoTrack, soloMode)
  const audioAudible = trackAudible(activeAudioTrack, soloMode)
  const voiceOn = useMemo(
    () => voiceActiveAt(project, playheadMs),
    [project, playheadMs]
  )

  const activeCaptions = useMemo(
    () => captionsAtTime(project, playheadMs),
    [project, playheadMs]
  )

  // -----------------------------------------------------------------------
  // Sync <video> / <audio> src + currentTime + playbackRate to the playhead.
  // Throttled via a single rAF batch so scrubbing doesn't thrash the elements.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (swapRaf.current !== null) cancelAnimationFrame(swapRaf.current)
    swapRaf.current = requestAnimationFrame(() => {
      swapRaf.current = null
      // ----- VIDEO TRACK -----
      const v = videoEl.current
      if (v) {
        if (activeVideo) {
          const media = project.media[activeVideo.mediaId]
          if (media && media.kind !== 'audio') {
            if (loadedVideoId.current !== media.id) {
              v.src = toMediaUrl(media.path)
              loadedVideoId.current = media.id
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
              const rate = clipPlaybackRate(activeVideo)
              if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate
            }
            // Phase 2.5 audio shaping on the <video> element (video tracks
            // carry audio too — e.g. a clip with embedded VO).
            const gain = clipGain(activeVideo, playheadMs)
            const wantMuted = !videoAudible || gain === 0
            if (v.muted !== wantMuted) v.muted = wantMuted
            const targetVol = Math.max(0, Math.min(1, gain))
            if (Math.abs(v.volume - targetVol) > 0.005) v.volume = targetVol
          } else if (loadedVideoId.current !== null) {
            v.removeAttribute('src')
            v.load()
            loadedVideoId.current = null
          }
        } else if (loadedVideoId.current !== null) {
          v.pause()
          v.removeAttribute('src')
          v.load()
          loadedVideoId.current = null
        }
      }
      // ----- AUDIO-ONLY TRACK -----
      const a = audioEl.current
      if (a) {
        if (activeAudio) {
          const media = project.media[activeAudio.mediaId]
          if (media && media.kind === 'audio') {
            if (loadedAudioId.current !== media.id) {
              a.src = toMediaUrl(media.path)
              loadedAudioId.current = media.id
            }
            const target = clipSourceTimeSec(activeAudio, playheadMs)
            if (Math.abs((a.currentTime || 0) - target) > 0.05) {
              try {
                a.currentTime = Math.max(0, target)
              } catch {
                // ignore
              }
            }
            const rate = clipPlaybackRate(activeAudio)
            if (Math.abs(a.playbackRate - rate) > 0.001) a.playbackRate = rate
            // Mute / volume / ducking. Ducking is applied to BGM-role tracks
            // when any voice-role track is currently audible.
            let target_vol = clipGain(activeAudio, playheadMs)
            if (
              activeAudioTrack?.role === 'bgm' &&
              activeAudioTrack.duckTarget === 'voice' &&
              voiceOn
            ) {
              const duckDb = activeAudioTrack.duckingDb ?? -12
              target_vol = target_vol * Math.pow(10, duckDb / 20)
            }
            const wantMuted = !audioAudible || target_vol === 0
            if (a.muted !== wantMuted) a.muted = wantMuted
            // Smooth a touch — the rAF tick lands ~16ms, so even a direct
            // assignment here is effectively a fast linear ramp.
            const clamped = Math.max(0, Math.min(1, target_vol))
            if (Math.abs(a.volume - clamped) > 0.005) a.volume = clamped
          }
        } else if (loadedAudioId.current !== null) {
          a.pause()
          a.removeAttribute('src')
          a.load()
          loadedAudioId.current = null
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
    activeVideo,
    activeAudio,
    activeAudioTrack,
    videoAudible,
    audioAudible,
    voiceOn
  ])

  // -----------------------------------------------------------------------
  // Play / pause sync with transport state.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const v = videoEl.current
    const a = audioEl.current
    if (playing) {
      if (v && loadedVideoId.current) {
        v.play().catch(() => {
          /* autoplay rejection / src not ready — silently ignored */
        })
      }
      if (a && loadedAudioId.current) {
        a.play().catch(() => {
          /* ignore */
        })
      }
    } else {
      v?.pause()
      a?.pause()
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
        {/* <video> for the active video-track media. object-fit: contain
            preserves the source aspect ratio inside the letterbox. z-index:1
            so the caption overlay sits on top. */}
        <video
          ref={videoEl}
          data-testid="preview-video"
          data-track-audible={videoAudible ? 'true' : 'false'}
          playsInline
          muted={false}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            background: '#000',
            zIndex: 1
          }}
        />
        {/* <audio> for audio-only tracks (BGM / VO). No visual surface. */}
        <audio
          ref={audioEl}
          data-testid="preview-audio"
          data-track-audible={audioAudible ? 'true' : 'false'}
          data-ducking={
            activeAudioTrack?.role === 'bgm' &&
            activeAudioTrack.duckTarget === 'voice' &&
            voiceOn
              ? 'true'
              : 'false'
          }
        />

        {/* Placeholder when no video clip is at the playhead. */}
        {!activeVideo && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#1f2937',
              fontSize: 11,
              zIndex: 2
            }}
            data-testid="preview-placeholder-empty"
          >
            재생 헤드 위치에 클립이 없습니다
          </div>
        )}

        {/* Caption overlay — sits above video (z-index higher than the video). */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 3
          }}
          data-testid="caption-overlay-layer"
        >
          {activeCaptions.map((c) => (
            <CaptionOverlay key={c.id} caption={c} fittedHeight={fitted.height} />
          ))}
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
