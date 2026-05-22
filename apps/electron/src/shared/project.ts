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

export type TrackKind = 'video' | 'audio' | 'caption' | 'overlay'

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

/**
 * One keyframe in a clip's transform animation track (Phase 3.5).
 * `atMs` is RELATIVE to the clip's own start (clip.startMs == atMs 0) — this
 * survives clip moves on the timeline and clip duplication without remapping.
 */
export interface TransformKeyframe {
  /** Offset from clip.startMs, in ms. >= 0. */
  atMs: number
  /** Full transform snapshot at this instant (all 5 fields, no partials). */
  transform: ClipTransform
}

/**
 * One keyframe in a clip's variable-speed curve (Phase 3.10).
 * `atMs` is a SOURCE-consumption offset from `trimInMs` (0 .. trimOutMs-trimInMs)
 * — source-relative, so it is stable under other keyframe edits and under split.
 */
export interface SpeedKeyframe {
  /** Source offset from trimInMs, in ms. 0 .. (trimOutMs - trimInMs). */
  atMs: number
  /** Speed multiplier at this instant. Clamped [MIN_CLIP_SPEED, MAX_CLIP_SPEED]. */
  speed: number
}

/**
 * One freeze-frame insertion on a media clip (Phase 3.16).
 * `sourceMs` is a SOURCE-consumption offset from `trimInMs` (0 .. trimOutMs-
 * trimInMs) — source-relative, the same convention as `SpeedKeyframe.atMs`, so
 * it is stable under split. The frame sampled AT `sourceMs` is HELD for
 * `durationMs` of timeline output; the clip then continues from `sourceMs`. A
 * freeze consumes ~0 source time and produces `durationMs` of timeline time.
 */
export interface FreezeFrame {
  /** Source offset from trimInMs, in ms. 0 .. (trimOutMs - trimInMs). */
  sourceMs: number
  /** Held duration on the timeline, in ms. Clamped [MIN_FREEZE_MS, MAX_FREEZE_MS]. */
  durationMs: number
}

// -----------------------------------------------------------------------------
// Phase 3.17 — text-based editing. A per-clip transcript (word-level STT) plus
// a non-destructive list of removed SOURCE ranges. Deleting transcript words
// appends ranges; the clip's timeline footprint shrinks; export/preview skip
// the deleted source. Reversible — restoring words removes the ranges.
// -----------------------------------------------------------------------------

/**
 * One transcribed word bound to a media clip. Times are ABSOLUTE media source
 * ms (not timeline) — stable under trim / speed / freeze. `id` is a stable id
 * so selections + deletions survive re-render and undo.
 */
export interface TranscriptWord {
  id: string
  text: string
  /** Absolute media source bounds, ms. */
  sourceStartMs: number
  sourceEndMs: number
}

/**
 * A contiguous ABSOLUTE-source-ms range removed from a clip by transcript
 * editing. Non-destructive + reversible. Absent / empty = byte-identical
 * legacy behavior. Resolved defensively by `getClipDeletedRanges`.
 */
export interface DeletedRange {
  sourceStartMs: number
  sourceEndMs: number
}

/**
 * Per-clip transcript — the immutable word-level STT output (`words` ascending
 * by `sourceStartMs`). Absent = not transcribed yet.
 */
export interface ClipTranscript {
  words: TranscriptWord[]
  /** whisper's detected language. */
  language: string
  /** When the transcript was generated (epoch ms). */
  generatedAt: number
}

/**
 * Phase 3.6 — static per-clip SOURCE crop. A rectangle of the clip's SOURCE
 * frame to KEEP; everything outside is discarded. Coordinates are FRACTIONS
 * of source width/height: x/y = top-left (0..1), w/h = size (0..1). Crop
 * changes the source SAMPLING rectangle — it does NOT move the result on the
 * canvas (that is `transform`'s job); the cropped region is re-fit into the
 * canvas slot where the full frame used to sit. Absent = no crop.
 */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Phase 3.7 — static per-clip manual color adjustment. Four normalized signed
 * sliders, range -100..100, 0 = neutral (no-op). STACKS on top of
 * `filterPreset` (preset look applied first, manual adjust second). STATIC
 * ONLY — color-adjust keyframing is out of scope. Absent / partially-absent =
 * neutral; back-filled lazily by `getClipColorAdjust` (null = neutral).
 *   - brightness:  -100 dark        .. +100 bright
 *   - contrast:    -100 flat        .. +100 harsh
 *   - saturation:  -100 grayscale   .. +100 oversaturated
 *   - temperature: -100 cool/blue   .. +100 warm/orange
 */
export interface ColorAdjust {
  brightness: number
  contrast: number
  saturation: number
  temperature: number
}

// -----------------------------------------------------------------------------
// Phase 3.11 — static mosaic / blur regions. Hide faces / logos / sensitive
// info by mosaicking or blurring a sub-rectangle of the FINAL CANVAS.
// -----------------------------------------------------------------------------
/**
 * Region effect kind. 'mosaic'/'blur' obscure the region; 'remove' (Phase 3.14)
 * ERASES it via ffmpeg `delogo` — object removal, filling from the box edges.
 */
export type BlurEffectKind = 'mosaic' | 'blur' | 'remove'
/** Region shape. */
export type BlurRegionShape = 'rectangle' | 'ellipse'

/**
 * One static mosaic/blur region masking a sub-rect of the final canvas.
 * Coordinates are CANVAS-relative fractions: x/y = top-left (0..1), w/h = size
 * (0..1). STATIC ONLY — no keyframes (motion tracking is a separate feature).
 */
export interface BlurRegion {
  /** Stable id (lets the UI select/update/remove one of several). */
  id: string
  shape: BlurRegionShape
  x: number
  y: number
  w: number
  h: number
  effect: BlurEffectKind
  /** Effect strength 0..100 (mosaic block size / blur radius). */
  strength: number
  /**
   * Phase 3.13 — when set, this region FOLLOWS the named motion track on its
   * own clip: its x/y become time-varying. Absent ⇒ static legacy behavior. A
   * dangling id (track since deleted) ⇒ resolver falls back to static.
   */
  motionTrackId?: string
}

// -----------------------------------------------------------------------------
// Phase 3.12 — curves + HSL secondary color grading. STATIC ONLY (no keyframes).
// Both STACK on top of `filterPreset` and `colorAdjust` (preset → colorAdjust →
// curves → HSL). Absent / identity / neutral = no-op → byte-identical export.
// -----------------------------------------------------------------------------

/** One control point on a tone curve. Both coords are 0..1 (input → output). */
export interface CurvePoint {
  x: number
  y: number
}

/** The four independently-editable tone-curve channels. */
export type CurveChannelKey = 'master' | 'red' | 'green' | 'blue'

/**
 * Per-clip tone curves. Four channels, each an ordered list of control points
 * (ascending x, 0..1). Identity channel = the diagonal [{0,0},{1,1}]. Absent /
 * all-identity = no-op. Sanitized lazily by `getClipCurves` (null = identity).
 */
export interface ClipCurves {
  master: CurvePoint[]
  red: CurvePoint[]
  green: CurvePoint[]
  blue: CurvePoint[]
}

/**
 * The 6 hue bands ffmpeg's `huesaturation` filter natively targets. CapCut
 * shows 8 — orange is folded into red/yellow, purple into magenta (documented,
 * intentional v1 scope; matching the export filter's real capability).
 */
export type HslBandKey = 'red' | 'yellow' | 'green' | 'cyan' | 'blue' | 'magenta'

/** Hue / Saturation / Luminance offsets for one HSL band. All 0 = neutral. */
export interface HslBandAdjust {
  /** -100..100. Mapped to ±180° hue rotation on export. */
  hue: number
  /** -100..100. Mapped to ±1.0 saturation on export. */
  saturation: number
  /** -100..100. Mapped to ±1.0 `intensity` (lightness) on export. */
  luminance: number
}

