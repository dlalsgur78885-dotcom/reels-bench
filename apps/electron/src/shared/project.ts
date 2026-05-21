// Project / media / clip / track types — shared between main, preload, renderer.
// Pure data; no runtime imports allowed here.

export type MediaKind = 'video' | 'audio' | 'image'

export interface MediaAsset {
  /** Stable id (ulid). */
  id: string
  /** Absolute local path on disk. */
  path: string
  kind: MediaKind
  /** 0 for images. */
  durationMs: number
  width: number
  height: number
  codec?: string
  /** Absolute local path to the generated thumbnail (JPG). */
  thumbnailPath?: string
  /** Absolute local path to the generated waveform PNG (audio only, Phase 2.5). */
  waveformPath?: string
  importedAt: number
  fileName: string
  fileSizeBytes: number
}

export type TrackKind = 'video' | 'audio' | 'caption'

// ---------------------------------------------------------------------------
// Clips: discriminated union between media-backed clips and caption clips.
// ---------------------------------------------------------------------------

/**
 * Media-backed clip (video / audio / image). Phase 2.1~2.3 fields live here.
 * Discriminator: `kind === 'media'`.
 */
// -----------------------------------------------------------------------------
// Phase 2.6 — transitions + filter presets.
// -----------------------------------------------------------------------------
export type TransitionKind =
  | 'none'
  | 'crossfade'
  | 'slide-left'
  | 'slide-right'
  | 'fade-to-black'
  | 'zoom-in'
  | 'glitch'

export interface ClipTransition {
  kind: TransitionKind
  /** Overlap window in ms. Default 500. Must be < both adjacent clips' durations. */
  durationMs: number
}

// -----------------------------------------------------------------------------
// Phase 3 — static per-clip transform. Canvas-relative.
//   - x/y: translation as a FRACTION of canvas width/height; origin = canvas
//     center; +x = right, +y = down.
//   - scale: multiplier on the clip's aspect-fit ("contain") size. 1 = identity.
//   - rotation: degrees clockwise about the clip's own center.
//   - opacity: 0..1.
// Absent / partially-absent transform = identity (full backwards-compat).
// -----------------------------------------------------------------------------
export interface ClipTransform {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
}

export type FilterPreset =
  | 'none'
  | 'cinematic'
  | 'vibrant'
  | 'bw'
  | 'vintage'
  | 'cool'
  | 'warm'
  | 'golden-hour'

export interface VideoAudioClip {
  id: string
  kind: 'media'
  /** References MediaAsset.id. */
  mediaId: string
  trackId: string
  /** Position on timeline (inclusive). */
  startMs: number
  /** Position on timeline (exclusive). */
  endMs: number
  /** Offset into the source media start. */
  trimInMs: number
  /** Offset into the source media end. */
  trimOutMs: number
  /** Playback speed multiplier (1.0 = normal). */
  speed?: number
  // -----------------------------------------------------------------
  // Phase 2.5 — audio shaping (optional, backwards-compatible).
  // -----------------------------------------------------------------
  /** Gain in decibels, clamped to [MIN_GAIN_DB, MAX_GAIN_DB]. Default 0. */
  gainDb?: number
  /** Linear fade-in in ms from clip start. Default 0. */
  fadeInMs?: number
  /** Linear fade-out in ms before clip end. Default 0. */
  fadeOutMs?: number
  /** Per-clip mute (overrides gain). Default false. */
  isMuted?: boolean
  // -----------------------------------------------------------------
  // Phase 2.6 — transitions + filter presets (optional, backwards-compatible).
  // -----------------------------------------------------------------
  /**
   * Transition INTO this clip from the previous clip on the same track.
   * Modeled on the incoming (right-hand) clip; outgoing tail plays normally.
   * Default kind: 'none' (no transition).
   */
  transitionIn?: ClipTransition
  /** 1-click LUT/filter preset applied at export. Preview uses CSS approximation. */
  filterPreset?: FilterPreset
  /** 0..1 intensity for the filter. Default 1 (full). */
  filterIntensity?: number
  // -----------------------------------------------------------------
  // Phase 3 — static transform + layer compositing (optional, BC-safe).
  // -----------------------------------------------------------------
  /** Static canvas-relative transform. Absent = identity (centered, 1x, 0°, opaque). */
  transform?: ClipTransform
}

