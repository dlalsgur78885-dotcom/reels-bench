import { ulid } from 'ulid'
import { create, useStore } from 'zustand'
import { temporal, type TemporalState } from 'zundo'
import {
  ASPECT_RATIO_DIMENSIONS,
  DEFAULT_BLUR_EFFECT,
  DEFAULT_BLUR_REGION_RECT,
  DEFAULT_BLUR_STRENGTH,
  DEFAULT_DUCKING_DB,
  DEFAULT_TRANSITION_MS,
  IDENTITY_CROP,
  MAX_AUDIO_TRACKS,
  MAX_BLUR_REGIONS_PER_CLIP,
  MAX_CLIP_SPEED,
  MAX_COLOR_ADJUST,
  MAX_GAIN_DB,
  MAX_KEYFRAMES_PER_CLIP,
  MAX_MOTION_TRACKS_PER_CLIP,
  MAX_SPEED_KEYFRAMES_PER_CLIP,
  MAX_TRANSFORM_OFFSET,
  MAX_TRANSFORM_ROTATION,
  MAX_TRANSFORM_SCALE,
  MAX_TRANSITION_MS,
  MAX_VIDEO_TRACKS,
  MIN_CLIP_MS,
  MIN_CLIP_SPEED,
  MIN_COLOR_ADJUST,
  MIN_CROP_SIZE,
  MIN_GAIN_DB,
  MIN_KEYFRAME_GAP_MS,
  MIN_NOISE_REDUCTION,
  MAX_NOISE_REDUCTION,
  MIN_SPEED_KEYFRAME_GAP_MS,
  MIN_TRANSFORM_OFFSET,
  MIN_TRANSFORM_ROTATION,
  MIN_TRANSFORM_SCALE,
  MIN_TRANSITION_MS,
  NEUTRAL_COLOR_ADJUST,
  IDENTITY_CLIP_CURVES,
  NEUTRAL_CLIP_HSL,
  NEUTRAL_HSL_BAND,
  MIN_CURVE_POINTS,
  MAX_CURVE_POINTS,
  MIN_HSL_ADJUST,
  MAX_HSL_ADJUST,
  type AspectRatio,
  type BlurRegion,
  type CaptionClip,
  type Clip,
  type ColorAdjust,
  type ClipTransform,
  type CropRect,
  type CurveChannelKey,
  type CurvePoint,
  type FilterPreset,
  type HslBandAdjust,
  type HslBandKey,
  type MediaAsset,
  type MotionTrack,
  type OverlayClip,
  type Project,
  type Track,
  type TrackKind,
  type TrackRole,
  type SpeedKeyframe,
  type TransformKeyframe,
  type TransitionKind,
  type VideoAudioClip,
  clampBlurRegion,
  getClipDuration,
  getClipTimelineDuration,
  getClipTransform,
  getSpeedAt,
  getTransformAt,
  hasSpeedCurve,
  hasTransformKeyframes,
  isCaptionClip,
  isIdentityCrop,
  isIdentityTransform,
  isMediaClip,
  isNeutralColorAdjust,
  isOverlayClip,
  sanitizeClipCurves,
  isIdentityClipCurves,
  sanitizeClipHsl,
  isNeutralClipHsl,
  sourceOffsetForTimelineOffset
} from '../../../shared/project'
import type { SilenceRange } from '../../../shared/ipc'

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function freshProject(): Project {
  const now = Date.now()
  const dims = ASPECT_RATIO_DIMENSIONS['9:16']
  return {
    id: ulid(),
    name: '제목 없는 프로젝트',
    aspectRatio: '9:16',
    width: dims.width,
    height: dims.height,
    fps: 30,
    tracks: [
      { id: ulid(), kind: 'video', name: 'Video 1', clips: [] },
      // Voice track — primary VO/dialogue lane.
      { id: ulid(), kind: 'audio', name: 'Voice 1', clips: [], role: 'voice' },
      // BGM track — ducked by the voice track when active.
      {
        id: ulid(),
        kind: 'audio',
        name: 'BGM',
        clips: [],
        role: 'bgm',
        duckTarget: 'voice',
        duckingDb: DEFAULT_DUCKING_DB
      },
      { id: ulid(), kind: 'caption', name: 'Caption 1', clips: [] },
      // Phase 3.8 — overlay track (stickers / shapes), composites above
      // video, below captions. Last track so it round-trips identically.
      { id: ulid(), kind: 'overlay', name: 'Overlay 1', clips: [] }
    ],
    media: {},
    createdAt: now,
    updatedAt: now
  }
}

function touch(p: Project): Project {
  return { ...p, updatedAt: Date.now() }
}

/**
 * Range-clamp every transform field — the SAME clamp `setClipTransform` applies
 * to a static transform. Reused by the Phase 3.5 keyframe actions so a stored
 * keyframe never holds an out-of-range value.
 */
function clampClipTransform(t: ClipTransform): ClipTransform {
  return {
    x: Math.max(MIN_TRANSFORM_OFFSET, Math.min(MAX_TRANSFORM_OFFSET, t.x)),
    y: Math.max(MIN_TRANSFORM_OFFSET, Math.min(MAX_TRANSFORM_OFFSET, t.y)),
    scale: Math.max(
      MIN_TRANSFORM_SCALE,
      Math.min(MAX_TRANSFORM_SCALE, t.scale)
    ),
    rotation: Math.max(
      MIN_TRANSFORM_ROTATION,
      Math.min(MAX_TRANSFORM_ROTATION, t.rotation)
    ),
    opacity: Math.max(0, Math.min(1, t.opacity))
  }
}

/**
 * Clamp a crop rect — the SAME logic `getClipCropRect` applies defensively:
 * clamp each field to [0,1], floor w/h at MIN_CROP_SIZE, then push x/y so the
 * rect stays inside the source frame (x+w<=1, y+h<=1). Used by `setClipCrop`
 * so the stored rect is already canonical (getClipCropRect is then idempotent).
 */
function clampCropRect(c: CropRect): CropRect {
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
  return { x, y, w, h }
}

/**
 * Clamp a color adjust — clamps every field to [MIN_COLOR_ADJUST,
 * MAX_COLOR_ADJUST] and coerces non-finite values to 0 (neutral). Used by
 * `setClipColorAdjust` so the stored object is already canonical
 * (getClipColorAdjust is then idempotent). Mirrors `clampCropRect`.
 */
function clampColorAdjust(c: ColorAdjust): ColorAdjust {
  const f = (v: number): number => {
    const n = Number.isFinite(v) ? v : 0
    return Math.min(MAX_COLOR_ADJUST, Math.max(MIN_COLOR_ADJUST, n))
  }
  return {
    brightness: f(c.brightness),
    contrast: f(c.contrast),
    saturation: f(c.saturation),
    temperature: f(c.temperature)
  }
}

/**
 * Normalize a keyframe list (Phase 3.5): clamp each keyframe transform, sort
 * ascending by atMs, then dedup — keyframes within MIN_KEYFRAME_GAP_MS of the
 * previously-kept one REPLACE it (last write wins). The result is the
 * canonical form the store persists; callers must still enforce the >= 2
 * invariant (a normalized list MAY collapse to length 1).
 */
function normalizeKeyframes(kfs: TransformKeyframe[]): TransformKeyframe[] {
  const sorted = kfs
    .map((kf) => ({
      atMs: Math.max(0, Math.round(kf.atMs)),
      transform: clampClipTransform(kf.transform)
    }))
    .sort((a, b) => a.atMs - b.atMs)
  const out: TransformKeyframe[] = []
  for (const kf of sorted) {
    const last = out[out.length - 1]
    if (last && kf.atMs - last.atMs < MIN_KEYFRAME_GAP_MS) {
      // Within the dedup window — replace the kept keyframe.
      out[out.length - 1] = kf
    } else {
      out.push(kf)
    }
  }
  return out
}

/**
 * Normalize a speed-keyframe list (Phase 3.10): round + clamp `atMs >= 0`,
 * clamp each `speed` into [MIN_CLIP_SPEED, MAX_CLIP_SPEED], sort ascending by
 * atMs, then dedup — keyframes within MIN_SPEED_KEYFRAME_GAP_MS of the
 * previously-kept one REPLACE it (last write wins). Mirrors
 * `normalizeKeyframes`; callers must still enforce the >= 2 invariant (a
 * normalized list MAY collapse to length 1).
 */
function normalizeSpeedKeyframes(kfs: SpeedKeyframe[]): SpeedKeyframe[] {
  const sorted = kfs
    .map((kf) => ({
      atMs: Math.max(0, Math.round(kf.atMs)),
      speed: Math.max(
        MIN_CLIP_SPEED,
        Math.min(MAX_CLIP_SPEED, Number.isFinite(kf.speed) ? kf.speed : 1)
      )
    }))
    .sort((a, b) => a.atMs - b.atMs)
  const out: SpeedKeyframe[] = []
  for (const kf of sorted) {
    const last = out[out.length - 1]
    if (last && kf.atMs - last.atMs < MIN_SPEED_KEYFRAME_GAP_MS) {
      // Within the dedup window — replace the kept keyframe.
      out[out.length - 1] = kf
    } else {
      out.push(kf)
    }
  }
  return out
}

/**
 * Recompute a media clip's `endMs` from its (possibly variable) speed:
 * `endMs = startMs + max(MIN_CLIP_MS, round(getClipTimelineDuration(clip)))`.
 * `getClipTimelineDuration` returns `(trimOutMs-trimInMs)/speed` for a
 * constant clip and the exact integral of 1/speed for a curve clip — so every
 * speed mutation (constant or curve) routes through this single helper.
 */
function recomputeEndMsForSpeed(clip: VideoAudioClip): VideoAudioClip {
  const dur = Math.max(MIN_CLIP_MS, Math.round(getClipTimelineDuration(clip)))
  return { ...clip, endMs: clip.startMs + dur }
}

/**
 * Migration helper: an older persisted project may have:
 *   - clips without `kind` (assume 'media')
 *   - no caption track (add one)
 */
function migrateLoadedProject(p: Project): Project {
  const tracks = p.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => {
      if (!('kind' in c) || !c.kind) {
        // Pre-2.4 clip — treat as a media clip.
        const legacy = c as unknown as VideoAudioClip
        return { ...legacy, kind: 'media' as const }
      }
      return c
    })
  }))
  // Phase 3 — `transform` is an optional field on media clips. No migration
  // logic is needed: a missing/partial transform is back-filled lazily by
  // `getClipTransform` (identity fallback). Multi-video-track projects also
  // load as-is — `tracks` is already a generic list, so extra video tracks
  // simply round-trip through persistence untouched.
  // Phase 3.6 — `cropRect` is likewise optional + back-filled lazily by
  // `getClipCropRect` (null = no crop). No migration step needed.
  // Phase 3.7 — `colorAdjust` is optional, back-filled lazily by
  // `getClipColorAdjust` (null = neutral). No migration step needed.
  // Phase 3.10 — `speedKeyframes` is optional (absent/empty/length-1 falls
  // back to the constant `speed` field via hasSpeedCurve). No migration.
  // Phase 3.8 — do NOT auto-append an overlay track to old projects (keeps
  // the export byte-identical); `addOverlay` lazily creates it on first use.
  // Ensure a caption track exists. If none, append one.
  const hasCaption = tracks.some((t) => t.kind === 'caption')
  const migratedTracks = hasCaption
    ? tracks
    : [
        ...tracks,
        { id: ulid(), kind: 'caption' as const, name: 'Caption 1', clips: [] }
      ]
  return { ...p, tracks: migratedTracks }
}

// ---------------------------------------------------------------------------
// Persistence (debounced via setTimeout). Loaded on first store consumer.
// ---------------------------------------------------------------------------
const PERSIST_DEBOUNCE_MS = 500

let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistEnabled = false

function schedulePersist(project: Project): void {
  if (!persistEnabled) return
  if (typeof window === 'undefined' || !window.electron?.fs?.writeProject) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void window.electron.fs.writeProject(project).catch((err: unknown) => {
      console.error('[store] writeProject failed', err)
    })
  }, PERSIST_DEBOUNCE_MS)
}

// ---------------------------------------------------------------------------
// Store.
// ---------------------------------------------------------------------------
export interface ProjectStore {
  project: Project
  /** True until the persisted project (if any) has been loaded. */
  hydrated: boolean

  createNew(): void
  setName(name: string): void
  setAspectRatio(ratio: AspectRatio): void

  addMedia(asset: MediaAsset): void
  removeMedia(mediaId: string): void
  updateMediaThumbnail(mediaId: string, thumbnailPath: string): void
  /** Attach a generated waveform PNG to a media asset (Phase 2.5). */
  updateMediaWaveform(mediaId: string, waveformPath: string): void