/** Per-clip HSL secondary grading: one HslBandAdjust per band. */
export type ClipHsl = Record<HslBandKey, HslBandAdjust>

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
  /** Playback speed multiplier (1.0 = normal). Constant; superseded by speedKeyframes. */
  speed?: number
  // -----------------------------------------------------------------
  // Phase 3.10 — variable speed curve (optional, BC-safe).
  // -----------------------------------------------------------------
  /**
   * Variable speed curve. With >= 2 entries the clip's speed VARIES
   * (piecewise-linear between keyframes, atMs = source offset from trimInMs);
   * absent / empty / length 1 → falls back to the constant `speed` field.
   */
  speedKeyframes?: SpeedKeyframe[]
  // -----------------------------------------------------------------
  // Phase 3.16 — freeze frames (optional, BC-safe).
  // -----------------------------------------------------------------
  /**
   * Freeze-frame insertions. Each entry holds the source frame at `sourceMs`
   * for `durationMs` of timeline output; the clip's on-timeline footprint grows
   * by Σ durationMs. Composes orthogonally with `speedKeyframes` (freezes add
   * pure timeline holds on top of the speed-remapped duration). Absent / empty
   * = no freezes (byte-identical legacy export + preview). Resolved defensively
   * by `getClipFreezeFrames` ([] when absent). No migration.
   */
  freezeFrames?: FreezeFrame[]
  // -----------------------------------------------------------------
  // Phase 3.17 — text-based editing (optional, BC-safe).
  // -----------------------------------------------------------------
  /**
   * Word-level transcript of this clip's source window (text-based editing).
   * Absent = not transcribed. Words are absolute source-ms. No migration.
   */
  transcript?: ClipTranscript
  /**
   * Source ranges removed by transcript editing. Absent / empty = no deletions
   * → byte-identical export + preview + timeline. Resolved defensively by
   * `getClipDeletedRanges` ([] when absent). No migration.
   */
  deletedRanges?: DeletedRange[]
  /**
   * Phase 3.19 — when true the clip's trimmed source window plays BACKWARDS
   * (역재생). Absent / false = forward (byte-identical export + preview).
   * Reverse does NOT change the clip's timeline duration. Mutually exclusive
   * with a speed curve / freeze frames / transcript deletions (enforced by the
   * store + UI); freely combined with constant `speed` + trim. Resolved by
   * `isClipReversed`. No migration.
   */
  reversed?: boolean
  /**
   * Phase 3.18 — id of the collage / split-screen layout group this clip
   * belongs to. Pure UI metadata: lets the layout picker re-select / re-apply /
   * clear a layout as a unit. Export + preview IGNORE it entirely (the visual
   * is fully expressed by `transform` + `cropRect`). Absent = not in a layout.
   */
  layoutGroupId?: string
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
  /**
   * Phase 4 — background-noise reduction strength, 0..100. 0 / absent = OFF
   * (byte-identical legacy audio graph). Export-only (ffmpeg `afftdn`);
   * resolved defensively by `getClipDenoise` (null when off).
   */
  noiseReduction?: number
  /**
   * Phase 3.21 — retouch / beauty (edge-preserving skin smoothing) strength,
   * 0..100. 0 / absent = OFF (byte-identical legacy video graph). Export-only
   * (ffmpeg `smartblur`, luma-only); resolved defensively by `getClipRetouch`
   * (null when off). STATIC ONLY. Whole-frame smoothing, not face-targeted —
   * keep tasteful.
   */
  retouch?: number
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
  // -----------------------------------------------------------------
  // Phase 3.5 — keyframe animation (optional, BC-safe).
  // -----------------------------------------------------------------
  /**
   * Ordered transform keyframes. With >= 2 entries the clip's transform
   * ANIMATES (getTransformAt interpolates linearly). Absent / empty / length 1
   * → falls back to the static `transform` field (Phase 3 behavior). `atMs` is
   * clip-relative; the store keeps entries sorted ascending and deduped.
   */
  transformKeyframes?: TransformKeyframe[]
  // -----------------------------------------------------------------
  // Phase 3.6 — static SOURCE crop (optional, BC-safe).
  // -----------------------------------------------------------------
  /**
   * Static source-crop rectangle (fractions of source W/H). Absent = no crop
   * (full frame). STATIC ONLY — crop keyframing is out of scope. A missing /
   * malformed rect is back-filled lazily by `getClipCropRect` (null = no crop).
   */
  cropRect?: CropRect
  // -----------------------------------------------------------------
  // Phase 3.7 — static manual color adjustment (optional, BC-safe).
  // -----------------------------------------------------------------
  /**
   * Static manual color-adjust sliders. Absent = neutral (no adjustment).
   * STACKS with `filterPreset`: preset applied first, then this. STATIC ONLY.
   * Back-filled lazily by `getClipColorAdjust` (null = neutral). No migration.
   */
  colorAdjust?: ColorAdjust
  // -----------------------------------------------------------------
  // Phase 3.11 — static mosaic / blur regions (optional, BC-safe).
  // -----------------------------------------------------------------
  /**
   * Static mosaic/blur regions masking sub-rects of the final canvas. Absent /
   * empty = none (byte-identical legacy export + preview). STATIC ONLY.
   * Sanitized lazily by `getClipBlurRegions` ([] when absent). No migration.
   */
  blurRegions?: BlurRegion[]
  // -----------------------------------------------------------------
  // Phase 3.12 — curves + HSL secondary color grading (optional, BC-safe).
  // -----------------------------------------------------------------
  /**
   * Static tone curves (4 channels). Absent / all-identity = no-op
   * (byte-identical legacy export + preview). Resolved by `getClipCurves`
   * (null = identity). No migration.
   */
  curves?: ClipCurves
  /**
   * Static HSL secondary grading (6 hue bands). Absent / all-neutral = no-op
   * (byte-identical legacy export). Resolved by `getClipHsl` (null = neutral).
   * Export-only when ffmpeg lacks `huesaturation` (probe-gated). No migration.
   */
  hsl?: ClipHsl
  // -----------------------------------------------------------------
  // Phase 3.13 — motion tracks (optional, BC-safe).
  // -----------------------------------------------------------------
  /**
   * Motion tracks computed on this clip by tracking a user-drawn box across
   * its frames. Absent / empty = none. A track is consumed only when a blur
   * region / overlay / caption BINDS to it via `motionTrackId`; tracking data
   * alone never changes the export graph. Resolved by `getClipMotionTracks`.
   * No migration.
   */
  motionTracks?: MotionTrack[]
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

// -----------------------------------------------------------------------------
// Phase 3.9 — caption / text animation (entrance + exit).
// -----------------------------------------------------------------------------

/** Caption entrance animation kinds. */
export type CaptionEntranceKind =
  | 'none'
  | 'fade'
  | 'slide-up'
  | 'slide-down'
  | 'pop'
  | 'typewriter'

/** Caption exit animation kinds (typewriter has no exit form). */
export type CaptionExitKind = 'none' | 'fade' | 'slide-up' | 'slide-down'

/**
 * Per-clip caption animation spec. Absent / both-kinds-'none' = no animation
 * (byte-identical legacy behavior). Durations are clip-relative ms, applied to
 * the FIRST `inMs` and LAST `outMs` of the clip's [startMs,endMs] window.
 */
export interface CaptionAnimation {
  entrance: CaptionEntranceKind
  exit: CaptionExitKind
  /** Entrance duration (ms), clamped to [MIN..MAX]_CAPTION_ANIM_MS. */
  inMs: number
  /** Exit duration (ms), clamped to [MIN..MAX]_CAPTION_ANIM_MS. */
  outMs: number
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
  // -----------------------------------------------------------------
  // Phase 3.9 — entrance/exit animation (optional, BC-safe).
  // -----------------------------------------------------------------
  /**
   * Caption animation spec. Absent / both-kinds-'none' = no animation.
   * Back-filled lazily by `getCaptionAnimation` (null = none). No migration.
   */
  animation?: CaptionAnimation
  /**
   * Phase 3.13 — when set, this caption FOLLOWS the named motion track (located
   * across the project by id). Absent ⇒ static legacy behavior. Dangling id ⇒
   * static fallback.
   */
  motionTrackId?: string
}

// -----------------------------------------------------------------------------
// Phase 3.8 — overlay elements (image stickers, bundled stickers, shapes).
// An OverlayClip lives on a dedicated `overlay` track, composites above video
// (below captions), and reuses ClipTransform + TransformKeyframe so Phase 3
// positioning and Phase 3.5 keyframes apply unchanged.
// -----------------------------------------------------------------------------

/** Basic vector shape primitive for a shape overlay. */
export type ShapeKind = 'rectangle' | 'ellipse' | 'line'

export interface ShapeStyle {
  shape: ShapeKind
  /** Fill color #rrggbb, or 'none' for stroke-only. */
  fill: string
  /** Fill opacity 0..1 (independent of whole-element transform.opacity). */
  fillOpacity: number
  /** Stroke color #rrggbb, or 'none'. */
  stroke: string
  /** Stroke width in canvas px (pre-transform-scale). */
  strokeWidth: number
  /** Corner radius in canvas px — rectangle only; ignored otherwise. */
  cornerRadius: number
}

/** What an overlay element draws. Discriminated by `type`. */
export type OverlaySource =
  | {
      type: 'image'
      /** Absolute path of a user-imported image. */
      path: string
      /** Intrinsic px (for aspect ratio). 0 if unknown. */
      naturalWidth: number
      naturalHeight: number
    }
  | { type: 'sticker'; /** Bundled-sticker id — see BUNDLED_STICKERS. */ stickerId: string }
  | { type: 'shape'; style: ShapeStyle }

/**
 * Overlay clip — lives on an `overlay` track. Carries the SAME ClipTransform +
 * TransformKeyframe fields as a media clip, so Phase 3 / 3.5 transform + keyframe
 * code applies unchanged. Discriminator: `kind === 'overlay'`.
 */
export interface OverlayClip {
  id: string
  kind: 'overlay'
  trackId: string
  startMs: number
  endMs: number
  source: OverlaySource
  /** Static canvas-relative transform. Absent = identity. Same ClipTransform as media. */
  transform?: ClipTransform
  /** Ordered transform keyframes (Phase 3.5 infra, shared with media clips). */
  transformKeyframes?: TransformKeyframe[]
  /**
   * Phase 3.13 — when set, this overlay FOLLOWS the named motion track (located
   * across the project by id). Absent ⇒ static legacy behavior. Dangling id ⇒
   * static fallback.
   */
  motionTrackId?: string
  /** Phase 3.18 — collage / split-screen layout group id (UI-only metadata). */
  layoutGroupId?: string
  /**
   * Base element size BEFORE transform.scale, as a fraction of canvas
   * width/height. `transform.scale/x/y/rotation/opacity` apply on top.
   */
  baseWidthFrac: number
  baseHeightFrac: number
}

// -----------------------------------------------------------------------------
// Phase 3.13 — motion tracking. A MotionTrack is a per-time position curve
// produced by tracking a user-drawn box across a media clip's frames. A blur
// region / overlay / caption may BIND to a track (motionTrackId) so it FOLLOWS
// the tracked object. Tracks are stored PER media clip; positions are clip-
// relative so they survive clip moves + duplication, like TransformKeyframe.
// Absent / empty / nothing-bound = byte-identical legacy export + preview.
// -----------------------------------------------------------------------------

/**
 * One tracked sample. `atMs` is clip-relative (offset from clip.startMs). x/y
 * are CANVAS-relative fractions of the tracked object's CENTER (0..1, 0,0 =
 * top-left). `scale` is a multiplier vs. the source box size at atMs 0 (1 =
 * unchanged); absent ⇒ treat as 1.
 */
