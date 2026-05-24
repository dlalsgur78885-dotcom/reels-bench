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
  MAX_FREEZE_FRAMES_PER_CLIP,
  MAX_FREEZE_MS,
  MAX_GAIN_DB,
  MAX_KEYFRAMES_PER_CLIP,
  MAX_MOTION_TRACKS_PER_CLIP,
  MAX_SPEED_KEYFRAMES_PER_CLIP,
  MAX_TRANSFORM_OFFSET,
  MAX_TRANSFORM_ROTATION,
  MAX_TRANSFORM_SCALE,
  MAX_TRANSITION_MS,
  MAX_VIDEO_TRACKS,
  MAX_VOLUME_KEYFRAMES_PER_CLIP,
  MIN_VOLUME_KEYFRAME_GAP_MS,
  MAX_DELETED_RANGES_PER_CLIP,
  MIN_DELETED_RANGE_GAP_MS,
  MIN_CLIP_MS,
  MIN_CLIP_SPEED,
  MIN_COLOR_ADJUST,
  MIN_CROP_SIZE,
  MIN_FREEZE_MS,
  DEFAULT_FREEZE_MS,
  MIN_GAIN_DB,
  MIN_KEYFRAME_GAP_MS,
  MIN_NOISE_REDUCTION,
  MAX_NOISE_REDUCTION,
  MIN_RETOUCH,
  MAX_RETOUCH,
  MIN_ENHANCE,
  MAX_ENHANCE,
  MIN_STABILIZE,
  MAX_STABILIZE,
  MIN_FILM_LOOK,
  MAX_FILM_LOOK,
  NEUTRAL_FILM_LOOK,
  FILM_TONE_IDS,
  isNeutralFilmLook,
  NEUTRAL_VOICE_ENHANCE,
  VISUAL_EFFECT_IDS,
  VOICE_CHANGER_IDS,
  isNeutralVoiceEnhance,
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
  MAX_ADJUSTMENT_LAYERS,
  DEFAULT_PROGRESS_BAR_COLOR,
  DEFAULT_PROGRESS_BAR_HEIGHT_FRAC,
  MIN_PROGRESS_BAR_HEIGHT_FRAC,
  MAX_PROGRESS_BAR_HEIGHT_FRAC,
  MAX_PREVIEW_GUIDES,
  MIN_PREVIEW_GUIDE_FRAC,
  MAX_PREVIEW_GUIDE_FRAC,
  DEFAULT_PREVIEW_GUIDE_FRAC,
  DEFAULT_CANVAS_BACKGROUND_COLOR,
  getPreviewGuides,
  type CanvasBackground,
  type ProgressBarConfig,
  type AdjustmentLayer,
  type AspectRatio,
  type BlurRegion,
  type CaptionClip,
  type Clip,
  type ClipTranscript,
  type ColorAdjust,
  type ClipTransform,
  type CropRect,
  type DeletedRange,
  type TranscriptWord,
  type CurveChannelKey,
  type CurvePoint,
  type FilmLook,
  type VisualEffectId,
  type VoiceChangerId,
  type VoiceEnhance,
  type FilterPreset,
  type FreezeFrame,
  type HslBandAdjust,
  type HslBandKey,
  type MediaAsset,
  type SfxMeta,
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
  type VolumeKeyframe,
  type ClipKind,
  aspectRatioConversion,
  canPlaceClipOnTrack,
  resolveCoverMs,
  clampBlurRegion,
  getClipDuration,
  getGroupMembers,
  getClipDeletedRanges,
  getClipFreezeFrames,
  getClipTimelineDuration,
  getClipTransform,
  getSpeedAt,
  getTransformAt,
  getVisibleTranscriptWords,
  hasClipTranscript,
  hasFreezeFrames,
  hasSpeedCurve,
  hasTransformKeyframes,
  hasVolumeEnvelope,
  resolvedVolumeKeyframes,
  getVolumeDbAt,
  isCaptionClip,
  isClipLocked,
  isClipReversed,
  canReverseClip,
  CLIP_COLOR_IDS,
  type ClipColorId,
  EASING_KINDS,
  isIdentityCrop,
  isIdentityTransform,
  isMediaClip,
  isNeutralColorAdjust,
  isOverlayClip,
  sanitizeClipCurves,
  isIdentityClipCurves,
  sanitizeClipHsl,
  isNeutralClipHsl,
  sourceOffsetForTimelineOffset,
  type EasingKind
} from '../../../shared/project'
import type { SilenceRange } from '../../../shared/ipc'
import {
  cellToClipPlacement,
  getLayoutPreset,
  type LayoutPresetId
} from '../../../shared/layoutPresets'
import { buildZoomKeyframes, getZoomPreset } from '../../../shared/zoomPresets'

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
 * Phase 3.32 — clamp an adjustment layer's [startMs, endMs] window to the
 * SAME shape `getAdjustmentLayers` resolves defensively: startMs >= 0, endMs
 * >= startMs + MIN_CLIP_MS, both coerced finite. Returns null when either
 * input is non-finite (caller treats this as a no-op). Used by
 * `addAdjustmentLayer` / `updateAdjustmentLayer` so the stored window is
 * already canonical.
 */
function clampAdjustmentLayerWindow(
  startMs: number,
  endMs: number
): { startMs: number; endMs: number } | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  const s = Math.max(0, Math.round(startMs))
  const e = Math.max(s + MIN_CLIP_MS, Math.round(endMs))
  return { startMs: s, endMs: e }
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
      transform: clampClipTransform(kf.transform),
      // Phase 3.54 — preserve outgoing easing through normalization. Linear /
      // unknown values are dropped (BC-safe: absent = linear).
      ...(kf.easing && (EASING_KINDS as readonly string[]).includes(kf.easing)
        ? kf.easing === 'linear'
          ? {}
          : { easing: kf.easing }
        : {})
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
 * Normalize a volume-keyframe list (Phase 3.30): round + clamp `atMs >= 0`,
 * clamp each `gainDb` into [MIN_GAIN_DB, MAX_GAIN_DB], sort ascending by atMs,
 * then dedup — keyframes within MIN_VOLUME_KEYFRAME_GAP_MS of the
 * previously-kept one REPLACE it (last write wins), and the list is capped at
 * MAX_VOLUME_KEYFRAMES_PER_CLIP. Mirrors `normalizeSpeedKeyframes`; callers
 * must still enforce the >= 2 invariant (a normalized list MAY collapse to
 * length 1). `atMs` is clip-relative TIMELINE ms (volume is authored in
 * timeline space — no source mapping).
 */