  addClip(clip: Clip): void
  removeClip(clipId: string): void
  /**
   * Partial update for a media clip's trim/timeline fields. Caption clips
   * are handled by `updateCaption` instead. Light invariants:
   *   - startMs >= 0
   *   - endMs > startMs (clamped to startMs+1 otherwise)
   */
  updateMediaClipTrim(
    clipId: string,
    partial: Partial<Pick<VideoAudioClip, 'startMs' | 'endMs' | 'trimInMs' | 'trimOutMs'>>
  ): void

  // --- Editing operations (Phase 2.3) ---
  /**
   * Split a media clip at the given absolute timeline ms.
   * Returns the id of the newly created right-side clip, or null if:
   *   - clip not found
   *   - clip is a caption (split is not supported for captions in 2.3)
   *   - split position is outside [startMs+MIN, endMs-MIN]
   */
  splitClipAt(clipId: string, atMs: number): string | null
  /**
   * Deep-clone a clip and place the duplicate at the next free slot on the
   * same track. Works for BOTH media and caption clips. Returns the new
   * clip's id, or null if the source clip can't be found.
   */
  duplicateClip(clipId: string): string | null
  /**
   * Set a media clip's playback speed (clamped to [MIN_CLIP_SPEED,
   * MAX_CLIP_SPEED]). Keeps startMs and the source in/out range
   * (trimInMs..trimOutMs) fixed and recomputes endMs.
   * No-op for caption clips.
   */
  setClipSpeed(clipId: string, speed: number): void

  // --- Audio shaping (Phase 2.5, media clips only) ---
  /** Set a media clip's gain in dB, clamped to [MIN_GAIN_DB, MAX_GAIN_DB]. */
  setClipGainDb(clipId: string, db: number): void
  /** Set per-clip fade-in / fade-out (ms). Negatives rejected; clamped to
   *  the clip's own duration so fades never overlap. */
  setClipFade(clipId: string, fadeInMs: number, fadeOutMs: number): void
  /** Set per-clip mute. */
  setClipMuted(clipId: string, muted: boolean): void
  /**
   * Set a media clip's noise-reduction strength (0..100). 0 (or any value
   * clamping to <= 0) stores `undefined` (OFF — lean snapshots). Export-only;
   * the preview audio graph is untouched. No-op for non-media clips and for
   * non-finite inputs.
   */
  setClipNoiseReduction(clipId: string, strength: number): void
  /** Set track-wide mute. */
  setTrackMuted(trackId: string, muted: boolean): void
  /** Set track-wide solo. */
  setTrackSolo(trackId: string, solo: boolean): void
  /**
   * Remove silent sections from a media clip in one atomic step.
   * Splits the clip into the surviving voiced pieces. Returns the IDs of
   * the resulting clips (in timeline order), or [] if the clip is missing,
   * is not a media clip, or `ranges` is empty.
   */
  removeSilencesFromClip(clipId: string, ranges: SilenceRange[]): string[]
  /**
   * Ripple-close every gap on a single track: sort the track's clips by
   * `startMs`, then translate each clip so it butts directly against the
   * previous one (or, for the first clip, keeps its original `startMs`).
   * Per-clip duration is preserved exactly — only `startMs`/`endMs` shift; a
   * clip is NEVER pushed to the right (`shift` is clamped `>= 0`). Trims,
   * speed, keyframes, transitions etc. are untouched.
   * Returns the total milliseconds removed (sum of every clip's left-shift).
   */
  rippleCloseTrackGaps(trackId: string): number

  // --- Transitions + filters (Phase 2.6, media clips only) ---
  /** Set the incoming transition on a media clip. kind='none' clears it. */
  setClipTransitionIn(
    clipId: string,
    kind: TransitionKind,
    durationMs?: number
  ): void
  /** Set the filter preset + intensity (0..1) on a media clip. */
  setClipFilter(clipId: string, preset: FilterPreset, intensity?: number): void

  // --- Transform + layer compositing (Phase 3, media clips only) ---
  /**
   * Merge a partial transform onto a media clip, clamping each field. If the
   * merged result is identity, `transform` is set to `undefined` (keeps
   * persisted JSON + undo snapshots lean). No-op for caption clips and for
   * non-finite inputs.
   */
  setClipTransform(clipId: string, partial: Partial<ClipTransform>): void
  /** Clear a media clip's transform (back to identity). */
  resetClipTransform(clipId: string): void

  // --- Static source crop (Phase 3.6, media clips only) ---
  /**
   * Merge a partial crop rect onto a media clip, clamping with the SAME logic
   * as `getClipCropRect` (clamp to [0,1], floor w/h at MIN_CROP_SIZE, push
   * x/y inside the source frame). If the clamped result is identity (full
   * frame), `cropRect` is set to `undefined` (keeps persisted JSON + undo
   * snapshots lean). No-op for caption clips and for non-finite inputs.
   */
  setClipCrop(clipId: string, partial: Partial<CropRect>): void
  /** Clear a media clip's crop (back to full frame). */
  resetClipCrop(clipId: string): void

  // --- Manual color adjustment (Phase 3.7, media clips only) ---
  /**
   * Merge a partial color adjust onto a media clip, clamping each field to
   * [MIN_COLOR_ADJUST, MAX_COLOR_ADJUST]. If the merged result is neutral
   * (all zero), `colorAdjust` is set to `undefined` (keeps persisted JSON +
   * undo snapshots lean). No-op for caption clips and for non-finite inputs.
   */
  setClipColorAdjust(clipId: string, partial: Partial<ColorAdjust>): void
  /**
   * Auto color correction (Phase 3.15) — REPLACE a media clip's whole
   * `colorAdjust` with `clampColorAdjust(adjust)` (auto overwrites prior
   * manual values, unlike `setClipColorAdjust` which merges). A neutral
   * result collapses to `undefined`. No-op for caption clips and for
   * non-finite inputs. Produces exactly one zundo snapshot.
   */
  applyAutoColorAdjust(clipId: string, adjust: ColorAdjust): void
  /** Clear a media clip's color adjustment (back to neutral). */
  resetClipColorAdjust(clipId: string): void

  // --- Tone curves + HSL secondary grading (Phase 3.12, media clips only) ---
  /**
   * Update one tone-curve control point's x/y (each clamped to [0,1]) on a
   * media clip. The whole `curves` object is re-sanitized via
   * `sanitizeClipCurves`; an all-identity result is stored as `undefined`
   * (keeps persisted JSON + undo snapshots lean). No-op for caption clips,
   * for non-finite input, and when `pointIndex` is out of range.
   */
  setCurvePoint(
    clipId: string,
    channel: CurveChannelKey,
    pointIndex: number,
    p: Partial<CurvePoint>
  ): void
  /**
   * Insert a control point into one curve channel of a media clip. The
   * sanitizer sorts + dedupes. No-op for caption clips, for non-finite input,
   * and when the channel already holds MAX_CURVE_POINTS points.
   */
  addCurvePoint(
    clipId: string,
    channel: CurveChannelKey,
    p: CurvePoint
  ): void
  /**
   * Remove the control point at `pointIndex` from one curve channel of a
   * media clip. No-op when removal would drop the channel below
   * MIN_CURVE_POINTS, for caption clips, and when the index is out of range.
   */
  removeCurvePoint(
    clipId: string,
    channel: CurveChannelKey,
    pointIndex: number
  ): void
  /** Clear a media clip's tone curves (back to identity). */
  resetCurves(clipId: string): void
  /**
   * Merge a partial HslBandAdjust into one band of a media clip's HSL
   * grading, clamping each field to [MIN_HSL_ADJUST, MAX_HSL_ADJUST]. The
   * whole `hsl` object is re-sanitized; an all-neutral result is stored as
   * `undefined`. No-op for caption clips and for non-finite input.
   */
  setClipHslBand(
    clipId: string,
    band: HslBandKey,
    partial: Partial<HslBandAdjust>
  ): void
  /** Clear a media clip's HSL secondary grading (back to neutral). */
  resetClipHsl(clipId: string): void

  // --- Mosaic / blur regions (Phase 3.11, media clips only) ---
  /**
   * Append a new mosaic/blur region to a media clip — centered, ~30% of the
   * canvas, mosaic effect, default strength. No-op for non-media clips and
   * when the clip already has MAX_BLUR_REGIONS_PER_CLIP regions.
   */
  addBlurRegion(clipId: string): void
  /**
   * Merge a partial onto the region matched by `regionId`, then clamp/sanitize
   * the result via `clampBlurRegion`. No-op for non-media clips, when the
   * region is not found, and for non-finite numeric input.
   */
  updateBlurRegion(
    clipId: string,
    regionId: string,
    partial: Partial<BlurRegion>
  ): void
  /**
   * Drop the region matched by `regionId`. When the array becomes empty,
   * `blurRegions` is set to `undefined` (keeps persisted JSON + undo
   * snapshots lean). No-op for non-media clips and when not found.
   */
  removeBlurRegion(clipId: string, regionId: string): void

  // --- Motion tracks (Phase 3.13, media clips only) ---
  /**
   * Add OR replace (by id) a motion track on a media clip. Capped at
   * MAX_MOTION_TRACKS_PER_CLIP — silently no-op once full (when adding a NEW
   * track; replacing an existing id always succeeds). No-op for non-media
   * clips and when the clip is missing.
   */
  setMotionTrack(clipId: string, track: MotionTrack): void
  /**
   * Drop the motion track matched by `trackId`. ALSO clears every dangling
   * binding: any blur region on this clip, and any overlay / caption clip
   * across the project, whose `motionTrackId === trackId` is reset to
   * `undefined`. When the last track is removed, `motionTracks` is set to
   * `undefined` (NOT []). No-op for non-media clips and when not found.
   */
  removeMotionTrack(clipId: string, trackId: string): void
  /**
   * Bind (or unbind, with `null`) a blur region to a motion track on the same
   * clip. `null` clears the binding (field → `undefined`). No-op for non-media
   * clips and when the region is not found.
   */
  bindBlurRegionToTrack(
    clipId: string,
    regionId: string,
    trackId: string | null
  ): void
  /**
   * Bind (or unbind, with `null`) an overlay clip to a motion track. `null`
   * clears the binding. No-op when the overlay clip is missing.
   */
  bindOverlayToTrack(overlayClipId: string, trackId: string | null): void
  /**
   * Bind (or unbind, with `null`) a caption clip to a motion track. `null`
   * clears the binding. No-op when the caption clip is missing.
   */
  bindCaptionToTrack(captionClipId: string, trackId: string | null): void

  // --- Transform keyframe animation (Phase 3.5, media clips only) ---
  /**
   * Add a transform keyframe at a clip-relative `atMs`.
   *  - If the clip has NO active keyframe track yet: seed TWO keyframes (one
   *    at atMs 0, one at the requested atMs), both = the clip's current static
   *    transform — this satisfies the >= 2 invariant immediately.
   *  - If a track exists: insert ONE keyframe; its transform defaults to the
   *    interpolated value on the existing curve (no jump) unless `transform`
   *    overrides specific fields.
   * A keyframe within MIN_KEYFRAME_GAP_MS of an existing one REPLACES it.
   * Rejected when atMs<0, atMs>clip duration, or count>=MAX_KEYFRAMES_PER_CLIP.
   * No-op for caption clips.
   */
  addTransformKeyframe(
    clipId: string,
    atMs: number,
    transform?: Partial<ClipTransform>
  ): void
  /**
   * Merge into the keyframe at `kfIndex`: re-clamp atMs into [0, clipDuration],
   * merge + clamp the transform, then re-sort the track ascending by atMs.
   */
  updateTransformKeyframe(
    clipId: string,
    kfIndex: number,
    partial: { atMs?: number; transform?: Partial<ClipTransform> }
  ): void
  /**
   * Remove the keyframe at `kfIndex`. If removal would drop the track below 2
   * keyframes, the whole track is cleared and the surviving keyframe's
   * transform is written into the clip's static `transform` so the look holds.
   */
  removeTransformKeyframe(clipId: string, kfIndex: number): void
  /** Clear a clip's keyframe track entirely; keeps its static `transform`. */
  clearTransformKeyframes(clipId: string): void