export interface TrackPoint {
  atMs: number
  x: number
  y: number
  scale?: number
}

/**
 * Status of a track's compute job. 'partial' = the tracker lost the object
 * before the clip end (points cover [0, lastGoodMs] only).
 */
export type MotionTrackStatus =
  | 'pending'
  | 'tracking'
  | 'complete'
  | 'partial'
  | 'failed'

/**
 * A motion track attached to a media clip. `sourceRect` is the box the user
 * drew at track-start (canvas-relative fractions, top-left origin). `points`
 * is the dense output curve, ascending by atMs.
 */
export interface MotionTrack {
  id: string
  /** Human label, e.g. "트랙 1". */
  name: string
  /** User-drawn box at track-start: canvas-relative fractions. */
  sourceRect: { x: number; y: number; w: number; h: number }
  /** Dense tracked positions, clip-relative ascending atMs. */
  points: TrackPoint[]
  status: MotionTrackStatus
  /** Nominal spacing between points in ms (≈ 1000/fps). Diagnostics. */
  samplePeriodMs: number
  createdAt: number
}

/** Union: every clip on a track. Use `clip.kind` to narrow safely. */
export type Clip = VideoAudioClip | CaptionClip | OverlayClip

/** Clips that carry a ClipTransform + optional transform keyframes. */
export type TransformableClip = VideoAudioClip | OverlayClip

/**
 * Semantic role for an audio track (Phase 2.5, used by ducking).
 * 'submix' (Phase 3 timeline-track menu) marks an auxiliary audio bus track
 * — for now it behaves like a plain audio track at export; a true routing
 * bus (other tracks feeding into it) is not yet implemented.
 */
export type TrackRole = 'voice' | 'bgm' | 'sfx' | 'submix' | null

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
/** Noise-reduction strength range (Phase 4). 0 = off. */
export const MIN_NOISE_REDUCTION = 0
export const MAX_NOISE_REDUCTION = 100
/** Strength applied when the noise-reduction toggle is first switched ON. */
export const DEFAULT_NOISE_REDUCTION = 50
/** Retouch / beauty strength range (Phase 3.21). 0 = off. */
export const MIN_RETOUCH = 0
export const MAX_RETOUCH = 100
/** Strength applied when the retouch toggle is first switched ON. */
export const DEFAULT_RETOUCH = 40

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
/** Hard cap on the number of audio tracks. */
export const MAX_AUDIO_TRACKS = 8
/** Max tracks added/removed in one "여러 트랙" bulk operation. */
export const MAX_BULK_TRACKS = 10

// ---------------------------------------------------------------------------
// Keyframe animation constants (Phase 3.5).
// ---------------------------------------------------------------------------
/** Hard cap on keyframes per clip (UI + ffmpeg expression-length guard). */
export const MAX_KEYFRAMES_PER_CLIP = 24
/** Two keyframes closer than this (clip-relative ms) are deduped/merged. */
export const MIN_KEYFRAME_GAP_MS = 30

// ---------------------------------------------------------------------------
// Speed-curve constants (Phase 3.10).
// ---------------------------------------------------------------------------
/** Hard cap on speed keyframes per clip. */
export const MAX_SPEED_KEYFRAMES_PER_CLIP = 12
/** Two speed keyframes closer than this (source ms) are deduped/merged. */
export const MIN_SPEED_KEYFRAME_GAP_MS = 50
/** Export step granularity — one constant-speed sub-segment per this much
 *  timeline-output ms when expanding a speed curve. */
export const SPEED_RAMP_STEP_MS = 250
/** Hard cap on constant-speed sub-segments a single curve clip expands to. */
export const MAX_SPEED_SEGMENTS = 64

// ---------------------------------------------------------------------------
// Freeze-frame constants (Phase 3.16).
// ---------------------------------------------------------------------------
/** Hard cap on freeze frames per clip (UI + export segment-count guard). */
export const MAX_FREEZE_FRAMES_PER_CLIP = 8
/** Two freezes whose `sourceMs` are closer than this are deduped (last wins). */
export const MIN_FREEZE_GAP_MS = 50
/** Default held duration when a freeze is first inserted. */
export const DEFAULT_FREEZE_MS = 1000
/** Min / max held duration. */
export const MIN_FREEZE_MS = 100
export const MAX_FREEZE_MS = 10_000

// ---------------------------------------------------------------------------
// Text-based editing constants (Phase 3.17).
// ---------------------------------------------------------------------------
/** Hard cap on deleted ranges per clip (UI + export segment-count guard). */
export const MAX_DELETED_RANGES_PER_CLIP = 64
/** Deleted ranges closer than this (source ms) are merged into one. */
export const MIN_DELETED_RANGE_GAP_MS = 30

// ---------------------------------------------------------------------------
// Reverse / 역재생 constants (Phase 3.19).
// ---------------------------------------------------------------------------
/**
 * Soft warning threshold on a clip's trimmed source duration for reverse (ms).
 * ffmpeg's `reverse`/`areverse` buffer the whole trimmed window into RAM;
 * above this the UI warns but does not block.
 */
export const REVERSE_SOFT_CAP_MS = 60_000

// ---------------------------------------------------------------------------
// Crop constants (Phase 3.6).
// ---------------------------------------------------------------------------
/** Full-frame crop = identity (no crop). */
export const IDENTITY_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 }
/** Smallest allowed crop edge as a fraction of the source dimension. */
export const MIN_CROP_SIZE = 0.05

// ---------------------------------------------------------------------------
// Manual color-adjust constants (Phase 3.7).
// ---------------------------------------------------------------------------
/** Neutral color adjustment = identity (no-op). */
export const NEUTRAL_COLOR_ADJUST: ColorAdjust = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0
}
/** Min/max for every color-adjust field (signed, 0 = neutral). */
export const MIN_COLOR_ADJUST = -100
export const MAX_COLOR_ADJUST = 100
/**
 * Phase 3.15 — auto color correction caps each computed slider at a MODERATE
 * magnitude so auto never pushes a slider to the manual ±100 extremes (it must
 * stay tasteful — the user can still drag past this afterward). Bounds only the
 * AUTO-computed values; see `shared/autoColor.ts`.
 */
export const AUTO_COLOR_MAX_MAGNITUDE = 60

// ---------------------------------------------------------------------------
// Mosaic / blur region constants (Phase 3.11).
// ---------------------------------------------------------------------------
/** Hard cap on regions per clip (UI + ffmpeg graph-length guard). */
export const MAX_BLUR_REGIONS_PER_CLIP = 8
/** Smallest allowed region edge as a fraction of the canvas dimension. */
export const MIN_BLUR_REGION_SIZE = 0.03
export const MIN_BLUR_STRENGTH = 0
export const MAX_BLUR_STRENGTH = 100
/** Default strength for a freshly added region. */
export const DEFAULT_BLUR_STRENGTH = 55
/** Default effect for a freshly added region. */
export const DEFAULT_BLUR_EFFECT: BlurEffectKind = 'mosaic'
export const BLUR_EFFECT_KINDS: readonly BlurEffectKind[] = [
  'mosaic',
  'blur',
  'remove'
]
export const BLUR_REGION_SHAPES: readonly BlurRegionShape[] = [
  'rectangle',
  'ellipse'
]
/** Default rect for a freshly added region — centered, ~30% of canvas. */
export const DEFAULT_BLUR_REGION_RECT = { x: 0.35, y: 0.35, w: 0.3, h: 0.3 }
/**
 * Phase 3.14 — minimum inset (canvas fraction) a 'remove' (delogo) region must
 * keep from every frame edge. ffmpeg's `delogo` filter ERRORS if its box
 * touches an edge — it interpolates from the pixel ring just outside the box.
 * Applied only to 'remove' regions by `clampBlurRegion`; 'mosaic'/'blur' use
 * inset 0 → their canonical output stays byte-identical to pre-Phase-3.14.
 */
export const REMOVAL_REGION_EDGE_INSET = 0.004

// ---------------------------------------------------------------------------
// Curves + HSL color-grading constants (Phase 3.12).
// ---------------------------------------------------------------------------
/** Identity tone curve — the diagonal: input maps to itself. */
export const IDENTITY_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 }
]
/** Identity for all four channels — the no-op ClipCurves. */
export const IDENTITY_CLIP_CURVES: ClipCurves = {
  master: IDENTITY_CURVE,
  red: IDENTITY_CURVE,
  green: IDENTITY_CURVE,
  blue: IDENTITY_CURVE
}
/** A curve must keep its two endpoints. */
export const MIN_CURVE_POINTS = 2
/** Hard cap on points per channel (UI + ffmpeg arg-length guard). */
export const MAX_CURVE_POINTS = 16
export const CURVE_CHANNEL_KEYS: readonly CurveChannelKey[] = [
  'master',
  'red',
  'green',
  'blue'
]

/** Neutral (no-op) adjust for one HSL band. */
export const NEUTRAL_HSL_BAND: HslBandAdjust = {
  hue: 0,
  saturation: 0,
  luminance: 0
}
export const HSL_BAND_KEYS: readonly HslBandKey[] = [
  'red',
  'yellow',
  'green',
  'cyan',
  'blue',
  'magenta'
]
/** Neutral (no-op) ClipHsl — every band at zero. */
export const NEUTRAL_CLIP_HSL: ClipHsl = {
  red: { ...NEUTRAL_HSL_BAND },
  yellow: { ...NEUTRAL_HSL_BAND },
  green: { ...NEUTRAL_HSL_BAND },
  cyan: { ...NEUTRAL_HSL_BAND },
  blue: { ...NEUTRAL_HSL_BAND },
  magenta: { ...NEUTRAL_HSL_BAND }
}
export const MIN_HSL_ADJUST = -100
export const MAX_HSL_ADJUST = 100

