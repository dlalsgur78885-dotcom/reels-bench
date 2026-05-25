// Project / media / clip / track types — shared between main, preload, renderer.
// Pure data; no runtime imports allowed here (sibling shared/* modules OK).

import { easeFraction, type EasingKind } from './easing'
export { easeFraction, easingToFfmpegFExpr, EASING_KINDS, EASING_LABELS } from './easing'
export type { EasingKind } from './easing'

export type MediaKind = 'video' | 'audio' | 'image'

/**
 * Phase 8 — SFX (sound-effect) provenance metadata. Stamped onto the asset
 * when imported via the "🔊 효과음" tab so credits/license can flow into
 * the export step (caption/credit roll).
 *   - source: which catalog the file came from.
 *   - license: SPDX-ish short code ('CC0', 'CC-BY', 'CC-BY-NC', …).
 *   - attribution: human-readable artist/uploader string (required for CC-BY).
 *   - sourceUrl: original landing page URL (Freesound page, etc.).
 */
export interface SfxMeta {
  source: 'ours' | 'freesound'
  license: string
  attribution?: string
  sourceUrl?: string
}

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
  /** Phase 8 — SFX provenance (license/attribution/source) for credit roll. */
  sfxMeta?: SfxMeta
}

export type TrackKind = 'video' | 'audio' | 'caption' | 'overlay'

/**
 * The clip-kind discriminator values that appear on Clip variants
 * (VideoAudioClip='media', CaptionClip='caption', OverlayClip='overlay').
 * Used by `canPlaceClipOnTrack` for the clip-kind ↔ track-kind matrix.
 */
export type ClipKind = 'media' | 'caption' | 'overlay'

/**
 * Phase 3.40 — clip-kind ↔ track-kind compatibility predicate. Used by
 * `addClip` and the new `moveClipToTrack` cross-track drag action. Centralizes
 * the matrix:
 *   - 'media'   → 'video' OR 'audio'  (audio-only routing lives on audio tracks)
 *   - 'caption' → 'caption'
 *   - 'overlay' → 'overlay'
 *
 * BYTE-IDENTICAL GATE: pure UI/store predicate — no export path or
 * filter-graph builder consumes it. A project where no clip has changed
 * track produces an unchanged graph.
 */
export function canPlaceClipOnTrack(
  clipKind: ClipKind,
  trackKind: TrackKind
): boolean {
  if (trackKind === 'caption') return clipKind === 'caption'
  if (trackKind === 'overlay') return clipKind === 'overlay'
  // 'video' or 'audio' track → media clips only.
  return clipKind === 'media'
}

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
  // Basic
  | 'crossfade'
  | 'fade-to-black'
  | 'fade-to-white'
  | 'dissolve'
  // Slide
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down'
  // Wipe
  | 'wipe-left'
  | 'wipe-right'
  | 'wipe-up'
  | 'wipe-down'
  // Smooth (gradient-soft wipe)
  | 'smooth-left'
  | 'smooth-right'
  | 'smooth-up'
  | 'smooth-down'
  // Cover (incoming clip pushes in)
  | 'cover-left'
  | 'cover-right'
  | 'cover-up'
  | 'cover-down'
  // Reveal (outgoing clip slides out to expose incoming)
  | 'reveal-left'
  | 'reveal-right'
  | 'reveal-up'
  | 'reveal-down'
  // Shape mask
  | 'circle-open'
  | 'circle-close'
  | 'diag-top-left'
  | 'diag-top-right'
  | 'diag-bottom-left'
  | 'diag-bottom-right'
  // Effect
  | 'zoom-in'
  | 'pixelize'
  | 'radial'
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
  /**
   * Phase 3.54 — OUTGOING easing curve from this keyframe to the next.
   * Absent / 'linear' = pre-3.54 byte-identical linear interpolation
   * (preview + export expression unchanged). The last keyframe's easing is
   * IGNORED (no outgoing segment). See `shared/easing.ts`.
   */
  easing?: EasingKind
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

/**
 * One keyframe in a clip's volume envelope (Phase 3.30). `atMs` is RELATIVE to
 * the clip's own start (clip.startMs == atMs 0) — the same clip-relative
 * TIMELINE convention as `TransformKeyframe.atMs` (volume does not define the
 * source↔timeline mapping, so it is authored in timeline space).
 */