/** Visual preset for a caption block. */
export type CaptionPreset =
  | 'bottom-center'
  | 'neon'
  | 'block-bold'
  | 'minimal-white'
  | 'youtube-yellow'
  | 'tiktok-rounded'
  | 'gradient'

/** Caption alignment within the overlay box. */
export type CaptionAlign = 'left' | 'center' | 'right'

/** Background treatment for the caption overlay. */
export type CaptionBackground = 'none' | 'solid' | 'pill' | 'highlight'

export interface CaptionStyle {
  preset: CaptionPreset
  /** Base font size in px (relative to canvas height — overlay scales). */
  fontSize: number
  align: CaptionAlign
  /** 0..1, fraction of canvas height (0 = top, 1 = bottom anchor). */
  yPosition: number
  background: CaptionBackground
}

/** Per-word optional emphasis. */
export type CaptionEmphasis = 'bold' | 'highlight' | 'pulse'

export interface CaptionSpan {
  text: string
  emphasis?: CaptionEmphasis
  /** Hex color (#rrggbb). */
  color?: string
}

/**
 * Caption clip — lives on a `caption` track. No media reference, no trim
 * window, no playback speed. Discriminator: `kind === 'caption'`.
 */
export interface CaptionClip {
  id: string
  kind: 'caption'
  trackId: string
  startMs: number
  endMs: number
  /** Ordered spans; joined with a single space when rendering. */
  spans: CaptionSpan[]
  style: CaptionStyle
}

/** Union: every clip on a track. Use `clip.kind` to narrow safely. */
export type Clip = VideoAudioClip | CaptionClip

/** Semantic role for an audio track (Phase 2.5, used by ducking). */
export type TrackRole = 'voice' | 'bgm' | 'sfx' | null

export interface Track {
  id: string
  kind: TrackKind
  name: string
  clips: Clip[]
  // -----------------------------------------------------------------
  // Phase 2.5 — track-level audio controls.
  // -----------------------------------------------------------------
  /** Track-wide mute. Default false. */
  muted?: boolean
  /** Solo flag — when any track has solo=true, non-soloed tracks mute. */
  solo?: boolean
  /** Semantic role for ducking and routing. */
  role?: TrackRole
  /** Duck target ('voice'|'bgm'|null). A BGM track's duckTarget='voice'
   *  attenuates whenever any voice clip is audible. */
  duckTarget?: 'voice' | 'bgm' | null
  /** Ducking attenuation in dB applied while target is active. Default -12. */
  duckingDb?: number
}

export type AspectRatio = '9:16' | '1:1' | '16:9' | '4:5'

export interface Project {
  id: string
  name: string
  aspectRatio: AspectRatio
  /** Canvas width (pixels). */
  width: number
  /** Canvas height (pixels). */
  height: number
  fps: number
  tracks: Track[]
  /** Keyed by MediaAsset.id. */
  media: Record<string, MediaAsset>
  createdAt: number
  updatedAt: number
}

export const ASPECT_RATIO_DIMENSIONS: Record<
  AspectRatio,
  { width: number; height: number }
> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
  '4:5': { width: 1080, height: 1350 }
}

// ---------------------------------------------------------------------------
// Editing constants (Phase 2.3).
// ---------------------------------------------------------------------------

/** Default playback speed for a freshly added media clip. */
export const DEFAULT_CLIP_SPEED = 1.0
/** Minimum allowed playback speed (slowest). */
export const MIN_CLIP_SPEED = 0.1
/** Maximum allowed playback speed (fastest). */
export const MAX_CLIP_SPEED = 10.0
/** Minimum on-timeline clip width (ms). Prevents zero/negative widths. */
export const MIN_CLIP_MS = 100

// ---------------------------------------------------------------------------
// Audio constants (Phase 2.5).
// ---------------------------------------------------------------------------
/** Minimum allowed clip gain (dB). */
export const MIN_GAIN_DB = -60
/** Maximum allowed clip gain (dB). */
export const MAX_GAIN_DB = 12
/** Default ducking attenuation for a BGM track when a voice clip plays. */
export const DEFAULT_DUCKING_DB = -12