// ---------------------------------------------------------------------------
// Motion-tracking constants (Phase 3.13).
// ---------------------------------------------------------------------------
/** Hard cap on motion tracks per clip (UI + JSON-size guard). */
export const MAX_MOTION_TRACKS_PER_CLIP = 4
/** Hard cap on points per track (≈ 60 s @ 30 fps; graph-length guard). */
export const MAX_TRACK_POINTS = 1800
/** Smallest drawable track-box edge as a fraction of the canvas dimension. */
export const MIN_TRACK_SOURCE_SIZE = 0.04
/** Default nominal spacing between track samples (ms). */
export const DEFAULT_TRACK_SAMPLE_PERIOD_MS = 33
/**
 * Track-point spacing used to BUILD the export t-expression — emit at most one
 * keyframe per this much output ms so `filter_complex` stays bounded.
 */
export const TRACK_EXPORT_STEP_MS = 100
/** Hard cap on keyframes a bound track contributes to one ffmpeg expression. */
export const MAX_TRACK_EXPORT_KEYFRAMES = 60

// ---------------------------------------------------------------------------
// Overlay element constants (Phase 3.8).
// ---------------------------------------------------------------------------
/** Default on-timeline duration for a freshly added overlay (ms). */
export const DEFAULT_OVERLAY_MS = 3000
/** Min/max base size of an overlay element, as a fraction of a canvas dimension. */
export const MIN_OVERLAY_SIZE_FRAC = 0.02
export const MAX_OVERLAY_SIZE_FRAC = 2
/** Default style for a freshly added shape overlay. */
export const DEFAULT_SHAPE_STYLE: ShapeStyle = {
  shape: 'rectangle',
  fill: '#ffffff',
  fillOpacity: 1,
  stroke: 'none',
  strokeWidth: 0,
  cornerRadius: 0
}

/** A bundled (built-in) sticker — `assetFile` is relative to build/stickers/. */
export interface BundledSticker {
  id: string
  label: string
  assetFile: string
}
/**
 * Built-in sticker manifest — shared so renderer (picker) + main (export path
 * resolution) agree on the id↔file mapping with no IPC. May be empty when no
 * sticker art is vendored; the picker then offers shapes + user images only.
 */
export const BUNDLED_STICKERS: readonly BundledSticker[] = []

// ---------------------------------------------------------------------------
// Caption animation constants (Phase 3.9).
// ---------------------------------------------------------------------------
export const MIN_CAPTION_ANIM_MS = 100
export const MAX_CAPTION_ANIM_MS = 2000
export const DEFAULT_CAPTION_ANIM_MS = 400
export const NO_CAPTION_ANIMATION: CaptionAnimation = {
  entrance: 'none',
  exit: 'none',
  inMs: DEFAULT_CAPTION_ANIM_MS,
  outMs: DEFAULT_CAPTION_ANIM_MS
}
export const CAPTION_ENTRANCE_KINDS: readonly CaptionEntranceKind[] = [
  'none',
  'fade',
  'slide-up',
  'slide-down',
  'pop',
  'typewriter'
]
export const CAPTION_EXIT_KINDS: readonly CaptionExitKind[] = [
  'none',
  'fade',
  'slide-up',
  'slide-down'
]
/** Slide travel distance as a fraction of canvas height. */
export const CAPTION_SLIDE_FRAC = 0.06
/** Pop start scale. */
export const CAPTION_POP_START_SCALE = 0.6
/** Max stepped PNGs rendered for a typewriter caption at export. */
export const MAX_CAPTION_TYPEWRITER_STEPS = 12

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

/**
 * Resolve a clip's effective noise-reduction strength (1..100), or null when
 * off. Defensive (clip may arrive over IPC unvalidated): non-finite → 0,
 * clamped to [MIN, MAX]; 0 → null so callers cheaply skip work.
 */
export function getClipDenoise(clip: VideoAudioClip): number | null {
  const v = clip.noiseReduction
  if (v === undefined) return null
  const n = Number.isFinite(v) ? v : 0
  const clamped = Math.min(
    MAX_NOISE_REDUCTION,
    Math.max(MIN_NOISE_REDUCTION, n)
  )
  return clamped <= 0 ? null : clamped
}

/**
 * Resolve a clip's effective retouch / beauty strength (1..100), or null when
 * off. Defensive (clip may arrive over IPC unvalidated): non-finite → 0,
 * clamped to [MIN_RETOUCH, MAX_RETOUCH]; 0 → null so callers cheaply skip work.
 */
export function getClipRetouch(clip: VideoAudioClip): number | null {
  const v = clip.retouch
  if (v === undefined) return null
  const n = Number.isFinite(v) ? v : 0
  const clamped = Math.min(MAX_RETOUCH, Math.max(MIN_RETOUCH, n))
  return clamped <= 0 ? null : clamped
}

/** Type-narrowed predicate: is this clip an overlay clip? */
export function isOverlayClip(clip: Clip): clip is OverlayClip {
  return clip.kind === 'overlay'
}

/** Resolve an overlay's base size (fraction of canvas), clamped + finite-coerced. */
export function getOverlayBaseSize(clip: OverlayClip): { w: number; h: number } {
  const c = (v: number, d: number): number => {
    const n = Number.isFinite(v) ? v : d
    return Math.min(MAX_OVERLAY_SIZE_FRAC, Math.max(MIN_OVERLAY_SIZE_FRAC, n))
  }
  return { w: c(clip.baseWidthFrac, 0.3), h: c(clip.baseHeightFrac, 0.3) }
}

// ---------------------------------------------------------------------------
// Transform helpers (Phase 3) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/** Resolve a clip's effective transform, filling identity for any missing field. */
export function getClipTransform(clip: TransformableClip): ClipTransform {
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

// ---------------------------------------------------------------------------
// Keyframe helpers (Phase 3.5) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/** Coerce non-finite to identity defaults + range-clamp every transform field. */
function clampTransform(t: ClipTransform): ClipTransform {
  const num = (v: number, d: number): number => (Number.isFinite(v) ? v : d)
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, v))
  return {
    x: clamp(num(t.x, 0), MIN_TRANSFORM_OFFSET, MAX_TRANSFORM_OFFSET),
    y: clamp(num(t.y, 0), MIN_TRANSFORM_OFFSET, MAX_TRANSFORM_OFFSET),
    scale: clamp(num(t.scale, 1), MIN_TRANSFORM_SCALE, MAX_TRANSFORM_SCALE),
    rotation: clamp(
      num(t.rotation, 0),
      MIN_TRANSFORM_ROTATION,
      MAX_TRANSFORM_ROTATION
    ),
    opacity: clamp(num(t.opacity, 1), 0, 1)
  }
}

/** True iff the clip has an active (>= 2 keyframe) transform animation track. */
export function hasTransformKeyframes(clip: TransformableClip): boolean {
  return (
    Array.isArray(clip.transformKeyframes) &&
    clip.transformKeyframes.length >= 2
  )
}

/**
 * Resolve the effective transform for a clip at an ABSOLUTE timeline ms.
 *  - No active keyframe track → getClipTransform(clip) (Phase 3 static path).
 *  - Active track → linear interpolation between the two surrounding
 *    keyframes; hold-clamp before the first / after the last keyframe.
 * Every returned field is finite + range-clamped (clip may arrive over IPC
 * unvalidated).
 */
export function getTransformAt(
  clip: TransformableClip,
  timelineMs: number
): ClipTransform {
  if (!hasTransformKeyframes(clip)) return getClipTransform(clip)
  const kfs = [...(clip.transformKeyframes as TransformKeyframe[])].sort(
    (a, b) => a.atMs - b.atMs
  )
  const localMs = timelineMs - clip.startMs
  const first = kfs[0]
  const last = kfs[kfs.length - 1]
  if (localMs <= first.atMs) return clampTransform(first.transform)
  if (localMs >= last.atMs) return clampTransform(last.transform)
  let k0 = first
  let k1 = last
  for (let i = 0; i < kfs.length - 1; i++) {
    if (localMs >= kfs[i].atMs && localMs <= kfs[i + 1].atMs) {
      k0 = kfs[i]
      k1 = kfs[i + 1]
      break
    }
  }
  const span = k1.atMs - k0.atMs
  if (span <= 0) return clampTransform(k0.transform)
  const f = (localMs - k0.atMs) / span
  const a = clampTransform(k0.transform)
  const b = clampTransform(k1.transform)
  const lerp = (u: number, v: number): number => u + (v - u) * f
  return clampTransform({
    x: lerp(a.x, b.x),
    y: lerp(a.y, b.y),
    scale: lerp(a.scale, b.scale),
    rotation: lerp(a.rotation, b.rotation),
    opacity: lerp(a.opacity, b.opacity)
  })
}

// ---------------------------------------------------------------------------
// Crop helpers (Phase 3.6) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/** True iff the rect keeps the whole source frame (no crop). */
export function isIdentityCrop(c: CropRect): boolean {
  const EPS = 1e-4
  return (
    Math.abs(c.x) < EPS &&
    Math.abs(c.y) < EPS &&
    Math.abs(c.w - 1) < EPS &&
    Math.abs(c.h - 1) < EPS
  )
}

/**
 * Resolve a clip's effective crop rectangle, or null when the clip has no
 * meaningful crop. Defensive: the clip may arrive over IPC unvalidated, so
 * every field is coerced finite, clamped to [0,1], w/h floored at
 * MIN_CROP_SIZE, and the rect pushed inside the source frame (x+w<=1,
 * y+h<=1). An identity (full-frame) result returns null so callers can
 * cheaply skip work.
 */