export interface VolumeKeyframe {
  /** Offset from clip.startMs, in ms. >= 0. */
  atMs: number
  /** Gain in dB at this instant. Clamped [MIN_GAIN_DB, MAX_GAIN_DB]. */
  gainDb: number
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
  // Phase 3.63 — second-batch presets.
  | 'moody'
  | 'noir'
  | 'pastel'
  | 'sunset'
  | 'arctic'
  | 'forest'
  | 'desert'
  | 'cyberpunk'
  | 'sepia'
  | 'high-contrast'
  | 'low-contrast'
  | 'punch'
  | 'underwater'

/**
 * Phase 3.74 — clip color label. One of `ClipColorId | undefined`. Pure
 * editing metadata: the Timeline paints a left-edge accent strip in this
 * color so users can categorise clips (interview / b-roll / opener etc).
 * Export IGNORES it — the value never reaches the filter graph.
 */
export type ClipColorId =
  | 'none'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'gray'

export const CLIP_COLOR_IDS: readonly ClipColorId[] = [
  'none',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'gray'
]

/** CSS hex for each color id — used by Timeline's accent strip. */
export const CLIP_COLOR_HEX: Record<ClipColorId, string> = {
  none: 'transparent',
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#facc15',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  gray: '#94a3b8'
}

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
  /**
   * Phase 3.33 — id of the link group this clip belongs to. Clips sharing a
   * `groupId` move / delete / select together. PURE editing metadata — export
   * IGNORES it. Absent = not grouped. No migration.
   */
  groupId?: string
  /**
   * Phase 3.41 — when true this clip is LOCKED: drags, trim, split, delete,
   * and effects-panel edits are blocked at the UI + store level. Absent /
   * false = unlocked. PURE editing guard — export IGNORES it. Resolved by
   * `isClipLocked`. No migration.
   */
  locked?: boolean
  /**
   * Phase 3.74 — UI-only color label. Renders as a left-edge accent strip
   * on the Timeline. Export ignores it; absent = no accent.
   */
  color?: ClipColorId
  // -----------------------------------------------------------------
  // Phase 2.5 — audio shaping (optional, backwards-compatible).
  // -----------------------------------------------------------------
  /** Gain in decibels, clamped to [MIN_GAIN_DB, MAX_GAIN_DB]. Default 0. */
  gainDb?: number
  /**
   * Phase 3.30 — volume envelope. With >= 2 entries the clip's volume VARIES
   * (piecewise-linear in dB between keyframes); absent / empty / length 1 →
   * falls back to the constant `gainDb`. `atMs` is clip-relative timeline ms.
   * Resolved defensively by `resolvedVolumeKeyframes` (null when < 2). Replaces
   * the constant-gain `volume=` step on export; fades + ducking still stack.
   */
  volumeKeyframes?: VolumeKeyframe[]
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
   * Phase 3.39 — voice enhancement bundle (loudnorm / compressor / de-esser /
   * EQ). Absent / all-toggles-false = OFF (byte-identical pre-3.39 audio
   * graph AND argv). Export-only — preview audio is untouched (panel hint
   * says so). Resolved defensively by `getVoiceEnhance` (null when neutral).
   * Applies to any clip with audio — video clips with embedded audio AND
   * standalone audio clips. No coupling to ducking (orthogonal: VE is
   * per-clip pre-mix; ducking is a post-mix sidechain).
   */
  voiceEnhance?: VoiceEnhance
  /**
   * Phase 3.50 — voice-changer preset. Absent / 'none' = no change
   * (byte-identical audio graph). Preset recipe is fully deterministic
   * (`voiceChangerToFfmpeg`); presets that change pitch normalize the input
   * sample rate first via `aresample=44100` so they sound consistent across
   * source rates. Stacks AFTER voiceEnhance, BEFORE atempo (so the user's
   * speed change is the last temporal modifier).
   */
  voiceChangerId?: VoiceChangerId
  /**
   * Phase 3.21 — retouch / beauty (edge-preserving skin smoothing) strength,
   * 0..100. 0 / absent = OFF (byte-identical legacy video graph). Export-only
   * (ffmpeg `smartblur`, luma-only); resolved defensively by `getClipRetouch`
   * (null when off). STATIC ONLY. Whole-frame smoothing, not face-targeted —
   * keep tasteful.
   */
  retouch?: number
  /**
   * Phase 3.49 — video quality enhancer strength, 0..100. 0 / absent = OFF
   * (byte-identical legacy video graph). Light denoise (hqdn3d) + adaptive
   * sharpen (unsharp); good for low-light / soft-focus footage. Resolved
   * defensively by `getClipEnhance` (null when off). STATIC ONLY.
   */
  enhance?: number
  /**
   * Phase 3.38 — per-clip video stabilization (손떨림 보정) strength, 0..100.
   * 0 / absent = OFF (byte-identical legacy video graph AND no `vidstabdetect`
   * 1st-pass spawned). Export-only: prefers ffmpeg vidstab two-pass when the
   * bundled ffmpeg-static exposes libvidstab, falls back to single-pass
   * `deshake`, silently no-ops if neither is available. Resolved defensively
   * by `getClipStabilize` (null when off). NOT previewed — stabilization is
   * a per-frame warp from a motion-data file with no honest CSS analogue.
   * STATIC ONLY.
   */
  stabilize?: number
  /**
   * Phase 3.37 — film-look finishing filter (vignette / grain / faded tone).
   * Absent / all-neutral = no-op (byte-identical legacy export + preview).
   * Resolved by `getFilmLook` (null = absent/neutral). Export-only filters are
   * `vignette` + `noise` (core ffmpeg, no probe); tone is a curves/eq recipe.
   * STATIC ONLY. No migration.
   */
  filmLook?: FilmLook
  /**
   * Phase 3.51 — visual effect preset (glitch / VHS / dream / dual-tone /
   * sketch etc.). Absent / 'none' = no effect (byte-identical export).
   * Stacks AFTER filmLook (effect overlays the tone+vignette+grain). Recipe
   * is fully deterministic — see `visualEffectToFfmpeg`.
   */
  visualEffect?: VisualEffectId
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
  /**
   * Phase 3.75 — absolute path to a user-supplied 3D LUT (.cube) file.
   * Export wraps it as `lut3d=<path>` AFTER the built-in `filterPreset`
   * filter chain and BEFORE `colorAdjust` / `curves` / `hsl`. Preview
   * shows no LUT (CSS has no .cube equivalent — the post-export look is
   * the source of truth). Absent / empty = no LUT (byte-identical legacy
   * export). The path MUST be allow-listed by the main-process security
   * layer; an unknown path falls back to "no LUT" with a console warning.
   */
  lutPath?: string
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

/**
 * Phase 3.23 — explicit caption text OUTLINE. Absent / width<=0 = no outline
 * (byte-identical legacy caption). Composited ON TOP OF any outline a preset
 * already bakes in. Resolved/validated by `getCaptionTextStroke`.
 */
export interface CaptionTextStroke {
  /** Outline color, validated #rrggbb. */
  color: string
  /** Outline width in px (canvas-relative, same ref frame as fontSize). */
  width: number
}

/**
 * Phase 3.23 — explicit caption text DROP-SHADOW / GLOW. Absent = no shadow.
 * A glow is just offsetX=0, offsetY=0, blur large. Composited on top of preset
 * shadows. Resolved/validated by `getCaptionTextShadow`.
 */
export interface CaptionTextShadow {
  /** Shadow color, validated #rrggbb. */
  color: string
  /** Horizontal offset px (may be negative). */
  offsetX: number
  /** Vertical offset px (may be negative). */
  offsetY: number
  /** Gaussian blur radius px, >= 0. */
  blur: number
}

export interface CaptionStyle {
  preset: CaptionPreset
  /** Base font size in px (relative to canvas height — overlay scales). */
  fontSize: number
  align: CaptionAlign
  /** 0..1, fraction of canvas height (0 = top, 1 = bottom anchor). */
  yPosition: number
  background: CaptionBackground
  /**
   * Phase 3.23 — explicit text outline. Absent = byte-identical legacy caption.
   */
  textStroke?: CaptionTextStroke
  /**
   * Phase 3.23 — explicit text drop-shadow / glow. Absent = byte-identical
   * legacy caption.
   */
  textShadow?: CaptionTextShadow
  /**
   * Phase 3.42 — extra HEIGHT padding around the caption text for the
   * background box, as a fraction of CANVAS HEIGHT. 0 / absent = box tightly
   * fits text (byte-identical legacy). Applies to 'solid' / 'pill'
   * backgrounds; 'none' / 'highlight' (per-span) ignore it. Clamped to
   * [0, MAX_CAPTION_BG_FRAC] by `getCaptionBackgroundSize`.
   */
  backgroundHeightFrac?: number
  /**
   * Phase 3.42 — extra WIDTH padding around the caption text for the
   * background box, as a fraction of CANVAS WIDTH. Same gating as
   * `backgroundHeightFrac`.
   */
  backgroundWidthFrac?: number
  /**
   * User-selected font family id from `CAPTION_FONT_FAMILIES`. Absent =
   * Pretendard (legacy default — byte-identical). The id maps to a fully
   * resolved CSS font-family stack at render time; the resolver always
   * falls through to Pretendard + system Korean fallbacks so unknown ids
   * never break a render.
   */
  fontFamilyId?: CaptionFontFamilyId
}

/**
 * Caption font catalog. The id is what we persist on `CaptionStyle`; the
 * resolver in main/captions/render.ts maps it to a CSS font-family stack
 * that always ends with the embedded Pretendard so Korean glyphs survive
 * even when the picked family lacks Hangul. Adding a new family is a
 * 2-step change: extend this list + add a stack entry in the resolver.
 */
export const CAPTION_FONT_FAMILIES = [
  { id: 'pretendard', label: 'Pretendard (기본)', stack: "'Pretendard'" },
  { id: 'malgun', label: '맑은 고딕', stack: "'Malgun Gothic'" },
  { id: 'apple-sd', label: 'Apple SD 고딕 Neo', stack: "'Apple SD Gothic Neo'" },
  { id: 'noto-sans-kr', label: 'Noto Sans KR', stack: "'Noto Sans KR'" },
  { id: 'arial', label: 'Arial', stack: 'Arial' },
  { id: 'impact', label: 'Impact', stack: 'Impact' },
  { id: 'georgia', label: 'Georgia', stack: 'Georgia' },
  { id: 'courier', label: 'Courier New', stack: "'Courier New'" }
] as const
export type CaptionFontFamilyId =
  (typeof CAPTION_FONT_FAMILIES)[number]['id']

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

// -----------------------------------------------------------------------------
// Phase 3.22 — word-level / karaoke captions. As the speaker talks, each word
// highlights in real time (the dominant short-form caption look).
// -----------------------------------------------------------------------------

/** One word's timing within a caption. CLIP-RELATIVE ms (offset from startMs). */
export interface CaptionWord {
  text: string
  /** Clip-relative start ms, clamped to [0, clip duration]. */
  startMs: number
  /** Clip-relative end ms, >= startMs. */
  endMs: number
}

/** Karaoke highlight visual mode. */
export type CaptionKaraokeStyle = 'color-fill' | 'scale-pop'

/**
 * Per-caption karaoke (word-level highlight) spec. Absent / `enabled:false`,
 * OR no resolvable `words`, = byte-identical legacy caption.
 */
export interface CaptionKaraoke {
  enabled: boolean
  highlightStyle: CaptionKaraokeStyle
  /** Active-word color for 'color-fill' (#rrggbb). */
  highlightColor: string
  /** When true ('color-fill' only): a filled box behind the active word. */
  highlightBox: boolean
}

export const DEFAULT_KARAOKE_COLOR = '#ffd400'
export const KARAOKE_POP_SCALE = 1.18
export const KARAOKE_DIM_OPACITY = 0.55
/** Hard cap on stepped PNGs / overlay ops for one karaoke caption at export. */
export const MAX_CAPTION_KARAOKE_STEPS = 40
export const KARAOKE_STYLES: readonly CaptionKaraokeStyle[] = [
  'color-fill',
  'scale-pop'
]
/** Neutral (disabled) karaoke spec — what a fresh caption starts at. */
export const NO_CAPTION_KARAOKE: CaptionKaraoke = {
  enabled: false,
  highlightStyle: 'color-fill',
  highlightColor: DEFAULT_KARAOKE_COLOR,
  highlightBox: false
}

// --- Caption background box size (Phase 3.42) ------------------------------
/** Caption background-box extra padding bounds (fraction of canvas axis). */
export const MIN_CAPTION_BG_FRAC = 0
export const MAX_CAPTION_BG_FRAC = 0.5

// --- Caption text decoration constants (Phase 3.23) ------------------------
/** Caption text outline width bounds (px, canvas-relative ref frame). */
export const MAX_CAPTION_STROKE_WIDTH = 24
export const DEFAULT_CAPTION_STROKE_WIDTH = 4
export const DEFAULT_CAPTION_STROKE_COLOR = '#000000'
/** Caption text shadow offset / blur bounds (px). */
export const MAX_CAPTION_SHADOW_OFFSET = 64
export const MAX_CAPTION_SHADOW_BLUR = 64
export const DEFAULT_CAPTION_SHADOW_COLOR = '#000000'
/** Default drop-shadow when the shadow control is first switched on. */
export const DEFAULT_CAPTION_SHADOW: CaptionTextShadow = {
  color: DEFAULT_CAPTION_SHADOW_COLOR,
  offsetX: 0,
  offsetY: 4,
  blur: 4
}
/** One-click glow preset — a shadow with no offset + a large blur. */
export const DEFAULT_CAPTION_GLOW: CaptionTextShadow = {
  color: '#00e5ff',
  offsetX: 0,
  offsetY: 0,
  blur: 24
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
  /**
   * Phase 3.22 — per-word timing for karaoke captions. CLIP-RELATIVE ms.
   * Populated by the STT word-mode pass or an even-split fallback. Absent ⇒
   * no word timing (karaoke unavailable). Resolved by `resolveCaptionWords`.
   */
  words?: CaptionWord[]
  /**
   * Phase 3.22 — karaoke (word highlight) spec. Absent / `enabled:false`, or
   * no resolvable `words`, ⇒ byte-identical legacy caption. Resolved by
   * `getCaptionKaraoke` (null when inactive).
   */
  karaoke?: CaptionKaraoke
  /** Phase 3.33 — link-group id (move/delete/select together; export ignores). */
  groupId?: string
  /** Phase 3.41 — when true the clip is uneditable (UI + store guards). Export ignores. */
  locked?: boolean
  /** Phase 3.74 — UI-only color label. Export ignores. */
  color?: ClipColorId
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
 * Phase 3.36 — drop shadow for an OverlayClip (image / sticker / shape).
 * Absent on the clip = NO shadow, byte-identical legacy export + preview.
 * Offsets/blur are canvas px (pre-transform-scale, same reference frame as
 * `ShapeStyle.strokeWidth` and `CaptionTextShadow`). Resolved by
 * `getOverlayShadow`, which is the byte-identical gate.
 */
export interface OverlayShadow {
  /** Shadow color, validated #rrggbb. */
  color: string
  /** Horizontal offset px (may be negative). */
  offsetX: number
  /** Vertical offset px (may be negative). */
  offsetY: number
  /** Gaussian blur radius px, >= 0. */
  blur: number
  /** Shadow opacity 0..1 (1 = fully opaque shadow color). */
  opacity: number
}

/** Overlay shadow offset bound (canvas px). */
export const MAX_OVERLAY_SHADOW_OFFSET = 256
/** Overlay shadow blur bound (canvas px). */
export const MAX_OVERLAY_SHADOW_BLUR = 128
/** Default overlay shadow color. */
export const DEFAULT_OVERLAY_SHADOW_COLOR = '#000000'
/** Default drop-shadow applied when the overlay shadow control is first enabled. */
export const DEFAULT_OVERLAY_SHADOW: OverlayShadow = {
  color: DEFAULT_OVERLAY_SHADOW_COLOR,
  offsetX: 0,
  offsetY: 12,
  blur: 16,
  opacity: 0.5
}

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
  /** Phase 3.33 — link-group id (move/delete/select together; export ignores). */
  groupId?: string
  /** Phase 3.41 — when true the clip is uneditable (UI + store guards). Export ignores. */
  locked?: boolean
  /** Phase 3.74 — UI-only color label. Export ignores. */
  color?: ClipColorId
  /**
   * Base element size BEFORE transform.scale, as a fraction of canvas
   * width/height. `transform.scale/x/y/rotation/opacity` apply on top.
   */
  baseWidthFrac: number
  baseHeightFrac: number
  /**
   * Phase 3.36 — optional drop shadow (image / sticker / shape). Absent ⇒
   * byte-identical legacy overlay: no shadow subchain emitted at export, no
   * CSS `filter` written in preview. Resolved/validated by `getOverlayShadow`.
   */
  shadow?: OverlayShadow
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

// -----------------------------------------------------------------------------
// Phase 3.32 — adjustment layers. A timeline element with a [startMs,endMs]
// range that applies a color grade to the FINAL COMPOSITED frame (every video
// track + overlay beneath it) within that range. Lives in
// `Project.adjustmentLayers` — NOT a Clip, NOT a Track. Reuses the existing
// color-grade payload types. Absent / empty / all-neutral = byte-identical.
// -----------------------------------------------------------------------------

/** A range color-grade applied to the composited frame. */
export interface AdjustmentLayer {
  /** Stable id (ulid). */
  id: string
  /** Timeline ms, inclusive (same axis as the playhead / clip.startMs). */
  startMs: number
  /** Timeline ms, exclusive. >= startMs + MIN_CLIP_MS. */
  endMs: number
  /** Manual color adjust. Absent / neutral = nothing emitted. */
  colorAdjust?: ColorAdjust
  /** Tone curves. Absent / all-identity = nothing emitted. */
  curves?: ClipCurves
  /** HSL secondary grade. Absent / neutral = nothing emitted. */
  hsl?: ClipHsl
  /** One-click filter preset. Absent / 'none' = nothing emitted. */
  filterPreset?: FilterPreset
  /** Preset intensity 0..1. Default 1. */
  filterIntensity?: number
}

/** Hard cap on adjustment layers per project (filter-graph length guard). */
export const MAX_ADJUSTMENT_LAYERS = 8
/** Default span for a freshly added adjustment layer. */
export const DEFAULT_ADJUSTMENT_LAYER_MS = 3000

// -----------------------------------------------------------------------------
// Phase 3.35 — progress bar overlay. A thin bar filling 0→100% over the whole
// exported video (a short-form retention element). Project-level, like coverMs.
// -----------------------------------------------------------------------------

export type ProgressBarPosition = 'top' | 'bottom'

/** Whole-video progress bar config. */
export interface ProgressBarConfig {
  /** Master switch. Absent config OR enabled:false ⇒ byte-identical export. */
  enabled: boolean
  /** 'top' = y=0; 'bottom' = y=ih-h. */
  position: ProgressBarPosition
  /** Fill (and track) color, '#rrggbb'. */
  color: string
  /** Bar thickness as a fraction of canvas height (resolution-independent). */
  heightFrac: number
}

export const DEFAULT_PROGRESS_BAR_COLOR = '#ffffff'
export const DEFAULT_PROGRESS_BAR_HEIGHT_FRAC = 0.012
export const MIN_PROGRESS_BAR_HEIGHT_FRAC = 0.004
export const MAX_PROGRESS_BAR_HEIGHT_FRAC = 0.08
/** Opacity of the faint full-width track drawn behind the fill. */
export const PROGRESS_BAR_TRACK_OPACITY = 0.25

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
  /**
   * Phase 3.27 — timeline ms (final-exported-timeline axis, same axis as the
   * renderer playhead) marked by the user as the video's cover frame. Absent ⇒
   * no explicit cover (export falls back to frame 0). Clamped on read by
   * `resolveCoverMs`. The cover is exported as a standalone `<name>_cover.jpg`
   * — a SEPARATE second ffmpeg pass; the main export graph is unaffected.
   */
  coverMs?: number
  /**
   * Phase 3.32 — adjustment layers (range color-grades over the composited
   * frame). Absent / empty / all-neutral = byte-identical legacy export.
   * Resolved defensively by `getAdjustmentLayers`. No migration.
   */
  adjustmentLayers?: AdjustmentLayer[]
  /**
   * Phase 3.35 — progress bar overlay. Absent / `enabled:false` = byte-
   * identical legacy export. Resolved defensively by `getProgressBar`.
   */
  progressBar?: ProgressBarConfig
  /**
   * Phase 3.43 — preview-only horizontal guideline rules (yFractions ∈ [0,1]).
   * Absent / empty list = no guides → byte-identical preview DOM (no overlay
   * block emitted) AND byte-identical export (export.ts NEVER reads this
   * field — pure preview decoration). Persisted via the project JSON
   * serializer so the user's compositional safe-zones survive reloads.
   * Resolved defensively by `getPreviewGuides`.
   */
  previewGuides?: { yFractions: number[] }
  /**
   * Phase 3.44 — project-wide canvas backdrop fill that occupies the gutters
   * around a scaled-down or aspect-mismatched clip.
   *
   *   Absent / `{ kind: 'blur' }` ⇒ BYTE-IDENTICAL legacy export: the
   *     existing per-clip blurred-bg subchain in `buildVideoSegmentChain`
   *     (`split=2 → boxblur=20:1, eq=brightness=-0.2`) is emitted verbatim.
   *   `{ kind: 'black' }` ⇒ solid black canvas (`color=c=black`).
   *   `{ kind: 'white' }` ⇒ solid white.
   *   `{ kind: 'color', color }` ⇒ user-picked solid color.
   *
   * Resolved defensively by `getCanvasBackground`. Export + preview MUST
   * route through it — never read `project.canvasBackground` raw.
   */
  canvasBackground?: CanvasBackground
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

/**
 * Phase 3.26 — aspect-ratio conversion. Returns the new
 * `{ aspectRatio, width, height }` for a target ratio. PURE: clip transforms
 * are canvas-RELATIVE fractions and re-fit the new canvas automatically, so
 * conversion changes ONLY these three project fields — no clip is touched, and
 * repeated conversions round-trip exactly (A→B→A restores byte-identical dims).
 * NOT read by the export graph (export canvas size comes from the export
 * preset), so converting never changes export output for a fixed preset.
 */
export function aspectRatioConversion(next: AspectRatio): {
  aspectRatio: AspectRatio
  width: number
  height: number
} {
  const d = ASPECT_RATIO_DIMENSIONS[next]
  return { aspectRatio: next, width: d.width, height: d.height }
}

/**
 * Phase 3.27 — resolve a project's cover-frame timeline ms, clamped into
 * [0, durationMs]. `durationMs` is the authoritative timeline length (renderer:
 * `getTotalDurationMs(project)`; main: the exported mp4's probed duration).
 * Returns 0 (frame-0 fallback) when `coverMs` is unset/invalid or duration ≤ 0.
 */
export function resolveCoverMs(
  coverMs: number | undefined,
  durationMs: number
): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0
  if (coverMs == null || !Number.isFinite(coverMs)) return 0
  return Math.max(0, Math.min(Math.round(coverMs), Math.round(durationMs)))
}

// ---------------------------------------------------------------------------
// Adjustment-layer helpers (Phase 3.32) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/** True iff a layer's entire grade payload is neutral (a pure no-op). */
export function isNeutralAdjustmentLayer(layer: AdjustmentLayer): boolean {
  return (
    resolveColorAdjust(layer.colorAdjust) === null &&
    resolveClipCurves(layer.curves) === null &&
    resolveClipHsl(layer.hsl) === null &&
    (!layer.filterPreset || layer.filterPreset === 'none')
  )
}

/**
 * Resolve a project's effective adjustment layers — sanitized, each clamped to
 * a valid [startMs, endMs] window (startMs >= 0, endMs >= startMs + MIN_CLIP_MS),
 * sorted ascending by startMs, capped at MAX_ADJUSTMENT_LAYERS. Drops malformed
 * entries AND any fully-neutral layer (a neutral layer is a no-op — dropping it
 * keeps the export graph byte-identical). [] when absent — the byte-identical
 * gate. Defensive: the project arrives over IPC unvalidated.
 */
export function getAdjustmentLayers(project: Project): AdjustmentLayer[] {
  const raw = project.adjustmentLayers
  if (!Array.isArray(raw) || raw.length === 0) return []
  const out: AdjustmentLayer[] = []
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i]
    if (!l || typeof l !== 'object') continue
    const startMs = Math.max(0, Number.isFinite(l.startMs) ? l.startMs : 0)
    const endRaw = Number.isFinite(l.endMs) ? l.endMs : startMs + MIN_CLIP_MS
    const endMs = Math.max(startMs + MIN_CLIP_MS, endRaw)
    const layer: AdjustmentLayer = {
      id: typeof l.id === 'string' && l.id ? l.id : `adj-${i}`,
      startMs,
      endMs,
      colorAdjust: l.colorAdjust,
      curves: l.curves,
      hsl: l.hsl,
      filterPreset: l.filterPreset,
      filterIntensity: l.filterIntensity
    }
    if (isNeutralAdjustmentLayer(layer)) continue
    out.push(layer)
  }
  out.sort((a, b) => a.startMs - b.startMs)
  return out.slice(0, MAX_ADJUSTMENT_LAYERS)
}

