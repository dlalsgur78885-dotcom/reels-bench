import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { filterPresetToCss } from '../../../shared/filterPresets'
import { useTimelineUi } from '../store/timelineUi'
import { toMediaUrl } from '../lib/mediaUrl'
import {
  dbToLinear,
  getPreviewAudioGraph,
  installAutoResume
} from '../lib/audioGraph'

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
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasAspect = project.width / Math.max(1, project.height)
  const fitted = useFittedRect(containerRef, canvasAspect)

  const videoEl = useRef<HTMLVideoElement | null>(null)
  /**
   * Background video element — same source as foreground, but rendered as
   * a blurred cover behind so non-matching aspect ratios show the iconic
   * "vertical TikTok" blurred gutters instead of black bars.
   */
  const bgVideoEl = useRef<HTMLVideoElement | null>(null)
  /** One <audio> per audio track, indexed by trackId. */
  const audioEls = useRef<Map<string, HTMLAudioElement>>(new Map())
  const loadedVideoId = useRef<string | null>(null)
  /** Per-track currently-loaded media id (for src-change detection). */
  const loadedAudioIds = useRef<Map<string, string>>(new Map())
  /** Per-track playing state (for play/pause sync without redundant calls). */
  const audioPlaying = useRef<Map<string, boolean>>(new Map())
  const swapRaf = useRef<number | null>(null)

  const activeVideoHit = useMemo(
    () => videoClipAt(project, playheadMs),
    [project, playheadMs]
  )
  const audioHits = useMemo(
    () => activeAudioClips(project, playheadMs),
    [project, playheadMs]
  )
  const activeVideo = activeVideoHit?.clip ?? null
  const activeVideoTrack = activeVideoHit?.track

  const soloMode = useMemo(() => anyTrackSoloed(project), [project])
  const videoAudible = trackAudible(activeVideoTrack, soloMode)
  const voiceOn = useMemo(
    () => voiceActiveAt(project, playheadMs),
    [project, playheadMs]
  )

  const activeCaptions = useMemo(
    () => captionsAtTime(project, playheadMs),
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
    // Re-attach video element (it carries audio too — embedded VO etc.).
    if (videoEl.current && activeVideoTrack) {
      graph.attach(videoEl.current, activeVideoTrack.id)
    }
    // Re-attach each <audio> element to its track's GainNode.
    for (const t of audioTracks) {
      const el = audioEls.current.get(t.id)
      if (el) graph.attach(el, t.id)
    }
  }, [audioTracks, activeVideoTrack])

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

      // ----- VIDEO TRACK -----
      const v = videoEl.current
      const bg = bgVideoEl.current
      if (v) {
        if (activeVideo) {
          const media = project.media[activeVideo.mediaId]
          if (media && media.kind !== 'audio') {
            if (loadedVideoId.current !== media.id) {
              v.src = toMediaUrl(media.path)
              if (bg) {
                bg.src = toMediaUrl(media.path)
                bg.muted = true
              }
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
              if (bg && Math.abs((bg.currentTime || 0) - target) > 0.05) {
                try {
                  bg.currentTime = Math.max(0, target)
                } catch {
                  // ignore
                }
              }
              const rate = clipPlaybackRate(activeVideo)
              if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate
              if (bg && Math.abs(bg.playbackRate - rate) > 0.001) bg.playbackRate = rate
            }
            // Route video element audio through the graph (track id = video
            // track id). Idempotent if already attached.
            if (activeVideoTrack) graph.attach(v, activeVideoTrack.id)

            // Compute effective video-track gain. Use the GainNode if the
            // graph is ready; otherwise fall back to `el.volume`.
            const gain = clipGain(activeVideo, playheadMs)
            const wantAudible = videoAudible && gain > 0
            const effectiveGain = wantAudible ? gain : 0
            if (activeVideoTrack && graph.isReady()) {
              graph.setTrackGain(activeVideoTrack.id, effectiveGain, 20)
              // WebAudio path uses unity passthrough on `el.volume` to avoid
              // double-attenuation. But we still mirror track-mute on
              // `el.muted` so legacy DOM-readers (e.g. audio.spec.ts) see
              // the expected muted=true. Setting el.muted=true on a wrapped
              // element silences both layers consistently.
              const wantElMuted = !videoAudible
              if (v.muted !== wantElMuted) v.muted = wantElMuted
              if (Math.abs(v.volume - 1) > 0.005) v.volume = 1
            } else {
              // Fallback path (AudioContext failed): drive el.volume directly.
              if (v.muted !== !wantAudible) v.muted = !wantAudible
              const targetVol = Math.max(0, Math.min(1, gain))
              if (Math.abs(v.volume - targetVol) > 0.005) v.volume = targetVol
            }
          } else if (loadedVideoId.current !== null) {
            v.removeAttribute('src')
            v.load()
            if (bg) {
              bg.removeAttribute('src')
              bg.load()
            }
            loadedVideoId.current = null
          }
        } else if (loadedVideoId.current !== null) {
          v.pause()
          v.removeAttribute('src')
          v.load()
          if (bg) {
            bg.pause()
            bg.removeAttribute('src')
            bg.load()
          }
          loadedVideoId.current = null
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
            const rate = clipPlaybackRate(clip)
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
    activeVideo,
    activeVideoTrack,
    audioTracks,
    hitByTrackId,
    videoAudible,
    voiceOn,
    soloMode
  ])

  // -----------------------------------------------------------------------
  // Play / pause sync with transport state. Each <audio> element + the
  // <video> element are toggled together so all routed sources advance in
  // lockstep with the playhead.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const v = videoEl.current
    const bg = bgVideoEl.current
    if (playing) {
      if (v && loadedVideoId.current) {
        v.play().catch(() => {
          /* autoplay rejection / src not ready — silently ignored */
        })
      }
      if (bg && loadedVideoId.current) {
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
      v?.pause()
      bg?.pause()
      for (const track of audioTracks) {
        const a = audioEls.current.get(track.id)
        a?.pause()
        audioPlaying.current.set(track.id, false)
      }
    }
  }, [playing, audioTracks])

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
            iconic "vertical TikTok" look instead of black bars. z-index: 0. */}
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
        {/* <video> for the active video-track media. object-fit: contain
            preserves the source aspect ratio inside the letterbox. z-index:1
            so the caption overlay sits on top. */}
        <video
          ref={videoEl}
          data-testid="preview-video"
          data-track-audible={videoAudible ? 'true' : 'false'}
          data-filter-preset={activeVideo?.filterPreset ?? 'none'}
          playsInline
          muted={false}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            background: 'transparent',
            zIndex: 1,
            filter: activeVideo
              ? filterPresetToCss(
                  activeVideo.filterPreset,
                  activeVideo.filterIntensity ?? 1
                ) || 'none'
              : 'none'
          }}
        />
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