export function getClipCropRect(clip: VideoAudioClip): CropRect | null {
  const c = clip.cropRect
  if (!c) return null
  const clamp01 = (v: number, d: number): number =>
    Math.min(1, Math.max(0, Number.isFinite(v) ? v : d))
  const w = Math.max(MIN_CROP_SIZE, clamp01(c.w, 1))
  const h = Math.max(MIN_CROP_SIZE, clamp01(c.h, 1))
  let x = clamp01(c.x, 0)
  let y = clamp01(c.y, 0)
  if (x + w > 1) x = 1 - w
  if (y + h > 1) y = 1 - h
  x = Math.max(0, x)
  y = Math.max(0, y)
  const rect = { x, y, w, h }
  return isIdentityCrop(rect) ? null : rect
}

// ---------------------------------------------------------------------------
// Color-adjust helpers (Phase 3.7) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/** True iff every field is neutral (0) — callers can cheaply skip work. */
export function isNeutralColorAdjust(c: ColorAdjust): boolean {
  return (
    c.brightness === 0 &&
    c.contrast === 0 &&
    c.saturation === 0 &&
    c.temperature === 0
  )
}

/**
 * Resolve a clip's effective color adjustment, or null when neutral. Defensive:
 * the clip may arrive over IPC unvalidated, so every field is coerced finite
 * (non-finite → 0) and clamped to [MIN_COLOR_ADJUST, MAX_COLOR_ADJUST]. A
 * neutral (all-zero) result returns null so callers skip work.
 */
export function getClipColorAdjust(clip: VideoAudioClip): ColorAdjust | null {
  const c = clip.colorAdjust
  if (!c) return null
  const f = (v: number): number => {
    const n = Number.isFinite(v) ? v : 0
    return Math.min(MAX_COLOR_ADJUST, Math.max(MIN_COLOR_ADJUST, n))
  }
  const adj: ColorAdjust = {
    brightness: f(c.brightness),
    contrast: f(c.contrast),
    saturation: f(c.saturation),
    temperature: f(c.temperature)
  }
  return isNeutralColorAdjust(adj) ? null : adj
}

// ---------------------------------------------------------------------------
// Caption animation helpers (Phase 3.9) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/** True iff the spec produces no visible animation. */
export function isNoCaptionAnimation(a: CaptionAnimation): boolean {
  return a.entrance === 'none' && a.exit === 'none'
}

/**
 * Resolve a caption clip's effective animation, or null when there is none.
 * Defensive: the clip may arrive over IPC unvalidated — every field is coerced
 * to a known enum / finite clamped number. Unknown kind → 'none'.
 */
export function getCaptionAnimation(clip: CaptionClip): CaptionAnimation | null {
  const a = clip.animation
  if (!a) return null
  const entrance: CaptionEntranceKind = (
    CAPTION_ENTRANCE_KINDS as readonly string[]
  ).includes(a.entrance)
    ? a.entrance
    : 'none'
  const exit: CaptionExitKind = (
    CAPTION_EXIT_KINDS as readonly string[]
  ).includes(a.exit)
    ? a.exit
    : 'none'
  const clampMs = (v: number): number => {
    const n = Number.isFinite(v) ? v : DEFAULT_CAPTION_ANIM_MS
    return Math.min(MAX_CAPTION_ANIM_MS, Math.max(MIN_CAPTION_ANIM_MS, n))
  }
  const resolved: CaptionAnimation = {
    entrance,
    exit,
    inMs: clampMs(a.inMs),
    outMs: clampMs(a.outMs)
  }
  return isNoCaptionAnimation(resolved) ? null : resolved
}

/**
 * Effective entrance/exit window lengths (ms) AFTER clamping each to the clip
 * duration and shrinking proportionally if in+out overlap. {0,0} when there is
 * no animation. Pure — preview (renderer) and export consume this identically.
 */
export function getCaptionAnimWindows(
  clip: CaptionClip
): { inMs: number; outMs: number } {
  const a = getCaptionAnimation(clip)
  if (!a) return { inMs: 0, outMs: 0 }
  const dur = Math.max(1, clip.endMs - clip.startMs)
  let inMs = a.entrance === 'none' ? 0 : Math.min(a.inMs, dur)
  let outMs = a.exit === 'none' ? 0 : Math.min(a.outMs, dur)
  if (inMs + outMs > dur) {
    const scale = dur / (inMs + outMs)
    inMs = Math.floor(inMs * scale)
    outMs = Math.floor(outMs * scale)
  }
  return { inMs, outMs }
}

// ---------------------------------------------------------------------------
// Speed-curve helpers (Phase 3.10) — pure, importable from any layer.
// All math operates on SOURCE offsets (ms from trimInMs); the curve maps a
// source window to a (longer/shorter) timeline window via the integral of
// 1/speed. A clip with < 2 speedKeyframes uses the constant `speed` field.
// ---------------------------------------------------------------------------

function clampSpeedVal(v: number): number {
  return Math.min(
    MAX_CLIP_SPEED,
    Math.max(MIN_CLIP_SPEED, Number.isFinite(v) ? v : 1)
  )
}

/** True iff the clip has an active (>= 2 keyframe) variable-speed curve. */
export function hasSpeedCurve(clip: VideoAudioClip): boolean {
  return (
    Array.isArray(clip.speedKeyframes) && clip.speedKeyframes.length >= 2
  )
}

/** Sorted keyframes with speed clamped + atMs clamped into [0, sourceDur]. */
function resolvedSpeedKeyframes(clip: VideoAudioClip): SpeedKeyframe[] {
  const srcDur = Math.max(0, clip.trimOutMs - clip.trimInMs)
  return (clip.speedKeyframes as SpeedKeyframe[])
    .map((k) => ({
      atMs: Math.min(srcDur, Math.max(0, Number.isFinite(k.atMs) ? k.atMs : 0)),
      speed: clampSpeedVal(k.speed)
    }))
    .sort((a, b) => a.atMs - b.atMs)
}

/** Speed at a given SOURCE offset (ms from trimInMs). Piecewise-linear, hold-clamped. */
export function getSpeedAt(clip: VideoAudioClip, sourceOffsetMs: number): number {
  if (!hasSpeedCurve(clip)) return clampSpeedVal(clip.speed ?? 1)
  const kfs = resolvedSpeedKeyframes(clip)
  const first = kfs[0]
  const last = kfs[kfs.length - 1]
  if (sourceOffsetMs <= first.atMs) return first.speed
  if (sourceOffsetMs >= last.atMs) return last.speed
  for (let i = 0; i < kfs.length - 1; i++) {
    const k0 = kfs[i]
    const k1 = kfs[i + 1]
    if (sourceOffsetMs >= k0.atMs && sourceOffsetMs <= k1.atMs) {
      const span = k1.atMs - k0.atMs
      if (span <= 0) return k0.speed
      const f = (sourceOffsetMs - k0.atMs) / span
      return clampSpeedVal(k0.speed + (k1.speed - k0.speed) * f)
    }
  }
  return last.speed
}

/** Piecewise linear-speed intervals spanning the clip's full source window. */
function speedIntervals(
  clip: VideoAudioClip
): Array<{ s0: number; s1: number; v0: number; v1: number }> {
  const srcDur = Math.max(0, clip.trimOutMs - clip.trimInMs)
  if (!hasSpeedCurve(clip)) {
    const s = clampSpeedVal(clip.speed ?? 1)
    return [{ s0: 0, s1: srcDur, v0: s, v1: s }]
  }
  const kfs = resolvedSpeedKeyframes(clip)
  const first = kfs[0]
  const last = kfs[kfs.length - 1]
  const out: Array<{ s0: number; s1: number; v0: number; v1: number }> = []
  if (first.atMs > 0) {
    out.push({ s0: 0, s1: first.atMs, v0: first.speed, v1: first.speed })
  }
  for (let i = 0; i < kfs.length - 1; i++) {
    if (kfs[i + 1].atMs > kfs[i].atMs) {
      out.push({
        s0: kfs[i].atMs,
        s1: kfs[i + 1].atMs,
        v0: kfs[i].speed,
        v1: kfs[i + 1].speed
      })
    }
  }
  if (last.atMs < srcDur) {
    out.push({ s0: last.atMs, s1: srcDur, v0: last.speed, v1: last.speed })
  }
  if (out.length === 0) {
    out.push({ s0: 0, s1: srcDur, v0: first.speed, v1: first.speed })
  }
  return out
}

/** Timeline (output) duration of one linear-speed interval = integral of 1/speed. */
function intervalOutDur(
  s0: number,
  s1: number,
  v0: number,
  v1: number
): number {
  const span = s1 - s0
  if (span <= 0) return 0
  const dv = v1 - v0
  if (Math.abs(dv) < 1e-9) return span / v0
  return (span * Math.log(v1 / v0)) / dv
}

// ---------------------------------------------------------------------------
// Freeze-frame helpers (Phase 3.16) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/** True iff the clip has >= 1 freeze frame. */
export function hasFreezeFrames(clip: VideoAudioClip): boolean {
  return Array.isArray(clip.freezeFrames) && clip.freezeFrames.length > 0
}

function clampFreezeDuration(v: number): number {
  return Math.min(
    MAX_FREEZE_MS,
    Math.max(MIN_FREEZE_MS, Number.isFinite(v) ? v : DEFAULT_FREEZE_MS)
  )
}

/**
 * Resolve a clip's effective freeze frames — sorted, clamped, deduped, or []
 * when absent. Defensive: coerces `sourceMs` finite & into [0, srcDur], coerces
 * `durationMs` into [MIN_FREEZE_MS, MAX_FREEZE_MS], sorts ascending by
 * `sourceMs`, dedupes entries within MIN_FREEZE_GAP_MS (last wins), caps to
 * MAX_FREEZE_FRAMES_PER_CLIP. (Pattern: getClipBlurRegions + resolved speed kf.)
 */