// ---------------------------------------------------------------------------
// Clip-group helpers (Phase 3.33) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/**
 * All clips across the project carrying `groupId`. [] when `groupId` is falsy.
 * Order: track order, then in-track order.
 */
export function getGroupMembers(project: Project, groupId: string): Clip[] {
  if (!groupId) return []
  const out: Clip[] = []
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.groupId === groupId) out.push(c)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-clip lock helper (Phase 3.41) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/**
 * True when `clip.locked === true`. Pure boolean read — works for every Clip
 * variant (the field is on each interface, mirroring the `groupId?` pattern)
 * so no isXxxClip narrowing is required at the call site. Export-path code
 * MUST NOT read this — lock is a pure editing guard with no graph effect.
 */
export function isClipLocked(clip: Clip): boolean {
  return clip.locked === true
}

// ---------------------------------------------------------------------------
// Progress-bar helpers (Phase 3.35) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/** Max `endMs` across every clip — the exported timeline length (ms). */
export function getProjectTotalMs(project: Project): number {
  let max = 0
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.endMs > max) max = c.endMs
    }
  }
  return max
}

/**
 * Resolve a project's progress-bar config, or null when absent / disabled.
 * Defensive: validates color (#rrggbb), clamps `heightFrac`, coerces position.
 * Null is the byte-identical legacy gate.
 */