  // --- Variable speed curve (Phase 3.10, media clips only) ---
  /**
   * Add a speed keyframe at a SOURCE offset `atMs` (ms from trimInMs).
   *  - If the clip has NO active speed curve yet: seed TWO keyframes (source
   *    offset 0 + the clip's full source span `trimOutMs-trimInMs`), both at
   *    the clip's current constant `speed` — this satisfies the >= 2 invariant.
   *  - If a curve exists: insert ONE keyframe; its speed defaults to the
   *    interpolated value on the existing curve (`getSpeedAt`) unless `speed`
   *    overrides it.
   * Rejected when atMs<0, atMs>(trimOutMs-trimInMs), or
   * count>=MAX_SPEED_KEYFRAMES_PER_CLIP. Recomputes endMs. No-op for captions.
   */
  addSpeedKeyframe(clipId: string, atMs: number, speed?: number): void
  /**
   * Merge into the speed keyframe at `kfIndex`: re-clamp atMs into [0,
   * srcDur], clamp speed, then re-normalize the curve. If it collapses below
   * 2 keyframes the curve is dropped and the survivor's speed is baked into
   * the clip's constant `speed`. Recomputes endMs.
   */
  updateSpeedKeyframe(
    clipId: string,
    kfIndex: number,
    partial: { atMs?: number; speed?: number }
  ): void
  /**
   * Remove the speed keyframe at `kfIndex`. If removal drops the curve below
   * 2 keyframes, the curve is cleared and the surviving keyframe's speed is
   * baked into the clip's constant `speed`. Recomputes endMs.
   */
  removeSpeedKeyframe(clipId: string, kfIndex: number): void
  /** Clear a clip's speed curve entirely; keeps its constant `speed`. */
  clearSpeedKeyframes(clipId: string): void

  /**
   * Append a video track immediately after the last existing video track.
   * Returns the new track's id, or null if already at MAX_VIDEO_TRACKS.
   */
  addVideoTrack(): string | null
  /** Remove a video track. No-op if it is the only video track. */
  removeVideoTrack(trackId: string): void

  // --- Generic track management (Phase 3 — timeline track context menu) ---
  /**
   * Rename a track. Trims whitespace; an empty/blank name is rejected
   * (no-op). No-op if the track is missing or the name is unchanged.
   */
  renameTrack(trackId: string, name: string): void
  /**
   * Add ONE track of the given kind, inserted next to its peers (video tracks
   * stay contiguous, audio after the last audio/video, caption/overlay at the
   * end). Optional `role` for audio tracks. Returns the new track's id, or
   * null when a per-kind cap (MAX_VIDEO_TRACKS / MAX_AUDIO_TRACKS) is hit.
   */
  addTrack(kind: TrackKind, role?: TrackRole): string | null
  /**
   * Add an auxiliary audio submix track (role='submix'). For now this is a
   * plain audio track marked as a submix bus; true routing (other tracks
   * feeding into it) is not yet wired. Returns the new track id, or null at
   * MAX_AUDIO_TRACKS.
   */
  addAudioSubmixTrack(): string | null
  /**
   * Add `count` tracks of the given kind in ONE atomic update. Stops early at
   * the per-kind cap. Returns the ids actually created (may be fewer than
   * `count`, or empty).
   */
  addTracks(kind: TrackKind, count: number, role?: TrackRole): string[]
  /**
   * Remove a single track by id. Guards: the last video track and the last
   * caption track cannot be removed. Returns true when a track was removed.
   */
  removeTrack(trackId: string): boolean
  /**
   * Remove several tracks in ONE atomic update. Applies the same guards as
   * `removeTrack` (always keeps ≥1 video track and ≥1 caption track).
   * Returns the ids actually removed.
   */
  removeTracks(trackIds: string[]): string[]

  /**
   * Resolve an audio track for dropping an audio clip, creating one if the
   * project has none. With `preferRole` an existing audio track of that role
   * is preferred. The new track is inserted right after the last existing
   * audio track (or after the last video track). Returns the track id.
   */
  ensureAudioTrack(preferRole?: 'voice' | 'bgm'): string

  // --- Captions (Phase 2.4) ---
  /** Append a caption clip to the caption track. */
  addCaption(caption: CaptionClip): void
  /**
   * Bulk-append caption clips in a single atomic store update.
   * Phase 3.3 prefill flow may add 50+ captions — using addCaption in a
   * loop would trigger N re-renders; this method coalesces to one.
   * Caption clips with a non-caption trackId are silently filtered out.
   */
  addCaptions(captions: CaptionClip[]): void
  /** Generic partial update for a caption clip. */
  updateCaption(captionId: string, partial: Partial<Omit<CaptionClip, 'id' | 'kind' | 'trackId'>>): void
  /** Remove a caption clip (alias of removeClip with kind guard). */
  removeCaption(captionId: string): void
  /** Get the id of the (first) caption track in the project. */
  getCaptionTrackId(): string | null

  // --- Overlay elements (Phase 3.8) ---
  /** Get the id of the (first) overlay track, or null if none exists yet. */
  getOverlayTrackId(): string | null
  /**
   * Return the (first) overlay track's id, creating one (appended after the
   * caption track) if the project has none. Lets old projects gain an
   * overlay track lazily on first overlay insert.
   */
  ensureOverlayTrack(): string
  /** Append an overlay clip; creates the overlay track if needed. */
  addOverlay(clip: OverlayClip): void
  /** Generic partial update for an overlay clip (mirrors `updateCaption`). */
  updateOverlay(
    overlayId: string,
    partial: Partial<Omit<OverlayClip, 'id' | 'kind' | 'trackId'>>
  ): void
  /** Remove an overlay clip (alias of removeClip with kind guard). */
  removeOverlay(overlayId: string): void

  /**
   * Replace the entire project with one loaded from disk. Used at startup.
   * Does NOT trigger a re-persist.
   */
  _hydrateFromDisk(project: Project): void
}

// ---------------------------------------------------------------------------
// Undo/redo (Phase 4.3) — zundo middleware.
//
// We track ONLY `state.project` (the persistent doc). UI ephemera
// (selectedClipIds, playheadMs, bpm, etc.) lives in a separate store
// (timelineUi) and is intentionally excluded.
//
// "Noisy" async-generated fields on media (thumbnailPath, waveformPath) are
// stripped before equality comparison so that thumbnail/waveform jobs that
// land 200–800ms after import don't pollute the history stack.
// ---------------------------------------------------------------------------
const UNDO_LIMIT = 100
const UNDO_THROTTLE_MS = 200

/** Minimal throttle: leading-edge with trailing flush. Avoids pulling in lodash. */
function makeThrottle<F extends (...args: never[]) => void>(fn: F, wait: number): F {
  let last = 0
  let pending: Parameters<F> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (pending) {
      last = Date.now()
      const args = pending
      pending = null
      timer = null
      fn(...args)
    } else {
      timer = null
    }
  }
  return ((...args: Parameters<F>) => {
    const now = Date.now()
    const remaining = wait - (now - last)
    if (remaining <= 0) {
      last = now
      pending = null
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      fn(...args)
    } else {
      pending = args
      if (!timer) timer = setTimeout(flush, remaining)
    }
  }) as F
}

interface ProjectSnapshot {
  project: Project
}

/**
 * Strip noisy async-generated metadata before equality comparison. We do NOT
 * use partialize for this — partialize would PERMANENTLY drop the fields
 * (undoing would unset thumbnails/waveforms). Instead we compare normalized
 * shapes so thumbnail-only deltas don't create a history entry.
 */
function stripNoisy(s: ProjectSnapshot): unknown {
  const p = s.project
  return {
    ...p,
    // updatedAt changes on every touch() call but isn't user-visible mutation.
    updatedAt: 0,
    media: Object.fromEntries(
      Object.entries(p.media).map(([id, m]) => [
        id,
        { ...m, thumbnailPath: undefined, waveformPath: undefined }
      ])
    )
  }
}

function snapshotsEqual(a: ProjectSnapshot, b: ProjectSnapshot): boolean {
  // JSON.stringify is plenty fast at this scale (a 100-clip project
  // serializes in <2ms; we only run this on each mutating set, throttled to
  // 200ms minimum). If it ever shows up in a profile, swap in fast-deep-equal.
  return JSON.stringify(stripNoisy(a)) === JSON.stringify(stripNoisy(b))
}

