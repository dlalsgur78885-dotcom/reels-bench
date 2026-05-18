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

export interface Track {
  id: string
  kind: TrackKind
  name: string
  clips: Clip[]
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