export function getProgressBar(project: Project): ProgressBarConfig | null {
  const raw = project.progressBar
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null
  const position: ProgressBarPosition = raw.position === 'top' ? 'top' : 'bottom'
  const color = /^#[0-9a-fA-F]{6}$/.test(raw.color)
    ? raw.color
    : DEFAULT_PROGRESS_BAR_COLOR
  const h = Number.isFinite(raw.heightFrac)
    ? raw.heightFrac
    : DEFAULT_PROGRESS_BAR_HEIGHT_FRAC
  const heightFrac = Math.max(
    MIN_PROGRESS_BAR_HEIGHT_FRAC,
    Math.min(MAX_PROGRESS_BAR_HEIGHT_FRAC, h)
  )
  return { enabled: true, position, color, heightFrac }
}

/**
 * ffmpeg `drawbox` chain for the progress bar (faint full-width track + the
 * time-varying fill). '' when `totalSec <= 0`. The `min(t,total)` clamp pins
 * the fill at 100% on the last frame despite fps rounding.
 */
export function progressBarToFfmpeg(
  cfg: ProgressBarConfig,
  totalSec: number
): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return ''
  const hex = '0x' + cfg.color.replace(/^#/, '')
  const hf = cfg.heightFrac
  const y = cfg.position === 'top' ? '0' : `ih-ih*${hf}`
  const total = totalSec.toFixed(3)
  const track =
    `drawbox=x=0:y=${y}:w=iw:h=ih*${hf}` +
    `:color=${hex}@${PROGRESS_BAR_TRACK_OPACITY}:t=fill`
  const fill =
    `drawbox=x=0:y=${y}:w='iw*min(t\\,${total})/${total}':h=ih*${hf}` +
    `:color=${hex}@1.0:t=fill`
  return `${track},${fill}`
}