export const useProjectStore = create<ProjectStore>()(
  temporal(
    (set, get) => ({
  project: freshProject(),
  hydrated: false,

  createNew(): void {
    set({ project: freshProject() })
    schedulePersist(get().project)
    // A brand-new project should be the new baseline; previous history
    // shouldn't be undo-able. Defer to next tick so the just-issued
    // set() lands before clear (avoids the new project itself sneaking into
    // pastStates).
    // Push past the throttle window so any in-flight trailing-edge entry
    // for the just-issued set() lands before we wipe the stack.
    setTimeout(
      () => useProjectStore.temporal.getState().clear(),
      UNDO_THROTTLE_MS + 50
    )
  },

  setName(name: string): void {
    const trimmed = (name ?? '').slice(0, 200)
    const next = touch({ ...get().project, name: trimmed })
    set({ project: next })
    schedulePersist(next)
  },

  setAspectRatio(ratio: AspectRatio): void {
    const dims = ASPECT_RATIO_DIMENSIONS[ratio]
    if (!dims) return
    const next = touch({
      ...get().project,
      aspectRatio: ratio,
      width: dims.width,
      height: dims.height
    })
    set({ project: next })
    schedulePersist(next)
  },

  addMedia(asset: MediaAsset): void {
    const project = get().project
    const next = touch({
      ...project,
      media: { ...project.media, [asset.id]: asset }
    })
    set({ project: next })
    schedulePersist(next)
  },

  updateMediaThumbnail(mediaId: string, thumbnailPath: string): void {
    const project = get().project
    const existing = project.media[mediaId]
    if (!existing) return
    const next = touch({
      ...project,
      media: {
        ...project.media,
        [mediaId]: { ...existing, thumbnailPath }
      }
    })
    set({ project: next })
    schedulePersist(next)
  },

  updateMediaWaveform(mediaId: string, waveformPath: string): void {
    const project = get().project
    const existing = project.media[mediaId]
    if (!existing) return
    const next = touch({
      ...project,
      media: {
        ...project.media,
        [mediaId]: { ...existing, waveformPath }
      }
    })
    set({ project: next })
    schedulePersist(next)
  },

  removeMedia(mediaId: string): void {
    const project = get().project
    if (!project.media[mediaId]) return
    const nextMedia = { ...project.media }
    delete nextMedia[mediaId]
    // Also drop media-clips referencing this media. Caption clips are NEVER
    // dropped here — they have no mediaId.
    const nextTracks = project.tracks.map((t) => ({
      ...t,
      clips: t.clips.filter((c) => {
        if (isMediaClip(c)) return c.mediaId !== mediaId
        return true
      })
    }))
    const next = touch({ ...project, media: nextMedia, tracks: nextTracks })
    set({ project: next })
    schedulePersist(next)
  },

  addClip(clip: Clip): void {
    const project = get().project
    const trackIdx = project.tracks.findIndex((t) => t.id === clip.trackId)
    if (trackIdx === -1) return
    // Enforce a track-kind ↔ clip-kind match matrix (belt-and-suspenders
    // against UI bugs):
    //   - video/audio track  ↔ media clip
    //   - caption track      ↔ caption clip
    //   - overlay track      ↔ overlay clip
    const track = project.tracks[trackIdx]
    const accepts =
      track.kind === 'caption'
        ? clip.kind === 'caption'
        : track.kind === 'overlay'
          ? clip.kind === 'overlay'
          : clip.kind === 'media'
    if (!accepts) return

    const tracks = [...project.tracks]
    tracks[trackIdx] = {
      ...tracks[trackIdx],
      clips: [...tracks[trackIdx].clips, clip]
    }
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeClip(clipId: string): void {
    const project = get().project
    let touched = false
    const tracks = project.tracks.map((t) => {
      const before = t.clips.length
      const clips = t.clips.filter((c) => c.id !== clipId)
      if (clips.length !== before) touched = true
      return { ...t, clips }
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  updateMediaClipTrim(clipId, partial): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const cur = t.clips[idx]
      if (!isMediaClip(cur)) return t
      const merged: VideoAudioClip = { ...cur, ...partial }
      if (merged.startMs < 0) merged.startMs = 0
      if (merged.endMs <= merged.startMs) merged.endMs = merged.startMs + 1
      if (merged.trimInMs < 0) merged.trimInMs = 0
      const clips = [...t.clips]
      clips[idx] = merged
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --- Editing operations (Phase 2.3) ---
  splitClipAt(clipId: string, atMs: number): string | null {
    const project = get().project
    let trackIdx = -1
    let clipIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      const found = project.tracks[i].clips.findIndex((c) => c.id === clipId)
      if (found !== -1) {
        trackIdx = i
        clipIdx = found
        break
      }
    }
    if (trackIdx === -1 || clipIdx === -1) return null
    const orig = project.tracks[trackIdx].clips[clipIdx]
    // Split is only supported for media clips in Phase 2.3.
    if (!isMediaClip(orig)) return null
    // Must be strictly inside the clip, with at least MIN_CLIP_MS on each side.
    if (atMs <= orig.startMs + MIN_CLIP_MS) return null
    if (atMs >= orig.endMs - MIN_CLIP_MS) return null

    const speed = orig.speed ?? 1
    // Source-time offset from orig.trimInMs for the split point. Phase 3.10 —
    // a curve clip's timeline⇄source mapping is non-linear, so map the split's
    // TIMELINE offset through the inverse integral instead of `*speed`.
    const offsetSourceMs = hasSpeedCurve(orig)
      ? sourceOffsetForTimelineOffset(orig, atMs - orig.startMs)
      : (atMs - orig.startMs) * speed
    const splitSource = orig.trimInMs + offsetSourceMs
    const newRightId = ulid()
    // -------------------------------------------------------------------
    // Phase 3.5 — keyframe split handling. CHOSEN APPROACH: partition +
    // re-base. Keyframes are clip-relative, so on split we (1) partition by
    // the clip-relative split offset, (2) re-base the right half's atMs by
    // subtracting that offset, and (3) inject a boundary keyframe (the
    // interpolated value AT the split point) into both halves so neither
    // half jumps. If either half ends up with < 2 keyframes the track is
    // collapsed to a static transform (the value at that half's midpoint).
    // -------------------------------------------------------------------
    let leftKfs: TransformKeyframe[] | undefined
    let rightKfs: TransformKeyframe[] | undefined
    let leftStaticTransform = orig.transform
    let rightStaticTransform = orig.transform
    if (hasTransformKeyframes(orig)) {
      const splitOffsetLocalMs = atMs - orig.startMs
      const boundary = clampClipTransform(getTransformAt(orig, atMs))
      const all = orig.transformKeyframes as TransformKeyframe[]
      // Left half keeps keyframes at/before the split offset + the boundary.
      const leftRaw: TransformKeyframe[] = [
        ...all.filter((kf) => kf.atMs <= splitOffsetLocalMs),
        { atMs: splitOffsetLocalMs, transform: { ...boundary } }
      ]
      // Right half keeps keyframes at/after the split offset, re-based to 0,
      // plus a boundary keyframe at re-based 0.
      const rightRaw: TransformKeyframe[] = [
        { atMs: 0, transform: { ...boundary } },
        ...all
          .filter((kf) => kf.atMs >= splitOffsetLocalMs)
          .map((kf) => ({
            atMs: kf.atMs - splitOffsetLocalMs,
            transform: { ...kf.transform }
          }))
      ]
      const leftNorm = normalizeKeyframes(leftRaw)
      const rightNorm = normalizeKeyframes(rightRaw)
      if (leftNorm.length >= 2) {
        leftKfs = leftNorm
      } else {
        // Degenerate — bake to the left half's midpoint value.
        const baked = clampClipTransform(
          getTransformAt(orig, (orig.startMs + atMs) / 2)
        )
        leftStaticTransform = isIdentityTransform(baked) ? undefined : baked
      }
      if (rightNorm.length >= 2) {
        rightKfs = rightNorm
      } else {
        const baked = clampClipTransform(
          getTransformAt(orig, (atMs + orig.endMs) / 2)
        )
        rightStaticTransform = isIdentityTransform(baked) ? undefined : baked
      }
    }
    // -------------------------------------------------------------------
    // Phase 3.10 — speed-curve split handling. PARALLEL to the transform-
    // keyframe partition above, but speed keyframes' atMs are SOURCE offsets
    // (ms from trimInMs). `offsetSourceMs` is the split's source offset within
    // the ORIGINAL clip. Left keeps keyframes at/before it; right keeps those
    // at/after, re-based by `-offsetSourceMs` (the right clip's trimInMs
    // becomes splitSource). A boundary keyframe (the speed AT the split) is
    // synthesized on both sides so neither half jumps. If a half collapses
    // below 2 keyframes its curve is dropped + the survivor's speed baked into
    // the constant `speed`.
    // -------------------------------------------------------------------
    let leftSpeedKfs: SpeedKeyframe[] | undefined
    let rightSpeedKfs: SpeedKeyframe[] | undefined
    let leftSpeed = orig.speed
    let rightSpeed = orig.speed
    if (hasSpeedCurve(orig)) {
      const boundarySpeed = getSpeedAt(orig, offsetSourceMs)
      const allSp = orig.speedKeyframes as SpeedKeyframe[]
      const leftSpRaw: SpeedKeyframe[] = [
        ...allSp.filter((kf) => kf.atMs <= offsetSourceMs),
        { atMs: offsetSourceMs, speed: boundarySpeed }
      ]
      const rightSpRaw: SpeedKeyframe[] = [
        { atMs: 0, speed: boundarySpeed },
        ...allSp
          .filter((kf) => kf.atMs >= offsetSourceMs)
          .map((kf) => ({ atMs: kf.atMs - offsetSourceMs, speed: kf.speed }))
      ]
      const leftSpNorm = normalizeSpeedKeyframes(leftSpRaw)
      const rightSpNorm = normalizeSpeedKeyframes(rightSpRaw)
      if (leftSpNorm.length >= 2) {
        leftSpeedKfs = leftSpNorm
      } else {
        // Degenerate — bake the surviving speed into the constant field.
        leftSpeed = leftSpNorm[0]?.speed ?? boundarySpeed
      }
      if (rightSpNorm.length >= 2) {
        rightSpeedKfs = rightSpNorm
      } else {
        rightSpeed = rightSpNorm[0]?.speed ?? boundarySpeed
      }
    }
    // Phase 3.6 — `cropRect` is a SOURCE-fraction rect, so the {...orig}
    // spread below carries it unchanged to both halves (every same-source
    // descendant samples the identical sub-region). No crop-specific handling.
    const left: VideoAudioClip = recomputeEndMsForSpeed({
      ...orig,
      endMs: atMs,
      trimOutMs: splitSource,
      transform: leftStaticTransform,
      transformKeyframes: leftKfs,
      speed: leftSpeed,
      speedKeyframes: leftSpeedKfs
    })
    const right: VideoAudioClip = recomputeEndMsForSpeed({
      ...orig,
      id: newRightId,
      startMs: atMs,
      trimInMs: splitSource,
      transform: rightStaticTransform,
      transformKeyframes: rightKfs,
      speed: rightSpeed,
      speedKeyframes: rightSpeedKfs
    })
    const tracks = project.tracks.map((t, i) => {
      if (i !== trackIdx) return t
      const clips = [...t.clips]
      clips.splice(clipIdx, 1, left, right)
      return { ...t, clips }
    })
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return newRightId
  },

  duplicateClip(clipId: string): string | null {
    const project = get().project
    let trackIdx = -1
    let orig: Clip | null = null
    for (let i = 0; i < project.tracks.length; i++) {
      const c = project.tracks[i].clips.find((cc) => cc.id === clipId)
      if (c) {
        trackIdx = i
        orig = c
        break
      }
    }
    if (trackIdx === -1 || !orig) return null
    const duration = orig.endMs - orig.startMs
    const desired = orig.endMs

    // Find a free slot on the same track (lane-overlap walk).
    const sorted = [...project.tracks[trackIdx].clips]
      .filter((c) => c.id !== orig!.id)
      .sort((a, b) => a.startMs - b.startMs)
    let start = Math.max(0, desired)
    for (let i = 0; i <= sorted.length; i++) {
      let collided = false
      for (const c of sorted) {
        if (start < c.endMs && start + duration > c.startMs) {
          start = c.endMs
          collided = true
          break
        }
      }
      if (!collided) break
    }
    const newClipId = ulid()
    // Deep-copy: spread covers all surface fields. For caption clips we need
    // to clone the nested spans + style so future edits to the duplicate
    // don't mutate the original. Overlay clips need their `source` cloned
    // (shape overlays carry a nested `style`). Media clips have no nested
    // mutable refs.
    let dup: Clip
    if (isCaptionClip(orig)) {
      dup = {
        ...orig,
        id: newClipId,
        startMs: start,
        endMs: start + duration,
        spans: orig.spans.map((s) => ({ ...s })),
        style: { ...orig.style }
      }
    } else if (isOverlayClip(orig)) {
      dup = {
        ...orig,
        id: newClipId,
        startMs: start,
        endMs: start + duration,
        source:
          orig.source.type === 'shape'
            ? { ...orig.source, style: { ...orig.source.style } }
            : { ...orig.source }
      }
    } else {
      dup = {
        ...orig,
        id: newClipId,
        startMs: start,
        endMs: start + duration
      }
    }
    const tracks = project.tracks.map((t, i) => {
      if (i !== trackIdx) return t
      return { ...t, clips: [...t.clips, dup] }
    })
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return newClipId
  },

  /**
   * Set a media clip's CONSTANT playback speed. Phase 3.10 — when the clip
   * currently has a variable speed curve, the curve is FIRST dropped (the
   * user explicitly chose a single constant speed), then the constant is
   * applied. endMs is recomputed via `getClipTimelineDuration` (constant
   * math once the curve is gone).
   */
  setClipSpeed(clipId: string, speed: number): void {
    const project = get().project
    const clamped = Math.max(MIN_CLIP_SPEED, Math.min(MAX_CLIP_SPEED, speed))
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Speed is a media-only concept; silently ignore captions.
      if (!isMediaClip(c)) return t
      // Phase 3.10 — the user explicitly chose a constant speed: drop any
      // variable speed curve FIRST, then apply the constant + recompute endMs.
      const updated: VideoAudioClip = recomputeEndMsForSpeed({
        ...c,
        speed: clamped,
        speedKeyframes: undefined
      })
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Audio shaping (Phase 2.5). Media clips only — caption clips ignored.
  // --------------------------------------------------------------------
  setClipGainDb(clipId: string, db: number): void {
    const numeric = Number(db)
    if (!Number.isFinite(numeric)) return
    const clamped = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, numeric))
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if ((c.gainDb ?? 0) === clamped) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, gainDb: clamped }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipFade(clipId: string, fadeInMs: number, fadeOutMs: number): void {
    const fin = Number(fadeInMs)
    const fout = Number(fadeOutMs)
    if (!Number.isFinite(fin) || !Number.isFinite(fout)) return
    // Reject negatives — no-op rather than clamp (caller bug → loud failure mode).
    if (fin < 0 || fout < 0) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const dur = Math.max(0, c.endMs - c.startMs)
      // Clamp each fade to the clip duration; then ensure fadeIn+fadeOut <= duration.
      let a = Math.min(fin, dur)
      let b = Math.min(fout, dur)
      if (a + b > dur) {
        // Proportional shrink.
        const ratio = dur / (a + b)
        a = Math.floor(a * ratio)
        b = Math.floor(b * ratio)
      }
      if ((c.fadeInMs ?? 0) === a && (c.fadeOutMs ?? 0) === b) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, fadeInMs: a, fadeOutMs: b }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipMuted(clipId: string, muted: boolean): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if (Boolean(c.isMuted) === Boolean(muted)) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, isMuted: Boolean(muted) }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipNoiseReduction(clipId: string, strength: number): void {
    const numeric = Number(strength)
    if (!Number.isFinite(numeric)) return
    const clamped = Math.max(
      MIN_NOISE_REDUCTION,
      Math.min(MAX_NOISE_REDUCTION, numeric)
    )
    // Store `undefined` when OFF (clamped <= 0) — keeps persisted JSON + undo
    // snapshots lean, mirroring setClipColorAdjust's neutral-collapse.
    const nextVal = clamped <= 0 ? undefined : Math.round(clamped)
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if ((c.noiseReduction ?? undefined) === nextVal) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, noiseReduction: nextVal }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setTrackMuted(trackId: string, muted: boolean): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      if (t.id !== trackId) return t
      if (Boolean(t.muted) === Boolean(muted)) return t
      changed = true
      return { ...t, muted: Boolean(muted) }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setTrackSolo(trackId: string, solo: boolean): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      if (t.id !== trackId) return t
      if (Boolean(t.solo) === Boolean(solo)) return t
      changed = true
      return { ...t, solo: Boolean(solo) }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeSilencesFromClip(clipId: string, ranges: SilenceRange[]): string[] {
    if (!Array.isArray(ranges) || ranges.length === 0) return []
    const project = get().project
    let trackIdx = -1
    let clipIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      const idx = project.tracks[i].clips.findIndex((c) => c.id === clipId)
      if (idx !== -1) {
        trackIdx = i
        clipIdx = idx
        break
      }
    }
    if (trackIdx === -1 || clipIdx === -1) return []
    const orig = project.tracks[trackIdx].clips[clipIdx]
    if (!isMediaClip(orig)) return []

    const speed = orig.speed ?? 1
    const origHasCurve = hasSpeedCurve(orig)
    // Forward map: SOURCE offset (ms from orig.trimInMs) → TIMELINE offset
    // (ms from orig.startMs). Constant clip → linear (/speed). Curve clip →
    // the integral of 1/speed up to that source offset, obtained by measuring
    // the timeline duration of a virtual clip trimmed to [trimInMs, here].
    const srcOffsetToTimelineOffset = (srcOff: number): number => {
      if (!origHasCurve) return srcOff / speed
      const clamped = Math.max(0, srcOff)
      return getClipTimelineDuration({
        ...orig,
        trimOutMs: orig.trimInMs + clamped
      })
    }
    // Translate source-time silence ranges to TIMELINE ranges relative to the
    // clip. silencedetect emits source-time seconds; we received ms here.
    // src_t = trimInMs + (timeline_t - startMs) * speed   (constant case)
    //      => timeline_t = startMs + (src_t - trimInMs) / speed
    const localRanges: { startMs: number; endMs: number }[] = []
    for (const r of ranges) {
      // Normalize + clamp into the clip's source window.
      const sStart = Math.max(orig.trimInMs, Math.min(orig.trimOutMs, r.startMs))
      const sEnd = Math.max(orig.trimInMs, Math.min(orig.trimOutMs, r.endMs))
      if (sEnd <= sStart) continue
      const tStart =
        orig.startMs + srcOffsetToTimelineOffset(sStart - orig.trimInMs)
      const tEnd =
        orig.startMs + srcOffsetToTimelineOffset(sEnd - orig.trimInMs)
      localRanges.push({
        startMs: Math.round(tStart),
        endMs: Math.round(tEnd)
      })
    }
    if (localRanges.length === 0) return []
    // Sort + merge overlapping ranges.
    localRanges.sort((a, b) => a.startMs - b.startMs)
    const merged: { startMs: number; endMs: number }[] = []
    for (const r of localRanges) {
      const last = merged[merged.length - 1]
      if (last && r.startMs <= last.endMs) {
        if (r.endMs > last.endMs) last.endMs = r.endMs
      } else {
        merged.push({ startMs: r.startMs, endMs: r.endMs })
      }
    }
    // Build the surviving (voiced) timeline segments.
    const survivors: { startMs: number; endMs: number }[] = []
    let cursor = orig.startMs
    for (const m of merged) {
      if (m.startMs > cursor) {
        survivors.push({ startMs: cursor, endMs: Math.min(orig.endMs, m.startMs) })
      }
      cursor = Math.max(cursor, m.endMs)
    }
    if (cursor < orig.endMs) {
      survivors.push({ startMs: cursor, endMs: orig.endMs })
    }
    // Drop survivors shorter than MIN_CLIP_MS.
    const usable = survivors.filter((s) => s.endMs - s.startMs >= MIN_CLIP_MS)
    if (usable.length === 0) {
      // Everything was silence — drop the clip entirely.
      const tracks = project.tracks.map((t, i) => {
        if (i !== trackIdx) return t
        const clips = [...t.clips]
        clips.splice(clipIdx, 1)
        return { ...t, clips }
      })
      const next = touch({ ...project, tracks })
      set({ project: next })
      schedulePersist(next)
      return []
    }
    // Compose new media clips. Each survivor is a fresh clip referencing the
    // same media; trimInMs/trimOutMs are derived from the timeline window.
    // Phase 3.10 — when the original carries a speed curve, map each
    // survivor's timeline window through the inverse integral to get source
    // offsets, then partition `speedKeyframes` per piece (parallel to the
    // splitClipAt logic) and recompute endMs via `getClipTimelineDuration`.
    const ids: string[] = []
    const built: VideoAudioClip[] = usable.map((s) => {
      const id = ulid()
      ids.push(id)
      // Source offsets (ms from orig.trimInMs) of this survivor's edges.
      const srcOffStart = origHasCurve
        ? sourceOffsetForTimelineOffset(orig, s.startMs - orig.startMs)
        : (s.startMs - orig.startMs) * speed
      const srcOffEnd = origHasCurve
        ? sourceOffsetForTimelineOffset(orig, s.endMs - orig.startMs)
        : (s.endMs - orig.startMs) * speed
      const trimIn = orig.trimInMs + srcOffStart
      const trimOut = orig.trimInMs + srcOffEnd
      let pieceSpeed = orig.speed
      let pieceSpeedKfs: SpeedKeyframe[] | undefined
      if (origHasCurve) {
        const allSp = orig.speedKeyframes as SpeedKeyframe[]
        // Keep keyframes inside [srcOffStart, srcOffEnd], re-based to the
        // piece's own trimInMs, plus boundary keyframes at both edges.
        const raw: SpeedKeyframe[] = [
          { atMs: 0, speed: getSpeedAt(orig, srcOffStart) },
          ...allSp
            .filter((kf) => kf.atMs > srcOffStart && kf.atMs < srcOffEnd)
            .map((kf) => ({ atMs: kf.atMs - srcOffStart, speed: kf.speed })),
          {
            atMs: srcOffEnd - srcOffStart,
            speed: getSpeedAt(orig, srcOffEnd)
          }
        ]
        const norm = normalizeSpeedKeyframes(raw)
        if (norm.length >= 2) {
          pieceSpeedKfs = norm
        } else {
          // Degenerate piece — bake the surviving speed into the constant.
          pieceSpeed = norm[0]?.speed ?? getSpeedAt(orig, srcOffStart)
        }
      }
      return recomputeEndMsForSpeed({
        ...orig,
        id,
        startMs: s.startMs,
        endMs: s.endMs,
        trimInMs: Math.max(0, Math.round(trimIn)),
        trimOutMs: Math.max(0, Math.round(trimOut)),
        speed: pieceSpeed,
        speedKeyframes: pieceSpeedKfs
      })
    })
    const tracks = project.tracks.map((t, i) => {
      if (i !== trackIdx) return t
      const clips = [...t.clips]
      clips.splice(clipIdx, 1, ...built)
      return { ...t, clips }
    })
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return ids
  },

  rippleCloseTrackGaps(trackId: string): number {
    const project = get().project
    const trackIdx = project.tracks.findIndex((t) => t.id === trackId)
    if (trackIdx === -1) return 0
    const track = project.tracks[trackIdx]
    if (track.clips.length === 0) return 0

    // Work on a startMs-sorted copy; the first clip anchors the timeline.
    const ordered = [...track.clips].sort((a, b) => a.startMs - b.startMs)
    let cursor = ordered[0].startMs
    let totalRemoved = 0
    let changed = false

    // Map clip id → translated {startMs,endMs} so we can rebuild in the
    // ORIGINAL clips[] order (only positions move; order is preserved).
    const shifted = new Map<string, { startMs: number; endMs: number }>()
    for (const clip of ordered) {
      // Never push a clip right — a clip already at/behind the cursor keeps
      // its position and simply advances the cursor.
      const shift = Math.max(0, clip.startMs - cursor)
      const newStart = clip.startMs - shift
      const newEnd = clip.endMs - shift
      if (shift > 0) {
        totalRemoved += shift
        changed = true
      }
      shifted.set(clip.id, { startMs: newStart, endMs: newEnd })
      cursor = newEnd
    }
    if (!changed) return 0

    const tracks = project.tracks.map((t, i) => {
      if (i !== trackIdx) return t
      const clips = t.clips.map((c) => {
        const pos = shifted.get(c.id)
        if (!pos || (pos.startMs === c.startMs && pos.endMs === c.endMs)) {
          return c
        }
        // Only translate the timeline window — per-clip duration is preserved
        // exactly; trims/speed/keyframes/transitions are untouched.
        return { ...c, startMs: pos.startMs, endMs: pos.endMs }
      })
      return { ...t, clips }
    })
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return totalRemoved
  },

  // --------------------------------------------------------------------
  // Transitions + filters (Phase 2.6) — media clips only.
  // --------------------------------------------------------------------
  setClipTransitionIn(clipId, kind, durationMs): void {
    const project = get().project
    const dur = Math.max(
      MIN_TRANSITION_MS,
      Math.min(
        MAX_TRANSITION_MS,
        Math.round(Number(durationMs ?? DEFAULT_TRANSITION_MS))
      )
    )
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const updated: VideoAudioClip =
        kind === 'none'
          ? { ...c, transitionIn: undefined }
          : { ...c, transitionIn: { kind, durationMs: dur } }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipFilter(clipId, preset, intensity): void {
    const project = get().project
    const clamped = Math.max(0, Math.min(1, Number(intensity ?? 1)))
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const updated: VideoAudioClip =
        preset === 'none'
          ? { ...c, filterPreset: 'none', filterIntensity: 1 }
          : { ...c, filterPreset: preset, filterIntensity: clamped }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Transform + layer compositing (Phase 3) — media clips only.
  // --------------------------------------------------------------------
  setClipTransform(clipId, partial): void {
    if (!partial || typeof partial !== 'object') return
    // Reject any non-finite numeric input outright (caller bug → no-op).
    for (const v of Object.values(partial)) {
      if (v !== undefined && !Number.isFinite(v)) return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Transform applies to media + overlay clips; ignore captions.
      if (!isMediaClip(c) && !isOverlayClip(c)) return t
      const merged: ClipTransform = { ...getClipTransform(c), ...partial }
      // Clamp each field to its allowed range.
      merged.scale = Math.max(
        MIN_TRANSFORM_SCALE,
        Math.min(MAX_TRANSFORM_SCALE, merged.scale)
      )
      merged.rotation = Math.max(
        MIN_TRANSFORM_ROTATION,
        Math.min(MAX_TRANSFORM_ROTATION, merged.rotation)
      )
      merged.opacity = Math.max(0, Math.min(1, merged.opacity))
      merged.x = Math.max(
        MIN_TRANSFORM_OFFSET,
        Math.min(MAX_TRANSFORM_OFFSET, merged.x)
      )
      merged.y = Math.max(
        MIN_TRANSFORM_OFFSET,
        Math.min(MAX_TRANSFORM_OFFSET, merged.y)
      )
      const updated: VideoAudioClip | OverlayClip = isIdentityTransform(merged)
        ? { ...c, transform: undefined }
        : { ...c, transform: merged }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  resetClipTransform(clipId: string): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c) && !isOverlayClip(c)) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, transform: undefined }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Static source crop (Phase 3.6) — media clips only.
  // --------------------------------------------------------------------
  setClipCrop(clipId, partial): void {
    if (!partial || typeof partial !== 'object') return
    // Reject any non-finite numeric input outright (caller bug → no-op).
    for (const v of Object.values(partial)) {
      if (v !== undefined && !Number.isFinite(v)) return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Crop is a media-only concept; silently ignore captions.
      if (!isMediaClip(c)) return t
      const merged = clampCropRect({ ...(c.cropRect ?? IDENTITY_CROP), ...partial })
      const updated: VideoAudioClip = isIdentityCrop(merged)
        ? { ...c, cropRect: undefined }
        : { ...c, cropRect: merged }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  resetClipCrop(clipId: string): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, cropRect: undefined }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Manual color adjustment (Phase 3.7) — media clips only.
  // --------------------------------------------------------------------
  setClipColorAdjust(clipId, partial): void {
    if (!partial || typeof partial !== 'object') return
    // Reject any non-finite numeric input outright (caller bug → no-op).
    for (const v of Object.values(partial)) {
      if (v !== undefined && !Number.isFinite(v)) return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Color adjust is a media-only concept; silently ignore captions.
      if (!isMediaClip(c)) return t
      const merged = clampColorAdjust({
        ...(c.colorAdjust ?? NEUTRAL_COLOR_ADJUST),
        ...partial
      })
      const updated: VideoAudioClip = isNeutralColorAdjust(merged)
        ? { ...c, colorAdjust: undefined }
        : { ...c, colorAdjust: merged }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  applyAutoColorAdjust(clipId, adjust): void {
    if (!adjust || typeof adjust !== 'object') return
    // Reject any non-finite numeric input outright (caller bug → no-op).
    for (const v of Object.values(adjust)) {
      if (!Number.isFinite(v)) return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Color adjust is a media-only concept; silently ignore captions.
      if (!isMediaClip(c)) return t
      // REPLACE the whole colorAdjust — auto overwrites prior manual values
      // (unlike setClipColorAdjust which merges a partial onto the current).
      const replaced = clampColorAdjust(adjust)
      const updated: VideoAudioClip = isNeutralColorAdjust(replaced)
        ? { ...c, colorAdjust: undefined }
        : { ...c, colorAdjust: replaced }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  resetClipColorAdjust(clipId: string): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, colorAdjust: undefined }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Tone curves + HSL secondary grading (Phase 3.12) — media clips only.
  //
  // Every mutation re-sanitizes the whole field (sanitizeClipCurves /
  // sanitizeClipHsl) so the stored object is canonical, then neutral-
  // collapses (identity curves / neutral HSL → `undefined`) — keeping the
  // persisted JSON + undo snapshots lean and the export byte-identical for
  // un-graded clips. Mirrors setClipColorAdjust's structure exactly.
  // --------------------------------------------------------------------
  setCurvePoint(clipId, channel, pointIndex, p): void {
    if (!p || typeof p !== 'object') return
    // Reject any non-finite numeric input outright (caller bug → no-op).
    for (const v of Object.values(p)) {
      if (v !== undefined && !Number.isFinite(v)) return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Curves are a media-only concept; silently ignore captions.
      if (!isMediaClip(c)) return t
      // Base on the clip's curves, or identity when it has none.
      const base = sanitizeClipCurves(c.curves ?? IDENTITY_CLIP_CURVES)
      const pts = base[channel]
      if (!pts || pointIndex < 0 || pointIndex >= pts.length) return t
      const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
      const nextPts = pts.map((pt, i) =>
        i === pointIndex
          ? {
              x: clamp01(p.x !== undefined ? p.x : pt.x),
              y: clamp01(p.y !== undefined ? p.y : pt.y)
            }
          : pt
      )
      const merged = sanitizeClipCurves({ ...base, [channel]: nextPts })
      const updated: VideoAudioClip = isIdentityClipCurves(merged)
        ? { ...c, curves: undefined }
        : { ...c, curves: merged }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  addCurvePoint(clipId, channel, p): void {
    if (!p || typeof p !== 'object') return
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const base = sanitizeClipCurves(c.curves ?? IDENTITY_CLIP_CURVES)
      // Hard cap — silently no-op once full.
      if (base[channel].length >= MAX_CURVE_POINTS) return t
      const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
      const inserted: CurvePoint[] = [
        ...base[channel],
        { x: clamp01(p.x), y: clamp01(p.y) }
      ]
      // sanitizeClipCurves sorts + dedupes the inserted point.
      const merged = sanitizeClipCurves({ ...base, [channel]: inserted })
      const updated: VideoAudioClip = isIdentityClipCurves(merged)
        ? { ...c, curves: undefined }
        : { ...c, curves: merged }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeCurvePoint(clipId, channel, pointIndex): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const base = sanitizeClipCurves(c.curves ?? IDENTITY_CLIP_CURVES)
      const pts = base[channel]
      if (pointIndex < 0 || pointIndex >= pts.length) return t
      // Refuse to drop below the minimum point count.
      if (pts.length <= MIN_CURVE_POINTS) return t
      const nextPts = pts.filter((_, i) => i !== pointIndex)
      const merged = sanitizeClipCurves({ ...base, [channel]: nextPts })
      const updated: VideoAudioClip = isIdentityClipCurves(merged)
        ? { ...c, curves: undefined }
        : { ...c, curves: merged }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  resetCurves(clipId: string): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, curves: undefined }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipHslBand(clipId, band, partial): void {
    if (!partial || typeof partial !== 'object') return
    // Reject any non-finite numeric input outright (caller bug → no-op).
    for (const v of Object.values(partial)) {
      if (v !== undefined && !Number.isFinite(v)) return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // HSL is a media-only concept; silently ignore captions.
      if (!isMediaClip(c)) return t
      const base = sanitizeClipHsl(c.hsl ?? NEUTRAL_CLIP_HSL)
      const clampAdj = (v: number): number =>
        Math.min(MAX_HSL_ADJUST, Math.max(MIN_HSL_ADJUST, v))
      const cur = base[band] ?? { ...NEUTRAL_HSL_BAND }
      const nextBand: HslBandAdjust = {
        hue: clampAdj(partial.hue !== undefined ? partial.hue : cur.hue),
        saturation: clampAdj(
          partial.saturation !== undefined ? partial.saturation : cur.saturation
        ),
        luminance: clampAdj(
          partial.luminance !== undefined ? partial.luminance : cur.luminance
        )
      }
      const merged = sanitizeClipHsl({ ...base, [band]: nextBand })
      const updated: VideoAudioClip = isNeutralClipHsl(merged)
        ? { ...c, hsl: undefined }
        : { ...c, hsl: merged }
      const clips = [...t.clips]
      clips[idx] = updated
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  resetClipHsl(clipId: string): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, hsl: undefined }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Mosaic / blur regions (Phase 3.11) — media clips only.
  // --------------------------------------------------------------------
  addBlurRegion(clipId: string): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Blur regions are a media-only concept; silently ignore captions.
      if (!isMediaClip(c)) return t
      // Hard cap — silently no-op once full.
      if ((c.blurRegions?.length ?? 0) >= MAX_BLUR_REGIONS_PER_CLIP) return t
      const region: BlurRegion = {
        id: newId(),
        shape: 'rectangle',
        effect: DEFAULT_BLUR_EFFECT,
        strength: DEFAULT_BLUR_STRENGTH,
        ...DEFAULT_BLUR_REGION_RECT
      }
      const clips = [...t.clips]
      clips[idx] = { ...c, blurRegions: [...(c.blurRegions ?? []), region] }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  updateBlurRegion(clipId, regionId, partial): void {
    if (!partial || typeof partial !== 'object') return
    // Reject any non-finite numeric input outright (caller bug → no-op).
    for (const v of Object.values(partial)) {
      if (typeof v === 'number' && !Number.isFinite(v)) return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const regions = c.blurRegions
      if (!Array.isArray(regions)) return t
      const rIdx = regions.findIndex((r) => r.id === regionId)
      if (rIdx === -1) return t
      // Merge the partial onto the matched region, then clamp/sanitize so the
      // stored region is already canonical (id preserved).
      const merged = clampBlurRegion({ ...regions[rIdx], ...partial, id: regionId })
      const nextRegions = [...regions]
      nextRegions[rIdx] = merged
      const clips = [...t.clips]
      clips[idx] = { ...c, blurRegions: nextRegions }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeBlurRegion(clipId: string, regionId: string): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const regions = c.blurRegions
      if (!Array.isArray(regions)) return t
      const nextRegions = regions.filter((r) => r.id !== regionId)
      if (nextRegions.length === regions.length) return t
      const clips = [...t.clips]
      // Empty → store `undefined` (NOT []) so persisted JSON + undo snapshots
      // stay lean, mirroring crop / colorAdjust.
      clips[idx] = {
        ...c,
        blurRegions: nextRegions.length > 0 ? nextRegions : undefined
      }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Motion tracks (Phase 3.13) — media clips only. Mirrors the blur-region
  // immutable-map + touch() + schedulePersist() pattern. zundo tracks
  // `project` so undo/redo of these is automatic.
  // --------------------------------------------------------------------
  setMotionTrack(clipId: string, track: MotionTrack): void {
    if (!track || typeof track !== 'object' || !track.id) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Motion tracks are a media-only concept.
      if (!isMediaClip(c)) return t
      const existing = c.motionTracks ?? []
      const replaceIdx = existing.findIndex((m) => m.id === track.id)
      let nextTracks: MotionTrack[]
      if (replaceIdx >= 0) {
        // Replace in place — capacity is unaffected.
        nextTracks = [...existing]
        nextTracks[replaceIdx] = track
      } else {
        // New track — silently no-op once the per-clip cap is hit.
        if (existing.length >= MAX_MOTION_TRACKS_PER_CLIP) return t
        nextTracks = [...existing, track]
      }
      const clips = [...t.clips]
      clips[idx] = { ...c, motionTracks: nextTracks }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeMotionTrack(clipId: string, trackId: string): void {
    if (!trackId) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const clips = t.clips.map((c) => {
        // 1) Drop the track from the owning media clip, AND clear any blur
        //    region on that same clip bound to it.
        if (c.id === clipId && isMediaClip(c)) {
          const existing = c.motionTracks
          if (!Array.isArray(existing)) return c
          const filtered = existing.filter((m) => m.id !== trackId)
          if (filtered.length === existing.length) {
            // Track id absent — nothing to remove on this clip. The binding
            // sweep below still runs (handled in the generic branch).
          }
          // Empty → undefined (NOT []), keeping persisted JSON lean.
          const nextMotionTracks =
            filtered.length > 0 ? filtered : undefined
          // Clear dangling blur-region bindings on this clip.
          let nextBlur = c.blurRegions
          if (Array.isArray(nextBlur)) {
            let blurChanged = false
            const swept = nextBlur.map((r) => {
              if (r.motionTrackId === trackId) {
                blurChanged = true
                const { motionTrackId: _drop, ...rest } = r
                return rest
              }
              return r
            })
            if (blurChanged) nextBlur = swept
          }
          if (
            nextMotionTracks !== existing ||
            nextBlur !== c.blurRegions ||
            filtered.length !== existing.length
          ) {
            changed = true
          }
          return { ...c, motionTracks: nextMotionTracks, blurRegions: nextBlur }
        }
        // 2) Clear dangling overlay / caption bindings ANYWHERE in the project.
        if (
          (isOverlayClip(c) || isCaptionClip(c)) &&
          c.motionTrackId === trackId
        ) {
          changed = true
          const { motionTrackId: _drop, ...rest } = c
          return rest as Clip
        }
        return c
      })
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  bindBlurRegionToTrack(clipId, regionId, trackId): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const regions = c.blurRegions
      if (!Array.isArray(regions)) return t
      const rIdx = regions.findIndex((r) => r.id === regionId)
      if (rIdx === -1) return t
      const nextRegions = [...regions]
      if (trackId === null) {
        // Unbind — drop the field entirely.
        const { motionTrackId: _drop, ...rest } = regions[rIdx]
        nextRegions[rIdx] = rest
      } else {
        nextRegions[rIdx] = { ...regions[rIdx], motionTrackId: trackId }
      }
      const clips = [...t.clips]
      clips[idx] = { ...c, blurRegions: nextRegions }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  bindOverlayToTrack(overlayClipId, trackId): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === overlayClipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isOverlayClip(c)) return t
      const clips = [...t.clips]
      if (trackId === null) {
        const { motionTrackId: _drop, ...rest } = c
        clips[idx] = rest as Clip
      } else {
        clips[idx] = { ...c, motionTrackId: trackId }
      }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  bindCaptionToTrack(captionClipId, trackId): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === captionClipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isCaptionClip(c)) return t
      const clips = [...t.clips]
      if (trackId === null) {
        const { motionTrackId: _drop, ...rest } = c
        clips[idx] = rest as Clip
      } else {
        clips[idx] = { ...c, motionTrackId: trackId }
      }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Transform keyframe animation (Phase 3.5) — media clips only.
  //
  // Invariants enforced after every mutation:
  //   - transformKeyframes is sorted ascending by atMs
  //   - keyframes closer than MIN_KEYFRAME_GAP_MS are deduped/replaced
  //   - a length-1 array is NEVER persisted (collapses to static transform)
  //   - every stored keyframe transform is range-clamped
  // --------------------------------------------------------------------
  addTransformKeyframe(clipId, atMs, transform): void {
    const at = Math.round(Number(atMs))
    if (!Number.isFinite(at) || at < 0) return
    if (transform && typeof transform === 'object') {
      for (const v of Object.values(transform)) {
        if (v !== undefined && !Number.isFinite(v)) return
      }
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c) && !isOverlayClip(c)) return t
      const dur = getClipDuration(c)
      if (at > dur) return t
      const existing = Array.isArray(c.transformKeyframes)
        ? [...c.transformKeyframes]
        : []
      let nextKfs: TransformKeyframe[]
      if (existing.length < 2) {
        // No active track — seed two keyframes (atMs 0 + requested) both at
        // the clip's current static transform. If atMs===0 the dedup below
        // collapses them, so nudge the second to a minimal non-zero offset.
        const base = clampClipTransform(getClipTransform(c))
        const secondAt = at <= 0 ? Math.min(dur, MIN_KEYFRAME_GAP_MS) : at
        nextKfs = [
          { atMs: 0, transform: { ...base } },
          { atMs: secondAt, transform: { ...base } }
        ]
        // If the requested keyframe carried explicit field overrides, apply
        // them to the requested (second) keyframe.
        if (transform && Object.keys(transform).length > 0) {
          nextKfs[1] = {
            atMs: secondAt,
            transform: clampClipTransform({ ...base, ...transform })
          }
        }
      } else {
        if (existing.length >= MAX_KEYFRAMES_PER_CLIP) return t
        // Land on the existing curve so the insert doesn't cause a jump.
        const onCurve = getTransformAt(c, c.startMs + at)
        const merged: ClipTransform =
          transform && Object.keys(transform).length > 0
            ? clampClipTransform({ ...onCurve, ...transform })
            : clampClipTransform(onCurve)
        nextKfs = [...existing, { atMs: at, transform: merged }]
      }
      const finalKfs = normalizeKeyframes(nextKfs)
      if (finalKfs.length < 2) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, transformKeyframes: finalKfs }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  updateTransformKeyframe(clipId, kfIndex, partial): void {
    if (!partial || typeof partial !== 'object') return
    if (
      partial.transform &&
      typeof partial.transform === 'object'
    ) {
      for (const v of Object.values(partial.transform)) {
        if (v !== undefined && !Number.isFinite(v)) return
      }
    }
    if (
      partial.atMs !== undefined &&
      !Number.isFinite(Number(partial.atMs))
    ) {
      return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c) && !isOverlayClip(c)) return t
      const existing = Array.isArray(c.transformKeyframes)
        ? [...c.transformKeyframes]
        : []
      if (kfIndex < 0 || kfIndex >= existing.length) return t
      const dur = getClipDuration(c)
      const cur = existing[kfIndex]
      const nextAt =
        partial.atMs !== undefined
          ? Math.max(0, Math.min(dur, Math.round(Number(partial.atMs))))
          : cur.atMs
      const nextTransform = partial.transform
        ? clampClipTransform({ ...cur.transform, ...partial.transform })
        : clampClipTransform(cur.transform)
      const updated = existing.map((kf, i) =>
        i === kfIndex ? { atMs: nextAt, transform: nextTransform } : kf
      )
      const finalKfs = normalizeKeyframes(updated)
      const clips = [...t.clips]
      if (finalKfs.length < 2) {
        // Collapsed below the invariant (dedup merged everything) — fall
        // back to a static transform from the surviving keyframe.
        clips[idx] = {
          ...c,
          transform: finalKfs[0] ? finalKfs[0].transform : c.transform,
          transformKeyframes: undefined
        }
      } else {
        clips[idx] = { ...c, transformKeyframes: finalKfs }
      }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeTransformKeyframe(clipId, kfIndex): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c) && !isOverlayClip(c)) return t
      const existing = Array.isArray(c.transformKeyframes)
        ? [...c.transformKeyframes]
        : []
      if (kfIndex < 0 || kfIndex >= existing.length) return t
      const remaining = existing.filter((_, i) => i !== kfIndex)
      const clips = [...t.clips]
      if (remaining.length < 2) {
        // Track would fall below the >= 2 invariant — clear it and bake the
        // surviving keyframe's transform into the static transform so the
        // current look is kept.
        const survivor = remaining[0]
        const baked = survivor
          ? clampClipTransform(survivor.transform)
          : undefined
        clips[idx] = {
          ...c,
          transform:
            baked && !isIdentityTransform(baked) ? baked : undefined,
          transformKeyframes: undefined
        }
      } else {
        clips[idx] = {
          ...c,
          transformKeyframes: normalizeKeyframes(remaining)
        }
      }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  clearTransformKeyframes(clipId): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c) && !isOverlayClip(c)) return t
      if (c.transformKeyframes === undefined) return t
      const clips = [...t.clips]
      // Keep the static transform untouched — only drop the animation track.
      clips[idx] = { ...c, transformKeyframes: undefined }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Variable speed curve (Phase 3.10) — media clips only. Mirrors the
  // Phase 3.5 transform-keyframe actions. Speed keyframes' atMs are SOURCE
  // offsets (ms from trimInMs). Every mutation recomputes endMs via
  // `recomputeEndMsForSpeed` (the curve changes the clip's timeline length).
  //
  // Invariants enforced after every mutation:
  //   - speedKeyframes is sorted ascending by atMs
  //   - keyframes closer than MIN_SPEED_KEYFRAME_GAP_MS are deduped/replaced
  //   - a length-1 array is NEVER persisted (collapses to constant `speed`)
  //   - every stored keyframe speed is clamped [MIN_CLIP_SPEED, MAX_CLIP_SPEED]
  // --------------------------------------------------------------------
  addSpeedKeyframe(clipId, atMs, speed): void {
    const at = Math.round(Number(atMs))
    if (!Number.isFinite(at) || at < 0) return
    if (speed !== undefined && !Number.isFinite(Number(speed))) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const srcDur = Math.max(0, c.trimOutMs - c.trimInMs)
      if (at > srcDur) return t
      const existing = Array.isArray(c.speedKeyframes)
        ? [...c.speedKeyframes]
        : []
      let nextKfs: SpeedKeyframe[]
      if (existing.length < 2) {
        // No active curve — seed two keyframes spanning the full source
        // window, both at the clip's current constant speed. An explicit
        // `speed` override applies to the requested keyframe.
        const base = Math.max(
          MIN_CLIP_SPEED,
          Math.min(MAX_CLIP_SPEED, c.speed ?? 1)
        )
        nextKfs = [
          { atMs: 0, speed: base },
          { atMs: srcDur, speed: base }
        ]
        if (speed !== undefined) {
          // The requested keyframe sits at `at` (dedup merges if it lands on
          // 0 or srcDur within the gap window).
          nextKfs.push({ atMs: at, speed: Number(speed) })
        }
      } else {
        if (existing.length >= MAX_SPEED_KEYFRAMES_PER_CLIP) return t
        // Land on the existing curve so the insert causes no speed jump.
        const onCurve = getSpeedAt(c, at)
        nextKfs = [
          ...existing,
          { atMs: at, speed: speed !== undefined ? Number(speed) : onCurve }
        ]
      }
      const finalKfs = normalizeSpeedKeyframes(nextKfs)
      if (finalKfs.length < 2) return t
      const clips = [...t.clips]
      clips[idx] = recomputeEndMsForSpeed({ ...c, speedKeyframes: finalKfs })
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  updateSpeedKeyframe(clipId, kfIndex, partial): void {
    if (!partial || typeof partial !== 'object') return
    if (partial.atMs !== undefined && !Number.isFinite(Number(partial.atMs))) {
      return
    }
    if (
      partial.speed !== undefined &&
      !Number.isFinite(Number(partial.speed))
    ) {
      return
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const existing = Array.isArray(c.speedKeyframes)
        ? [...c.speedKeyframes]
        : []
      if (kfIndex < 0 || kfIndex >= existing.length) return t
      const srcDur = Math.max(0, c.trimOutMs - c.trimInMs)
      const cur = existing[kfIndex]
      const nextAt =
        partial.atMs !== undefined
          ? Math.max(0, Math.min(srcDur, Math.round(Number(partial.atMs))))
          : cur.atMs
      const nextSpeed =
        partial.speed !== undefined
          ? Math.max(
              MIN_CLIP_SPEED,
              Math.min(MAX_CLIP_SPEED, Number(partial.speed))
            )
          : cur.speed
      const updated = existing.map((kf, i) =>
        i === kfIndex ? { atMs: nextAt, speed: nextSpeed } : kf
      )
      const finalKfs = normalizeSpeedKeyframes(updated)
      const clips = [...t.clips]
      if (finalKfs.length < 2) {
        // Collapsed below the >= 2 invariant — drop the curve + bake the
        // surviving keyframe's speed into the constant `speed` field.
        clips[idx] = recomputeEndMsForSpeed({
          ...c,
          speed: finalKfs[0] ? finalKfs[0].speed : c.speed,
          speedKeyframes: undefined
        })
      } else {
        clips[idx] = recomputeEndMsForSpeed({ ...c, speedKeyframes: finalKfs })
      }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeSpeedKeyframe(clipId, kfIndex): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const existing = Array.isArray(c.speedKeyframes)
        ? [...c.speedKeyframes]
        : []
      if (kfIndex < 0 || kfIndex >= existing.length) return t
      const remaining = existing.filter((_, i) => i !== kfIndex)
      const clips = [...t.clips]
      if (remaining.length < 2) {
        // Curve would fall below the >= 2 invariant — clear it + bake the
        // surviving keyframe's speed into the constant `speed`.
        const survivor = remaining[0]
        clips[idx] = recomputeEndMsForSpeed({
          ...c,
          speed: survivor
            ? Math.max(
                MIN_CLIP_SPEED,
                Math.min(MAX_CLIP_SPEED, survivor.speed)
              )
            : c.speed,
          speedKeyframes: undefined
        })
      } else {
        clips[idx] = recomputeEndMsForSpeed({
          ...c,
          speedKeyframes: normalizeSpeedKeyframes(remaining)
        })
      }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  clearSpeedKeyframes(clipId): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if (c.speedKeyframes === undefined) return t
      const clips = [...t.clips]
      // Keep the constant `speed` untouched — only drop the curve, then
      // recompute endMs with the now-constant timeline math.
      clips[idx] = recomputeEndMsForSpeed({
        ...c,
        speedKeyframes: undefined
      })
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  addVideoTrack(): string | null {
    const project = get().project
    const videoCount = project.tracks.filter((t) => t.kind === 'video').length
    if (videoCount >= MAX_VIDEO_TRACKS) return null
    const id = ulid()
    const newTrack = {
      id,
      kind: 'video' as const,
      name: `Video ${videoCount + 1}`,
      clips: []
    }
    // Insert immediately AFTER the last existing video track — keeps video
    // tracks contiguous; a later track renders on top (higher layer).
    let lastVideoIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      if (project.tracks[i].kind === 'video') lastVideoIdx = i
    }
    const tracks = [...project.tracks]
    tracks.splice(lastVideoIdx + 1, 0, newTrack)
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return id
  },

  ensureAudioTrack(preferRole?: 'voice' | 'bgm'): string {
    const project = get().project
    const audioTracks = project.tracks.filter((t) => t.kind === 'audio')
    // Prefer an existing audio track of the requested role; otherwise any
    // audio track; otherwise create a fresh Voice track.
    if (audioTracks.length > 0) {
      const byRole = preferRole
        ? audioTracks.find((t) => t.role === preferRole)
        : undefined
      return (byRole ?? audioTracks[0]).id
    }
    const id = ulid()
    const newTrack: Track =
      preferRole === 'bgm'
        ? {
            id,
            kind: 'audio',
            name: 'BGM',
            clips: [],
            role: 'bgm',
            duckTarget: 'voice',
            duckingDb: DEFAULT_DUCKING_DB
          }
        : { id, kind: 'audio', name: 'Voice 1', clips: [], role: 'voice' }
    // Insert right after the last video/audio track so audio lanes sit below
    // video lanes and above caption/overlay lanes (CapCut layout).
    let insertIdx = project.tracks.length
    for (let i = 0; i < project.tracks.length; i++) {
      if (project.tracks[i].kind === 'video' || project.tracks[i].kind === 'audio') {
        insertIdx = i + 1
      }
    }
    const tracks = [...project.tracks]
    tracks.splice(insertIdx, 0, newTrack)
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return id
  },

  removeVideoTrack(trackId: string): void {
    const project = get().project
    const target = project.tracks.find((t) => t.id === trackId)
    if (!target || target.kind !== 'video') return
    // Refuse to remove the last remaining video track.
    const videoCount = project.tracks.filter((t) => t.kind === 'video').length
    if (videoCount <= 1) return
    let touched = false
    const tracks = project.tracks.filter((t) => {
      if (t.id === trackId) {
        touched = true
        return false
      }
      return true
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // -------------------------------------------------------------------------
  // Generic track management (Phase 3 — timeline track context menu).
  // -------------------------------------------------------------------------
  renameTrack(trackId: string, name: string): void {
    const trimmed = (name ?? '').trim()
    if (trimmed.length === 0) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      if (t.id !== trackId) return t
      if (t.name === trimmed) return t
      changed = true
      return { ...t, name: trimmed }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  addTrack(kind: TrackKind, role?: TrackRole): string | null {
    const ids = get().addTracks(kind, 1, role)
    return ids.length > 0 ? ids[0] : null
  },

  addAudioSubmixTrack(): string | null {
    return get().addTrack('audio', 'submix')
  },

  addTracks(kind: TrackKind, count: number, role?: TrackRole): string[] {
    const n = Math.max(0, Math.floor(count))
    if (n === 0) return []
    let project = get().project
    let tracks = [...project.tracks]
    const created: string[] = []

    // Per-kind caps. caption/overlay are unbounded.
    const capFor = (k: TrackKind): number => {
      if (k === 'video') return MAX_VIDEO_TRACKS
      if (k === 'audio') return MAX_AUDIO_TRACKS
      return Number.POSITIVE_INFINITY
    }

    // Pick an insertion index that keeps tracks grouped by kind:
    //   video  → after the last video track
    //   audio  → after the last audio (or video) track
    //   others → at the end
    const insertIndexFor = (list: Track[], k: TrackKind): number => {
      if (k === 'video') {
        let idx = 0
        for (let i = 0; i < list.length; i++) {
          if (list[i].kind === 'video') idx = i + 1
        }
        return idx
      }
      if (k === 'audio') {
        let idx = list.length
        for (let i = 0; i < list.length; i++) {
          if (list[i].kind === 'video' || list[i].kind === 'audio') {
            idx = i + 1
          }
        }
        return idx
      }
      return list.length
    }

    const labelFor = (k: TrackKind, r: TrackRole, seq: number): string => {
      if (k === 'video') return `Video ${seq}`
      if (k === 'audio') {
        if (r === 'bgm') return `BGM ${seq}`
        if (r === 'sfx') return `SFX ${seq}`
        if (r === 'submix') return `Submix ${seq}`
        return `Voice ${seq}`
      }
      if (k === 'caption') return `Caption ${seq}`
      if (k === 'overlay') return `Overlay ${seq}`
      return `Track ${seq}`
    }

    for (let i = 0; i < n; i++) {
      const existingOfKind = tracks.filter((t) => t.kind === kind).length
      if (existingOfKind >= capFor(kind)) break
      const id = ulid()
      const seq = existingOfKind + 1
      const base: Track = { id, kind, name: labelFor(kind, role ?? null, seq), clips: [] }
      if (kind === 'audio') {
        base.role = role ?? 'voice'
        if (role === 'bgm') {
          base.duckTarget = 'voice'
          base.duckingDb = DEFAULT_DUCKING_DB
        }
      }
      const at = insertIndexFor(tracks, kind)
      tracks.splice(at, 0, base)
      created.push(id)
    }

    if (created.length === 0) return []
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return created
  },

  removeTrack(trackId: string): boolean {
    return get().removeTracks([trackId]).length > 0
  },

  removeTracks(trackIds: string[]): string[] {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return []
    const project = get().project
    const wanted = new Set(trackIds)
    const videoCount = project.tracks.filter((t) => t.kind === 'video').length
    const captionCount = project.tracks.filter(
      (t) => t.kind === 'caption'
    ).length
    let remainingVideo = videoCount
    let remainingCaption = captionCount
    const removed: string[] = []
    const tracks = project.tracks.filter((t) => {
      if (!wanted.has(t.id)) return true
      // Guard: never drop the last video track or the last caption track.
      if (t.kind === 'video' && remainingVideo <= 1) return true
      if (t.kind === 'caption' && remainingCaption <= 1) return true
      if (t.kind === 'video') remainingVideo -= 1
      if (t.kind === 'caption') remainingCaption -= 1
      removed.push(t.id)
      return false
    })
    if (removed.length === 0) return []
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return removed
  },

  addCaption(caption: CaptionClip): void {
    // Delegate to addClip; addClip validates track-kind compatibility.
    get().addClip(caption)
  },

  addCaptions(captions: CaptionClip[]): void {
    if (!Array.isArray(captions) || captions.length === 0) return
    const project = get().project
    // Find caption track once. If there's no caption track, this is a no-op
    // (matches addCaption's silent failure mode).
    const captionTrackIdx = project.tracks.findIndex((t) => t.kind === 'caption')
    if (captionTrackIdx === -1) return
    const captionTrackId = project.tracks[captionTrackIdx].id
    // Filter + reassign trackId defensively. Caller can supply any trackId,
    // but bulk insert MUST land on the caption track to match addCaption.
    const accepted: CaptionClip[] = []
    for (const c of captions) {
      if (!c || c.kind !== 'caption') continue
      accepted.push(c.trackId === captionTrackId ? c : { ...c, trackId: captionTrackId })
    }
    if (accepted.length === 0) return
    const tracks = project.tracks.map((t, i) => {
      if (i !== captionTrackIdx) return t
      return { ...t, clips: [...t.clips, ...accepted] }
    })
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  updateCaption(captionId, partial): void {
    const project = get().project
    let touched = false
    const tracks = project.tracks.map((t) => {
      if (t.kind !== 'caption') return t
      const clips = t.clips.map((c) => {
        if (!isCaptionClip(c)) return c
        if (c.id !== captionId) return c
        touched = true
        const merged: CaptionClip = {
          ...c,
          ...partial,
          // Preserve immutable fields if caller passed them in by mistake.
          id: c.id,
          kind: 'caption',
          trackId: c.trackId,
          // Merge nested style/spans shallowly.
          style: partial.style ? { ...c.style, ...partial.style } : c.style,
          spans: partial.spans ?? c.spans
        }
        return merged
      })
      return { ...t, clips }
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeCaption(captionId: string): void {
    const project = get().project
    let touched = false
    const tracks = project.tracks.map((t) => {
      if (t.kind !== 'caption') return t
      const before = t.clips.length
      const clips = t.clips.filter((c) => !(isCaptionClip(c) && c.id === captionId))
      if (clips.length !== before) touched = true
      return { ...t, clips }
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  getCaptionTrackId(): string | null {
    const track = get().project.tracks.find((t) => t.kind === 'caption')
    return track ? track.id : null
  },

  // --------------------------------------------------------------------
  // Overlay elements (Phase 3.8) — stickers / shapes on the overlay track.
  // --------------------------------------------------------------------
  getOverlayTrackId(): string | null {
    const track = get().project.tracks.find((t) => t.kind === 'overlay')
    return track ? track.id : null
  },

  ensureOverlayTrack(): string {
    const project = get().project
    const existing = project.tracks.find((t) => t.kind === 'overlay')
    if (existing) return existing.id
    // No overlay track (old project) — append one after the caption track
    // so it sits last, matching freshProject's track order.
    const id = ulid()
    const newTrack: Track = {
      id,
      kind: 'overlay',
      name: 'Overlay 1',
      clips: []
    }
    let lastCaptionIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      if (project.tracks[i].kind === 'caption') lastCaptionIdx = i
    }
    const tracks = [...project.tracks]
    // Insert right after the caption track, or at the very end if none.
    tracks.splice(
      lastCaptionIdx === -1 ? tracks.length : lastCaptionIdx + 1,
      0,
      newTrack
    )
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return id
  },

  addOverlay(clip: OverlayClip): void {
    // Lazily create the overlay track, then re-target the clip onto it and
    // delegate to addClip (which validates track-kind compatibility).
    const trackId = get().ensureOverlayTrack()
    get().addClip(clip.trackId === trackId ? clip : { ...clip, trackId })
  },

  updateOverlay(overlayId, partial): void {
    const project = get().project
    let touched = false
    const tracks = project.tracks.map((t) => {
      if (t.kind !== 'overlay') return t
      const clips = t.clips.map((c) => {
        if (!isOverlayClip(c)) return c
        if (c.id !== overlayId) return c
        touched = true
        const merged: OverlayClip = {
          ...c,
          ...partial,
          // Preserve immutable fields if the caller passed them in.
          id: c.id,
          kind: 'overlay',
          trackId: c.trackId,
          // Deep-clone the nested source — for shape overlays clone `style`
          // so the merged object never aliases the caller's input.
          source: partial.source
            ? partial.source.type === 'shape'
              ? {
                  ...partial.source,
                  style: { ...partial.source.style }
                }
              : { ...partial.source }
            : c.source
        }
        return merged
      })
      return { ...t, clips }
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeOverlay(overlayId: string): void {
    const project = get().project
    let touched = false
    const tracks = project.tracks.map((t) => {
      if (t.kind !== 'overlay') return t
      const before = t.clips.length
      const clips = t.clips.filter(
        (c) => !(isOverlayClip(c) && c.id === overlayId)
      )
      if (clips.length !== before) touched = true
      return { ...t, clips }
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  _hydrateFromDisk(project: Project): void {
    set({ project: migrateLoadedProject(project), hydrated: true })
    // A loaded project IS the new baseline — nothing before this point
    // should be undo-able. Defer to next tick so the set() above lands first.
    // Push past the throttle window so any in-flight trailing-edge entry
    // for the just-issued set() lands before we wipe the stack.
    setTimeout(
      () => useProjectStore.temporal.getState().clear(),
      UNDO_THROTTLE_MS + 50
    )
  }
    }),
    {
      limit: UNDO_LIMIT,
      // Track only the project doc. `hydrated` is bootstrap state, not user
      // mutation; everything else (UI ephemera, action refs) is excluded.
      partialize: (state): ProjectSnapshot => ({ project: state.project }),
      // Skip history entries where only the noisy fields differ (thumbnail
      // paths, waveform paths, updatedAt timestamps).
      equality: snapshotsEqual,
      // Throttle rapid mutations (drags, scrubs) into one entry per
      // UNDO_THROTTLE_MS window. The leading edge captures the first state
      // change instantly; subsequent changes within the window are coalesced
      // into a single trailing entry.
      //
      // Note: zundo internally curries `handleSet` with 4 args (past, replace,
      // current, delta), but its TS type narrows to the 1-2-arg StoreApi
      // setState shape. We pass args through opaquely.
      handleSet: (handleSet) => {
        const throttled = makeThrottle(
          (...args: unknown[]) => {
            ;(handleSet as unknown as (...a: unknown[]) => void)(...args)
          },
          UNDO_THROTTLE_MS
        )
        return throttled as unknown as typeof handleSet
      }
    }
  )
)

/**
 * Hook to subscribe a component reactively to the undo/redo state.
 * `pastStates.length` / `futureStates.length` are derived (canUndo/canRedo).
 */
export interface UndoRedoApi {
  undo: () => void
  redo: () => void
  clear: () => void
  canUndo: boolean
  canRedo: boolean
  pastCount: number
  futureCount: number
}

export function useUndoRedo(): UndoRedoApi {
  // Subscribe to scalar primitives only so each useStore call uses Object.is
  // safely. Returning an aggregated object from a single selector would
  // create a new reference each render and infinite-loop React.
  const pastCount = useStore(
    useProjectStore.temporal,
    (s: TemporalState<ProjectSnapshot>) => s.pastStates.length
  )
  const futureCount = useStore(
    useProjectStore.temporal,
    (s: TemporalState<ProjectSnapshot>) => s.futureStates.length
  )
  const undo = useStore(
    useProjectStore.temporal,
    (s: TemporalState<ProjectSnapshot>) => s.undo
  )
  const redo = useStore(
    useProjectStore.temporal,
    (s: TemporalState<ProjectSnapshot>) => s.redo
  )
  const clear = useStore(
    useProjectStore.temporal,
    (s: TemporalState<ProjectSnapshot>) => s.clear
  )
  return {
    undo,
    redo,
    clear,
    canUndo: pastCount > 0,
    canRedo: futureCount > 0,
    pastCount,
    futureCount
  }
}

// ---------------------------------------------------------------------------
// Init: try to load the persisted project once when this module is imported.
// ---------------------------------------------------------------------------
let hydrationStarted = false

export function initProjectStore(): Promise<void> {
  if (hydrationStarted) return Promise.resolve()
  hydrationStarted = true

  if (typeof window === 'undefined' || !window.electron?.fs?.readProject) {
    persistEnabled = true
    useProjectStore.setState({ hydrated: true })
    return Promise.resolve()
  }

  return window.electron.fs
    .readProject()
    .then((p) => {
      if (p) useProjectStore.getState()._hydrateFromDisk(p)
      else useProjectStore.setState({ hydrated: true })
    })
    .catch((err: unknown) => {
      console.error('[store] readProject failed', err)
      useProjectStore.setState({ hydrated: true })
    })
    .finally(() => {
      // Only enable persistence AFTER hydration so we never overwrite a
      // valid on-disk project with the default in-memory blank.
      persistEnabled = true
      // Wipe any history accumulated during the hydrate set() calls — the
      // post-hydrate state is the user's baseline, not undo-able.
      try {
        useProjectStore.temporal.getState().clear()
      } catch {
        /* defensive — temporal should always exist post-init */
      }
    })
}

/** Generates a fresh ulid (re-exported for renderer convenience). */
export function newId(): string {
  return ulid()
}

/** Compute the total timeline duration (max endMs across every clip). */
export function getTotalDurationMs(project: Project): number {
  let max = 0
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.endMs > max) max = c.endMs
    }
  }
  return max
}

// ---------------------------------------------------------------------------
// E2E hook: expose the store on window so Playwright can introspect state.
// Strictly read-only via getState; tests that need to mutate go through IPC
// or DOM actions. Guarded behind the renderer's window (no-op in node).
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  ;(window as unknown as { __PROJECT_STORE_FOR_TEST__: typeof useProjectStore }).__PROJECT_STORE_FOR_TEST__ =
    useProjectStore
}