function normalizeVolumeKeyframes(kfs: VolumeKeyframe[]): VolumeKeyframe[] {
  const sorted = kfs
    .map((kf) => ({
      atMs: Math.max(0, Math.round(kf.atMs)),
      gainDb: Math.max(
        MIN_GAIN_DB,
        Math.min(MAX_GAIN_DB, Number.isFinite(kf.gainDb) ? kf.gainDb : 0)
      )
    }))
    .sort((a, b) => a.atMs - b.atMs)
  const out: VolumeKeyframe[] = []
  for (const kf of sorted) {
    const last = out[out.length - 1]
    if (last && kf.atMs - last.atMs < MIN_VOLUME_KEYFRAME_GAP_MS) {
      // Within the dedup window — replace the kept keyframe.
      out[out.length - 1] = kf
    } else {
      out.push(kf)
    }
    if (out.length >= MAX_VOLUME_KEYFRAMES_PER_CLIP) break
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

// ---------------------------------------------------------------------------
// Text-based editing helpers (Phase 3.17).
// ---------------------------------------------------------------------------

/**
 * Filler-word lexicon for `removeFillerWords`. Matched case-insensitively
 * against punctuation-stripped word text.
 */
const FILLER_LEXICON: ReadonlySet<string> = new Set([
  '음',
  '어',
  '그',
  '저',
  '뭐',
  '인제',
  '이제',
  'um',
  'uh',
  'er',
  'ah',
  'like'
])

/** Strip leading/trailing punctuation + whitespace, lowercase. */
function normalizeWordText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
}

/**
 * Merge a set of transcript words (by id) into minimal contiguous SOURCE
 * ranges. Words are sorted by `sourceStartMs`; adjacent words within
 * MIN_DELETED_RANGE_GAP_MS coalesce into one range. Returns ABSOLUTE source ms.
 */
function wordsToDeletedRanges(
  words: TranscriptWord[],
  wordIds: ReadonlySet<string>
): DeletedRange[] {
  const picked = words
    .filter(
      (w) =>
        wordIds.has(w.id) &&
        Number.isFinite(w.sourceStartMs) &&
        Number.isFinite(w.sourceEndMs) &&
        w.sourceEndMs > w.sourceStartMs
    )
    .map((w) => ({
      sourceStartMs: Math.min(w.sourceStartMs, w.sourceEndMs),
      sourceEndMs: Math.max(w.sourceStartMs, w.sourceEndMs)
    }))
    .sort((a, b) => a.sourceStartMs - b.sourceStartMs)
  const out: DeletedRange[] = []
  for (const r of picked) {
    const last = out[out.length - 1]
    if (last && r.sourceStartMs <= last.sourceEndMs + MIN_DELETED_RANGE_GAP_MS) {
      if (r.sourceEndMs > last.sourceEndMs) last.sourceEndMs = r.sourceEndMs
    } else {
      out.push({ ...r })
    }
  }
  return out
}

/**
 * Subtract a set of [start,end] cut intervals from a list of deleted ranges —
 * portions overlapping a cut interval are removed/trimmed; the rest survives.
 * Used by `restoreTranscriptWords`. Both inputs/outputs are ABSOLUTE source ms.
 */
function subtractRanges(
  ranges: DeletedRange[],
  cuts: DeletedRange[]
): DeletedRange[] {
  let working = ranges.map((r) => ({ ...r }))
  for (const cut of cuts) {
    const next: DeletedRange[] = []
    for (const r of working) {
      // No overlap — keep as-is.
      if (cut.sourceEndMs <= r.sourceStartMs || cut.sourceStartMs >= r.sourceEndMs) {
        next.push(r)
        continue
      }
      // Left remainder.
      if (cut.sourceStartMs > r.sourceStartMs) {
        next.push({
          sourceStartMs: r.sourceStartMs,
          sourceEndMs: cut.sourceStartMs
        })
      }
      // Right remainder.
      if (cut.sourceEndMs < r.sourceEndMs) {
        next.push({
          sourceStartMs: cut.sourceEndMs,
          sourceEndMs: r.sourceEndMs
        })
      }
    }
    working = next
  }
  return working.filter((r) => r.sourceEndMs - r.sourceStartMs > 0)
}

/**
 * Pure variant of the `rippleCloseTrackGaps` action — translate later clips on
 * a track left so no gap opens after a clip shrinks. Used by the transcript
 * actions to ripple within the SAME `set()` (one undo snapshot). Identical
 * algorithm to the action: clip order preserved, only positions move, a clip
 * never moves right. Returns a NEW tracks array (untouched tracks by ref).
 */
function rippleTracks(tracks: Track[], trackId: string): Track[] {
  const trackIdx = tracks.findIndex((t) => t.id === trackId)
  if (trackIdx === -1) return tracks
  const track = tracks[trackIdx]
  if (track.clips.length === 0) return tracks
  const ordered = [...track.clips].sort((a, b) => a.startMs - b.startMs)
  let cursor = ordered[0].startMs
  let changed = false
  const shifted = new Map<string, { startMs: number; endMs: number }>()
  for (const clip of ordered) {
    const shift = Math.max(0, clip.startMs - cursor)
    const newStart = clip.startMs - shift
    const newEnd = clip.endMs - shift
    if (shift > 0) changed = true
    shifted.set(clip.id, { startMs: newStart, endMs: newEnd })
    cursor = newEnd
  }
  if (!changed) return tracks
  return tracks.map((t, i) => {
    if (i !== trackIdx) return t
    const clips = t.clips.map((c) => {
      const pos = shifted.get(c.id)
      if (!pos || (pos.startMs === c.startMs && pos.endMs === c.endMs)) return c
      return { ...c, startMs: pos.startMs, endMs: pos.endMs }
    })
    return { ...t, clips }
  })
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
  /** Phase 3.27 — mark a timeline ms as the video's cover frame. */
  setCoverMs(ms: number): void
  /** Phase 3.27 — clear the cover-frame marker (export falls back to frame 0). */
  clearCoverMs(): void
  /** Phase 3.35 — merge a patch over the progress-bar config (one zundo step). */
  setProgressBar(patch: Partial<ProgressBarConfig>): void
  /** Phase 3.35 — flip the progress-bar `enabled` flag (config object survives). */
  toggleProgressBar(): void

  // --- Canvas backdrop fill (Phase 3.44) — see shared/project.ts ---
  /**
   * Replace the project's canvas-background payload. `null` or
   * `{ kind: 'blur' }` COLLAPSES the field to absent so the persisted JSON
   * stays byte-identical to a project that never set the field (the legacy
   * default — today's preview blur backdrop). A `color` payload validates
   * the `#rrggbb` hex; `#000000` collapses to `{ kind: 'black' }` (identical
   * pixels) and an invalid hex collapses to absent (= blur). All other kinds
   * are stored verbatim. One zundo step per call.
   */
  setCanvasBackground(bg: CanvasBackground | null): void

  // --- Preview-only horizontal guidelines (Phase 3.43) — see shared/project.ts ---
  /**
   * Replace the project's preview-guide list with a sanitized copy of
   * `yFractions`. Drops NaN/non-finite entries, clamps every value to
   * [MIN_PREVIEW_GUIDE_FRAC, MAX_PREVIEW_GUIDE_FRAC], caps at
   * MAX_PREVIEW_GUIDES, sorts ascending. When the cleaned array is empty,
   * the `previewGuides` field is COLLAPSED to absent so the persisted JSON
   * stays byte-identical to a project that never had a guide.
   */
  setPreviewGuides(yFractions: number[]): void
  /**
   * Append a new guide at `yFrac` (or DEFAULT_PREVIEW_GUIDE_FRAC when omitted).
   * No-op when the current list is already at MAX_PREVIEW_GUIDES.
   */
  addPreviewGuide(yFrac?: number): void
  /** Drop the guide at `index` (no-op when out of range). */
  removePreviewGuide(index: number): void
  /** Replace the guide at `index` with `yFrac` (no-op when out of range). */
  updatePreviewGuide(index: number, yFrac: number): void

  // --- Adjustment layers (Phase 3.32) — range color-grades over the composite ---
  /**
   * Append a new adjustment layer spanning [startMs, endMs]. The window is
   * clamped (startMs >= 0, endMs >= startMs + MIN_CLIP_MS). Returns the new
   * layer's id, or null when the project already holds MAX_ADJUSTMENT_LAYERS
   * layers or either input is non-finite. The layer is created neutral (no
   * grade payload) — it stays selectable/editable; the export-side
   * `getAdjustmentLayers` drops it until a grade is set.
   */
  addAdjustmentLayer(startMs: number, endMs: number): string | null
  /** Remove the adjustment layer matched by `id`. No-op when not found. */
  removeAdjustmentLayer(id: string): void
  /**
   * Move / trim an adjustment layer's window. Merges the partial onto the
   * current [startMs, endMs] then re-clamps. No-op when not found or for
   * non-finite input.
   */
  updateAdjustmentLayer(
    id: string,
    patch: { startMs?: number; endMs?: number }
  ): void
  /**
   * Merge a partial color adjust onto an adjustment layer, clamping each
   * field. An all-neutral merged result collapses the `colorAdjust` field to
   * `undefined`. No-op when not found or for non-finite input.
   */
  setAdjustmentLayerColorAdjust(
    id: string,
    partial: Partial<ColorAdjust>
  ): void
  /**
   * Update one tone-curve control point's x/y (each clamped to [0,1]) on an
   * adjustment layer. The whole `curves` object is re-sanitized; an all-
   * identity result collapses to `undefined`.
   */
  setAdjustmentLayerCurvePoint(
    id: string,
    channel: CurveChannelKey,
    pointIndex: number,
    p: Partial<CurvePoint>
  ): void
  /**
   * Merge a partial HslBandAdjust into one band of an adjustment layer's HSL
   * grading, clamping each field. An all-neutral result collapses to
   * `undefined`.
   */
  setAdjustmentLayerHslBand(
    id: string,
    band: HslBandKey,
    partial: Partial<HslBandAdjust>
  ): void
  /**
   * Set the filter preset + intensity (0..1) on an adjustment layer.
   * preset='none' clears the preset.
   */
  setAdjustmentLayerFilterPreset(
    id: string,
    preset: FilterPreset,
    intensity?: number
  ): void

  addMedia(asset: MediaAsset): void
  removeMedia(mediaId: string): void
  updateMediaThumbnail(mediaId: string, thumbnailPath: string): void
  /** Attach a generated waveform PNG to a media asset (Phase 2.5). */
  updateMediaWaveform(mediaId: string, waveformPath: string): void
  /**
   * Phase 8 — attach SFX provenance (license/attribution/source) to a media
   * asset. Called by the "🔊 효과음" import tab right after `addMedia`.
   * No-op if the media id is unknown.
   */
  updateMediaSfxMeta(mediaId: string, meta: SfxMeta): void

  addClip(clip: Clip): void
  removeClip(clipId: string): void

  // --- Clip grouping / linking (Phase 3.33) ---
  /**
   * Group the listed clips under a fresh link group. Counts distinct existing
   * clips among `clipIds`; if fewer than 2 exist, returns null (no-op). Mints a
   * new `groupId`, assigns it to every listed clip (overwriting any prior
   * `groupId`). Then sweeps: any PRIOR group left with <2 members has those
   * members' `groupId` cleared (no stale 1-member groups). Returns the new id.
   */
  /**
   * Phase 3.61 — compound clip: apply a uniform patch to every clip sharing
   * the given groupId. Supported patch fields:
   *   - `colorAdjust`     → merged into each member's existing colorAdjust
   *   - `filterPreset`    → set on each member (overwrites; pass 'none' to clear)
   *   - `filterIntensity` → set on each member (clamped 0..1)
   *   - `transform`       → merged into each member's existing transform
   * Members on tracks where a field is meaningless (e.g. captions for
   * filterPreset) are silently skipped. Returns the number of clips actually
   * modified. Honors per-clip locks (locked members are skipped).
   */
  applyToGroup(
    groupId: string,
    patch: {
      colorAdjust?: Partial<ColorAdjust>
      filterPreset?: FilterPreset
      filterIntensity?: number
      transform?: Partial<ClipTransform>
    }
  ): number
  groupClips(clipIds: string[]): string | null
  /**
   * Dissolve a link group. The argument may be the group's id OR any member
   * clip's id; it's resolved to a groupId, then every member's `groupId` is
   * cleared. No-op when the argument resolves to nothing.
   */
  ungroupClips(groupIdOrClipId: string): void
  /**
   * Move a clip (and, if it's grouped, its whole link group) so the anchor
   * clip's `startMs` lands at `desiredStartMs`. The shift delta is pre-clamped
   * so the earliest member can't go below 0 — the whole group stops together.
   * trackIds are unchanged.
   */
  moveClipGroup(clipId: string, desiredStartMs: number): void
  /**
   * Phase 3.40 — move a single clip onto a different track. Validates
   * compatibility via `canPlaceClipOnTrack`; no-op if source==target,
   * target missing, or kinds incompatible. Preserves every other field on
   * the clip (startMs/endMs/groupId/transform/etc.).
   *
   * GROUP BEHAVIOR: only the named clip changes track. Other group members
   * keep their trackId — the group `groupId` is preserved as a time-link
   * (still drives `moveClipGroup`).
   */
  moveClipToTrack(clipId: string, newTrackId: string): void
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
   * Phase 3.60 — split a clip at MANY timeline-ms offsets in one undo step.
   * The returned array holds the new clip ids in left-to-right order; the
   * input `clipId` ends up as the leftmost piece. Each offset MUST lie
   * strictly inside the source clip (and its successively-split right
   * fragment); offsets out of range are silently skipped. Ordering of the
   * input list is irrelevant — the action sorts ascending and rebuilds the
   * cut chain so each split operates on the correct surviving fragment.
   */
  splitClipAtMany(clipId: string, atMsList: number[]): string[]
  /**
   * Deep-clone a clip and place the duplicate at the next free slot on the
   * same track. Works for BOTH media and caption clips. Returns the new
   * clip's id, or null if the source clip can't be found.
   */
  duplicateClip(clipId: string): string | null
  /**
   * Detach (분리) a video-track media clip's embedded audio onto its own
   * audio track. ONE atomic store mutation (single zundo undo step):
   *   1. Create a new `'media'` clip on an audio track (reused if one exists,
   *      else a fresh audio track is built inline) with the SAME `mediaId`
   *      and timeline/trim/speed window — audio-only because the export
   *      collectors are track-kind-scoped.
   *   2. MUTE the source video clip so the audio isn't doubled.
   * Returns the new audio clip's id, or null when:
   *   - the clip can't be found / isn't a media clip
   *   - its track isn't a `'video'` track (no embedded audio to detach)
   *   - the source clip is ALREADY `isMuted` (already detached / deliberately
   *     muted — adding a twin would double audio)
   *   - the audio-track cap (MAX_AUDIO_TRACKS) is hit and none exists yet
   */
  detachAudio(clipId: string): string | null
  /**
   * Set a media clip's playback speed (clamped to [MIN_CLIP_SPEED,
   * MAX_CLIP_SPEED]). Keeps startMs and the source in/out range
   * (trimInMs..trimOutMs) fixed and recomputes endMs.
   * No-op for caption clips.
   */
  setClipSpeed(clipId: string, speed: number): void

  /**
   * Toggle reverse (역재생) on a media clip. `reversed:true` is REFUSED
   * (no-op) when `!canReverseClip(clip)` — reverse is mutually exclusive
   * with a speed curve / freeze frames / transcript deletions. Reverse does
   * NOT change the clip's timeline duration (endMs untouched). When `false`
   * the field is omitted (BC-clean JSON). No-op for caption clips.
   */
  setClipReversed(clipId: string, reversed: boolean): void

  // --- Audio shaping (Phase 2.5, media clips only) ---
  /** Set a media clip's gain in dB, clamped to [MIN_GAIN_DB, MAX_GAIN_DB]. */
  setClipGainDb(clipId: string, db: number): void
  /** Set per-clip fade-in / fade-out (ms). Negatives rejected; clamped to
   *  the clip's own duration so fades never overlap. */
  setClipFade(clipId: string, fadeInMs: number, fadeOutMs: number): void
  /** Set per-clip mute. */
  setClipMuted(clipId: string, muted: boolean): void
  /**
   * Phase 3.41 — per-clip lock (🔒). Pure editing guard with NO export-graph
   * effect (the export path never reads `clip.locked`). Walks
   * `project.tracks[].clips[]` to find the target; sets `locked: true` when
   * enabling and `locked: undefined` when disabling (lean JSON). No-op when
   * `Boolean(cur.locked) === Boolean(locked)`. Single zundo step.
   */
  setClipLocked(clipId: string, locked: boolean): void
  /**
   * Set a media clip's noise-reduction strength (0..100). 0 (or any value
   * clamping to <= 0) stores `undefined` (OFF — lean snapshots). Export-only;
   * the preview audio graph is untouched. No-op for non-media clips and for
   * non-finite inputs.
   */
  setClipNoiseReduction(clipId: string, strength: number): void
  /**
   * Merge a partial voice-enhance patch onto a media clip. Each sub-toggle is
   * coerced to boolean. A fully-neutral result (all sub-toggles false) stores
   * `voiceEnhance: undefined` (OFF — lean snapshots), mirroring
   * `setClipFilmLook`'s collapse-to-undefined. EXPORT-ONLY: the preview audio
   * graph is untouched. No-op for non-media clips.
   */
  setClipVoiceEnhance(clipId: string, patch: Partial<VoiceEnhance>): void
  /** Phase 3.50 — pick a voice-changer preset for a media clip (or 'none' to clear). */
  setClipVoiceChanger(clipId: string, id: VoiceChangerId): void
  /** Phase 3.51 — pick a visual-effect preset for a media clip (or 'none' to clear). */
  setClipVisualEffect(clipId: string, id: VisualEffectId): void
  /**
   * Set a media clip's retouch / beauty strength (0..100). 0 (or any value
   * clamping to <= 0) stores `undefined` (OFF — lean snapshots). Export-only;
   * the preview only approximates with a tiny CSS blur. No-op for non-media
   * clips and for non-finite inputs.
   */
  setClipRetouch(clipId: string, strength: number): void
  /** Phase 3.49 — set the per-clip video quality enhancer strength (0..100). */
  setClipEnhance(clipId: string, strength: number): void
  /**
   * Set a media clip's video-stabilization strength (0..100). 0 (or any value
   * clamping to <= 0) stores `undefined` (OFF — lean snapshots). Export-only;
   * the preview shows no stabilization (no honest CSS approximation exists).
   * No-op for non-media clips and for non-finite inputs.
   */
  setClipStabilize(clipId: string, strength: number): void
  /**
   * Merge a partial film-look (vignette / grain / tone) onto a media clip.
   * Values are clamped to [MIN_FILM_LOOK, MAX_FILM_LOOK]; an unknown toneId
   * falls back to 'none'. A fully-neutral result stores `filmLook: undefined`
   * (OFF — lean snapshots). No-op for non-media clips.
   */
  setClipFilmLook(clipId: string, patch: Partial<FilmLook>): void
  /**
   * Phase 3.74 — set a clip's UI color label (or clear with `null` / 'none').
   * Works on all clip kinds (media / caption / overlay). Locked clips are
   * still updatable (color is metadata, not editing) — only operations that
   * change the actual content / position respect the lock.
   */
  setClipColor(clipId: string, color: ClipColorId | null): void
  /**
   * Phase 3.75 — attach a user-supplied 3D LUT (.cube) path to a media clip.
   * `null` / '' clears. The caller is responsible for picking a valid file
   * (a follow-up phase ships an IPC `fs:pickLut` to gate this through the
   * main-process security allow-list). Media clips only — caption / overlay
   * are no-ops.
   */
  setClipLutPath(clipId: string, lutPath: string | null): void

  // -----------------------------------------------------------------
  // Phase 3.57 — advanced trim modes (ripple / rolling / slip / slide).
  //
  // All four actions are pure timeline-ms operations: they ignore `speed`
  // (the trim ms applies 1:1 to source ms), reject invalid deltas, refuse
  // moves that would push a clip endpoint past 0 or collide with neighbors,
  // and never split / reorder / remove clips. Caption / overlay clips are
  // ignored — these only act on `kind === 'media'` clips on the same track.
  // -----------------------------------------------------------------

  /**
   * Ripple-trim a clip's edge by `deltaMs`, then translate every later clip
   * on the same track by the same delta so no gap opens (and earlier clips
   * stay put). Positive delta = clip shrinks; negative = clip grows. Refuses
   * a delta that would push a trim out of [0, media.durationMs] or shrink
   * the clip below ~30ms.
   */
  rippleTrim(clipId: string, side: 'in' | 'out', deltaMs: number): void
  /**
   * Rolling-trim the boundary between this clip and an adjacent clip on the
   * same track. `side='out'` pairs with the next clip (this clip grows /
   * shrinks at its trim out, neighbor's trim in moves the opposite way);
   * `side='in'` pairs with the previous clip. The pair's combined timeline
   * length is preserved. No-op when no adjacent neighbor exists or the move
   * would overshoot either side's media bounds.
   */
  rollingTrim(clipId: string, side: 'in' | 'out', deltaMs: number): void
  /**
   * Slip a clip's source window by `deltaMs`. `trimInMs` and `trimOutMs`
   * both shift by `deltaMs` (positive = later source content), `startMs`
   * / `endMs` / timeline duration stay identical. No-op when the shifted
   * window would exit [0, media.durationMs].
   */
  slipClip(clipId: string, deltaMs: number): void
  /**
   * Slide a clip along the timeline by `deltaMs` while extending the
   * previous neighbor and trimming the next. Equivalent to a regular move
   * with the two adjacent clips' boundaries dragged along. No-op without
   * neighbors on both sides, or when the move would push any boundary out
   * of bounds.
   */
  slideClip(clipId: string, deltaMs: number): void
  /** Set track-wide mute. */
  setTrackMuted(trackId: string, muted: boolean): void
  /** Set track-wide solo. */
  setTrackSolo(trackId: string, solo: boolean): void
  /**
   * Phase 3.55 — audio ducking. Toggle the BGM-side sidechain compressor
   * on an audio track:
   *   - `'voice'` → marks this track as BGM (role='bgm', duckTarget='voice')
   *                 so the export pipeline runs sidechaincompress + volume
   *                 attenuation whenever any voice clip plays.
   *   - `null`    → clears duckTarget (role left as-is). Byte-identical export
   *                 if no other BGM/voice pair declares ducking.
   * `db` is clamped to [-30, -1]; defaults to DEFAULT_DUCKING_DB when omitted.
   * No-op on non-audio tracks. No-op on identical state.
   */
  setTrackDucking(
    trackId: string,
    target: 'voice' | null,
    db?: number
  ): void
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
   * Phase 3.54 — `easing` patches the OUTGOING curve from this keyframe
   * (linear / undefined = identity, byte-identical pre-3.54 export).
   */
  updateTransformKeyframe(
    clipId: string,
    kfIndex: number,
    partial: {
      atMs?: number
      transform?: Partial<ClipTransform>
      easing?: EasingKind | null
    }
  ): void
  /**
   * Remove the keyframe at `kfIndex`. If removal would drop the track below 2
   * keyframes, the whole track is cleared and the surviving keyframe's
   * transform is written into the clip's static `transform` so the look holds.
   */
  removeTransformKeyframe(clipId: string, kfIndex: number): void
  /** Clear a clip's keyframe track entirely; keeps its static `transform`. */
  clearTransformKeyframes(clipId: string): void
  /**
   * Apply an auto-zoom / punch-in preset (Phase 3.31). Resolves `presetId` via
   * `getZoomPreset`, builds RELATIVE keyframes for the clip's on-timeline span
   * (`buildZoomKeyframes`), composes each onto the clip's static transform
   * (scale multiplied — floored at 1 so a zoom never reveals gutters — x/y
   * offset added, rotation/opacity carried from the base), normalizes the
   * result, and REPLACES the clip's `transformKeyframes` track (CapCut
   * behavior). The static `transform` is left untouched. No-op for an unknown
   * preset, a missing clip, a caption clip, or when fewer than 2 keyframes
   * survive (clip too short). One undo step. Media + overlay clips only.
   */
  applyZoomPreset(clipId: string, presetId: string): void

  /**
   * Phase 3.52 — Auto-Reframe. Bulk-replace a media clip's
   * `transformKeyframes` with the array `kfs` (already in absolute, clip-
   * relative form). Skips silently when:
   *   - clip not found / not media / locked
   *   - any kf has non-finite `atMs` or malformed transform
   *   - after `normalizeKeyframes` + `clampClipTransform` the survivors
   *     collapse to fewer than 2 keyframes
   * One mutation per call; intended to be wrapped in a single undo step by
   * `runAutoReframe` (which pauses zundo's temporal and pushes one snapshot).
   */
  applyAutoReframeKeyframes(clipId: string, kfs: TransformKeyframe[]): void

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

  // --- Volume envelope (Phase 3.30, media clips only) ---
  /**
   * Add a volume keyframe at a clip-relative TIMELINE offset `atMs` (ms from
   * clip.startMs — volume is authored in timeline space, no source mapping).
   *  - If the clip has NO active envelope yet: seed TWO keyframes (atMs 0 +
   *    the clip's timeline duration `endMs-startMs`), both at the clip's
   *    current constant `gainDb` — enabling the envelope causes no jump.
   *  - If an envelope exists: insert ONE keyframe; its dB defaults to the
   *    interpolated value on the existing curve (`getVolumeDbAt`) unless
   *    `gainDb` overrides it.
   * A keyframe within MIN_VOLUME_KEYFRAME_GAP_MS of an existing one REPLACES
   * it. Capped at MAX_VOLUME_KEYFRAMES_PER_CLIP. No-op for caption clips or a
   * non-finite `atMs`. Collapses to `undefined` when fewer than 2 survive.
   */
  addVolumeKeyframe(clipId: string, atMs: number, gainDb?: number): void
  /**
   * Merge into the volume keyframe at `kfIndex`: re-clamp atMs into [0, clip
   * timeline duration], clamp gainDb into [MIN_GAIN_DB, MAX_GAIN_DB], then
   * re-normalize. If it collapses below 2 keyframes the envelope is dropped and
   * the survivor's dB is baked into the clip's constant `gainDb`.
   */
  updateVolumeKeyframe(
    clipId: string,
    kfIndex: number,
    partial: { atMs?: number; gainDb?: number }
  ): void
  /**
   * Remove the volume keyframe at `kfIndex`. If removal drops the envelope
   * below 2 keyframes, the envelope is cleared and the surviving keyframe's dB
   * is baked into the clip's constant `gainDb` (the sound does not change).
   */
  removeVolumeKeyframe(clipId: string, kfIndex: number): void
  /** Clear a clip's volume envelope entirely; keeps its constant `gainDb`. */
  clearVolumeKeyframes(clipId: string): void

  /**
   * Insert a freeze frame at SOURCE offset `sourceMs` (ms from trimInMs). The
   * frame sampled there is HELD for `durationMs` of timeline output (default
   * DEFAULT_FREEZE_MS). Rejected when the clip already has
   * MAX_FREEZE_FRAMES_PER_CLIP freezes, or `sourceMs`/`durationMs` non-finite.
   * Recomputes endMs via `recomputeEndMsForSpeed` (freeze-aware). No-op for
   * captions. Mirrors `addSpeedKeyframe`.
   */
  addFreezeFrame(clipId: string, sourceMs: number, durationMs?: number): void
  /**
   * Merge into the freeze frame at `freezeIndex`: re-base `sourceMs`/
   * `durationMs` (the contract resolver re-clamps/sorts/dedupes). Recomputes
   * endMs. Mirrors `updateSpeedKeyframe`.
   */
  updateFreezeFrame(
    clipId: string,
    freezeIndex: number,
    partial: { sourceMs?: number; durationMs?: number }
  ): void
  /** Remove the freeze frame at `freezeIndex`. Recomputes endMs. */
  removeFreezeFrame(clipId: string, freezeIndex: number): void
  /** Clear every freeze frame on a clip. Recomputes endMs. */
  clearFreezeFrames(clipId: string): void

  // --- Text-based editing (Phase 3.17) — media clips only ---
  /**
   * Store a word-level transcript on a media clip (the immutable STT output).
   * No-op for captions/overlays. Does NOT touch `deletedRanges` or `endMs` —
   * a fresh transcript adds no deletions.
   */
  setClipTranscript(clipId: string, transcript: ClipTranscript): void
  /**
   * Delete the SOURCE ranges covered by the given transcript word ids. Selected
   * words are mapped to `[sourceStartMs, sourceEndMs]`, contiguous words merged
   * into minimal ranges, and appended to `deletedRanges`. endMs is recomputed
   * (deletion-aware) and later clips ripple left. The clip's timeline footprint
   * is never allowed below MIN_CLIP_MS — a deletion that would shrink it past
   * that is clamped so a sliver survives. No-op for captions.
   */
  deleteTranscriptWords(clipId: string, wordIds: string[]): void
  /**
   * Restore the given transcript words — remove/trim any `deletedRanges`
   * portions overlapping the words' source ranges. Recomputes endMs + ripples.
   */
  restoreTranscriptWords(clipId: string, wordIds: string[]): void
  /**
   * Delete every transcript word matching the filler lexicon
   * (음·어·그·저·뭐·인제·이제·um·uh·er·ah·like). Returns the removed word ids.
   */
  removeFillerWords(clipId: string): string[]
  /** Clear all transcript deletions on a clip (keeps the transcript itself). */
  clearTranscriptDeletions(clipId: string): void

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

  // --- Collage / split-screen layout (Phase 3.18) ---
  /**
   * Arrange `clipIds` into the cells of a layout preset in ONE transaction.
   *
   * `clipIds[i]` is placed into `preset.cells[i]`; only the first
   * `min(clipIds.length, preset.cells.length)` ids are used. For each layout
   * clip this writes a static `transform` + `cropRect` (computed by
   * `cellToClipPlacement` from the clip's media natural size and the canvas
   * size), strips any `transformKeyframes` (a static cell placement conflicts
   * with an animation), and tags the clip with a shared fresh `layoutGroupId`.
   *
   * Compositing: each cell's clip is moved onto a DISTINCT video track so the
   * preview composites them as stacked layers — clip 0 keeps its track (bottom
   * layer), later cells go onto higher tracks (the LAST cell ends up highest,
   * so a PiP inset renders on top). New video tracks are created as needed; at
   * MAX_VIDEO_TRACKS surplus clips fall back to the overlay track or are
   * skipped (never crashes).
   *
   * Timing (`opts.alignTiming`, default true): every layout clip is given the
   * earliest member's `startMs` and the SHORTEST member's duration so they all
   * share a common on-screen window without over-extending any clip.
   *
   * No-op for empty / non-finite input or an unknown preset id.
   */
  applyLayout(
    presetId: LayoutPresetId,
    clipIds: string[],
    opts?: { alignTiming?: boolean }
  ): void
  /**
   * Undo a layout: for every clip carrying `layoutGroupId`, reset `transform`
   * and `cropRect` back to identity/undefined and clear `layoutGroupId`. ONE
   * transaction. NOTE: this only resets the visual placement — clips are NOT
   * moved back to their original tracks (that history is not stored).
   */
  clearLayout(layoutGroupId: string): void

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

  /**
   * Convert the project's aspect ratio. Routes through the documented pure
   * helper `aspectRatioConversion`, which mutates ONLY `aspectRatio` / `width`
   * / `height`. Clips re-fit the new canvas automatically because their
   * transforms are canvas-relative (fractional), so no clip is touched. This
   * is a single `touch` → one zundo (undo/redo) step. Export-graph-invariant:
   * the export pipeline reads the export preset's dimensions, not the project
   * dims, so converting never changes export output for a fixed preset.
   * `ratio` is typed `AspectRatio`, so the helper always returns valid dims —
   * no guard needed.
   */
  setAspectRatio(ratio: AspectRatio): void {
    const next = touch({ ...get().project, ...aspectRatioConversion(ratio) })
    set({ project: next })
    schedulePersist(next)
  },

  /**
   * Phase 3.27 — mark a timeline ms as the video's cover frame. The ms is
   * clamped into [0, totalDuration] via `resolveCoverMs`. Mutates ONLY
   * `project.coverMs` → exactly one zundo (undo/redo) step. Export-graph-
   * invariant: the cover JPG is a separate main-side ffmpeg pass.
   */
  setCoverMs(ms: number): void {
    const project = get().project
    const clamped = resolveCoverMs(ms, getTotalDurationMs(project))
    const next = touch({ ...project, coverMs: clamped })
    set({ project: next })
    schedulePersist(next)
  },

  /**
   * Phase 3.27 — clear the cover-frame marker. Removes the `coverMs` field
   * entirely so the export falls back to frame 0. No-op (no zundo step) when
   * the project already has no cover.
   */
  clearCoverMs(): void {
    const project = get().project
    if (project.coverMs == null) return
    const { coverMs: _drop, ...rest } = project
    const next = touch(rest)
    set({ project: next })
    schedulePersist(next)
  },

  /**
   * Phase 3.35 — merge `patch` over the progress-bar config. When the project
   * has no config yet, a disabled default is used as the base. `heightFrac` is
   * clamped to [MIN, MAX]; non-finite numeric fields are rejected (the prior
   * value is kept). Mutates ONLY `project.progressBar` → exactly one zundo
   * (undo/redo) step. The config object always survives an off→on round trip.
   */
  setProgressBar(patch: Partial<ProgressBarConfig>): void {
    const project = get().project
    const base: ProgressBarConfig = project.progressBar ?? {
      enabled: false,
      position: 'bottom',
      color: DEFAULT_PROGRESS_BAR_COLOR,
      heightFrac: DEFAULT_PROGRESS_BAR_HEIGHT_FRAC
    }
    const merged: ProgressBarConfig = { ...base, ...patch }
    // Reject non-finite numbers — fall back to the pre-patch value.
    let heightFrac = Number.isFinite(merged.heightFrac)
      ? merged.heightFrac
      : base.heightFrac
    heightFrac = Math.max(
      MIN_PROGRESS_BAR_HEIGHT_FRAC,
      Math.min(MAX_PROGRESS_BAR_HEIGHT_FRAC, heightFrac)
    )
    const nextCfg: ProgressBarConfig = {
      enabled: merged.enabled === true,
      position: merged.position === 'top' ? 'top' : 'bottom',
      color: merged.color,
      heightFrac
    }
    const next = touch({ ...project, progressBar: nextCfg })
    set({ project: next })
    schedulePersist(next)
  },

  /**
   * Phase 3.35 — flip the progress-bar `enabled` flag. Routes through
   * `setProgressBar` so the rest of the config (position/color/height) is
   * preserved across an off→on→off cycle.
   */
  toggleProgressBar(): void {
    const enabled = !(get().project.progressBar?.enabled ?? false)
    get().setProgressBar({ enabled })
  },

  // --------------------------------------------------------------------
  // Phase 3.44 — canvas backdrop fill.
  //
  // `null` or `{ kind: 'blur' }` COLLAPSES the field to absent — keeps the
  // persisted JSON byte-identical to "never set", which is the legacy
  // default (today's preview blur backdrop). A `color` payload validates
  // the `#rrggbb` hex; `#000000` collapses to `{ kind: 'black' }` (identical
  // pixels). An invalid hex falls back to absent (= blur), mirroring the
  // defensive guarantee in `getCanvasBackground`. All other kinds are
  // stored verbatim. Routes through touch()+set()+schedulePersist() so
  // each call = exactly one zundo step.
  // --------------------------------------------------------------------
  setCanvasBackground(bg: CanvasBackground | null): void {
    const project = get().project
    let nextField: CanvasBackground | null = null
    if (bg && typeof bg === 'object') {
      switch (bg.kind) {
        case 'blur':
          nextField = null
          break
        case 'black':
          nextField = { kind: 'black' }
          break
        case 'white':
          nextField = { kind: 'white' }
          break
        case 'color': {
          if (
            typeof bg.color === 'string' &&
            /^#[0-9a-fA-F]{6}$/.test(bg.color)
          ) {
            if (bg.color.toLowerCase() === '#000000') {
              nextField = { kind: 'black' }
            } else {
              nextField = { kind: 'color', color: bg.color }
            }
          } else {
            // Invalid hex → collapse to absent (= blur) per the
            // byte-identical-fallback guarantee.
            nextField = null
          }
          break
        }
        default:
          nextField = null
      }
    }
    let next: Project
    if (nextField === null) {
      // Collapse to absent — byte-identical to "never set".
      const { canvasBackground: _drop, ...rest } = project
      void _drop
      next = touch(rest as Project)
    } else {
      next = touch({ ...project, canvasBackground: nextField })
    }
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Phase 3.43 — preview-only horizontal guidelines.
  //
  // Mirrors the progress-bar action shape: every mutation routes through
  // `setPreviewGuides`, which sanitizes the input (drop NaN/non-finite,
  // clamp [0,1], cap at MAX_PREVIEW_GUIDES, sort ascending) and COLLAPSES
  // the field to absent when the cleaned list is empty — keeping the
  // persisted JSON byte-identical to "never set" → byte-identical preview
  // DOM gate (no `preview-guides-layer` element emitted).
  //
  // Each public action = exactly one zundo step via touch()+set()+persist.
  // --------------------------------------------------------------------
  setPreviewGuides(yFractions: number[]): void {
    const project = get().project
    const cleaned: number[] = []
    if (Array.isArray(yFractions)) {
      for (const v of yFractions) {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue
        const clamped = Math.max(
          MIN_PREVIEW_GUIDE_FRAC,
          Math.min(MAX_PREVIEW_GUIDE_FRAC, v)
        )
        cleaned.push(clamped)
        if (cleaned.length >= MAX_PREVIEW_GUIDES) break
      }
      cleaned.sort((a, b) => a - b)
    }
    let next: Project
    if (cleaned.length === 0) {
      // Collapse to absent — byte-identical to a project that never set the
      // field. This is the preview DOM gate (no overlay element emitted).
      const { previewGuides: _drop, ...rest } = project
      void _drop
      next = touch(rest as Project)
    } else {
      next = touch({ ...project, previewGuides: { yFractions: cleaned } })
    }
    set({ project: next })
    schedulePersist(next)
  },

  addPreviewGuide(yFrac?: number): void {
    const current = getPreviewGuides(get().project)
    if (current.length >= MAX_PREVIEW_GUIDES) return
    const value =
      typeof yFrac === 'number' && Number.isFinite(yFrac)
        ? yFrac
        : DEFAULT_PREVIEW_GUIDE_FRAC
    get().setPreviewGuides([...current, value])
  },

  removePreviewGuide(index: number): void {
    const current = getPreviewGuides(get().project)
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= current.length
    ) {
      return
    }
    const next = current.filter((_, i) => i !== index)
    get().setPreviewGuides(next)
  },

  updatePreviewGuide(index: number, yFrac: number): void {
    const current = getPreviewGuides(get().project)
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= current.length
    ) {
      return
    }
    if (typeof yFrac !== 'number' || !Number.isFinite(yFrac)) return
    const next = current.slice()
    next[index] = yFrac
    get().setPreviewGuides(next)
  },

  // --------------------------------------------------------------------
  // Adjustment layers (Phase 3.32) — range color-grades over the composite.
  //
  // Every mutation operates on `project.adjustmentLayers ?? []`, then
  // touch()+set()+schedulePersist() = one zundo step. The store KEEPS a
  // fully-neutral layer (so it stays selectable/editable) — only the
  // export-side `getAdjustmentLayers` drops neutral layers. Each grade
  // mutation neutral-collapses its own field (mirrors the per-clip grade
  // actions) to keep the persisted JSON + undo snapshots lean.
  // --------------------------------------------------------------------
  addAdjustmentLayer(startMs: number, endMs: number): string | null {
    const project = get().project
    const window = clampAdjustmentLayerWindow(startMs, endMs)
    if (!window) return null
    const layers = project.adjustmentLayers ?? []
    if (layers.length >= MAX_ADJUSTMENT_LAYERS) return null
    const id = ulid()
    const layer: AdjustmentLayer = {
      id,
      startMs: window.startMs,
      endMs: window.endMs
    }
    const next = touch({
      ...project,
      adjustmentLayers: [...layers, layer]
    })
    set({ project: next })
    schedulePersist(next)
    return id
  },

  removeAdjustmentLayer(id: string): void {
    const project = get().project
    const layers = project.adjustmentLayers ?? []
    const filtered = layers.filter((l) => l.id !== id)
    if (filtered.length === layers.length) return
    const next = touch({ ...project, adjustmentLayers: filtered })
    set({ project: next })
    schedulePersist(next)
  },

  updateAdjustmentLayer(id, patch): void {
    if (!patch || typeof patch !== 'object') return
    // Reject any non-finite numeric input outright (caller bug → no-op).
    for (const v of Object.values(patch)) {
      if (v !== undefined && !Number.isFinite(v)) return
    }
    const project = get().project
    const layers = project.adjustmentLayers ?? []
    let changed = false
    const nextLayers = layers.map((l) => {
      if (l.id !== id) return l
      const startMs = patch.startMs !== undefined ? patch.startMs : l.startMs
      const endMs = patch.endMs !== undefined ? patch.endMs : l.endMs
      const window = clampAdjustmentLayerWindow(startMs, endMs)
      if (!window) return l
      changed = true
      return { ...l, startMs: window.startMs, endMs: window.endMs }
    })
    if (!changed) return
    const next = touch({ ...project, adjustmentLayers: nextLayers })
    set({ project: next })
    schedulePersist(next)
  },

  setAdjustmentLayerColorAdjust(id, partial): void {
    if (!partial || typeof partial !== 'object') return
    for (const v of Object.values(partial)) {
      if (v !== undefined && !Number.isFinite(v)) return
    }
    const project = get().project
    const layers = project.adjustmentLayers ?? []
    let changed = false
    const nextLayers = layers.map((l) => {
      if (l.id !== id) return l
      const merged = clampColorAdjust({
        ...(l.colorAdjust ?? NEUTRAL_COLOR_ADJUST),
        ...partial
      })
      changed = true
      // Neutral-collapse: drop the field when all-neutral (mirrors setClipColorAdjust).
      return isNeutralColorAdjust(merged)
        ? { ...l, colorAdjust: undefined }
        : { ...l, colorAdjust: merged }
    })
    if (!changed) return
    const next = touch({ ...project, adjustmentLayers: nextLayers })
    set({ project: next })
    schedulePersist(next)
  },

  setAdjustmentLayerCurvePoint(id, channel, pointIndex, p): void {
    if (!p || typeof p !== 'object') return
    for (const v of Object.values(p)) {
      if (v !== undefined && !Number.isFinite(v)) return
    }
    const project = get().project
    const layers = project.adjustmentLayers ?? []
    let changed = false
    const nextLayers = layers.map((l) => {
      if (l.id !== id) return l
      const base = sanitizeClipCurves(l.curves ?? IDENTITY_CLIP_CURVES)
      const pts = base[channel]
      if (!pts || pointIndex < 0 || pointIndex >= pts.length) return l
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
      changed = true
      return isIdentityClipCurves(merged)
        ? { ...l, curves: undefined }
        : { ...l, curves: merged }
    })
    if (!changed) return
    const next = touch({ ...project, adjustmentLayers: nextLayers })
    set({ project: next })
    schedulePersist(next)
  },

  setAdjustmentLayerHslBand(id, band, partial): void {
    if (!partial || typeof partial !== 'object') return
    for (const v of Object.values(partial)) {
      if (v !== undefined && !Number.isFinite(v)) return
    }
    const project = get().project
    const layers = project.adjustmentLayers ?? []
    let changed = false
    const nextLayers = layers.map((l) => {
      if (l.id !== id) return l
      const base = sanitizeClipHsl(l.hsl ?? NEUTRAL_CLIP_HSL)
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
      changed = true
      return isNeutralClipHsl(merged)
        ? { ...l, hsl: undefined }
        : { ...l, hsl: merged }
    })
    if (!changed) return
    const next = touch({ ...project, adjustmentLayers: nextLayers })
    set({ project: next })
    schedulePersist(next)
  },

  setAdjustmentLayerFilterPreset(id, preset, intensity): void {
    const project = get().project
    const layers = project.adjustmentLayers ?? []
    const clamped = Math.max(0, Math.min(1, Number(intensity ?? 1)))
    let changed = false
    const nextLayers = layers.map((l) => {
      if (l.id !== id) return l
      changed = true
      return preset === 'none'
        ? { ...l, filterPreset: 'none' as FilterPreset, filterIntensity: 1 }
        : { ...l, filterPreset: preset, filterIntensity: clamped }
    })
    if (!changed) return
    const next = touch({ ...project, adjustmentLayers: nextLayers })
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

  updateMediaSfxMeta(mediaId: string, meta: SfxMeta): void {
    const project = get().project
    const existing = project.media[mediaId]
    if (!existing) return
    const next = touch({
      ...project,
      media: {
        ...project.media,
        [mediaId]: { ...existing, sfxMeta: meta }
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
    // against UI bugs). Phase 3.40 — delegate to the shared predicate so the
    // matrix has a single source of truth shared with `moveClipToTrack`.
    const track = project.tracks[trackIdx]
    if (!canPlaceClipOnTrack(clip.kind as ClipKind, track.kind)) return

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
    // Phase 3.33 — resolve the doomed set. If the target clip carries a
    // groupId, every group member dies together (covers keyboard Delete +
    // context-menu delete, both of which route here).
    let target: Clip | null = null
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => cc.id === clipId)
      if (c) {
        target = c
        break
      }
    }
    if (!target) return
    // Phase 3.41 — lock guard. If the target itself is locked → block. If
    // it's grouped, ANY locked member anchors the whole group (matches
    // moveClipGroup semantics).
    if (isClipLocked(target)) return
    if (target.groupId) {
      const members = getGroupMembers(project, target.groupId)
      for (const m of members) {
        if (isClipLocked(m)) return
      }
    }
    const doomed = new Set<string>(
      target.groupId
        ? getGroupMembers(project, target.groupId).map((c) => c.id)
        : [clipId]
    )
    let touched = false
    const tracks = project.tracks.map((t) => {
      const before = t.clips.length
      const clips = t.clips.filter((c) => !doomed.has(c.id))
      if (clips.length !== before) touched = true
      return { ...t, clips }
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --- Clip grouping / linking (Phase 3.33) ---
  groupClips(clipIds: string[]): string | null {
    const project = get().project
    // Collect distinct, existing clip ids among the request.
    const requested = new Set<string>()
    for (const id of clipIds) {
      if (typeof id === 'string') requested.add(id)
    }
    const known = new Set<string>()
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (requested.has(c.id)) known.add(c.id)
      }
    }
    // Need at least 2 real clips to form a group.
    if (known.size < 2) return null

    // Remember the prior groups touched, so we can sweep stale 1-member groups.
    const priorGroups = new Set<string>()
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (known.has(c.id) && c.groupId) priorGroups.add(c.groupId)
      }
    }

    const groupId = newId()
    // Assign the fresh groupId to every listed clip (overwriting any prior).
    let tracks = project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) =>
        known.has(c.id) ? { ...c, groupId } : c
      )
    }))

    // Sweep: any PRIOR group now left with <2 members → clear those members'
    // groupId so no stale 1-member group lingers.
    const stale = new Set<string>()
    for (const g of priorGroups) {
      if (g === groupId) continue
      let count = 0
      for (const t of tracks) {
        for (const c of t.clips) {
          if (c.groupId === g) count++
        }
      }
      if (count < 2) stale.add(g)
    }
    if (stale.size > 0) {
      tracks = tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.groupId && stale.has(c.groupId)
            ? { ...c, groupId: undefined }
            : c
        )
      }))
    }

    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
    return groupId
  },

  applyToGroup(groupId, patch): number {
    if (typeof groupId !== 'string' || groupId.length === 0) return 0
    if (!patch || typeof patch !== 'object') return 0
    const project = get().project
    const members = getGroupMembers(project, groupId)
    if (members.length === 0) return 0
    const clamp = (v: number, lo: number, hi: number): number =>
      Math.max(lo, Math.min(hi, v))
    let modified = 0
    const tracks = project.tracks.map((t) => {
      const clips = t.clips.map((c): typeof c => {
        if (c.groupId !== groupId) return c
        if (isClipLocked(c)) return c
        // Type-narrow up front — caption clips have no colorAdjust /
        // filterPreset / transform fields; skipping early keeps the spread
        // assignments below well-typed and avoids stray field writes.
        if (!isMediaClip(c) && !isOverlayClip(c)) return c
        let next: VideoAudioClip | OverlayClip = c
        let changed = false
        // colorAdjust / filterPreset / filterIntensity are media-clip-only
        // (OverlayClip doesn't carry these fields). Skip silently for overlays.
        const isMedia = isMediaClip(c)
        if (patch.colorAdjust !== undefined && isMedia) {
          const cur =
            (c as { colorAdjust?: ColorAdjust }).colorAdjust ??
            NEUTRAL_COLOR_ADJUST
          const merged: ColorAdjust = {
            brightness: clamp(
              Number.isFinite(patch.colorAdjust.brightness)
                ? (patch.colorAdjust.brightness as number)
                : cur.brightness,
              MIN_COLOR_ADJUST,
              MAX_COLOR_ADJUST
            ),
            contrast: clamp(
              Number.isFinite(patch.colorAdjust.contrast)
                ? (patch.colorAdjust.contrast as number)
                : cur.contrast,
              MIN_COLOR_ADJUST,
              MAX_COLOR_ADJUST
            ),
            saturation: clamp(
              Number.isFinite(patch.colorAdjust.saturation)
                ? (patch.colorAdjust.saturation as number)
                : cur.saturation,
              MIN_COLOR_ADJUST,
              MAX_COLOR_ADJUST
            ),
            temperature: clamp(
              Number.isFinite(patch.colorAdjust.temperature)
                ? (patch.colorAdjust.temperature as number)
                : cur.temperature,
              MIN_COLOR_ADJUST,
              MAX_COLOR_ADJUST
            )
          }
          const nextMedia = next as VideoAudioClip
          if (isNeutralColorAdjust(merged)) {
            const { colorAdjust: _drop, ...rest } = nextMedia
            next = rest as VideoAudioClip
          } else {
            next = { ...nextMedia, colorAdjust: merged }
          }
          changed = true
        }
        if (patch.filterPreset !== undefined && isMedia) {
          const nextMedia = next as VideoAudioClip
          if (patch.filterPreset === 'none') {
            const {
              filterPreset: _fp,
              filterIntensity: _fi,
              ...rest
            } = nextMedia
            next = rest as VideoAudioClip
          } else {
            next = { ...nextMedia, filterPreset: patch.filterPreset }
          }
          changed = true
        }
        if (
          patch.filterIntensity !== undefined &&
          Number.isFinite(patch.filterIntensity) &&
          isMedia
        ) {
          const v = clamp(Number(patch.filterIntensity), 0, 1)
          next = { ...(next as VideoAudioClip), filterIntensity: v }
          changed = true
        }
        if (patch.transform !== undefined) {
          const cur =
            ((c as unknown) as { transform?: ClipTransform }).transform ?? {
              x: 0,
              y: 0,
              scale: 1,
              rotation: 0,
              opacity: 1
            }
          const merged: ClipTransform = clampClipTransform({
            x: Number.isFinite(patch.transform.x)
              ? (patch.transform.x as number)
              : cur.x,
            y: Number.isFinite(patch.transform.y)
              ? (patch.transform.y as number)
              : cur.y,
            scale: Number.isFinite(patch.transform.scale)
              ? (patch.transform.scale as number)
              : cur.scale,
            rotation: Number.isFinite(patch.transform.rotation)
              ? (patch.transform.rotation as number)
              : cur.rotation,
            opacity: Number.isFinite(patch.transform.opacity)
              ? (patch.transform.opacity as number)
              : cur.opacity
          })
          if (isMedia) {
            next = { ...(next as VideoAudioClip), transform: merged }
          } else {
            next = { ...(next as OverlayClip), transform: merged }
          }
          changed = true
        }
        if (changed) modified += 1
        return next as typeof c
      })
      return { ...t, clips }
    })
    if (modified === 0) return 0
    const nextProj = touch({ ...project, tracks })
    set({ project: nextProj })
    schedulePersist(nextProj)
    return modified
  },

  ungroupClips(groupIdOrClipId: string): void {
    const project = get().project
    // The arg may be a groupId OR any member clip id. Resolve to a groupId.
    let groupId: string | null = null
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (c.id === groupIdOrClipId && c.groupId) {
          groupId = c.groupId
          break
        }
        if (c.groupId === groupIdOrClipId) {
          groupId = groupIdOrClipId
          break
        }
      }
      if (groupId) break
    }
    if (!groupId) return
    const gid = groupId
    let changed = false
    const tracks = project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.groupId === gid) {
          changed = true
          return { ...c, groupId: undefined }
        }
        return c
      })
    }))
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  moveClipGroup(clipId: string, desiredStartMs: number): void {
    const project = get().project
    // Locate the anchor clip.
    let anchor: Clip | null = null
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => cc.id === clipId)
      if (c) {
        anchor = c
        break
      }
    }
    if (!anchor) return
    const members = anchor.groupId
      ? getGroupMembers(project, anchor.groupId)
      : [anchor]
    // Phase 3.41 — if ANY member of the move set is locked, anchor the
    // whole group (whole-group atomic move semantics).
    for (const m of members) {
      if (isClipLocked(m)) return
    }
    const memberIds = new Set<string>(members.map((c) => c.id))
    let delta = Math.round(desiredStartMs) - anchor.startMs
    // Pre-clamp delta so the earliest member can't slide below 0 — the whole
    // group stops together rather than drifting apart.
    let earliest = Infinity
    for (const m of members) {
      if (m.startMs < earliest) earliest = m.startMs
    }
    if (earliest + delta < 0) delta = -earliest
    if (delta === 0) return
    const tracks = project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) =>
        memberIds.has(c.id)
          ? { ...c, startMs: c.startMs + delta, endMs: c.endMs + delta }
          : c
      )
    }))
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // Phase 3.40 — drag a single clip onto a different track. Only the named
  // clip moves; group members stay on their original tracks (groupId is
  // preserved so they remain a time-link).
  moveClipToTrack(clipId: string, newTrackId: string): void {
    const project = get().project
    let srcTrackIdx = -1
    let clipIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      const found = project.tracks[i].clips.findIndex((c) => c.id === clipId)
      if (found !== -1) {
        srcTrackIdx = i
        clipIdx = found
        break
      }
    }
    if (srcTrackIdx === -1 || clipIdx === -1) return
    const srcTrack = project.tracks[srcTrackIdx]
    // Same-track no-op.
    if (srcTrack.id === newTrackId) return
    const tgtTrackIdx = project.tracks.findIndex((t) => t.id === newTrackId)
    if (tgtTrackIdx === -1) return
    const tgtTrack = project.tracks[tgtTrackIdx]
    const clip = srcTrack.clips[clipIdx]
    // Phase 3.41 — locked clips can't be re-laned.
    if (isClipLocked(clip)) return
    if (!canPlaceClipOnTrack(clip.kind as ClipKind, tgtTrack.kind)) return
    // Build the new tracks array: drop the clip from the source lane, append
    // it to the target lane with `trackId` rewritten. Pass-through on every
    // other field (startMs/endMs/groupId/transform/etc.).
    const movedClip = { ...clip, trackId: newTrackId } as Clip
    const tracks = project.tracks.map((t, i) => {
      if (i === srcTrackIdx) {
        const clips = [...t.clips]
        clips.splice(clipIdx, 1)
        return { ...t, clips }
      }
      if (i === tgtTrackIdx) {
        return { ...t, clips: [...t.clips, movedClip] }
      }
      return t
    })
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
      // Phase 3.41 — locked clips reject trim edits.
      if (isClipLocked(cur)) return t
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
    // Phase 3.41 — locked clips reject splits.
    if (isClipLocked(orig)) return null
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
    // -------------------------------------------------------------------
    // Phase 3.16 — freeze-frame split handling. PARALLEL to the speed-curve
    // partition above. Freeze `sourceMs` is a SOURCE offset (ms from
    // trimInMs); `offsetSourceMs` is the split's source offset within the
    // ORIGINAL clip. Left keeps freezes with `sourceMs < offsetSourceMs`;
    // right keeps `sourceMs >= offsetSourceMs`, re-based by `-offsetSourceMs`
    // (the right clip's trimInMs becomes splitSource). No boundary freeze is
    // synthesized — a freeze is a point insertion, not a curve. Both halves
    // route through `recomputeEndMsForSpeed`. Empty halves drop the field.
    // -------------------------------------------------------------------
    let leftFreezes: FreezeFrame[] | undefined
    let rightFreezes: FreezeFrame[] | undefined
    if (hasFreezeFrames(orig)) {
      const allFz = getClipFreezeFrames(orig)
      const leftRaw = allFz.filter((f) => f.sourceMs < offsetSourceMs)
      const rightRaw = allFz
        .filter((f) => f.sourceMs >= offsetSourceMs)
        .map((f) => ({
          sourceMs: f.sourceMs - offsetSourceMs,
          durationMs: f.durationMs
        }))
      leftFreezes = leftRaw.length > 0 ? leftRaw : undefined
      rightFreezes = rightRaw.length > 0 ? rightRaw : undefined
    }
    // -------------------------------------------------------------------
    // Phase 3.30 — volume-envelope split handling. PARALLEL to the
    // transform-keyframe partition above — volume keyframes' atMs are
    // clip-relative TIMELINE offsets (ms from clip.startMs), so the cut is
    // keyed on `splitOffsetLocalMs` (= atMs - orig.startMs). Left keeps
    // keyframes at/before the cut offset; right keeps those at/after,
    // re-based by `-splitOffsetLocalMs`. A boundary keyframe (the dB AT the
    // cut) is synthesized on both sides so neither half jumps. A half that
    // collapses below 2 keyframes drops its envelope + bakes the survivor's
    // dB into the constant `gainDb`.
    // -------------------------------------------------------------------
    let leftVolumeKfs: VolumeKeyframe[] | undefined
    let rightVolumeKfs: VolumeKeyframe[] | undefined
    let leftGainDb = orig.gainDb
    let rightGainDb = orig.gainDb
    if (hasVolumeEnvelope(orig)) {
      const splitOffsetLocalMs = atMs - orig.startMs
      const boundaryDb = getVolumeDbAt(orig, splitOffsetLocalMs)
      const allVol = orig.volumeKeyframes as VolumeKeyframe[]
      const leftVolRaw: VolumeKeyframe[] = [
        ...allVol.filter((kf) => kf.atMs <= splitOffsetLocalMs),
        { atMs: splitOffsetLocalMs, gainDb: boundaryDb }
      ]
      const rightVolRaw: VolumeKeyframe[] = [
        { atMs: 0, gainDb: boundaryDb },
        ...allVol
          .filter((kf) => kf.atMs >= splitOffsetLocalMs)
          .map((kf) => ({
            atMs: kf.atMs - splitOffsetLocalMs,
            gainDb: kf.gainDb
          }))
      ]
      const leftVolNorm = normalizeVolumeKeyframes(leftVolRaw)
      const rightVolNorm = normalizeVolumeKeyframes(rightVolRaw)
      if (leftVolNorm.length >= 2) {
        leftVolumeKfs = leftVolNorm
      } else {
        leftGainDb = leftVolNorm[0]?.gainDb ?? boundaryDb
      }
      if (rightVolNorm.length >= 2) {
        rightVolumeKfs = rightVolNorm
      } else {
        rightGainDb = rightVolNorm[0]?.gainDb ?? boundaryDb
      }
    }
    // -------------------------------------------------------------------
    // Phase 3.17 — text-based-editing split handling. PARALLEL to the
    // freeze-frame partition above. `transcript.words` + `deletedRanges` are
    // ABSOLUTE source ms, so the split is keyed on `splitSource` (the absolute
    // source ms of the split point) — NOT a re-based offset. The {...orig}
    // spread carries both fields verbatim to each half; we OVERRIDE them so
    // each half keeps only its own source window's words/ranges.
    //   - words: a word goes to the half whose source window CONTAINS its
    //     [sourceStartMs, sourceEndMs] midpoint (words straddling the cut are
    //     assigned by midpoint — they stay whole, no word is duplicated).
    //   - deletedRanges: each range is CLAMPED to each half's source window;
    //     a clamped range with zero span is dropped.
    // Empty halves drop the field (lean JSON, byte-identical legacy).
    // -------------------------------------------------------------------
    let leftTranscript: ClipTranscript | undefined
    let rightTranscript: ClipTranscript | undefined
    let leftDeletedRanges: DeletedRange[] | undefined
    let rightDeletedRanges: DeletedRange[] | undefined
    if (orig.transcript && Array.isArray(orig.transcript.words)) {
      const allWords = orig.transcript.words
      const leftWords = allWords.filter(
        (w) => (w.sourceStartMs + w.sourceEndMs) / 2 < splitSource
      )
      const rightWords = allWords.filter(
        (w) => (w.sourceStartMs + w.sourceEndMs) / 2 >= splitSource
      )
      leftTranscript =
        leftWords.length > 0
          ? { ...orig.transcript, words: leftWords }
          : undefined
      rightTranscript =
        rightWords.length > 0
          ? { ...orig.transcript, words: rightWords }
          : undefined
    }
    if (Array.isArray(orig.deletedRanges) && orig.deletedRanges.length > 0) {
      const clampRanges = (lo: number, hi: number): DeletedRange[] =>
        orig
          .deletedRanges!.filter((r) => !!r && typeof r === 'object')
          .map((r) => ({
            sourceStartMs: Math.max(
              lo,
              Math.min(hi, Math.min(r.sourceStartMs, r.sourceEndMs))
            ),
            sourceEndMs: Math.max(
              lo,
              Math.min(hi, Math.max(r.sourceStartMs, r.sourceEndMs))
            )
          }))
          .filter((r) => r.sourceEndMs - r.sourceStartMs > 0)
      const leftRanges = clampRanges(orig.trimInMs, splitSource)
      const rightRanges = clampRanges(splitSource, orig.trimOutMs)
      leftDeletedRanges = leftRanges.length > 0 ? leftRanges : undefined
      rightDeletedRanges = rightRanges.length > 0 ? rightRanges : undefined
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
      speedKeyframes: leftSpeedKfs,
      freezeFrames: leftFreezes,
      gainDb: leftGainDb,
      volumeKeyframes: leftVolumeKfs,
      transcript: leftTranscript,
      deletedRanges: leftDeletedRanges
    })
    const right: VideoAudioClip = recomputeEndMsForSpeed({
      ...orig,
      id: newRightId,
      startMs: atMs,
      trimInMs: splitSource,
      transform: rightStaticTransform,
      transformKeyframes: rightKfs,
      speed: rightSpeed,
      speedKeyframes: rightSpeedKfs,
      freezeFrames: rightFreezes,
      gainDb: rightGainDb,
      volumeKeyframes: rightVolumeKfs,
      transcript: rightTranscript,
      deletedRanges: rightDeletedRanges
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
    // Phase 3.33 — STRIP groupId on every duplicate branch: a copy must NOT
    // silently inherit the original's link group.
    let dup: Clip
    if (isCaptionClip(orig)) {
      dup = {
        ...orig,
        id: newClipId,
        startMs: start,
        endMs: start + duration,
        groupId: undefined,
        spans: orig.spans.map((s) => ({ ...s })),
        style: { ...orig.style }
      }
    } else if (isOverlayClip(orig)) {
      dup = {
        ...orig,
        id: newClipId,
        startMs: start,
        endMs: start + duration,
        groupId: undefined,
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
        endMs: start + duration,
        groupId: undefined
      }
      // Phase 3.30 — deep-copy the volume envelope so future edits to the
      // duplicate's keyframes don't mutate the original's array.
      if (orig.volumeKeyframes !== undefined) {
        dup.volumeKeyframes = orig.volumeKeyframes.map((kf) => ({ ...kf }))
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

  splitClipAtMany(clipId, atMsList): string[] {
    if (!Array.isArray(atMsList) || atMsList.length === 0) return []
    // Sort DESCENDING so each split bites the right-fragment first and the
    // original clipId stays valid as the leftmost piece through the loop.
    const sorted = [...atMsList]
      .filter((x) => Number.isFinite(x))
      .map((x) => Math.round(Number(x)))
      .sort((a, b) => b - a)
    const newIds: string[] = []
    for (const at of sorted) {
      const id = get().splitClipAt(clipId, at)
      if (id) newIds.push(id)
    }
    // Reverse so the returned ids are in left→right timeline order.
    return newIds.reverse()
  },

  detachAudio(clipId: string): string | null {
    const project = get().project
    // Locate the source clip + its track.
    let srcTrack: Track | null = null
    let srcClip: Clip | null = null
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => cc.id === clipId)
      if (c) {
        srcTrack = t
        srcClip = c
        break
      }
    }
    if (!srcTrack || !srcClip) return null
    // Only video-track media clips carry embedded audio to detach.
    if (!isMediaClip(srcClip)) return null
    if (srcTrack.kind !== 'video') return null
    // Already muted → either already detached or deliberately silenced;
    // adding an audible twin would double the audio. Bail.
    if (srcClip.isMuted === true) return null

    // Resolve a target audio track: reuse the first existing 'audio' track,
    // else build a fresh one INLINE (so the whole detach is one set()).
    const existingAudio = project.tracks.find((t) => t.kind === 'audio')
    let audioTrackId: string
    let newAudioTrack: Track | null = null
    if (existingAudio) {
      audioTrackId = existingAudio.id
    } else {
      // Respect the per-kind cap: if at MAX_AUDIO_TRACKS with no audio track,
      // we cannot create one (unreachable when cap >= 1, but keeps the
      // invariant explicit).
      const audioCount = project.tracks.filter((t) => t.kind === 'audio').length
      if (audioCount >= MAX_AUDIO_TRACKS) return null
      audioTrackId = ulid()
      newAudioTrack = {
        id: audioTrackId,
        kind: 'audio',
        name: 'Voice 1',
        clips: [],
        role: 'voice'
      }
    }

    // Build the detached audio clip — a new 'media' clip on the audio track.
    // SAME mediaId + timeline/trim/speed window so the export audio collector
    // reads [N:a:0] of the same video input. Video-only fields are NOT copied;
    // the detached clip is NOT muted (it must be audible).
    const newClipId = ulid()
    // Phase 3.33 — auto-link: the detached audio and its source video join one
    // link group so they move / delete together. Reuse the source's existing
    // group if it has one, else mint a fresh group id.
    const linkGroupId = srcClip.groupId ?? newId()
    const detached: VideoAudioClip = {
      id: newClipId,
      kind: 'media',
      mediaId: srcClip.mediaId,
      trackId: audioTrackId,
      startMs: srcClip.startMs,
      endMs: srcClip.endMs,
      trimInMs: srcClip.trimInMs,
      trimOutMs: srcClip.trimOutMs,
      groupId: linkGroupId
    }
    if (srcClip.speed !== undefined) detached.speed = srcClip.speed
    if (srcClip.speedKeyframes !== undefined) {
      detached.speedKeyframes = srcClip.speedKeyframes.map((kf) => ({ ...kf }))
    }
    if (srcClip.freezeFrames !== undefined) {
      detached.freezeFrames = srcClip.freezeFrames.map((ff) => ({ ...ff }))
    }
    if (srcClip.deletedRanges !== undefined) {
      detached.deletedRanges = srcClip.deletedRanges.map((dr) => ({ ...dr }))
    }
    if (srcClip.gainDb !== undefined) detached.gainDb = srcClip.gainDb
    if (srcClip.volumeKeyframes !== undefined) {
      detached.volumeKeyframes = srcClip.volumeKeyframes.map((kf) => ({
        ...kf
      }))
    }
    if (srcClip.fadeInMs !== undefined) detached.fadeInMs = srcClip.fadeInMs
    if (srcClip.fadeOutMs !== undefined) detached.fadeOutMs = srcClip.fadeOutMs
    if (srcClip.reversed !== undefined) detached.reversed = srcClip.reversed

    // ONE immutable tracks rebuild: mute the source clip on its video track,
    // add the detached clip onto the (reused or freshly-built) audio track.
    let tracks = project.tracks.map((t) => {
      if (t.id === srcTrack!.id) {
        return {
          ...t,
          clips: t.clips.map((c) =>
            // Phase 3.33 — also link the source clip into the same group.
            c.id === clipId
              ? { ...c, isMuted: true, groupId: linkGroupId }
              : c
          )
        }
      }
      if (existingAudio && t.id === audioTrackId) {
        return { ...t, clips: [...t.clips, detached] }
      }
      return t
    })
    if (newAudioTrack) {
      // Insert the fresh audio track right after the last video/audio track
      // (CapCut layout — audio lanes sit below video, above caption/overlay).
      let insertIdx = tracks.length
      for (let i = 0; i < tracks.length; i++) {
        if (tracks[i].kind === 'video' || tracks[i].kind === 'audio') {
          insertIdx = i + 1
        }
      }
      const withClip: Track = { ...newAudioTrack, clips: [detached] }
      tracks = [...tracks]
      tracks.splice(insertIdx, 0, withClip)
    }
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

  /**
   * Toggle reverse (역재생) on a media clip. Reverse does NOT change the
   * clip's timeline duration, so endMs is NOT recomputed. Setting
   * `reversed:true` is refused (no-op) when `!canReverseClip(clip)` —
   * reverse is mutually exclusive with a speed curve / freeze frames /
   * transcript deletions. When `false` the field is omitted (BC-clean JSON).
   */
  setClipReversed(clipId: string, reversed: boolean): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Reverse is a media-only concept; silently ignore captions.
      if (!isMediaClip(c)) return t
      // Mutual exclusivity: refuse to turn reverse ON when the clip has a
      // speed curve / freeze frames / transcript deletions.
      if (reversed && !canReverseClip(c)) return t
      // Omit the field when false → BC-clean JSON, identical export/preview.
      const nextReversed = reversed ? true : undefined
      if ((c.reversed ?? undefined) === nextReversed) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, reversed: nextReversed }
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

  // Phase 3.41 — per-clip lock toggle. Pure editing-guard metadata; the
  // export pipeline NEVER reads `clip.locked`, so toggling this field MUST
  // leave `buildPlan().filterGraph` byte-identical. Single zundo step.
  setClipLocked(clipId: string, locked: boolean): void {
    const project = get().project
    let changed = false
    const nextLocked = locked ? true : undefined
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const cur = t.clips[idx]
      if (Boolean(cur.locked) === Boolean(locked)) return t
      const clips = [...t.clips]
      clips[idx] = { ...cur, locked: nextLocked } as Clip
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

  setClipRetouch(clipId: string, strength: number): void {
    const numeric = Number(strength)
    if (!Number.isFinite(numeric)) return
    const clamped = Math.max(MIN_RETOUCH, Math.min(MAX_RETOUCH, numeric))
    // Store `undefined` when OFF (clamped <= 0) — keeps persisted JSON + undo
    // snapshots lean, mirroring setClipNoiseReduction's collapse-to-undefined.
    const nextVal = clamped <= 0 ? undefined : Math.round(clamped)
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if ((c.retouch ?? undefined) === nextVal) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, retouch: nextVal }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // Phase 3.49 — video quality enhancer. Mirrors setClipRetouch exactly:
  // collapse to undefined when OFF for lean persisted JSON.
  setClipEnhance(clipId: string, strength: number): void {
    const numeric = Number(strength)
    if (!Number.isFinite(numeric)) return
    const clamped = Math.max(MIN_ENHANCE, Math.min(MAX_ENHANCE, numeric))
    const nextVal = clamped <= 0 ? undefined : Math.round(clamped)
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if ((c.enhance ?? undefined) === nextVal) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, enhance: nextVal }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipStabilize(clipId: string, strength: number): void {
    const numeric = Number(strength)
    if (!Number.isFinite(numeric)) return
    const clamped = Math.max(MIN_STABILIZE, Math.min(MAX_STABILIZE, numeric))
    // Store `undefined` when OFF (clamped <= 0) — keeps persisted JSON + undo
    // snapshots lean, mirroring setClipRetouch's collapse-to-undefined.
    const nextVal = clamped <= 0 ? undefined : Math.round(clamped)
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if ((c.stabilize ?? undefined) === nextVal) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, stabilize: nextVal }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipFilmLook(clipId: string, patch: Partial<FilmLook>): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const merged: FilmLook = { ...NEUTRAL_FILM_LOOK, ...c.filmLook, ...patch }
      const clampOne = (n: number): number =>
        Number.isFinite(n)
          ? Math.max(MIN_FILM_LOOK, Math.min(MAX_FILM_LOOK, n))
          : 0
      merged.vignette = clampOne(merged.vignette)
      merged.grain = clampOne(merged.grain)
      if (!FILM_TONE_IDS.includes(merged.toneId)) merged.toneId = 'none'
      // Collapse to `undefined` when OFF — keeps persisted JSON + undo
      // snapshots lean, mirroring setClipRetouch's collapse-to-undefined.
      const nextVal = isNeutralFilmLook(merged) ? undefined : merged
      const clips = [...t.clips]
      clips[idx] = { ...c, filmLook: nextVal }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipVoiceEnhance(clipId: string, patch: Partial<VoiceEnhance>): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      // Merge over NEUTRAL so missing sub-toggles default to OFF, then coerce
      // every field to boolean explicitly (defensive against truthy non-bool
      // values landing here from IPC / tests).
      const raw: VoiceEnhance = {
        ...NEUTRAL_VOICE_ENHANCE,
        ...c.voiceEnhance,
        ...patch
      }
      const merged: VoiceEnhance = {
        loudnorm: Boolean(raw.loudnorm),
        compress: Boolean(raw.compress),
        deEss: Boolean(raw.deEss),
        eqLowCut: Boolean(raw.eqLowCut),
        eqPresence: Boolean(raw.eqPresence)
      }
      // 5-field equality check — skip the update when nothing changed.
      const prev = c.voiceEnhance
      const prevLoudnorm = Boolean(prev?.loudnorm)
      const prevCompress = Boolean(prev?.compress)
      const prevDeEss = Boolean(prev?.deEss)
      const prevEqLowCut = Boolean(prev?.eqLowCut)
      const prevEqPresence = Boolean(prev?.eqPresence)
      if (
        prevLoudnorm === merged.loudnorm &&
        prevCompress === merged.compress &&
        prevDeEss === merged.deEss &&
        prevEqLowCut === merged.eqLowCut &&
        prevEqPresence === merged.eqPresence
      ) {
        return t
      }
      // Collapse to `undefined` when OFF — keeps persisted JSON + undo
      // snapshots lean, mirroring setClipFilmLook's collapse-to-undefined.
      const nextVal = isNeutralVoiceEnhance(merged) ? undefined : merged
      const clips = [...t.clips]
      clips[idx] = { ...c, voiceEnhance: nextVal }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // Phase 3.51 — visual-effect preset. 'none' (or unknown) collapses to
  // `undefined` for lean persisted JSON (byte-identical to "never set").
  setClipVisualEffect(clipId: string, id: VisualEffectId): void {
    const safeId =
      VISUAL_EFFECT_IDS.includes(id) && id !== 'none' ? id : undefined
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if ((c.visualEffect ?? undefined) === safeId) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, visualEffect: safeId }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // Phase 3.50 — voice-changer preset. 'none' (or unknown) collapses to
  // `undefined` for lean persisted JSON (byte-identical to "never set").
  setClipVoiceChanger(clipId: string, id: VoiceChangerId): void {
    const safeId =
      VOICE_CHANGER_IDS.includes(id) && id !== 'none' ? id : undefined
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if ((c.voiceChangerId ?? undefined) === safeId) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, voiceChangerId: safeId }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  setClipLutPath(clipId, lutPath): void {
    const next: string | undefined =
      lutPath === null || lutPath === '' || typeof lutPath !== 'string'
        ? undefined
        : lutPath
    if (next !== undefined && !next.toLowerCase().endsWith('.cube')) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const clips = t.clips.map((c) => {
        if (c.id !== clipId) return c
        if (!isMediaClip(c)) return c
        const cur = c.lutPath
        if (cur === next) return c
        changed = true
        if (next === undefined) {
          const { lutPath: _drop, ...rest } = c
          return rest as typeof c
        }
        return { ...c, lutPath: next }
      })
      return { ...t, clips }
    })
    if (!changed) return
    const nextProj = touch({ ...project, tracks })
    set({ project: nextProj })
    schedulePersist(nextProj)
  },

  setClipColor(clipId, color): void {
    if (color !== null && !(CLIP_COLOR_IDS as readonly string[]).includes(color)) {
      return
    }
    const next: ClipColorId | undefined =
      color === null || color === 'none' ? undefined : (color as ClipColorId)
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const clips = t.clips.map((c) => {
        if (c.id !== clipId) return c
        const cur = (c as { color?: ClipColorId }).color
        if (cur === next) return c
        changed = true
        if (next === undefined) {
          const { color: _drop, ...rest } = c as typeof c & {
            color?: ClipColorId
          }
          return rest as typeof c
        }
        return { ...c, color: next }
      })
      return { ...t, clips }
    })
    if (!changed) return
    const nextProj = touch({ ...project, tracks })
    set({ project: nextProj })
    schedulePersist(nextProj)
  },

  // ----- Phase 3.57 — advanced trim modes -----

  rippleTrim(clipId, side, deltaMs): void {
    if (!Number.isFinite(deltaMs)) return
    const d = Math.round(Number(deltaMs))
    if (d === 0) return
    if (side !== 'in' && side !== 'out') return
    const MIN_CLIP_MS = 30
    const project = get().project
    let trackIdx = -1
    let clipIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      const ci = project.tracks[i].clips.findIndex((c) => c.id === clipId)
      if (ci !== -1) {
        trackIdx = i
        clipIdx = ci
        break
      }
    }
    if (trackIdx === -1) return
    const track = project.tracks[trackIdx]
    const clip = track.clips[clipIdx]
    if (!isMediaClip(clip)) return
    if (isClipLocked(clip)) return
    const media = project.media[clip.mediaId]
    const maxSource = media?.durationMs ?? Number.MAX_SAFE_INTEGER
    let newStart = clip.startMs
    let newEnd = clip.endMs
    let newTrimIn = clip.trimInMs
    let newTrimOut = clip.trimOutMs
    if (side === 'out') {
      newTrimOut = clip.trimOutMs - d
      newEnd = clip.endMs - d
      if (newTrimOut < 0 || newTrimOut > maxSource) return
      if (newEnd - newStart < MIN_CLIP_MS) return
    } else {
      newTrimIn = clip.trimInMs + d
      newStart = clip.startMs + d
      if (newTrimIn < 0 || newTrimIn > maxSource) return
      if (newEnd - newStart < MIN_CLIP_MS) return
    }
    // Translate later clips by -d ms (since this clip shrunk by d on
    // either side). 'later' = startMs >= clip.endMs (current pre-edit).
    const sameTrackLaterStartBoundary = clip.endMs
    const tracks = project.tracks.map((t, i) => {
      if (i !== trackIdx) return t
      const clips = t.clips.map((c) => {
        if (c.id === clipId) {
          if (side === 'out') {
            return { ...c, endMs: newEnd, trimOutMs: newTrimOut }
          }
          return { ...c, startMs: newStart, trimInMs: newTrimIn }
        }
        if (c.startMs >= sameTrackLaterStartBoundary) {
          return { ...c, startMs: c.startMs - d, endMs: c.endMs - d }
        }
        return c
      })
      // Reject if any later clip would land at startMs < 0.
      if (clips.some((c) => c.startMs < 0)) return t
      return { ...t, clips }
    })
    // Detect no-op (no track was actually updated).
    if (tracks === project.tracks) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  rollingTrim(clipId, side, deltaMs): void {
    if (!Number.isFinite(deltaMs)) return
    const d = Math.round(Number(deltaMs))
    if (d === 0) return
    if (side !== 'in' && side !== 'out') return
    const MIN_CLIP_MS = 30
    const project = get().project
    let trackIdx = -1
    let clipIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      const ci = project.tracks[i].clips.findIndex((c) => c.id === clipId)
      if (ci !== -1) {
        trackIdx = i
        clipIdx = ci
        break
      }
    }
    if (trackIdx === -1) return
    const track = project.tracks[trackIdx]
    const clip = track.clips[clipIdx]
    if (!isMediaClip(clip)) return
    if (isClipLocked(clip)) return
    // Find neighbor: sort by startMs and find adjacent.
    const ordered = [...track.clips]
      .filter((c) => isMediaClip(c))
      .sort((a, b) => a.startMs - b.startMs)
    const orderedIdx = ordered.findIndex((c) => c.id === clipId)
    const neighbor =
      side === 'out'
        ? ordered[orderedIdx + 1]
        : ordered[orderedIdx - 1]
    if (!neighbor || !isMediaClip(neighbor)) return
    if (isClipLocked(neighbor)) return
    const media = project.media[clip.mediaId]
    const neighborMedia = project.media[neighbor.mediaId]
    const maxSource = media?.durationMs ?? Number.MAX_SAFE_INTEGER
    const maxNeighborSource =
      neighborMedia?.durationMs ?? Number.MAX_SAFE_INTEGER
    // Rolling at the shared boundary moves clip's edge by +d ms and the
    // neighbor's facing edge by the same +d ms (so combined length is fixed).
    if (side === 'out') {
      const newEnd = clip.endMs + d
      const newTrimOut = clip.trimOutMs + d
      const newNeighborStart = neighbor.startMs + d
      const newNeighborTrimIn = neighbor.trimInMs + d
      if (newTrimOut < 0 || newTrimOut > maxSource) return
      if (newEnd - clip.startMs < MIN_CLIP_MS) return
      if (newNeighborTrimIn < 0 || newNeighborTrimIn > maxNeighborSource)
        return
      if (neighbor.endMs - newNeighborStart < MIN_CLIP_MS) return
      const tracks = project.tracks.map((t, i) => {
        if (i !== trackIdx) return t
        const clips = t.clips.map((c) => {
          if (c.id === clip.id)
            return { ...c, endMs: newEnd, trimOutMs: newTrimOut }
          if (c.id === neighbor.id)
            return {
              ...c,
              startMs: newNeighborStart,
              trimInMs: newNeighborTrimIn
            }
          return c
        })
        return { ...t, clips }
      })
      const next = touch({ ...project, tracks })
      set({ project: next })
      schedulePersist(next)
    } else {
      const newStart = clip.startMs + d
      const newTrimIn = clip.trimInMs + d
      const newNeighborEnd = neighbor.endMs + d
      const newNeighborTrimOut = neighbor.trimOutMs + d
      if (newTrimIn < 0 || newTrimIn > maxSource) return
      if (clip.endMs - newStart < MIN_CLIP_MS) return
      if (newNeighborTrimOut < 0 || newNeighborTrimOut > maxNeighborSource)
        return
      if (newNeighborEnd - neighbor.startMs < MIN_CLIP_MS) return
      const tracks = project.tracks.map((t, i) => {
        if (i !== trackIdx) return t
        const clips = t.clips.map((c) => {
          if (c.id === clip.id)
            return { ...c, startMs: newStart, trimInMs: newTrimIn }
          if (c.id === neighbor.id)
            return {
              ...c,
              endMs: newNeighborEnd,
              trimOutMs: newNeighborTrimOut
            }
          return c
        })
        return { ...t, clips }
      })
      const next = touch({ ...project, tracks })
      set({ project: next })
      schedulePersist(next)
    }
  },

  slipClip(clipId, deltaMs): void {
    if (!Number.isFinite(deltaMs)) return
    const d = Math.round(Number(deltaMs))
    if (d === 0) return
    const project = get().project
    let trackIdx = -1
    let clipIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      const ci = project.tracks[i].clips.findIndex((c) => c.id === clipId)
      if (ci !== -1) {
        trackIdx = i
        clipIdx = ci
        break
      }
    }
    if (trackIdx === -1) return
    const clip = project.tracks[trackIdx].clips[clipIdx]
    if (!isMediaClip(clip)) return
    if (isClipLocked(clip)) return
    const media = project.media[clip.mediaId]
    const maxSource = media?.durationMs ?? Number.MAX_SAFE_INTEGER
    const newTrimIn = clip.trimInMs + d
    const newTrimOut = clip.trimOutMs + d
    if (newTrimIn < 0 || newTrimIn > maxSource) return
    if (newTrimOut < 0 || newTrimOut > maxSource) return
    if (newTrimIn >= newTrimOut) return
    const tracks = project.tracks.map((t, i) => {
      if (i !== trackIdx) return t
      const clips = t.clips.map((c) =>
        c.id === clipId
          ? { ...c, trimInMs: newTrimIn, trimOutMs: newTrimOut }
          : c
      )
      return { ...t, clips }
    })
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  slideClip(clipId, deltaMs): void {
    if (!Number.isFinite(deltaMs)) return
    const d = Math.round(Number(deltaMs))
    if (d === 0) return
    const MIN_CLIP_MS = 30
    const project = get().project
    let trackIdx = -1
    let clipIdx = -1
    for (let i = 0; i < project.tracks.length; i++) {
      const ci = project.tracks[i].clips.findIndex((c) => c.id === clipId)
      if (ci !== -1) {
        trackIdx = i
        clipIdx = ci
        break
      }
    }
    if (trackIdx === -1) return
    const track = project.tracks[trackIdx]
    const clip = track.clips[clipIdx]
    if (!isMediaClip(clip)) return
    if (isClipLocked(clip)) return
    const ordered = [...track.clips]
      .filter((c) => isMediaClip(c))
      .sort((a, b) => a.startMs - b.startMs)
    const orderedIdx = ordered.findIndex((c) => c.id === clipId)
    const prev = ordered[orderedIdx - 1]
    const next_ = ordered[orderedIdx + 1]
    if (!prev || !next_ || !isMediaClip(prev) || !isMediaClip(next_)) return
    if (isClipLocked(prev) || isClipLocked(next_)) return
    const prevMedia = project.media[prev.mediaId]
    const nextMedia = project.media[next_.mediaId]
    const maxPrevSource =
      prevMedia?.durationMs ?? Number.MAX_SAFE_INTEGER
    const maxNextSource =
      nextMedia?.durationMs ?? Number.MAX_SAFE_INTEGER
    // Slide clip by d ms: prev extends by +d (trimOut += d), next shrinks by
    // +d (trimIn += d, startMs += d). Clip keeps duration.
    const newClipStart = clip.startMs + d
    const newClipEnd = clip.endMs + d
    const newPrevEnd = prev.endMs + d
    const newPrevTrimOut = prev.trimOutMs + d
    const newNextStart = next_.startMs + d
    const newNextTrimIn = next_.trimInMs + d
    if (newPrevTrimOut < 0 || newPrevTrimOut > maxPrevSource) return
    if (newPrevEnd - prev.startMs < MIN_CLIP_MS) return
    if (newNextTrimIn < 0 || newNextTrimIn > maxNextSource) return
    if (next_.endMs - newNextStart < MIN_CLIP_MS) return
    if (newClipStart < 0) return
    const tracks = project.tracks.map((t, i) => {
      if (i !== trackIdx) return t
      const clips = t.clips.map((c) => {
        if (c.id === clip.id)
          return { ...c, startMs: newClipStart, endMs: newClipEnd }
        if (c.id === prev.id)
          return { ...c, endMs: newPrevEnd, trimOutMs: newPrevTrimOut }
        if (c.id === next_.id)
          return {
            ...c,
            startMs: newNextStart,
            trimInMs: newNextTrimIn
          }
        return c
      })
      return { ...t, clips }
    })
    const nextProj = touch({ ...project, tracks })
    set({ project: nextProj })
    schedulePersist(nextProj)
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

  setTrackDucking(trackId, target, db): void {
    // Defensive type guards — IPC may deliver malformed payloads.
    if (target !== 'voice' && target !== null) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      if (t.id !== trackId) return t
      if (t.kind !== 'audio') return t
      if (target === null) {
        if (t.duckTarget === undefined || t.duckTarget === null) return t
        const { duckTarget: _drop, ...rest } = t
        changed = true
        return rest as typeof t
      }
      // target === 'voice': set BGM role + duckTarget + clamp dB.
      const clampedDb =
        db === undefined || !Number.isFinite(db)
          ? DEFAULT_DUCKING_DB
          : Math.max(-30, Math.min(-1, Number(db)))
      if (
        t.role === 'bgm' &&
        t.duckTarget === 'voice' &&
        (t.duckingDb ?? DEFAULT_DUCKING_DB) === clampedDb
      ) {
        return t
      }
      changed = true
      return {
        ...t,
        role: 'bgm' as const,
        duckTarget: 'voice' as const,
        duckingDb: clampedDb
      }
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
      // Phase 3.30 — volume-envelope partition per piece (parallel to the
      // speed-curve partition above). Volume keyframes' atMs are clip-relative
      // TIMELINE offsets, so the piece's window is keyed on its TIMELINE
      // offsets within orig: [tlOffStart, tlOffEnd]. Keyframes inside are
      // re-based to the piece's own start, plus boundary keyframes at both
      // edges. A piece that collapses below 2 keyframes bakes the survivor's
      // dB into the constant `gainDb`.
      let pieceGainDb = orig.gainDb
      let pieceVolumeKfs: VolumeKeyframe[] | undefined
      if (hasVolumeEnvelope(orig)) {
        const tlOffStart = s.startMs - orig.startMs
        const tlOffEnd = s.endMs - orig.startMs
        const allVol = orig.volumeKeyframes as VolumeKeyframe[]
        const rawVol: VolumeKeyframe[] = [
          { atMs: 0, gainDb: getVolumeDbAt(orig, tlOffStart) },
          ...allVol
            .filter((kf) => kf.atMs > tlOffStart && kf.atMs < tlOffEnd)
            .map((kf) => ({ atMs: kf.atMs - tlOffStart, gainDb: kf.gainDb })),
          {
            atMs: tlOffEnd - tlOffStart,
            gainDb: getVolumeDbAt(orig, tlOffEnd)
          }
        ]
        const normVol = normalizeVolumeKeyframes(rawVol)
        if (normVol.length >= 2) {
          pieceVolumeKfs = normVol
        } else {
          pieceGainDb = normVol[0]?.gainDb ?? getVolumeDbAt(orig, tlOffStart)
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
        speedKeyframes: pieceSpeedKfs,
        gainDb: pieceGainDb,
        volumeKeyframes: pieceVolumeKfs
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
    // Phase 3.54 — validate easing: must be one of EASING_KINDS, or `null`
    // (sentinel to clear), or undefined (don't touch). Unknown string → no-op.
    if (
      partial.easing !== undefined &&
      partial.easing !== null &&
      !(EASING_KINDS as readonly string[]).includes(partial.easing)
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
      // Phase 3.54 — easing patch semantics:
      //   undefined → keep current
      //   null      → CLEAR (drops easing field; identity-linear)
      //   'linear'  → CLEAR (linear is the absent-default; keeps the JSON tight)
      //   other     → set
      const nextEasing: EasingKind | undefined =
        partial.easing === undefined
          ? cur.easing
          : partial.easing === null || partial.easing === 'linear'
            ? undefined
            : partial.easing
      const updated = existing.map((kf, i) =>
        i === kfIndex
          ? {
              atMs: nextAt,
              transform: nextTransform,
              ...(nextEasing ? { easing: nextEasing } : {})
            }
          : kf
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

  applyZoomPreset(clipId, presetId): void {
    // Bail on an unknown preset — keeps this a strict no-op.
    if (!getZoomPreset(presetId)) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // transformKeyframes live only on media + overlay clips — captions bail.
      if (!isMediaClip(c) && !isOverlayClip(c)) return t
      // Build RELATIVE keyframes for the clip's on-timeline span.
      const dur = getClipDuration(c)
      const rel = buildZoomKeyframes(presetId, dur)
      if (rel.length < 2) return t
      // Composition base — the clip's current static transform.
      const base = clampClipTransform(getClipTransform(c))
      // Compose each relative keyframe into an ABSOLUTE transform: scale is
      // multiplied (floored at 1 so a zoom never reveals transparent gutters),
      // x/y offsets are added, rotation/opacity carried from the base.
      const composed: TransformKeyframe[] = rel.map((kf) => ({
        atMs: kf.atMs,
        transform: clampClipTransform({
          x: base.x + kf.transform.x,
          y: base.y + kf.transform.y,
          scale: Math.max(1, base.scale * kf.transform.scale),
          rotation: base.rotation,
          opacity: base.opacity
        })
      }))
      const finalKfs = normalizeKeyframes(composed)
      if (finalKfs.length < 2) return t
      const clips = [...t.clips]
      // REPLACE any prior keyframe track (CapCut behavior); the static
      // `transform` is left untouched.
      clips[idx] = { ...c, transformKeyframes: finalKfs }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  applyAutoReframeKeyframes(clipId, kfs): void {
    // Defensive entry guards — caller bug → strict no-op.
    if (!Array.isArray(kfs)) return
    for (const kf of kfs) {
      if (!kf || typeof kf !== 'object') return
      if (!Number.isFinite(kf.atMs)) return
      const t = kf.transform
      if (!t || typeof t !== 'object') return
      if (
        !Number.isFinite(t.x) ||
        !Number.isFinite(t.y) ||
        !Number.isFinite(t.scale) ||
        !Number.isFinite(t.rotation) ||
        !Number.isFinite(t.opacity)
      ) {
        return
      }
    }
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      // Media-clip only (auto-reframe inspects video pixels). Captions /
      // overlay clips bail.
      if (!isMediaClip(c)) return t
      // Per-clip lock — never write through a locked clip.
      if (isClipLocked(c)) return t
      // normalizeKeyframes sorts ascending, clamps every transform, and
      // dedups within MIN_KEYFRAME_GAP_MS (last write wins). It MAY collapse
      // to length 1 — we re-check the >= 2 invariant below.
      const normalized = normalizeKeyframes(kfs)
      // Enforce the MAX_KEYFRAMES_PER_CLIP cap by uniform downsample. The
      // run shouldn't produce that many in normal cases, but a long clip
      // sampled fine could; trimming uniformly preserves curve shape.
      let finalKfs = normalized
      if (finalKfs.length > MAX_KEYFRAMES_PER_CLIP) {
        const out: TransformKeyframe[] = []
        const step = (finalKfs.length - 1) / (MAX_KEYFRAMES_PER_CLIP - 1)
        for (let i = 0; i < MAX_KEYFRAMES_PER_CLIP; i++) {
          const src = Math.min(finalKfs.length - 1, Math.round(i * step))
          out.push(finalKfs[src])
        }
        finalKfs = out
      }
      if (finalKfs.length < 2) return t
      const clips = [...t.clips]
      // REPLACE any prior keyframe track. Static `transform` is untouched.
      clips[idx] = { ...c, transformKeyframes: finalKfs }
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
      // Defense-in-depth: reverse is mutually exclusive with a speed curve.
      // The UI also disables this, but never let both be set on one clip.
      if (isClipReversed(c)) return t
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

  // --------------------------------------------------------------------
  // Volume envelope (Phase 3.30) — media clips only. Mirrors the Phase 3.10
  // speed-keyframe actions, but volume keyframes' atMs are clip-relative
  // TIMELINE offsets (ms from clip.startMs) — volume does NOT define the
  // source↔timeline mapping, so it is authored in timeline space (same
  // convention as TransformKeyframe). No endMs recompute — the envelope
  // never changes the clip's timeline length.
  //
  // Invariants enforced after every mutation:
  //   - volumeKeyframes is sorted ascending by atMs
  //   - keyframes closer than MIN_VOLUME_KEYFRAME_GAP_MS are deduped/replaced
  //   - a length-1 array is NEVER persisted (collapses to constant `gainDb`)
  //   - every stored keyframe gainDb is clamped [MIN_GAIN_DB, MAX_GAIN_DB]
  //   - the list is capped at MAX_VOLUME_KEYFRAMES_PER_CLIP
  // The contract resolver `resolvedVolumeKeyframes` returns NULL when < 2 —
  // the byte-identical legacy gate (export emits the constant-gain step).
  // --------------------------------------------------------------------
  addVolumeKeyframe(clipId, atMs, gainDb): void {
    const at = Math.round(Number(atMs))
    if (!Number.isFinite(at) || at < 0) return
    if (gainDb !== undefined && !Number.isFinite(Number(gainDb))) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const dur = Math.max(0, c.endMs - c.startMs)
      if (at > dur) return t
      const existing = Array.isArray(c.volumeKeyframes)
        ? [...c.volumeKeyframes]
        : []
      let nextKfs: VolumeKeyframe[]
      if (existing.length < 2) {
        // No active envelope — seed two keyframes spanning the full clip
        // timeline window, both at the clip's current constant gainDb so
        // enabling the envelope causes no jump.
        const base = Math.max(
          MIN_GAIN_DB,
          Math.min(MAX_GAIN_DB, c.gainDb ?? 0)
        )
        nextKfs = [
          { atMs: 0, gainDb: base },
          { atMs: dur, gainDb: base }
        ]
        // The requested keyframe lands on the curve (= base before any
        // override). dedup merges it if it sits on 0 or dur within the gap.
        nextKfs.push({
          atMs: at,
          gainDb: gainDb !== undefined ? Number(gainDb) : base
        })
      } else {
        if (existing.length >= MAX_VOLUME_KEYFRAMES_PER_CLIP) return t
        // Land on the existing curve so the insert causes no volume jump.
        const onCurve = getVolumeDbAt(c, at)
        nextKfs = [
          ...existing,
          { atMs: at, gainDb: gainDb !== undefined ? Number(gainDb) : onCurve }
        ]
      }
      const finalKfs = normalizeVolumeKeyframes(nextKfs)
      if (finalKfs.length < 2) return t
      const clips = [...t.clips]
      clips[idx] = { ...c, volumeKeyframes: finalKfs }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  updateVolumeKeyframe(clipId, kfIndex, partial): void {
    if (!partial || typeof partial !== 'object') return
    if (partial.atMs !== undefined && !Number.isFinite(Number(partial.atMs))) {
      return
    }
    if (
      partial.gainDb !== undefined &&
      !Number.isFinite(Number(partial.gainDb))
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
      const existing = Array.isArray(c.volumeKeyframes)
        ? [...c.volumeKeyframes]
        : []
      if (kfIndex < 0 || kfIndex >= existing.length) return t
      const dur = Math.max(0, c.endMs - c.startMs)
      const cur = existing[kfIndex]
      const nextAt =
        partial.atMs !== undefined
          ? Math.max(0, Math.min(dur, Math.round(Number(partial.atMs))))
          : cur.atMs
      const nextGain =
        partial.gainDb !== undefined
          ? Math.max(
              MIN_GAIN_DB,
              Math.min(MAX_GAIN_DB, Number(partial.gainDb))
            )
          : cur.gainDb
      const updated = existing.map((kf, i) =>
        i === kfIndex ? { atMs: nextAt, gainDb: nextGain } : kf
      )
      const finalKfs = normalizeVolumeKeyframes(updated)
      const clips = [...t.clips]
      if (finalKfs.length < 2) {
        // Collapsed below the >= 2 invariant — drop the envelope + bake the
        // surviving keyframe's dB into the constant `gainDb`.
        clips[idx] = {
          ...c,
          gainDb: finalKfs[0]
            ? Math.max(
                MIN_GAIN_DB,
                Math.min(MAX_GAIN_DB, finalKfs[0].gainDb)
              )
            : c.gainDb,
          volumeKeyframes: undefined
        }
      } else {
        clips[idx] = { ...c, volumeKeyframes: finalKfs }
      }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeVolumeKeyframe(clipId, kfIndex): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const existing = Array.isArray(c.volumeKeyframes)
        ? [...c.volumeKeyframes]
        : []
      if (kfIndex < 0 || kfIndex >= existing.length) return t
      const remaining = existing.filter((_, i) => i !== kfIndex)
      const clips = [...t.clips]
      if (remaining.length < 2) {
        // Envelope would fall below the >= 2 invariant — clear it + bake the
        // surviving keyframe's dB into the constant `gainDb` so the sound
        // does not change.
        const survivor = remaining[0]
        clips[idx] = {
          ...c,
          gainDb: survivor
            ? Math.max(
                MIN_GAIN_DB,
                Math.min(MAX_GAIN_DB, survivor.gainDb)
              )
            : c.gainDb,
          volumeKeyframes: undefined
        }
      } else {
        clips[idx] = {
          ...c,
          volumeKeyframes: normalizeVolumeKeyframes(remaining)
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

  clearVolumeKeyframes(clipId): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if (c.volumeKeyframes === undefined) return t
      const clips = [...t.clips]
      // Keep the constant `gainDb` untouched — only drop the envelope.
      clips[idx] = { ...c, volumeKeyframes: undefined }
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Freeze frames (Phase 3.16) — media clips only. Mirrors the speed-
  // keyframe actions. A freeze's `sourceMs` is a SOURCE offset (ms from
  // trimInMs); the frame there is HELD for `durationMs` of timeline output.
  // Every mutation recomputes endMs via `recomputeEndMsForSpeed` (which now
  // picks up freeze duration via `getClipTimelineDuration`). The list is set
  // to `undefined` when empty (lean JSON + undo snapshots, same as
  // blurRegions/speedKeyframes). The contract resolver `getClipFreezeFrames`
  // re-clamps/sorts/dedupes — actions store raw entries.
  // --------------------------------------------------------------------
  addFreezeFrame(clipId, sourceMs, durationMs): void {
    const src = Math.round(Number(sourceMs))
    if (!Number.isFinite(src) || src < 0) return
    if (durationMs !== undefined && !Number.isFinite(Number(durationMs))) {
      return
    }
    const dur =
      durationMs !== undefined
        ? Math.max(MIN_FREEZE_MS, Math.min(MAX_FREEZE_MS, Number(durationMs)))
        : DEFAULT_FREEZE_MS
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      // Defense-in-depth: reverse is mutually exclusive with freeze frames.
      // The UI also disables this, but never let both be set on one clip.
      if (isClipReversed(c)) return t
      // Reject once the clip is at the per-clip cap (resolved count).
      if (getClipFreezeFrames(c).length >= MAX_FREEZE_FRAMES_PER_CLIP) return t
      const existing = Array.isArray(c.freezeFrames)
        ? [...c.freezeFrames]
        : []
      const nextFreezes: FreezeFrame[] = [
        ...existing,
        { sourceMs: src, durationMs: dur }
      ]
      const clips = [...t.clips]
      clips[idx] = recomputeEndMsForSpeed({
        ...c,
        freezeFrames: nextFreezes.length > 0 ? nextFreezes : undefined
      })
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  updateFreezeFrame(clipId, freezeIndex, partial): void {
    if (!partial || typeof partial !== 'object') return
    if (
      partial.sourceMs !== undefined &&
      !Number.isFinite(Number(partial.sourceMs))
    ) {
      return
    }
    if (
      partial.durationMs !== undefined &&
      !Number.isFinite(Number(partial.durationMs))
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
      const existing = Array.isArray(c.freezeFrames)
        ? [...c.freezeFrames]
        : []
      if (freezeIndex < 0 || freezeIndex >= existing.length) return t
      const srcDur = Math.max(0, c.trimOutMs - c.trimInMs)
      const cur = existing[freezeIndex]
      const nextSource =
        partial.sourceMs !== undefined
          ? Math.max(0, Math.min(srcDur, Math.round(Number(partial.sourceMs))))
          : cur.sourceMs
      const nextDuration =
        partial.durationMs !== undefined
          ? Math.max(
              MIN_FREEZE_MS,
              Math.min(MAX_FREEZE_MS, Number(partial.durationMs))
            )
          : cur.durationMs
      const updated = existing.map((f, i) =>
        i === freezeIndex
          ? { sourceMs: nextSource, durationMs: nextDuration }
          : f
      )
      const clips = [...t.clips]
      clips[idx] = recomputeEndMsForSpeed({
        ...c,
        freezeFrames: updated.length > 0 ? updated : undefined
      })
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeFreezeFrame(clipId, freezeIndex): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      const existing = Array.isArray(c.freezeFrames)
        ? [...c.freezeFrames]
        : []
      if (freezeIndex < 0 || freezeIndex >= existing.length) return t
      const remaining = existing.filter((_, i) => i !== freezeIndex)
      const clips = [...t.clips]
      clips[idx] = recomputeEndMsForSpeed({
        ...c,
        freezeFrames: remaining.length > 0 ? remaining : undefined
      })
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  clearFreezeFrames(clipId): void {
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if (c.freezeFrames === undefined) return t
      const clips = [...t.clips]
      clips[idx] = recomputeEndMsForSpeed({
        ...c,
        freezeFrames: undefined
      })
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Text-based editing (Phase 3.17) — media clips only. A per-clip
  // word-level transcript + a non-destructive list of removed SOURCE
  // ranges. Deleting words appends ranges; the clip's timeline footprint
  // shrinks (deletion-aware `getClipTimelineDuration`); later clips on the
  // same track ripple left so no gap opens. Reversible — restoring words
  // removes the ranges. Every mutation routes endMs through
  // `recomputeEndMsForSpeed` and ripples within a SINGLE `set()` so undo
  // captures one snapshot. The contract resolver `getClipDeletedRanges`
  // re-clamps/sorts/merges — actions store raw entries.
  // --------------------------------------------------------------------
  setClipTranscript(clipId, transcript): void {
    if (
      !transcript ||
      typeof transcript !== 'object' ||
      !Array.isArray(transcript.words)
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
      const clips = [...t.clips]
      // Sanitize words to finite source bounds; sort ascending by start.
      const words: TranscriptWord[] = transcript.words
        .filter(
          (w): w is TranscriptWord =>
            !!w &&
            typeof w === 'object' &&
            typeof w.id === 'string' &&
            Number.isFinite(w.sourceStartMs) &&
            Number.isFinite(w.sourceEndMs)
        )
        .map((w) => ({
          id: w.id,
          text: String(w.text ?? ''),
          sourceStartMs: Math.min(w.sourceStartMs, w.sourceEndMs),
          sourceEndMs: Math.max(w.sourceStartMs, w.sourceEndMs)
        }))
        .sort((a, b) => a.sourceStartMs - b.sourceStartMs)
      clips[idx] = {
        ...c,
        transcript: {
          words,
          language: String(transcript.language ?? ''),
          generatedAt: Number.isFinite(transcript.generatedAt)
            ? transcript.generatedAt
            : Date.now()
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

  deleteTranscriptWords(clipId, wordIds): void {
    if (!Array.isArray(wordIds) || wordIds.length === 0) return
    const idSet = new Set(wordIds.filter((id) => typeof id === 'string'))
    if (idSet.size === 0) return
    const project = get().project
    let trackId: string | null = null
    let changed = false
    let tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c) || !hasClipTranscript(c)) return t
      // Defense-in-depth: reverse is mutually exclusive with transcript
      // deletions. The UI also disables this, but never set both on one clip.
      if (isClipReversed(c)) return t
      const words = c.transcript!.words
      const newRanges = wordsToDeletedRanges(words, idSet)
      if (newRanges.length === 0) return t
      const existing = Array.isArray(c.deletedRanges) ? c.deletedRanges : []
      let merged: DeletedRange[] = [...existing, ...newRanges]
      // Guard: never let the clip's timeline footprint fall below MIN_CLIP_MS.
      // If the merged deletions would, trim the LAST (newest) range so a sliver
      // of the clip survives. Do NOT auto-remove the clip.
      let probe: VideoAudioClip = { ...c, deletedRanges: merged }
      if (getClipTimelineDuration(probe) < MIN_CLIP_MS) {
        // Resolve the effective (sorted/merged/clamped) ranges, then shrink the
        // range with the latest source end until the clip clears MIN_CLIP_MS.
        let resolved = getClipDeletedRanges(probe)
          .slice()
          .sort((a, b) => a.sourceStartMs - b.sourceStartMs)
        // Iteratively trim from the end of the last resolved range.
        const STEP = Math.max(10, MIN_DELETED_RANGE_GAP_MS)
        let guard = 0
        while (
          resolved.length > 0 &&
          getClipTimelineDuration({ ...c, deletedRanges: resolved }) <
            MIN_CLIP_MS &&
          guard < 100000
        ) {
          const last = resolved[resolved.length - 1]
          const shrunk = last.sourceEndMs - STEP
          if (shrunk <= last.sourceStartMs) {
            // This range is exhausted — drop it entirely and continue.
            resolved = resolved.slice(0, -1)
          } else {
            resolved = [
              ...resolved.slice(0, -1),
              { sourceStartMs: last.sourceStartMs, sourceEndMs: shrunk }
            ]
          }
          guard++
        }
        merged = resolved
        probe = { ...c, deletedRanges: merged }
      }
      const finalRanges = merged.length > 0 ? merged : undefined
      const clips = [...t.clips]
      clips[idx] = recomputeEndMsForSpeed({ ...c, deletedRanges: finalRanges })
      trackId = t.id
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    // Ripple later clips on the SAME track left, inline (single snapshot).
    if (trackId) tracks = rippleTracks(tracks, trackId)
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  restoreTranscriptWords(clipId, wordIds): void {
    if (!Array.isArray(wordIds) || wordIds.length === 0) return
    const idSet = new Set(wordIds.filter((id) => typeof id === 'string'))
    if (idSet.size === 0) return
    const project = get().project
    let trackId: string | null = null
    let changed = false
    let tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c) || !hasClipTranscript(c)) return t
      const existing = Array.isArray(c.deletedRanges) ? c.deletedRanges : []
      if (existing.length === 0) return t
      // Cut intervals = the source ranges of the words being restored.
      const cuts = wordsToDeletedRanges(c.transcript!.words, idSet)
      if (cuts.length === 0) return t
      const remaining = subtractRanges(existing, cuts)
      const finalRanges = remaining.length > 0 ? remaining : undefined
      const clips = [...t.clips]
      clips[idx] = recomputeEndMsForSpeed({ ...c, deletedRanges: finalRanges })
      trackId = t.id
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    if (trackId) tracks = rippleTracks(tracks, trackId)
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  removeFillerWords(clipId): string[] {
    const project = get().project
    let clip: VideoAudioClip | null = null
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => cc.id === clipId)
      if (c && isMediaClip(c)) {
        clip = c
        break
      }
    }
    if (!clip || !hasClipTranscript(clip)) return []
    // Only filler words VISIBLE in the clip's trim window are removed.
    const visible = getVisibleTranscriptWords(clip)
    const fillerIds = visible
      .filter((w) => FILLER_LEXICON.has(normalizeWordText(w.text)))
      .map((w) => w.id)
    if (fillerIds.length === 0) return []
    get().deleteTranscriptWords(clipId, fillerIds)
    return fillerIds
  },

  clearTranscriptDeletions(clipId): void {
    const project = get().project
    let trackId: string | null = null
    let changed = false
    let tracks = project.tracks.map((t) => {
      const idx = t.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return t
      const c = t.clips[idx]
      if (!isMediaClip(c)) return t
      if (c.deletedRanges === undefined) return t
      const clips = [...t.clips]
      clips[idx] = recomputeEndMsForSpeed({ ...c, deletedRanges: undefined })
      trackId = t.id
      changed = true
      return { ...t, clips }
    })
    if (!changed) return
    if (trackId) tracks = rippleTracks(tracks, trackId)
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
        // Phase 3.41 — locked captions reject edits.
        if (isClipLocked(c)) return c
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
    // Phase 3.33 — resolve the doomed set so a grouped caption deleted from the
    // caption editor still propagates to its whole link group.
    let target: Clip | null = null
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => isCaptionClip(cc) && cc.id === captionId)
      if (c) {
        target = c
        break
      }
    }
    if (!target) return
    const doomed = new Set<string>(
      target.groupId
        ? getGroupMembers(project, target.groupId).map((c) => c.id)
        : [captionId]
    )
    let touched = false
    const tracks = project.tracks.map((t) => {
      const before = t.clips.length
      const clips = t.clips.filter((c) => !doomed.has(c.id))
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
        // Phase 3.41 — locked overlays reject edits.
        if (isClipLocked(c)) return c
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
    // Phase 3.33 — resolve the doomed set so a grouped overlay still drags its
    // whole link group along when deleted.
    let target: Clip | null = null
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => isOverlayClip(cc) && cc.id === overlayId)
      if (c) {
        target = c
        break
      }
    }
    if (!target) return
    const doomed = new Set<string>(
      target.groupId
        ? getGroupMembers(project, target.groupId).map((c) => c.id)
        : [overlayId]
    )
    let touched = false
    const tracks = project.tracks.map((t) => {
      const before = t.clips.length
      const clips = t.clips.filter((c) => !doomed.has(c.id))
      if (clips.length !== before) touched = true
      return { ...t, clips }
    })
    if (!touched) return
    const next = touch({ ...project, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  // --------------------------------------------------------------------
  // Collage / split-screen layout (Phase 3.18) — renderer-only. Writes the
  // existing `transform`/`cropRect` clip fields + a UI-only `layoutGroupId`;
  // export never reads `layoutGroupId`.
  // --------------------------------------------------------------------
  applyLayout(presetId, clipIds, opts): void {
    // --- Defensive input validation. ---
    const preset = getLayoutPreset(presetId)
    if (!preset) return
    if (!Array.isArray(clipIds) || clipIds.length < 2) return
    const project = get().project

    // Locate each requested clip (id → { trackId, clip }). Skip ids that
    // don't resolve or aren't media/overlay clips (transform/crop carriers).
    type Located = {
      id: string
      clip: VideoAudioClip | OverlayClip
      trackId: string
    }
    const located: Located[] = []
    for (const id of clipIds) {
      if (typeof id !== 'string' || !id) continue
      if (located.some((l) => l.id === id)) continue // de-dup
      let hit: Located | null = null
      for (const t of project.tracks) {
        const c = t.clips.find((cc) => cc.id === id)
        if (c && (isMediaClip(c) || isOverlayClip(c))) {
          hit = { id, clip: c, trackId: t.id }
          break
        }
      }
      if (hit) located.push(hit)
    }
    if (located.length < 2) return

    // Use only as many clips as the preset has cells.
    const memberCount = Math.min(located.length, preset.cells.length)
    const members = located.slice(0, memberCount)

    // --- Timing: shared window from the earliest start + shortest duration. ---
    const alignTiming = opts?.alignTiming !== false
    let commonStart = Infinity
    let shortestDur = Infinity
    for (const m of members) {
      if (Number.isFinite(m.clip.startMs)) {
        commonStart = Math.min(commonStart, m.clip.startMs)
      }
      const dur = m.clip.endMs - m.clip.startMs
      if (Number.isFinite(dur) && dur > 0) {
        shortestDur = Math.min(shortestDur, dur)
      }
    }
    if (!Number.isFinite(commonStart)) commonStart = 0
    if (!Number.isFinite(shortestDur) || shortestDur <= 0) {
      shortestDur = MIN_CLIP_MS
    }

    // --- Track assignment: distinct video layers, last cell on top. ---
    // Clip 0 keeps its current track (bottom layer). Clips 1..N-1 need a
    // DISTINCT track each, stacked above clip 0's track. We create video
    // tracks via addVideoTrack() (which sets project state) and re-read the
    // project between calls, then assemble all clip moves into ONE final
    // set() so the whole apply is a single undo step.
    const bottomTrackId = members[0].trackId
    // Target track for each member, by index. members[0] → its own track.
    const targetTrackIds: (string | null)[] = new Array(memberCount).fill(null)
    targetTrackIds[0] = bottomTrackId

    // Existing video tracks ABOVE clip 0's track, ordered low→high, that we
    // can reuse before creating new ones.
    const reusable: string[] = []
    {
      const tracksNow = get().project.tracks
      const bottomIdx = tracksNow.findIndex((t) => t.id === bottomTrackId)
      for (let i = bottomIdx + 1; i < tracksNow.length; i++) {
        if (tracksNow[i].kind === 'video') reusable.push(tracksNow[i].id)
      }
    }
    const overlayTrackId =
      get().project.tracks.find((t) => t.kind === 'overlay')?.id ?? null

    let reuseCursor = 0
    for (let i = 1; i < memberCount; i++) {
      if (reuseCursor < reusable.length) {
        targetTrackIds[i] = reusable[reuseCursor++]
        continue
      }
      // Need a fresh video track stacked above. addVideoTrack inserts after
      // the last video track (highest layer) — exactly what we want.
      const created = get().addVideoTrack()
      if (created) {
        targetTrackIds[i] = created
        continue
      }
      // MAX_VIDEO_TRACKS reached — fall back to the overlay track (still a
      // distinct layer above video), else leave the clip on its own track.
      targetTrackIds[i] = overlayTrackId ?? members[i].trackId
    }

    // --- Build the final project in ONE pass. ---
    // Re-read: addVideoTrack() above mutated the project (added tracks).
    const base = get().project
    const groupId = newId()

    // Compute the new clip object for each member (transform/crop/timing/group).
    const updatedById = new Map<string, VideoAudioClip | OverlayClip>()
    for (let i = 0; i < memberCount; i++) {
      const m = members[i]
      const cell = preset.cells[i]
      // Resolve media natural size for the cover math.
      let srcW = base.width
      let srcH = base.height
      if (isMediaClip(m.clip)) {
        const asset = base.media[m.clip.mediaId]
        if (asset && asset.width > 0 && asset.height > 0) {
          srcW = asset.width
          srcH = asset.height
        }
      }
      const { transform, cropRect } = cellToClipPlacement(
        cell,
        base.width,
        base.height,
        srcW,
        srcH
      )
      const clampedTransform = clampClipTransform(transform)
      const clampedCrop = clampCropRect(cropRect)
      const targetTrack = targetTrackIds[i] ?? m.trackId

      if (isMediaClip(m.clip)) {
        const next: VideoAudioClip = {
          ...m.clip,
          trackId: targetTrack,
          transform: clampedTransform,
          // cropRect is media-only.
          cropRect: clampedCrop,
          // A static cell placement conflicts with an animation.
          transformKeyframes: undefined,
          layoutGroupId: groupId
        }
        if (alignTiming) {
          next.startMs = commonStart
          next.endMs = commonStart + shortestDur
        }
        updatedById.set(m.id, next)
      } else {
        // Overlay clip — no cropRect field.
        const next: OverlayClip = {
          ...m.clip,
          trackId: targetTrack,
          transform: clampedTransform,
          transformKeyframes: undefined,
          layoutGroupId: groupId
        }
        if (alignTiming) {
          next.startMs = commonStart
          next.endMs = commonStart + shortestDur
        }
        updatedById.set(m.id, next)
      }
    }

    // Rebuild tracks: drop every member from wherever it currently sits, then
    // append each updated member to its target track.
    const memberIds = new Set(members.map((m) => m.id))
    const tracks = base.tracks.map((t) => {
      // Remove any member that currently lives on this track.
      let clips = t.clips.filter((c) => !memberIds.has(c.id))
      // Append members whose target track is this one.
      const incoming: Array<VideoAudioClip | OverlayClip> = []
      for (const m of members) {
        const updated = updatedById.get(m.id)
        if (updated && updated.trackId === t.id) incoming.push(updated)
      }
      if (incoming.length > 0) clips = [...clips, ...incoming]
      if (clips.length === t.clips.length && incoming.length === 0) return t
      return { ...t, clips }
    })

    const next = touch({ ...base, tracks })
    set({ project: next })
    schedulePersist(next)
  },

  clearLayout(layoutGroupId: string): void {
    if (typeof layoutGroupId !== 'string' || !layoutGroupId) return
    const project = get().project
    let changed = false
    const tracks = project.tracks.map((t) => {
      let touched = false
      const clips = t.clips.map((c) => {
        if (!isMediaClip(c) && !isOverlayClip(c)) return c
        if (c.layoutGroupId !== layoutGroupId) return c
        touched = true
        changed = true
        if (isMediaClip(c)) {
          // Reset transform + crop to identity (reuse the reset semantics:
          // identity = undefined), and drop the layout tag.
          return {
            ...c,
            transform: undefined,
            cropRect: undefined,
            layoutGroupId: undefined
          }
        }
        // Overlay clip — no cropRect.
        return { ...c, transform: undefined, layoutGroupId: undefined }
      })
      return touched ? { ...t, clips } : t
    })
    if (!changed) return
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