// ---------------------------------------------------------------------------
// Phase 3.44 — canvas backdrop fill. Project-wide. Selects what fills the
// canvas gutters around a scaled-down / aspect-mismatched clip.
// ---------------------------------------------------------------------------

export type CanvasBackgroundKind = 'black' | 'white' | 'color' | 'blur'

export interface CanvasBackground {
  kind: CanvasBackgroundKind
  /** `#rrggbb`. Required only when `kind === 'color'`. */
  color?: string
}

/** Default color when the user first picks the 컬러 option. */
export const DEFAULT_CANVAS_BACKGROUND_COLOR = '#ff00ff'

/**
 * Defensive resolver. Returns a discriminated payload that ALWAYS has a usable
 * `kind`. Absent ⇒ `{ kind: 'blur' }` — semantically: "today's legacy
 * per-clip blurred backdrop", which is the export's byte-identical baseline.
 * The renderer + export MUST both route through this — never read
 * `project.canvasBackground` raw. Invalid color hex falls back to BLUR (not
 * black — preserves byte-identical guarantee). `kind === 'color'` with
 * `color === '#000000'` collapses to `{ kind: 'black' }` (identical pixels).
 */
export function getCanvasBackground(project: Project): CanvasBackground {
  const raw = project.canvasBackground
  if (!raw || typeof raw !== 'object') return { kind: 'blur' }
  switch (raw.kind) {
    case 'black':
      return { kind: 'black' }
    case 'white':
      return { kind: 'white' }
    case 'blur':
      return { kind: 'blur' }
    case 'color': {
      if (
        typeof raw.color === 'string' &&
        /^#[0-9a-fA-F]{6}$/.test(raw.color)
      ) {
        if (raw.color.toLowerCase() === '#000000') return { kind: 'black' }
        return { kind: 'color', color: raw.color }
      }
      return { kind: 'blur' }
    }
    default:
      return { kind: 'blur' }
  }
}

/**
 * ffmpeg `c=` argument for the SOLID backdrop modes — `'black'` / `'white'` /
 * `'color'`. Throws conceptually (returns 'black' fallback) for `'blur'`; the
 * caller MUST branch on `kind === 'blur'` and emit the legacy split-blur chain
 * instead, NOT call this helper.
 */
export function canvasBackgroundToFfmpegColor(bg: CanvasBackground): string {
  if (bg.kind === 'white') return 'white'
  if (bg.kind === 'color' && bg.color) {
    return '0x' + bg.color.replace(/^#/, '').toLowerCase()
  }
  return 'black'
}

// ---------------------------------------------------------------------------
// Phase 3.43 — preview-only horizontal guidelines (project-level decoration).
// ---------------------------------------------------------------------------

/** Hard cap on how many guides one project can hold. */
export const MAX_PREVIEW_GUIDES = 10
/** Inclusive bounds for a guide's y-fraction. */
export const MIN_PREVIEW_GUIDE_FRAC = 0
export const MAX_PREVIEW_GUIDE_FRAC = 1
/** Default y-fraction when "+ 추가" is clicked with no other context (center). */
export const DEFAULT_PREVIEW_GUIDE_FRAC = 0.5

/**
 * Resolve a project's effective preview-guide y-fractions: sorted ascending,
 * clamped to [MIN_PREVIEW_GUIDE_FRAC, MAX_PREVIEW_GUIDE_FRAC], non-finite
 * entries dropped, capped at MAX_PREVIEW_GUIDES. Returns [] when the field
 * is absent / malformed / empty — the byte-identical preview gate.
 *
 * NEVER called from export.ts (preview-only). Defensive: the project arrives
 * over IPC unvalidated AND from a persisted JSON file the user could hand-edit.
 */
export function getPreviewGuides(project: Project): number[] {
  const raw = project.previewGuides
  if (!raw || typeof raw !== 'object') return []
  const arr = raw.yFractions
  if (!Array.isArray(arr) || arr.length === 0) return []
  const cleaned: number[] = []
  for (const v of arr) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const clamped = Math.max(
      MIN_PREVIEW_GUIDE_FRAC,
      Math.min(MAX_PREVIEW_GUIDE_FRAC, v)
    )
    cleaned.push(clamped)
    if (cleaned.length >= MAX_PREVIEW_GUIDES) break
  }
  cleaned.sort((a, b) => a - b)
  return cleaned
}

// ---------------------------------------------------------------------------
// Volume-envelope helpers (Phase 3.30) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/**
 * Resolve a clip's effective volume keyframes — sorted ascending by `atMs`,
 * dB-clamped to [MIN_GAIN_DB, MAX_GAIN_DB], `atMs`-clamped to [0, clip timeline
 * duration], deduped within MIN_VOLUME_KEYFRAME_GAP_MS, capped at
 * MAX_VOLUME_KEYFRAMES_PER_CLIP — or NULL when fewer than 2 real keyframes
 * survive. Defensive: the clip arrives over IPC unvalidated. NULL is the
 * byte-identical legacy gate (caller emits the constant-`gainDb` `volume=` step).
 */
export function resolvedVolumeKeyframes(
  clip: VideoAudioClip
): VolumeKeyframe[] | null {
  const raw = clip.volumeKeyframes
  if (!Array.isArray(raw) || raw.length < 2) return null
  const dur = Math.max(0, clip.endMs - clip.startMs)
  const norm: VolumeKeyframe[] = []
  for (const k of raw) {
    if (!k || typeof k !== 'object') continue
    const atMs = Number.isFinite(k.atMs) ? Math.min(dur, Math.max(0, k.atMs)) : 0
    const g = Number.isFinite(k.gainDb) ? k.gainDb : 0
    norm.push({ atMs, gainDb: Math.min(MAX_GAIN_DB, Math.max(MIN_GAIN_DB, g)) })
  }
  norm.sort((a, b) => a.atMs - b.atMs)
  const out: VolumeKeyframe[] = []
  for (const k of norm) {
    const prev = out[out.length - 1]
    if (prev && k.atMs - prev.atMs < MIN_VOLUME_KEYFRAME_GAP_MS) {
      out[out.length - 1] = k
    } else {
      out.push(k)
    }
    if (out.length >= MAX_VOLUME_KEYFRAMES_PER_CLIP) break
  }
  return out.length >= 2 ? out : null
}

/** True iff the clip has an active (>= 2 keyframe) volume envelope. */
export function hasVolumeEnvelope(clip: VideoAudioClip): boolean {
  return resolvedVolumeKeyframes(clip) !== null
}

/**
 * Volume (dB) at a clip-relative timeline ms — piecewise-linear between
 * keyframes, hold-clamped before the first / after the last. Falls back to the
 * clip's constant `gainDb` when there is no envelope.
 */