export function getClipFreezeFrames(clip: VideoAudioClip): FreezeFrame[] {
  const raw = clip.freezeFrames
  if (!Array.isArray(raw) || raw.length === 0) return []
  const srcDur = Math.max(0, clip.trimOutMs - clip.trimInMs)
  const sorted = raw
    .filter((f): f is FreezeFrame => !!f && typeof f === 'object')
    .map((f) => ({
      sourceMs: Math.min(
        srcDur,
        Math.max(0, Number.isFinite(f.sourceMs) ? f.sourceMs : 0)
      ),
      durationMs: clampFreezeDuration(f.durationMs)
    }))
    .sort((a, b) => a.sourceMs - b.sourceMs)
  const out: FreezeFrame[] = []
  for (const f of sorted) {
    const last = out[out.length - 1]
    if (last && f.sourceMs - last.sourceMs < MIN_FREEZE_GAP_MS) {
      out[out.length - 1] = f
    } else {
      out.push(f)
    }
    if (out.length >= MAX_FREEZE_FRAMES_PER_CLIP) break
  }
  return out
}

/** Total extra timeline ms a clip's freezes add. 0 when there are none. */
export function totalFreezeDurationMs(clip: VideoAudioClip): number {
  let t = 0
  for (const f of getClipFreezeFrames(clip)) t += f.durationMs
  return t
}

/**
 * Timeline (output) duration of a clip from its SPEED remapping alone —
 * `(trimOutMs-trimInMs)/speed` for a constant clip, the exact integral of
 * 1/speed for a curve clip. Excludes freeze-frame holds; the export's
 * speed-segment expansion works in this domain.
 */
export function speedOnlyTimelineDuration(clip: VideoAudioClip): number {
  let total = 0
  for (const iv of speedIntervals(clip)) {
    total += intervalOutDur(iv.s0, iv.s1, iv.v0, iv.v1)
  }
  return total
}

// ---------------------------------------------------------------------------
// Text-based-editing helpers (Phase 3.17) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/** True iff the clip has a word-level transcript. */
export function hasClipTranscript(clip: VideoAudioClip): boolean {
  return (
    !!clip.transcript &&
    Array.isArray(clip.transcript.words) &&
    clip.transcript.words.length > 0
  )
}

/**
 * Transcript words intersecting the clip's trim window — what the transcript
 * UI shows. [] when there is no transcript.
 */
export function getVisibleTranscriptWords(
  clip: VideoAudioClip
): TranscriptWord[] {
  const t = clip.transcript
  if (!t || !Array.isArray(t.words)) return []
  return t.words.filter(
    (w) =>
      !!w &&
      Number.isFinite(w.sourceStartMs) &&
      Number.isFinite(w.sourceEndMs) &&
      w.sourceEndMs > clip.trimInMs &&
      w.sourceStartMs < clip.trimOutMs
  )
}

/**
 * Resolve a clip's effective deleted ranges — sanitized, clamped to the clip's
 * source window, sorted, and merged (overlaps + near-adjacent within
 * MIN_DELETED_RANGE_GAP_MS). [] when absent. Defensive: the project arrives
 * over IPC unvalidated. Returned ranges are ABSOLUTE source ms.
 */
export function getClipDeletedRanges(clip: VideoAudioClip): DeletedRange[] {
  const raw = clip.deletedRanges
  if (!Array.isArray(raw) || raw.length === 0) return []
  const lo = clip.trimInMs
  const hi = clip.trimOutMs
  const norm = raw
    .filter((r): r is DeletedRange => !!r && typeof r === 'object')
    .map((r) => {
      const a = Math.min(hi, Math.max(lo, Number.isFinite(r.sourceStartMs) ? r.sourceStartMs : 0))
      const b = Math.min(hi, Math.max(lo, Number.isFinite(r.sourceEndMs) ? r.sourceEndMs : 0))
      return { sourceStartMs: Math.min(a, b), sourceEndMs: Math.max(a, b) }
    })
    .filter((r) => r.sourceEndMs - r.sourceStartMs > 0)
    .sort((a, b) => a.sourceStartMs - b.sourceStartMs)
  const out: DeletedRange[] = []
  for (const r of norm) {
    const last = out[out.length - 1]
    if (last && r.sourceStartMs <= last.sourceEndMs + MIN_DELETED_RANGE_GAP_MS) {
      if (r.sourceEndMs > last.sourceEndMs) last.sourceEndMs = r.sourceEndMs
    } else if (out.length < MAX_DELETED_RANGES_PER_CLIP) {
      out.push({ ...r })
    }
  }
  return out
}

/** True iff the clip has effective transcript deletions. */
export function hasTranscriptDeletions(clip: VideoAudioClip): boolean {
  return getClipDeletedRanges(clip).length > 0
}

/** Deleted ranges as SOURCE OFFSETS from trimInMs (sorted, merged). */
function deletedOffsetRanges(
  clip: VideoAudioClip
): Array<{ start: number; end: number }> {
  return getClipDeletedRanges(clip).map((r) => ({
    start: r.sourceStartMs - clip.trimInMs,
    end: r.sourceEndMs - clip.trimInMs
  }))
}

/**
 * Forward map through SPEED + FREEZE (pre-deletion timeline): the timeline
 * offset of a source offset, including any freeze hold at/before it.
 */
export function freezeAwareTimelineOffset(
  clip: VideoAudioClip,
  sourceMs: number
): number {
  let t = speedOnlyTimelineOffset(clip, sourceMs)
  for (const f of getClipFreezeFrames(clip)) {
    if (f.sourceMs <= sourceMs) t += f.durationMs
  }
  return t
}

/**
 * Total timeline (output) duration of a clip — speed-remapped duration plus
 * freeze holds, MINUS the timeline span of every transcript deletion. The
 * store keeps `endMs = startMs + this`. With no freezes/deletions this is
 * exactly `speedOnlyTimelineDuration` (byte-identical).
 */
export function getClipTimelineDuration(clip: VideoAudioClip): number {
  const predeletion = speedOnlyTimelineDuration(clip) + totalFreezeDurationMs(clip)
  const del = deletedOffsetRanges(clip)
  if (del.length === 0) return predeletion
  let cut = 0
  for (const d of del) {
    cut +=
      freezeAwareTimelineOffset(clip, d.end) -
      freezeAwareTimelineOffset(clip, d.start)
  }
  return Math.max(0, predeletion - cut)
}

/** Total source-time (ms) removed by a clip's transcript deletions. */
export function totalDeletedSourceMs(clip: VideoAudioClip): number {
  let t = 0
  for (const r of getClipDeletedRanges(clip)) t += r.sourceEndMs - r.sourceStartMs
  return t
}

/**
 * Forward speed map: the timeline (output) offset reached after `sourceMs` of
 * SOURCE has been consumed — partial integral of 1/speed. Freeze-agnostic.
 */
export function speedOnlyTimelineOffset(
  clip: VideoAudioClip,
  sourceMs: number
): number {
  if (sourceMs <= 0) return 0
  let out = 0
  for (const iv of speedIntervals(clip)) {
    if (sourceMs >= iv.s1) {
      out += intervalOutDur(iv.s0, iv.s1, iv.v0, iv.v1)
    } else if (sourceMs > iv.s0) {
      const span = iv.s1 - iv.s0
      const vAt =
        span > 0
          ? iv.v0 + ((iv.v1 - iv.v0) * (sourceMs - iv.s0)) / span
          : iv.v0
      out += intervalOutDur(iv.s0, sourceMs, iv.v0, vAt)
      break
    } else {
      break
    }
  }
  return out
}

/**
 * Inverse of the speed integral alone (freeze-agnostic): the SOURCE offset (ms
 * from trimInMs) consumed after `timelineOffsetMs` of speed-remapped output has
 * elapsed. Monotonic; clamped to the clip's source window.
 */
export function speedOnlySourceOffset(
  clip: VideoAudioClip,
  timelineOffsetMs: number
): number {
  const srcDur = Math.max(0, clip.trimOutMs - clip.trimInMs)
  if (timelineOffsetMs <= 0) return 0
  let outAcc = 0
  for (const iv of speedIntervals(clip)) {
    const ivOut = intervalOutDur(iv.s0, iv.s1, iv.v0, iv.v1)
    if (timelineOffsetMs <= outAcc + ivOut) {
      const tIn = timelineOffsetMs - outAcc
      const dv = iv.v1 - iv.v0
      const span = iv.s1 - iv.s0
      if (Math.abs(dv) < 1e-9) {
        return Math.min(srcDur, iv.s0 + tIn * iv.v0)
      }
      // t(ds) = span/dv * ln(v(ds)/v0) → v(ds) = v0*exp(t*dv/span)
      const vAt = iv.v0 * Math.exp((tIn * dv) / span)
      return Math.min(srcDur, iv.s0 + (span / dv) * (vAt - iv.v0))
    }
    outAcc += ivOut
  }
  return srcDur
}

/**
 * The SOURCE offset (ms from trimInMs) shown at `timelineOffsetMs` of a clip's
 * SPEED + FREEZE output (pre-deletion). Freeze-aware: each freeze inserts a
 * flat plateau during which the source offset is HELD. With no freezes this is
 * exactly `speedOnlySourceOffset`.
 */
export function freezeAwareSourceOffset(
  clip: VideoAudioClip,
  timelineOffsetMs: number
): number {
  const freezes = getClipFreezeFrames(clip)
  if (freezes.length === 0) return speedOnlySourceOffset(clip, timelineOffsetMs)
  if (timelineOffsetMs <= 0) return 0
  let consumedTimeline = 0
  for (const f of freezes) {
    const freezeStart = speedOnlyTimelineOffset(clip, f.sourceMs) + consumedTimeline
    if (timelineOffsetMs < freezeStart) {
      return speedOnlySourceOffset(clip, timelineOffsetMs - consumedTimeline)
    }
    if (timelineOffsetMs < freezeStart + f.durationMs) {
      return f.sourceMs
    }
    consumedTimeline += f.durationMs
  }
  return speedOnlySourceOffset(clip, timelineOffsetMs - consumedTimeline)
}