// ---------------------------------------------------------------------------
// Transition / filter constants (Phase 2.6).
// ---------------------------------------------------------------------------
export const DEFAULT_TRANSITION_MS = 500
export const MIN_TRANSITION_MS = 100
export const MAX_TRANSITION_MS = 3000
export const TRANSITION_KINDS: readonly TransitionKind[] = [
  'none',
  'crossfade',
  'slide-left',
  'slide-right',
  'fade-to-black',
  'zoom-in',
  'glitch'
]
export const FILTER_PRESETS: readonly FilterPreset[] = [
  'none',
  'cinematic',
  'vibrant',
  'bw',
  'vintage',
  'cool',
  'warm',
  'golden-hour'
]

// ---------------------------------------------------------------------------
// Transform / layer-compositing constants (Phase 3).
// ---------------------------------------------------------------------------
export const IDENTITY_TRANSFORM: ClipTransform = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1
}
export const MIN_TRANSFORM_SCALE = 0.05
export const MAX_TRANSFORM_SCALE = 8
export const MIN_TRANSFORM_ROTATION = -180
export const MAX_TRANSFORM_ROTATION = 180
/** x/y are unbounded in principle, but UI/clamp keeps them sane. */
export const MIN_TRANSFORM_OFFSET = -2
export const MAX_TRANSFORM_OFFSET = 2
/** Hard cap on the number of video tracks (layer count). */
export const MAX_VIDEO_TRACKS = 6

export interface ProbeResult {
  durationMs: number
  width: number
  height: number
  codec?: string
  kind: MediaKind
}

export interface ThumbnailResult {
  /** Absolute path of the generated thumbnail. */
  path: string
  /** data: URI for direct <img src=...> use (renderer CSP-safe). */
  dataUri: string
}

export interface ThumbnailOptions {
  /** Frame timestamp in ms. Default 0. */
  atMs?: number
  /** Override output path. Default = userData/thumbnails/<mediaId>.jpg. */
  outPath?: string
  /** Required when caller wants the default path computed for them. */
  mediaId?: string
}

// ---------------------------------------------------------------------------
// Shared clip helpers (pure, importable from any layer).
// ---------------------------------------------------------------------------

/** Duration of a clip on the timeline (endMs - startMs). */
export function getClipDuration(clip: Clip): number {
  return Math.max(0, clip.endMs - clip.startMs)
}

/**
 * Plain-text content of a clip for display / preview / search.
 * - media clips → empty string (caller should look up media.fileName)
 * - caption clips → spans joined with single space
 */
export function getClipSourceText(clip: Clip): string {
  if (clip.kind === 'caption') {
    return clip.spans.map((s) => s.text).join(' ').trim()
  }
  return ''
}

/** Type-narrowed predicate: is this clip a media-backed (video/audio) clip? */
export function isMediaClip(clip: Clip): clip is VideoAudioClip {
  return clip.kind === 'media'
}

/** Type-narrowed predicate: is this clip a caption clip? */
export function isCaptionClip(clip: Clip): clip is CaptionClip {
  return clip.kind === 'caption'
}

// ---------------------------------------------------------------------------
// Transform helpers (Phase 3) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/** Resolve a clip's effective transform, filling identity for any missing field. */
export function getClipTransform(clip: VideoAudioClip): ClipTransform {
  const t = clip.transform
  if (!t) return { ...IDENTITY_TRANSFORM }
  return {
    x: Number.isFinite(t.x) ? t.x : 0,
    y: Number.isFinite(t.y) ? t.y : 0,
    scale: Number.isFinite(t.scale) ? t.scale : 1,
    rotation: Number.isFinite(t.rotation) ? t.rotation : 0,
    opacity: Number.isFinite(t.opacity) ? t.opacity : 1
  }
}

/** True iff the transform is meaningfully non-identity (callers can skip work when false). */
export function isIdentityTransform(t: ClipTransform): boolean {
  return (
    t.x === 0 &&
    t.y === 0 &&
    t.scale === 1 &&
    t.rotation === 0 &&
    t.opacity === 1
  )
}