export function getVolumeDbAt(
  clip: VideoAudioClip,
  timelineOffsetMs: number
): number {
  const kfs = resolvedVolumeKeyframes(clip)
  if (!kfs) return clip.gainDb ?? 0
  const t = Number.isFinite(timelineOffsetMs) ? timelineOffsetMs : 0
  if (t <= kfs[0].atMs) return kfs[0].gainDb
  const last = kfs[kfs.length - 1]
  if (t >= last.atMs) return last.gainDb
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1]
    const b = kfs[i]
    if (t <= b.atMs) {
      const span = b.atMs - a.atMs
      if (span <= 0) return b.gainDb
      return a.gainDb + ((b.gainDb - a.gainDb) * (t - a.atMs)) / span
    }
  }
  return last.gainDb
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
/** Video quality enhancer strength range (Phase 3.49). 0 = off. */
export const MIN_ENHANCE = 0
export const MAX_ENHANCE = 100
/** Strength applied when the enhance toggle is first switched ON. */
export const DEFAULT_ENHANCE = 50
/** Stabilization strength range (Phase 3.38). 0 = off. */
export const MIN_STABILIZE = 0
export const MAX_STABILIZE = 100
/** Strength applied when the stabilize toggle is first switched ON. */
export const DEFAULT_STABILIZE = 50

// ---------------------------------------------------------------------------
// Phase 3.39 — voice enhancement (loudnorm / compress / de-ess / EQ).
// EXPORT-ONLY. Per-clip, boolean sub-toggles. Absent / all-false = no-op
// (byte-identical pre-3.39 audio graph + argv). Applies to ANY VideoAudioClip
// with an audio stream — video clips with embedded audio AND standalone audio
// clips. Resolved defensively by `getVoiceEnhance` (null when neutral/absent).
// ---------------------------------------------------------------------------
export interface VoiceEnhance {
  /** EBU R128 loudness normalization to -16 LUFS / -1.5 dBTP / LRA 11. */
  loudnorm: boolean
  /** Dynamic-range compression (acompressor, ~4:1 narration preset). */
  compress: boolean
  /** De-essing (sibilance suppression, ~6-8 kHz). */
  deEss: boolean
  /** 80 Hz high-pass to remove rumble. */
  eqLowCut: boolean
  /** 3 kHz presence shelf (+2 dB). */
  eqPresence: boolean
}

/** All-off voice-enhance — equivalent to the field being absent. */
export const NEUTRAL_VOICE_ENHANCE: VoiceEnhance = {
  loudnorm: false,
  compress: false,
  deEss: false,
  eqLowCut: false,
  eqPresence: false
}

// ---------------------------------------------------------------------------
// Phase 3.51 — Visual effect presets. Per-clip, applied AFTER filmLook.
// ---------------------------------------------------------------------------
export type VisualEffectId =
  | 'none'
  | 'glitch'
  | 'vhs'
  | 'dream'
  | 'dual-tone'
  | 'negative'
  | 'sketch'
  | 'infrared'
  // Phase 3.64 — second batch.
  | 'pixelate'
  | 'old-film'
  | 'blur-bg'
  | 'cartoon'
  | 'thermal'
  | 'chromatic'
  | 'mirror-h'
  | 'mirror-v'

/** All visual-effect ids in UI order. */
export const VISUAL_EFFECT_IDS: readonly VisualEffectId[] = [
  'none',
  'glitch',
  'vhs',
  'dream',
  'dual-tone',
  'negative',
  'sketch',
  'infrared',
  'pixelate',
  'old-film',
  'blur-bg',
  'cartoon',
  'thermal',
  'chromatic',
  'mirror-h',
  'mirror-v'
]

// ---------------------------------------------------------------------------
// Phase 3.50 — Voice changer presets. Stack on top of voiceEnhance.
// ---------------------------------------------------------------------------
export type VoiceChangerId =
  | 'none'
  | 'helium'
  | 'chipmunk'
  | 'deep'
  | 'robot'
  | 'echo'
  | 'phone'
  | 'monster'

/** All voice-changer ids in UI order. */
export const VOICE_CHANGER_IDS: readonly VoiceChangerId[] = [
  'none',
  'helium',
  'chipmunk',
  'deep',
  'robot',
  'echo',
  'phone',
  'monster'
]

/**
 * Defaults applied when the user FIRST flips the master 음성 보정 toggle ON.
 * Loudnorm-only — highest impact, least surgical, safe on any narration.
 */
export const DEFAULT_VOICE_ENHANCE: VoiceEnhance = {
  loudnorm: true,
  compress: false,
  deEss: false,
  eqLowCut: false,
  eqPresence: false
}

// ---------------------------------------------------------------------------
// Phase 3.37 — film look (vignette / grain / faded tone) finishing filter.
// ---------------------------------------------------------------------------
/** Named faded-film tones. Each is a small fixed curves/eq recipe on export. */
export type FilmToneId = 'none' | 'warm' | 'fade' | 'cool' | 'bw'

/**
 * Per-clip "film look" finishing filter. STATIC ONLY. Absent / fully-neutral
 * (vignette 0 + grain 0 + toneId 'none') = no-op → byte-identical export +
 * preview. Resolved defensively by `getFilmLook` (null when absent/neutral).
 */
export interface FilmLook {
  /** Corner-darkening strength, 0..100. 0 = no vignette. */
  vignette: number
  /** Film-grain strength, 0..100. 0 = no grain. */
  grain: number
  /** Faded-tone recipe id; 'none' = no tone shift. */
  toneId: FilmToneId
}

/** All film tone ids, in UI order. */
export const FILM_TONE_IDS: readonly FilmToneId[] = [
  'none',
  'warm',
  'fade',
  'cool',
  'bw'
]
/** A do-nothing film look (absent-equivalent). */
export const NEUTRAL_FILM_LOOK: FilmLook = {
  vignette: 0,
  grain: 0,
  toneId: 'none'
}
/** Film-look strength bounds (vignette / grain). */
export const MIN_FILM_LOOK = 0
export const MAX_FILM_LOOK = 100

// ---------------------------------------------------------------------------
// Transition / filter constants (Phase 2.6).
// ---------------------------------------------------------------------------
export const DEFAULT_TRANSITION_MS = 500
export const MIN_TRANSITION_MS = 100
export const MAX_TRANSITION_MS = 3000
export const TRANSITION_KINDS: readonly TransitionKind[] = [
  'none',
  // Basic
  'crossfade',
  'fade-to-black',
  'fade-to-white',
  'dissolve',
  // Slide
  'slide-left',
  'slide-right',
  'slide-up',
  'slide-down',
  // Wipe
  'wipe-left',
  'wipe-right',
  'wipe-up',
  'wipe-down',
  // Smooth
  'smooth-left',
  'smooth-right',
  'smooth-up',
  'smooth-down',
  // Cover
  'cover-left',
  'cover-right',
  'cover-up',
  'cover-down',
  // Reveal
  'reveal-left',
  'reveal-right',
  'reveal-up',
  'reveal-down',
  // Shape
  'circle-open',
  'circle-close',
  'diag-top-left',
  'diag-top-right',
  'diag-bottom-left',
  'diag-bottom-right',
  // Effect
  'zoom-in',
  'pixelize',
  'radial',
  'glitch'
]

/**
 * Phase 3.53 — UI category grouping. The picker renders one section per
 * category in this order; `kinds` order is the in-section button order.
 * 'none' is special-cased above the grid (reset chip) and not listed here.
 */
export type TransitionCategoryId =
  | 'basic'
  | 'slide'
  | 'wipe'
  | 'smooth'
  | 'cover'
  | 'reveal'
  | 'shape'
  | 'effect'

export interface TransitionCategory {
  id: TransitionCategoryId
  title: string
  kinds: readonly TransitionKind[]
}