/**
 * The SOURCE offset (ms from trimInMs) shown at `timelineOffsetMs` of the
 * clip's FINAL output. Deletion-aware on top of speed + freeze: a transcript
 * deletion compacts its source range out, so the timeline jumps past it. With
 * no deletions this is exactly `freezeAwareSourceOffset` (byte-identical).
 */
export function sourceOffsetForTimelineOffset(
  clip: VideoAudioClip,
  timelineOffsetMs: number
): number {
  const del = deletedOffsetRanges(clip)
  if (del.length === 0) return freezeAwareSourceOffset(clip, timelineOffsetMs)
  if (timelineOffsetMs <= 0) return 0
  let cutBefore = 0
  for (const d of del) {
    const cutStartFinal = freezeAwareTimelineOffset(clip, d.start) - cutBefore
    if (timelineOffsetMs < cutStartFinal) break
    cutBefore +=
      freezeAwareTimelineOffset(clip, d.end) -
      freezeAwareTimelineOffset(clip, d.start)
  }
  return freezeAwareSourceOffset(clip, timelineOffsetMs + cutBefore)
}

// ---------------------------------------------------------------------------
// Reverse / 역재생 helpers (Phase 3.19) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/** True iff the clip plays backwards. Defensive: non-boolean → false. */
export function isClipReversed(clip: VideoAudioClip): boolean {
  return clip.reversed === true
}

/**
 * True iff reverse may be toggled ON for this clip — reverse is mutually
 * exclusive with a speed curve, freeze frames, and transcript deletions (those
 * make the source↔timeline mapping too tangled to mirror cleanly in v1).
 */
export function canReverseClip(clip: VideoAudioClip): boolean {
  return (
    !hasSpeedCurve(clip) &&
    !hasFreezeFrames(clip) &&
    !hasTranscriptDeletions(clip)
  )
}

/**
 * SOURCE offset (ms from trimInMs) shown at `timelineOffsetMs`, REVERSE-aware.
 * For a forward clip this is exactly `sourceOffsetForTimelineOffset`. For a
 * reversed clip the trimmed source window is mirrored. Since reverse is
 * mutually exclusive with curve/freeze/deletions, the inner call always hits
 * the linear path — routing through the resolver keeps one code path.
 */
export function reverseAwareSourceOffset(
  clip: VideoAudioClip,
  timelineOffsetMs: number
): number {
  const fwd = sourceOffsetForTimelineOffset(clip, timelineOffsetMs)
  if (!isClipReversed(clip)) return fwd
  const srcDur = Math.max(0, clip.trimOutMs - clip.trimInMs)
  return Math.min(srcDur, Math.max(0, srcDur - fwd))
}

/**
 * Resolve a clip into constant-speed sub-segments for export. A constant clip
 * → one segment. A curve clip → N segments (capped at MAX_SPEED_SEGMENTS),
 * each ~SPEED_RAMP_STEP_MS of timeline output, each segment's speed = the
 * exact average over its window (srcSpan/outDur) so steps tile the source +
 * timeline windows with no drift. The export expands one media clip into N.
 */
export function resolveSpeedSegments(
  clip: VideoAudioClip
): Array<{ srcStartMs: number; srcEndMs: number; speed: number; outDurMs: number }> {
  const srcDur = Math.max(0, clip.trimOutMs - clip.trimInMs)
  if (!hasSpeedCurve(clip)) {
    const s = clampSpeedVal(clip.speed ?? 1)
    return [{ srcStartMs: 0, srcEndMs: srcDur, speed: s, outDurMs: srcDur / s }]
  }
  // Speed-domain only — freeze holds are expanded separately by the export's
  // segment collector, so this works in the pre-freeze timeline domain.
  const D = speedOnlyTimelineDuration(clip)
  if (D <= 0 || srcDur <= 0) {
    const s = clampSpeedVal(clip.speed ?? 1)
    return [
      { srcStartMs: 0, srcEndMs: srcDur, speed: s, outDurMs: Math.max(0, srcDur / s) }
    ]
  }
  const N = Math.min(
    MAX_SPEED_SEGMENTS,
    Math.max(1, Math.ceil(D / SPEED_RAMP_STEP_MS))
  )
  const segs: Array<{
    srcStartMs: number
    srcEndMs: number
    speed: number
    outDurMs: number
  }> = []
  let prevSrc = 0
  for (let i = 0; i < N; i++) {
    const outEnd = ((i + 1) * D) / N
    const srcEnd =
      i === N - 1 ? srcDur : speedOnlySourceOffset(clip, outEnd)
    const outDur = D / N
    const srcSpan = Math.max(0, srcEnd - prevSrc)
    const speed = clampSpeedVal(outDur > 0 ? srcSpan / outDur : 1)
    segs.push({ srcStartMs: prevSrc, srcEndMs: srcEnd, speed, outDurMs: outDur })
    prevSrc = srcEnd
  }
  return segs
}

// ---------------------------------------------------------------------------
// Mosaic / blur region helpers (Phase 3.11) — pure, importable from any layer.
// ---------------------------------------------------------------------------

function clampBlurNum(v: number, lo: number, hi: number, d: number): number {
  const n = Number.isFinite(v) ? v : d
  return Math.min(hi, Math.max(lo, n))
}

/** True iff a region is an object-removal (delogo) region. */
export function isRemovalRegion(r: BlurRegion): boolean {
  return r.effect === 'remove'
}

/** Clamp/sanitize one region into a canonical form (preserves `id`). */
export function clampBlurRegion(r: BlurRegion): BlurRegion {
  const shape: BlurRegionShape = (
    BLUR_REGION_SHAPES as readonly string[]
  ).includes(r.shape)
    ? r.shape
    : 'rectangle'
  const effect: BlurEffectKind = (
    BLUR_EFFECT_KINDS as readonly string[]
  ).includes(r.effect)
    ? r.effect
    : DEFAULT_BLUR_EFFECT
  // Phase 3.14: a 'remove' (delogo) region must keep an inset from every frame
  // edge. mosaic/blur use inset 0 → the arithmetic below collapses to exactly
  // the pre-Phase-3.14 clamp, keeping their canonical output byte-identical.
  const inset = effect === 'remove' ? REMOVAL_REGION_EDGE_INSET : 0
  const maxSize = 1 - 2 * inset
  const w = Math.min(
    maxSize,
    Math.max(MIN_BLUR_REGION_SIZE, clampBlurNum(r.w, MIN_BLUR_REGION_SIZE, 1, 0.3))
  )
  const h = Math.min(
    maxSize,
    Math.max(MIN_BLUR_REGION_SIZE, clampBlurNum(r.h, MIN_BLUR_REGION_SIZE, 1, 0.3))
  )
  let x = clampBlurNum(r.x, 0, 1, 0)
  let y = clampBlurNum(r.y, 0, 1, 0)
  if (x + w > 1 - inset) x = 1 - inset - w
  if (y + h > 1 - inset) y = 1 - inset - h
  x = Math.max(inset, x)
  y = Math.max(inset, y)
  const strength = clampBlurNum(
    r.strength,
    MIN_BLUR_STRENGTH,
    MAX_BLUR_STRENGTH,
    DEFAULT_BLUR_STRENGTH
  )
  // Phase 3.13: preserve motionTrackId when present (optional binding field).
  // clampBlurRegion was originally written before Phase 3.13 and must forward
  // any extra fields it doesn't canonicalise so the export pipeline can resolve
  // motion-track bindings after this sanitisation pass.
  const base: BlurRegion = { id: r.id, shape, x, y, w, h, effect, strength }
  if (typeof r.motionTrackId === 'string' && r.motionTrackId) {
    base.motionTrackId = r.motionTrackId
  }
  return base
}

/**
 * Resolve a clip's effective mosaic/blur regions — a sanitized array, or []
 * when there are none. Defensive: drops malformed entries, fills a synthetic
 * id when missing, truncates to MAX_BLUR_REGIONS_PER_CLIP. Order preserved.
 */
export function getClipBlurRegions(clip: VideoAudioClip): BlurRegion[] {
  const raw = clip.blurRegions
  if (!Array.isArray(raw) || raw.length === 0) return []
  const out: BlurRegion[] = []
  for (
    let i = 0;
    i < raw.length && out.length < MAX_BLUR_REGIONS_PER_CLIP;
    i++
  ) {
    const r = raw[i]
    if (!r || typeof r !== 'object') continue
    const id = typeof r.id === 'string' && r.id ? r.id : `region-${i}`
    out.push(clampBlurRegion({ ...r, id }))
  }
  return out
}

/** boxblur luma radius (px) for a region's blur effect. */
export function blurRegionBlurRadiusPx(region: BlurRegion): number {
  return Math.round(2 + (clampBlurNum(region.strength, 0, 100, 55) / 100) * 38)
}

/** Mosaic block edge in canvas px for a region (strength → block size). */
export function blurRegionMosaicBlockPx(
  region: BlurRegion,
  canvasW: number,
  canvasH: number
): number {
  const shortEdgePx = Math.min(region.w * canvasW, region.h * canvasH)
  const s = clampBlurNum(region.strength, 0, 100, 55) / 100
  const block = 6 + s * Math.max(0, shortEdgePx / 8 - 6)
  return Math.max(2, Math.round(block))
}

// ---------------------------------------------------------------------------
// Curves + HSL helpers (Phase 3.12) — pure, importable from any layer.
// All resolvers are DEFENSIVE: the project arrives over IPC unvalidated.
// ---------------------------------------------------------------------------

/** Tolerance for treating a coordinate / band value as "on the line / zero". */
const CURVE_EPS = 1e-6

/**
 * Canonicalize one tone-curve channel: coerce every coord finite & clamp to
 * [0,1], drop non-finite points, sort ascending by x, dedupe equal-x points
 * (last wins). Falls back to IDENTITY_CURVE when fewer than 2 points survive.
 */
