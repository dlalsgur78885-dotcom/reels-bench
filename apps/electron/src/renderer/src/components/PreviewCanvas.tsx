import { useEffect, useRef } from 'react'
import type { Clip, Project } from '../../../shared/project'
import { useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import { toMediaUrl } from '../lib/mediaUrl'

interface ActiveClips {
  videoClip: Clip | null
  audioClip: Clip | null // audio-only clips on audio tracks
}

function clipsAt(project: Project, ms: number): ActiveClips {
  let videoClip: Clip | null = null
  let audioClip: Clip | null = null
  for (const t of project.tracks) {
    if (t.kind === 'video') {
      for (const c of t.clips) {
        if (ms >= c.startMs && ms < c.endMs) {
          // Take the first (top-most) match.
          if (!videoClip) videoClip = c
        }
      }
    } else if (t.kind === 'audio') {
      for (const c of t.clips) {
        if (ms >= c.startMs && ms < c.endMs) {
          if (!audioClip) audioClip = c
        }
      }
    }
  }
  return { videoClip, audioClip }
}

const styles = {
  area: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0a0a0a',
    padding: 24,
    overflow: 'hidden',
    height: '100%'
  } as React.CSSProperties,
  letterbox: {
    position: 'relative',
    background: '#000',
    border: '1px solid #1f2937',
    borderRadius: 8,
    overflow: 'hidden',
    maxHeight: '100%',
    maxWidth: '100%',
    boxSizing: 'border-box'
  } as React.CSSProperties,
  video: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
    background: '#000'
  } as React.CSSProperties,
  placeholder: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#475569',
    fontSize: 12,
    pointerEvents: 'none'
  } as React.CSSProperties
}

export function PreviewCanvas(): JSX.Element {
  const project = useProjectStore((s) => s.project)
  const playheadMs = useTimelineUi((s) => s.playheadMs)
  const playing = useTimelineUi((s) => s.playing)

  // Derived: is there a video-track clip at the current playhead?
  const hasVideoClipAtPlayhead = (() => {
    for (const t of project.tracks) {
      if (t.kind !== 'video') continue
      for (const c of t.clips) {
        if (playheadMs >= c.startMs && playheadMs < c.endMs) return true
      }
    }
    return false
  })()

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** mediaId currently loaded into <video>. */
  const loadedVideoMediaId = useRef<string | null>(null)
  const loadedAudioMediaId = useRef<string | null>(null)
  /** rAF id for src-swap throttling. */
  const swapRaf = useRef<number | null>(null)

  // ---------------------------------------------------------------------
  // Sync <video>/<audio> to playhead.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (swapRaf.current !== null) cancelAnimationFrame(swapRaf.current)
    swapRaf.current = requestAnimationFrame(() => {
      swapRaf.current = null
      const { videoClip, audioClip } = clipsAt(project, playheadMs)
      const videoEl = videoRef.current
      const audioEl = audioRef.current

      // VIDEO TRACK ------------------------------------------------------
      if (videoEl) {
        if (videoClip) {
          const media = project.media[videoClip.mediaId]
          if (media && media.kind !== 'audio') {
            const desiredUrl = toMediaUrl(media.path)
            if (loadedVideoMediaId.current !== media.id) {
              videoEl.src = desiredUrl
              loadedVideoMediaId.current = media.id
            }
            const localMs =
              playheadMs - videoClip.startMs + videoClip.trimInMs
            const target = Math.max(0, localMs) / 1000
            // Image clips don't need currentTime set.
            if (media.kind !== 'image') {
              if (Math.abs((videoEl.currentTime || 0) - target) > 0.05) {
                try {
                  videoEl.currentTime = target
                } catch {
                  // Ignore: src may not be ready yet.
                }
              }
            }
          } else {
            if (loadedVideoMediaId.current !== null) {
              videoEl.removeAttribute('src')
              videoEl.load()
              loadedVideoMediaId.current = null
            }
          }
        } else {
          if (loadedVideoMediaId.current !== null) {
            videoEl.pause()
            videoEl.removeAttribute('src')
            videoEl.load()
            loadedVideoMediaId.current = null
          }
        }
      }

      // AUDIO-ONLY TRACK -------------------------------------------------
      if (audioEl) {
        if (audioClip) {
          const media = project.media[audioClip.mediaId]
          if (media && media.kind === 'audio') {
            if (loadedAudioMediaId.current !== media.id) {
              audioEl.src = toMediaUrl(media.path)
              loadedAudioMediaId.current = media.id
            }
            const localMs =
              playheadMs - audioClip.startMs + audioClip.trimInMs
            const target = Math.max(0, localMs) / 1000
            if (Math.abs((audioEl.currentTime || 0) - target) > 0.05) {
              try {
                audioEl.currentTime = target
              } catch {
                // ignore
              }
            }
          }
        } else if (loadedAudioMediaId.current !== null) {
          audioEl.pause()
          audioEl.removeAttribute('src')
          audioEl.load()
          loadedAudioMediaId.current = null
        }
      }
    })
    return () => {
      if (swapRaf.current !== null) {
        cancelAnimationFrame(swapRaf.current)
        swapRaf.current = null
      }
    }
  }, [project, playheadMs])

  // ---------------------------------------------------------------------
  // Play/pause sync.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const v = videoRef.current
    const a = audioRef.current
    if (playing) {
      if (v && loadedVideoMediaId.current) {
        v.play().catch(() => {
          /* ignore autoplay rejection — silent */
        })
      }
      if (a && loadedAudioMediaId.current) {
        a.play().catch(() => {
          /* ignore */
        })
      }
    } else {
      v?.pause()
      a?.pause()
    }
  }, [playing])

  // Letterbox container sized to project aspect ratio.
  const letterboxStyle: React.CSSProperties = {
    ...styles.letterbox,
    aspectRatio: `${project.width} / ${project.height}`,
    width: 'auto',
    height: 'auto',
    maxWidth: '95%',
    maxHeight: '95%'
  }

  return (
    <div style={styles.area} data-testid="preview-area">
      <div style={letterboxStyle} data-testid="preview-letterbox">
        <video
          ref={videoRef}
          style={styles.video}
          data-testid="preview-video"
          playsInline
          muted={false}
        />
        <audio ref={audioRef} data-testid="preview-audio" />
        {!hasVideoClipAtPlayhead && (
          <div style={styles.placeholder}>재생 헤드 위치에 클립이 없습니다</div>
        )}
      </div>
    </div>
  )
}