export const TRANSITION_CATEGORIES: readonly TransitionCategory[] = [
  {
    id: 'basic',
    title: '기본',
    kinds: ['crossfade', 'fade-to-black', 'fade-to-white', 'dissolve']
  },
  {
    id: 'slide',
    title: '슬라이드',
    kinds: ['slide-left', 'slide-right', 'slide-up', 'slide-down']
  },
  {
    id: 'wipe',
    title: '와이프',
    kinds: ['wipe-left', 'wipe-right', 'wipe-up', 'wipe-down']
  },
  {
    id: 'smooth',
    title: '스무스',
    kinds: ['smooth-left', 'smooth-right', 'smooth-up', 'smooth-down']
  },
  {
    id: 'cover',
    title: '커버',
    kinds: ['cover-left', 'cover-right', 'cover-up', 'cover-down']
  },
  {
    id: 'reveal',
    title: '리빌',
    kinds: ['reveal-left', 'reveal-right', 'reveal-up', 'reveal-down']
  },
  {
    id: 'shape',
    title: '모양',
    kinds: [
      'circle-open',
      'circle-close',
      'diag-top-left',
      'diag-top-right',
      'diag-bottom-left',
      'diag-bottom-right'
    ]
  },
  {
    id: 'effect',
    title: '이펙트',
    kinds: ['zoom-in', 'pixelize', 'radial', 'glitch']
  }
]
export const FILTER_PRESETS: readonly FilterPreset[] = [
  'none',
  'cinematic',
  'vibrant',
  'bw',
  'vintage',
  'cool',
  'warm',
  'golden-hour',
  'moody',
  'noir',
  'pastel',
  'sunset',
  'arctic',
  'forest',
  'desert',
  'cyberpunk',
  'sepia',
  'high-contrast',
  'low-contrast',
  'punch',
  'underwater'
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
// Volume-envelope constants (Phase 3.30).
// ---------------------------------------------------------------------------
/** Hard cap on volume keyframes per clip (UI + ffmpeg expression-length guard). */
export const MAX_VOLUME_KEYFRAMES_PER_CLIP = 24
/** Two volume keyframes closer than this (clip-relative ms) are deduped/merged. */
export const MIN_VOLUME_KEYFRAME_GAP_MS = 30

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

/**
 * Resolve a clip's effective video-quality-enhancer strength (1..100), or
 * null when off. Defensive: non-finite → 0, clamped to [MIN_ENHANCE,
 * MAX_ENHANCE]; 0 → null. BYTE-IDENTICAL GATE: when this returns null,
 * export emits the exact pre-Phase-3.49 video filter chain.
 */
export function getClipEnhance(clip: VideoAudioClip): number | null {
  const v = clip.enhance
  if (v === undefined) return null
  const n = Number.isFinite(v) ? v : 0
  const clamped = Math.min(MAX_ENHANCE, Math.max(MIN_ENHANCE, n))
  return clamped <= 0 ? null : clamped
}

/** True when a voice-enhance payload has every sub-toggle off. */
export function isNeutralVoiceEnhance(ve: VoiceEnhance): boolean {
  return (
    !ve.loudnorm && !ve.compress && !ve.deEss && !ve.eqLowCut && !ve.eqPresence
  )
}

/**
 * Resolve a clip's effective voice-enhancement payload, or null when off /
 * neutral / absent. Defensive against IPC: missing or non-object → null;
 * partial object → coerced to booleans then re-checked. Returning null lets
 * `voiceEnhanceToFfmpeg` return '' → byte-identical pre-Phase-3.39 audio
 * graph (the non-negotiable harness invariant).
 */
export function getVoiceEnhance(clip: VideoAudioClip): VoiceEnhance | null {
  const v = clip.voiceEnhance
  if (!v || typeof v !== 'object') return null
  const merged: VoiceEnhance = {
    loudnorm: Boolean(v.loudnorm),
    compress: Boolean(v.compress),
    deEss: Boolean(v.deEss),
    eqLowCut: Boolean(v.eqLowCut),
    eqPresence: Boolean(v.eqPresence)
  }
  return isNeutralVoiceEnhance(merged) ? null : merged
}

/**
 * Resolve a clip's effective visual-effect preset, or null when absent /
 * 'none' / unknown. BYTE-IDENTICAL GATE: null → `visualEffectToFfmpeg`
 * returns '' → caller pushes nothing → video graph byte-identical.
 */
export function getVisualEffect(
  clip: VideoAudioClip
): VisualEffectId | null {
  const v = clip.visualEffect
  if (!v || v === 'none' || !VISUAL_EFFECT_IDS.includes(v)) return null
  return v
}

/**
 * Resolve a clip's effective voice-changer preset, or null when absent /
 * 'none' / unknown. BYTE-IDENTICAL GATE: null → `voiceChangerToFfmpeg`
 * returns '' → caller pushes nothing → audio graph byte-identical.
 */
export function getVoiceChanger(clip: VideoAudioClip): VoiceChangerId | null {
  const v = clip.voiceChangerId
  if (!v || v === 'none' || !VOICE_CHANGER_IDS.includes(v)) return null
  return v
}

/**
 * Resolve a clip's effective stabilization strength (1..100), or null when
 * off. Defensive (clip may arrive over IPC unvalidated): non-finite → 0,
 * clamped to [MIN_STABILIZE, MAX_STABILIZE]; 0 → null so callers cheaply
 * skip BOTH the 1st-pass `vidstabdetect` step AND the 2nd-pass filter
 * emission. BYTE-IDENTICAL GATE: when this returns null, export emits the
 * exact pre-Phase-3.38 graph and runs NO vidstabdetect pre-pass.
 */
export function getClipStabilize(clip: VideoAudioClip): number | null {
  const v = clip.stabilize
  if (v === undefined) return null
  const n = Number.isFinite(v) ? v : 0
  const clamped = Math.min(MAX_STABILIZE, Math.max(MIN_STABILIZE, n))
  return clamped <= 0 ? null : clamped
}

/** True when a film look does nothing (absent-equivalent). */
export function isNeutralFilmLook(f: FilmLook): boolean {
  return f.vignette <= 0 && f.grain <= 0 && f.toneId === 'none'
}

/**
 * Resolve a clip's effective film look, or null when absent / neutral.
 * Defensive (clip may arrive over IPC unvalidated): non-finite strengths → 0,
 * clamped to [MIN_FILM_LOOK, MAX_FILM_LOOK]; unknown toneId → 'none'. A neutral
 * result returns null — THE BYTE-IDENTICAL GATE: when this returns null,
 * export emits the exact pre-Phase-3.37 graph and preview adds nothing.
 */
export function getFilmLook(clip: VideoAudioClip): FilmLook | null {
  const f = clip.filmLook
  if (!f) return null
  const clampStrength = (v: unknown): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
    return Math.min(MAX_FILM_LOOK, Math.max(MIN_FILM_LOOK, n))
  }
  const toneId: FilmToneId = FILM_TONE_IDS.includes(f.toneId) ? f.toneId : 'none'
  const resolved: FilmLook = {
    vignette: clampStrength(f.vignette),
    grain: clampStrength(f.grain),
    toneId
  }
  return isNeutralFilmLook(resolved) ? null : resolved
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
  const fRaw = (localMs - k0.atMs) / span
  // Phase 3.54 — apply outgoing easing from k0 (linear / absent = identity).
  const f = easeFraction(fRaw, k0.easing)
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
/**
 * Resolve a raw `ColorAdjust` payload, or null when absent/neutral. Defensive:
 * every field coerced finite + clamped. Payload-level twin of
 * `getClipColorAdjust` — reused by adjustment layers (Phase 3.32).
 */
export function resolveColorAdjust(
  c: ColorAdjust | undefined
): ColorAdjust | null {
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

export function getClipColorAdjust(clip: VideoAudioClip): ColorAdjust | null {
  return resolveColorAdjust(clip.colorAdjust)
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

// ---------------------------------------------------------------------------
// Karaoke caption helpers (Phase 3.22) — pure, importable from any layer.
// ---------------------------------------------------------------------------

/**
 * Resolve a caption's per-word timing — clip-relative, clamped to the clip's
 * duration, ascending by startMs. [] when absent / all malformed. Defensive:
 * the caption may arrive over IPC unvalidated.
 */
export function resolveCaptionWords(clip: CaptionClip): CaptionWord[] {
  const raw = clip.words
  if (!Array.isArray(raw) || raw.length === 0) return []
  const dur = Math.max(1, clip.endMs - clip.startMs)
  const out: CaptionWord[] = []
  for (const w of raw) {
    if (!w || typeof w.text !== 'string') continue
    const s = Math.min(dur, Math.max(0, Number.isFinite(w.startMs) ? w.startMs : 0))
    const e = Math.min(dur, Math.max(s, Number.isFinite(w.endMs) ? w.endMs : s))
    out.push({ text: w.text, startMs: s, endMs: e })
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

/**
 * Resolve a caption's effective karaoke spec, or null when inactive. Inactive =
 * absent / `enabled:false` / no resolvable words. Defensive: coerces the style
 * + color to valid values. Null is the byte-identical legacy gate.
 */
export function getCaptionKaraoke(clip: CaptionClip): CaptionKaraoke | null {
  const k = clip.karaoke
  if (!k || k.enabled !== true) return null
  if (resolveCaptionWords(clip).length === 0) return null
  return {
    enabled: true,
    highlightStyle: (KARAOKE_STYLES as readonly string[]).includes(
      k.highlightStyle
    )
      ? k.highlightStyle
      : 'color-fill',
    highlightColor: /^#[0-9a-fA-F]{6}$/.test(k.highlightColor)
      ? k.highlightColor
      : DEFAULT_KARAOKE_COLOR,
    highlightBox: k.highlightBox === true
  }
}

/**
 * Index of the active word at a clip-relative ms, or -1 (before the first
 * word). The last word that has started stays active through any gap until the
 * next word starts — no flicker on silence gaps. `words` must be sorted.
 */
export function getActiveWordIndex(
  words: CaptionWord[],
  clipRelativeMs: number
): number {
  let idx = -1
  for (let i = 0; i < words.length; i++) {
    if (words[i].startMs <= clipRelativeMs) idx = i
    else break
  }
  return idx
}

/**
 * Even-split fallback: synthesize `words` from a caption's non-empty spans,
 * distributed evenly across [0, clip duration]. For a manually-typed caption
 * with no STT word timing.
 */
export function evenSplitWords(clip: CaptionClip): CaptionWord[] {
  const dur = Math.max(1, clip.endMs - clip.startMs)
  const spans = clip.spans.filter((s) => s.text.trim().length > 0)
  if (spans.length === 0) return []
  const step = dur / spans.length
  return spans.map((s, i) => ({
    text: s.text,
    startMs: Math.round(i * step),
    endMs: Math.round((i + 1) * step)
  }))
}

// ---------------------------------------------------------------------------
// Caption text-decoration helpers (Phase 3.23) — pure, importable anywhere.
// ---------------------------------------------------------------------------

const HEX6_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Resolve a caption's effective text outline, or null when absent / inert
 * (width <= 0). Defensive: validates color, clamps width. Null is the
 * byte-identical legacy gate — callers MUST emit nothing new when null.
 */
export function getCaptionTextStroke(
  style: CaptionStyle
): CaptionTextStroke | null {
  const s = style.textStroke
  if (!s) return null
  const w = Number.isFinite(s.width) ? s.width : 0
  const width = Math.min(MAX_CAPTION_STROKE_WIDTH, Math.max(0, w))
  if (width <= 0) return null
  return {
    color: HEX6_RE.test(s.color) ? s.color : DEFAULT_CAPTION_STROKE_COLOR,
    width
  }
}

/**
 * Phase 3.42 — resolved caption background-box extra padding, as fractions of
 * canvas height/width. Returns `{0,0}` when:
 *   - both fields absent / NaN / <= 0, OR
 *   - `style.background === 'none'` (no rect to grow), OR
 *   - `style.background === 'highlight'` (per-span stroke trick, no rect).
 *
 * `{0,0}` is THE BYTE-IDENTICAL GATE: callers MUST run the original tight-fit
 * code path (no extra rect math, no extra CSS padding) when both are zero.
 * Defensive: non-finite → 0, clamped to [0, MAX_CAPTION_BG_FRAC].
 */
export function getCaptionBackgroundSize(
  style: CaptionStyle
): { heightFrac: number; widthFrac: number } {
  if (style.background === 'none' || style.background === 'highlight') {
    return { heightFrac: 0, widthFrac: 0 }
  }
  const clamp = (v: number | undefined): number => {
    if (v === undefined || !Number.isFinite(v)) return 0
    return Math.min(MAX_CAPTION_BG_FRAC, Math.max(MIN_CAPTION_BG_FRAC, v))
  }
  return {
    heightFrac: clamp(style.backgroundHeightFrac),
    widthFrac: clamp(style.backgroundWidthFrac)
  }
}

/**
 * Resolve a caption's effective text shadow / glow, or null when the field is
 * absent. Defensive: validates color, clamps offsets to ±MAX, blur to [0,MAX].
 * Absent field ⇒ null (the byte-identical legacy gate).
 */
export function getCaptionTextShadow(
  style: CaptionStyle
): CaptionTextShadow | null {
  const s = style.textShadow
  if (!s) return null
  const clampOff = (v: number): number => {
    const n = Number.isFinite(v) ? v : 0
    return Math.min(
      MAX_CAPTION_SHADOW_OFFSET,
      Math.max(-MAX_CAPTION_SHADOW_OFFSET, n)
    )
  }
  return {
    color: HEX6_RE.test(s.color) ? s.color : DEFAULT_CAPTION_SHADOW_COLOR,
    offsetX: clampOff(s.offsetX),
    offsetY: clampOff(s.offsetY),
    blur: Math.min(
      MAX_CAPTION_SHADOW_BLUR,
      Math.max(0, Number.isFinite(s.blur) ? s.blur : 0)
    )
  }
}

/**
 * Resolve an overlay clip's effective drop shadow, or null when the `shadow`
 * field is absent. Defensive (clips may arrive over IPC unvalidated): validates
 * color, clamps offsets to ±MAX_OVERLAY_SHADOW_OFFSET, blur to
 * [0,MAX_OVERLAY_SHADOW_BLUR], opacity to [0,1].
 *
 * Null is THE BYTE-IDENTICAL GATE: when this returns null, export emits the
 * exact pre-Phase-3.36 overlay filter graph and preview writes no CSS `filter`.
 */
export function getOverlayShadow(clip: OverlayClip): OverlayShadow | null {
  const s = clip.shadow
  if (!s) return null
  const clampOff = (v: number): number => {
    const n = Number.isFinite(v) ? v : 0
    return Math.min(
      MAX_OVERLAY_SHADOW_OFFSET,
      Math.max(-MAX_OVERLAY_SHADOW_OFFSET, n)
    )
  }
  return {
    color: HEX6_RE.test(s.color) ? s.color : DEFAULT_OVERLAY_SHADOW_COLOR,
    offsetX: clampOff(s.offsetX),
    offsetY: clampOff(s.offsetY),
    blur: Math.min(
      MAX_OVERLAY_SHADOW_BLUR,
      Math.max(0, Number.isFinite(s.blur) ? s.blur : 0)
    ),
    opacity: Math.min(
      1,
      Math.max(0, Number.isFinite(s.opacity) ? s.opacity : 1)
    )
  }
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
/** Payload-level twin of `getClipCurves` — reused by adjustment layers. */
export function resolveClipCurves(
  c: ClipCurves | undefined
): ClipCurves | null {
  if (!c) return null
  const s = sanitizeClipCurves(c)
  return isIdentityClipCurves(s) ? null : s
}

export function getClipCurves(clip: VideoAudioClip): ClipCurves | null {
  return resolveClipCurves(clip.curves)
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
/** Payload-level twin of `getClipHsl` — reused by adjustment layers. */
export function resolveClipHsl(h: ClipHsl | undefined): ClipHsl | null {
  if (!h) return null
  const s = sanitizeClipHsl(h)
  return isNeutralClipHsl(s) ? null : s
}

export function getClipHsl(clip: VideoAudioClip): ClipHsl | null {
  return resolveClipHsl(clip.hsl)
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