export function sanitizeCurveChannel(raw: unknown): CurvePoint[] {
  if (!Array.isArray(raw)) return IDENTITY_CURVE
  const pts: CurvePoint[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const x = (p as CurvePoint).x
    const y = (p as CurvePoint).y
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    pts.push({
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y))
    })
  }
  pts.sort((a, b) => a.x - b.x)
  const deduped: CurvePoint[] = []
  for (const p of pts) {
    const prev = deduped[deduped.length - 1]
    if (prev && Math.abs(prev.x - p.x) <= CURVE_EPS) deduped[deduped.length - 1] = p
    else deduped.push(p)
  }
  if (deduped.length < MIN_CURVE_POINTS) return IDENTITY_CURVE
  return deduped.slice(0, MAX_CURVE_POINTS)
}

/** True iff every point of a (sanitized) channel lies on the y = x diagonal. */
export function isIdentityCurveChannel(pts: CurvePoint[]): boolean {
  return pts.every((p) => Math.abs(p.x - p.y) <= CURVE_EPS)
}

/** Canonicalize a full ClipCurves (never null) — used by the store. */
export function sanitizeClipCurves(raw: unknown): ClipCurves {
  const r = (raw ?? {}) as Partial<ClipCurves>
  return {
    master: sanitizeCurveChannel(r.master),
    red: sanitizeCurveChannel(r.red),
    green: sanitizeCurveChannel(r.green),
    blue: sanitizeCurveChannel(r.blue)
  }
}

/** True iff all four channels are identity. */
export function isIdentityClipCurves(c: ClipCurves): boolean {
  return CURVE_CHANNEL_KEYS.every((k) => isIdentityCurveChannel(c[k]))
}

/**
 * Resolve a clip's effective tone curves, or null when identity. Defensive:
 * every channel is canonicalized (finite/clamped/sorted/deduped); a neutral
 * (all-identity) result returns null so callers skip work — keeping the export
 * graph byte-identical to the pre-Phase-3.12 graph for unadjusted clips.
 */
export function getClipCurves(clip: VideoAudioClip): ClipCurves | null {
  if (!clip.curves) return null
  const c = sanitizeClipCurves(clip.curves)
  return isIdentityClipCurves(c) ? null : c
}

/** Canonicalize one HSL band: each field coerced finite & clamped to range. */
export function sanitizeHslBand(raw: unknown): HslBandAdjust {
  const r = (raw ?? {}) as Partial<HslBandAdjust>
  const f = (v: unknown): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
    return Math.min(MAX_HSL_ADJUST, Math.max(MIN_HSL_ADJUST, n))
  }
  return { hue: f(r.hue), saturation: f(r.saturation), luminance: f(r.luminance) }
}

/** True iff a band is neutral (all three offsets zero). */
export function isNeutralHslBand(b: HslBandAdjust): boolean {
  return (
    Math.abs(b.hue) <= CURVE_EPS &&
    Math.abs(b.saturation) <= CURVE_EPS &&
    Math.abs(b.luminance) <= CURVE_EPS
  )
}

/** Canonicalize a full ClipHsl (never null) — used by the store. */
export function sanitizeClipHsl(raw: unknown): ClipHsl {
  const r = (raw ?? {}) as Partial<Record<HslBandKey, unknown>>
  return {
    red: sanitizeHslBand(r.red),
    yellow: sanitizeHslBand(r.yellow),
    green: sanitizeHslBand(r.green),
    cyan: sanitizeHslBand(r.cyan),
    blue: sanitizeHslBand(r.blue),
    magenta: sanitizeHslBand(r.magenta)
  }
}

/** True iff every HSL band is neutral. */
export function isNeutralClipHsl(h: ClipHsl): boolean {
  return HSL_BAND_KEYS.every((k) => isNeutralHslBand(h[k]))
}

/**
 * Resolve a clip's effective HSL grading, or null when neutral. Defensive:
 * unknown band keys dropped, missing bands → neutral, every field clamped. A
 * neutral (all-zero) result returns null so callers skip work.
 */
export function getClipHsl(clip: VideoAudioClip): ClipHsl | null {
  if (!clip.hsl) return null
  const h = sanitizeClipHsl(clip.hsl)
  return isNeutralClipHsl(h) ? null : h
}

// ---------------------------------------------------------------------------
// Motion-tracking helpers (Phase 3.13) — pure, importable from any layer.
// All resolvers are DEFENSIVE: the project arrives over IPC unvalidated.
// ---------------------------------------------------------------------------

const MOTION_TRACK_STATUSES: readonly MotionTrackStatus[] = [
  'pending',
  'tracking',
  'complete',
  'partial',
  'failed'
]

/** Sanitize one TrackPoint: finite-coerce, clamp x/y to [0,1], scale > 0. */
export function clampTrackPoint(p: TrackPoint): TrackPoint {
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const rawScale = num(p?.scale, 1)
  return {
    atMs: Math.max(0, num(p?.atMs, 0)),
    x: Math.min(1, Math.max(0, num(p?.x, 0.5))),
    y: Math.min(1, Math.max(0, num(p?.y, 0.5))),
    scale: rawScale > 0 ? rawScale : 1
  }
}

/**
 * Resolve a clip's motion tracks — a sanitized array, or [] when there are
 * none. Defensive: drops malformed entries, fills synthetic id/name, sorts &
 * dedupes each track's points ascending by atMs, truncates to MAX_TRACK_POINTS,
 * caps to MAX_MOTION_TRACKS_PER_CLIP. (Pattern: getClipBlurRegions.)
 */
export function getClipMotionTracks(clip: VideoAudioClip): MotionTrack[] {
  const raw = clip.motionTracks
  if (!Array.isArray(raw) || raw.length === 0) return []
  const clampFrac = (v: unknown): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
    return Math.min(1, Math.max(0, n))
  }
  const out: MotionTrack[] = []
  for (
    let i = 0;
    i < raw.length && out.length < MAX_MOTION_TRACKS_PER_CLIP;
    i++
  ) {
    const t = raw[i]
    if (!t || typeof t !== 'object') continue
    const pointsRaw = Array.isArray(t.points) ? t.points : []
    const points: TrackPoint[] = []
    for (const p of pointsRaw) {
      if (!p || typeof p !== 'object') continue
      points.push(clampTrackPoint(p))
    }
    points.sort((a, b) => a.atMs - b.atMs)
    const deduped: TrackPoint[] = []
    for (const p of points) {
      const prev = deduped[deduped.length - 1]
      if (prev && Math.abs(prev.atMs - p.atMs) < 1e-6) {
        deduped[deduped.length - 1] = p
      } else {
        deduped.push(p)
      }
    }
    const sr =
      t.sourceRect && typeof t.sourceRect === 'object'
        ? t.sourceRect
        : { x: 0, y: 0, w: 0, h: 0 }
    out.push({
      id: typeof t.id === 'string' && t.id ? t.id : `track-${i}`,
      name: typeof t.name === 'string' && t.name ? t.name : `트랙 ${i + 1}`,
      sourceRect: {
        x: clampFrac(sr.x),
        y: clampFrac(sr.y),
        w: clampFrac(sr.w),
        h: clampFrac(sr.h)
      },
      points: deduped.slice(0, MAX_TRACK_POINTS),
      status: MOTION_TRACK_STATUSES.includes(t.status) ? t.status : 'complete',
      samplePeriodMs:
        typeof t.samplePeriodMs === 'number' &&
        Number.isFinite(t.samplePeriodMs) &&
        t.samplePeriodMs > 0
          ? t.samplePeriodMs
          : DEFAULT_TRACK_SAMPLE_PERIOD_MS,
      createdAt:
        typeof t.createdAt === 'number' && Number.isFinite(t.createdAt)
          ? t.createdAt
          : 0
    })
  }
  return out
}

/**
 * Find a motion track by id anywhere in the project — tracks live on media
 * clips. Returns null when not found (callers fall back to static behavior).
 */
export function findMotionTrack(
  project: Project,
  trackId: string
): MotionTrack | null {
  if (!trackId) return null
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'media') continue
      const found = getClipMotionTracks(clip).find((m) => m.id === trackId)
      if (found) return found
    }
  }
  return null
}

/**
 * Resolve a track's position at a clip-relative ms — linear interpolation
 * between the two surrounding points, hold-clamped before the first / after
 * the last. Returns null when the track has < 2 points (caller falls back to
 * static). Every returned field is finite. (Pattern: getTransformAt.)
 */
export function getTrackPositionAt(
  track: MotionTrack,
  clipRelativeMs: number
): { x: number; y: number; scale: number } | null {
  const pts = track.points
  if (!Array.isArray(pts) || pts.length < 2) return null
  const t = Number.isFinite(clipRelativeMs) ? clipRelativeMs : 0
  const first = pts[0]
  if (t <= first.atMs) {
    return { x: first.x, y: first.y, scale: first.scale ?? 1 }
  }
  const last = pts[pts.length - 1]
  if (t >= last.atMs) {
    return { x: last.x, y: last.y, scale: last.scale ?? 1 }
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (t <= b.atMs) {
      const span = b.atMs - a.atMs
      const f = span > 1e-6 ? (t - a.atMs) / span : 0
      const as = a.scale ?? 1
      const bs = b.scale ?? 1
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        scale: as + (bs - as) * f
      }
    }
  }
  return { x: last.x, y: last.y, scale: last.scale ?? 1 }
}

/**
 * True iff `motionTrackId` resolves to an existing, usable (≥ 2-point) track —
 * callers skip the time-varying path entirely when false, preserving the
 * byte-identical export/preview invariant.
 */
export function isBoundToTrack(
  motionTrackId: string | undefined,
  project: Project
): boolean {
  if (!motionTrackId) return false
  const track = findMotionTrack(project, motionTrackId)
  return !!track && track.points.length >= 2
}
