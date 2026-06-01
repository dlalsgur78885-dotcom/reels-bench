import { useEffect, useRef, useState } from 'react'
import type {
  BlurRegion,
  Clip,
  ClipTransform,
  ColorAdjust,
  CropRect,
  FilterPreset,
  MotionTrack,
  OverlayShadow,
  ShapeStyle,
  TransitionKind,
  VoiceChangerId,
  VoiceEnhance
} from '../../../shared/project'
import {
  BLUR_EFFECT_KINDS,
  BLUR_REGION_SHAPES,
  DEFAULT_OVERLAY_SHADOW,
  DEFAULT_TRANSITION_MS,
  FILTER_PRESETS,
  getClipColorAdjust,
  getClipCropRect,
  getOverlayShadow,
  getTransformAt,
  IDENTITY_CROP,
  isCaptionClip,
  isClipLocked,
  isMediaClip,
  isOverlayClip,
  MAX_BLUR_REGIONS_PER_CLIP,
  MAX_BLUR_STRENGTH,
  MAX_CLIP_SPEED,
  MAX_COLOR_ADJUST,
  MAX_TRANSFORM_OFFSET,
  MAX_TRANSFORM_ROTATION,
  MAX_TRANSFORM_SCALE,
  MAX_TRANSITION_MS,
  MAX_NOISE_REDUCTION,
  MAX_OVERLAY_SHADOW_BLUR,
  MAX_OVERLAY_SHADOW_OFFSET,
  MIN_BLUR_REGION_SIZE,
  MIN_BLUR_STRENGTH,
  MIN_CLIP_SPEED,
  MIN_COLOR_ADJUST,
  MIN_TRANSFORM_OFFSET,
  MIN_TRANSFORM_ROTATION,
  MIN_TRANSFORM_SCALE,
  MIN_TRANSITION_MS,
  MIN_NOISE_REDUCTION,
  MIN_FREEZE_MS,
  MAX_FREEZE_MS,
  MIN_GAIN_DB,
  MAX_GAIN_DB,
  DEFAULT_NOISE_REDUCTION,
  DEFAULT_VOICE_ENHANCE,
  NEUTRAL_COLOR_ADJUST,
  NEUTRAL_VOICE_ENHANCE,
  VOICE_CHANGER_IDS,
  isNeutralVoiceEnhance,
  TRANSITION_CATEGORIES
} from '../../../shared/project'
import {
  COLOR_ADJUST_LABELS,
  FILTER_PRESET_LABELS,
  TRANSITION_LABELS,
  VOICE_CHANGER_LABELS,
  filterPresetToCss
} from '../../../shared/filterPresets'
import { BrandSwatchRow } from './BrandSwatchRow'
import { CropControls } from './CropControls'

interface ClipContextMenuProps {
  clip: Clip
  x: number
  y: number
  /**
   * Current playhead (ms) — used to gate the "여기서 자르기" entry on media
   * clips. Optional so callers that don't know/care about gating still work.
   */
  playheadMs?: number
  onAction: (key: string) => void
  /**
   * Called when the user picks a new speed in the speed sub-panel.
   * Optional — only invoked for media clips.
   */
  onSpeedChange?: (speed: number) => void
  /** Apply a transition-in (kind + duration). Media clips only. */
  onTransitionChange?: (kind: TransitionKind, durationMs: number) => void
  /** Apply a filter preset + intensity. Media clips only. */
  onFilterChange?: (preset: FilterPreset, intensity: number) => void
  /** Merge a partial transform onto the clip. Media clips only. */
  onTransformChange?: (partial: Partial<ClipTransform>) => void
  /** Reset the clip's transform to identity. Media clips only. */
  onTransformReset?: () => void
  // --- Phase 3.6 static source crop (media clips only) ---
  /** Merge a partial crop rect onto the clip. Media clips only. */
  onCropChange?: (partial: Partial<CropRect>) => void
  /** Reset the clip's crop to the full frame. Media clips only. */
  onCropReset?: () => void
  /** Source media aspect ratio (width / height) — drives the crop presets. */
  sourceAspect?: number
  // --- Phase 3.7 manual color adjustment (media clips only) ---
  /** Merge a partial color adjust onto the clip. Media clips only. */
  onColorAdjustChange?: (partial: Partial<ColorAdjust>) => void
  /** Reset the clip's color adjustment to neutral. Media clips only. */
  onColorAdjustReset?: () => void
  // --- Phase 4 noise reduction (media clips only) ---
  /** The clip's current noise-reduction strength (0..100, 0 = off). Media clips only. */
  noiseReduction?: number
  /** Set the clip's noise-reduction strength (0..100, 0 = off). Media clips only. */
  onNoiseReductionChange?: (strength: number) => void
  // --- Phase 3.39 voice enhancement (media clips only) ---
  /**
   * The clip's current voice-enhance payload (or undefined when off / neutral).
   * Media clips only — five boolean sub-toggles. EXPORT-ONLY.
   */
  voiceEnhance?: VoiceEnhance
  /**
   * Merge a partial voice-enhance patch onto the clip. A neutral result
   * collapses to `voiceEnhance: undefined` in the store. Media clips only.
   */
  onVoiceEnhanceChange?: (patch: Partial<VoiceEnhance>) => void
  // --- Phase 3.50 voice changer (media clips only) ---
  /** The clip's current voice-changer preset (resolved by getVoiceChanger). */
  voiceChangerId?: VoiceChangerId
  /** Pick a new voice-changer preset (or 'none' to clear). Media clips only. */
  onVoiceChangerChange?: (id: VoiceChangerId) => void
  // --- Phase 3.11 mosaic / blur regions (media clips only) ---
  /** The clip's current mosaic/blur regions (sanitized). Media clips only. */
  blurRegions?: BlurRegion[]
  /** Append a new mosaic/blur region to the clip. Media clips only. */
  onAddBlurRegion?: () => void
  /** Merge a partial onto the region matched by id. Media clips only. */
  onUpdateBlurRegion?: (
    regionId: string,
    partial: Partial<BlurRegion>
  ) => void
  /** Remove the region matched by id. Media clips only. */
  onRemoveBlurRegion?: (regionId: string) => void
  // --- Phase 3.13 motion tracking ---
  /** The clip's current motion tracks (sanitized). Media clips only. */
  motionTracks?: MotionTrack[]
  /** Arm the box-draw overlay for this clip. Media clips only. */
  onStartMotionTrackDraw?: () => void
  /** Cancel the running tracking job. */
  onCancelMotionTrack?: () => void
  /** Re-run tracking from a track's source rect. Media clips only. */
  onRetrackMotionTrack?: (track: MotionTrack) => void
  /** Delete a motion track by id. Media clips only. */
  onDeleteMotionTrack?: (trackId: string) => void
  /** Live tracking-job status for this clip (or null when no job runs). */
  motionTrackJobStatus?: 'idle' | 'preparing' | 'tracking' | 'done' | 'error'
  /** Live tracking-job progress 0..100 (only meaningful while a job runs). */
  motionTrackJobPercent?: number
  /** True when a tracking job is currently running for THIS clip. */
  motionTrackJobActive?: boolean
  /**
   * Bind a blur region to a motion track (null clears). Media clips only —
   * surfaces a dropdown in the blur-region panel.
   */
  onBindBlurRegionToTrack?: (
    regionId: string,
    trackId: string | null
  ) => void
  /** Bind THIS overlay clip to a motion track (null clears). Overlay clips only. */
  onBindOverlayToTrack?: (trackId: string | null) => void
  /** Bind THIS caption clip to a motion track (null clears). Caption clips only. */
  onBindCaptionToTrack?: (trackId: string | null) => void
  /**
   * All motion tracks in the WHOLE project (id + name) — used to populate the
   * overlay / caption binding dropdown, since their bindable tracks live on
   * other (media) clips.
   */
  allMotionTracks?: ReadonlyArray<{ id: string; name: string }>
  /** Currently-bound motion track id for an overlay / caption clip (if any). */
  boundMotionTrackId?: string
  // --- Phase 3.5 keyframe editing (media clips only) ---
  /** Add (or update) a transform keyframe at the current playhead. */
  onAddKeyframe?: () => void
  /** Remove the keyframe under the current playhead (if any). */
  onRemoveKeyframeAtPlayhead?: () => void
  /** Number of keyframes on the clip's animation track (0 when static). */
  keyframeCount?: number
  /** True when the playhead currently sits on an existing keyframe. */
  isOnKeyframe?: boolean
  // --- Phase 3.10 speed-curve editing (media clips only) ---
  /** Add (or update) a speed keyframe at the current playhead. */
  onAddSpeedKeyframe?: () => void
  /** Update the speed of the keyframe under the playhead (per-keyframe slider). */
  onUpdateSpeedKeyframeAtPlayhead?: (speed: number) => void
  /** Remove the speed keyframe under the current playhead (if any). */
  onRemoveSpeedKeyframeAtPlayhead?: () => void
  /** Clear the clip's speed curve entirely (keeps the constant speed). */
  onClearSpeedCurve?: () => void
  /** Number of speed keyframes on the clip's curve (0 when constant). */
  speedKeyframeCount?: number
  /** True when the playhead currently sits on an existing speed keyframe. */
  isOnSpeedKeyframe?: boolean
  /** Effective speed at the playhead (instantaneous curve value, or constant). */
  speedAtPlayhead?: number
  // --- 리버스 / 역재생 (reverse playback) — media clips only ---
  /** True when the clip currently plays backwards. */
  reversed?: boolean
  /** True when reverse may be toggled ON (no speed curve / freeze / deletions). */
  canReverse?: boolean
  /** True when the trimmed source duration exceeds the soft cap → memory warn. */
  reverseWarnLong?: boolean
  /** Toggle reverse on the clip. */
  onToggleReverse?: (reversed: boolean) => void
  // --- Phase 3.16 freeze-frame editing (media clips only) ---
  /** Insert a freeze frame at the current playhead's source position. */
  onAddFreezeFrame: () => void
  /** Update the held duration of the freeze under the playhead. */
  onUpdateFreezeFrameAtPlayhead: (durationMs: number) => void
  /** Remove the freeze frame under the current playhead. */
  onRemoveFreezeFrameAtPlayhead: () => void
  /** Number of freeze frames on the clip (0 when none). */
  freezeFrameCount: number
  /** True when the playhead currently sits inside an existing freeze plateau. */
  isOnFreezeFrame: boolean
  /** Held duration (ms) of the freeze under the playhead (DEFAULT when none). */
  freezeDurationAtPlayhead: number
  // --- Phase 3.30 volume-envelope editing (media clips only) ---
  /** Add (or update) a volume keyframe at the current playhead. */
  onAddVolumeKeyframe?: () => void
  /** Update the dB of the volume keyframe under the playhead (per-kf slider). */
  onUpdateVolumeKeyframeAtPlayhead?: (gainDb: number) => void
  /** Remove the volume keyframe under the current playhead (if any). */
  onRemoveVolumeKeyframeAtPlayhead?: () => void
  /** Clear the clip's volume envelope entirely (keeps the constant gainDb). */
  onClearVolumeEnvelope?: () => void
  /** Number of volume keyframes on the clip's envelope (0 when constant). */
  volumeKeyframeCount?: number
  /** True when the playhead currently sits on an existing volume keyframe. */
  isOnVolumeKeyframe?: boolean
  /** Effective dB at the playhead (instantaneous envelope value, or constant). */
  volumeDbAtPlayhead?: number
  // --- Phase 3.8 overlay shape style (shape overlay clips only) ---
  /** Merge a partial ShapeStyle onto a shape overlay's source.style. */
  onOverlayStyleChange?: (partial: Partial<ShapeStyle>) => void
  /**
   * Phase 3.36 — set/clear an overlay clip's drop shadow (image/sticker/shape).
   * `null` clears the shadow; an `OverlayShadow` sets it.
   */
  onOverlayShadowChange?: (shadow: OverlayShadow | null) => void
  /**
   * True when the "오디오 분리" row should be enabled — i.e. the target is a
   * video-track media clip whose audio hasn't already been detached/muted.
   */
  audioDetachable?: boolean
  /**
   * Phase 3.33 — true when the "그룹 묶기" row should be enabled: ≥2 clips are
   * selected and they don't already all share one group.
   */
  groupable?: boolean
  /**
   * Phase 3.33 — true when the "그룹 해제" row should be enabled: the context
   * clip currently belongs to a link group.
   */
  grouped?: boolean
  onClose: () => void
}

const styles = {
  wrap: {
    position: 'fixed' as const,
    minWidth: 200,
    maxWidth: 340,
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: 4,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    zIndex: 9999,
    overflowY: 'auto',
    overflowX: 'hidden',
    overscrollBehavior: 'contain',
    fontSize: 12,
    color: '#f5f5f5'
  } as React.CSSProperties,
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '6px 10px',
    cursor: 'pointer',
    borderRadius: 4,
    userSelect: 'none' as const
  } as React.CSSProperties,
  itemDisabled: {
    color: '#475569',
    cursor: 'not-allowed'
  } as React.CSSProperties,
  destructive: {
    color: '#fca5a5'
  } as React.CSSProperties,
  shortcut: {
    color: '#64748b',
    fontSize: 11
  } as React.CSSProperties,
  separator: {
    height: 1,
    background: '#2a2a2a',
    margin: '4px 0'
  } as React.CSSProperties,
  speedPanel: {
    padding: '8px 10px',
    borderTop: '1px solid #2a2a2a',
    background: '#0d0d0d'
  } as React.CSSProperties,
  presetRow: {
    display: 'flex',
    gap: 6,
    marginBottom: 8,
    flexWrap: 'wrap' as const
  } as React.CSSProperties,
  preset: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  presetActive: {
    background: '#10b981',
    border: '1px solid #10b981',
    color: '#04231a',
    fontWeight: 600
  } as React.CSSProperties,
  speedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8
  } as React.CSSProperties,
  slider: {
    flex: 1
  } as React.CSSProperties,
  speedInput: {
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: 11,
    width: 56,
    textAlign: 'right' as const
  } as React.CSSProperties,
  transformRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6
  } as React.CSSProperties,
  transformLabel: {
    width: 48,
    fontSize: 11,
    color: '#9aa0a6',
    flexShrink: 0
  } as React.CSSProperties,
  transformResetBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '3px 10px',
    fontSize: 11,
    cursor: 'pointer',
    width: '100%'
  } as React.CSSProperties,
  keyframeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8
  } as React.CSSProperties,
  keyframeBtn: {
    flex: 1,
    background: '#312e81',
    color: '#e0e7ff',
    border: '1px solid #6366f1',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  keyframeBtnDisabled: {
    background: '#1f2937',
    color: '#475569',
    border: '1px solid #374151',
    cursor: 'not-allowed'
  } as React.CSSProperties,
  keyframeCountBadge: {
    flexShrink: 0,
    background: '#6366f1',
    color: '#f5f5f5',
    borderRadius: 999,
    padding: '2px 8px',
    fontSize: 10,
    fontWeight: 700,
    minWidth: 22,
    textAlign: 'center' as const
  } as React.CSSProperties
}

const SPEED_PRESETS = [0.5, 1, 1.5, 2]

interface MenuRow {
  key: string
  label: string
  shortcut?: string
  destructive?: boolean
  /** When false, row is rendered but click is suppressed. */
  enabled?: boolean
}

/**
 * Phase 3.33 — the group묶기 / 해제 rows shared by every clip kind. `groupable`
 * gates 그룹 묶기 (≥2 clips selected, not all already one group); `grouped`
 * gates 그룹 해제 (the ctx clip belongs to a link group).
 */
function groupRows(groupable: boolean, grouped: boolean): MenuRow[] {
  return [
    { key: 'group', label: '그룹 묶기', enabled: groupable },
    { key: 'ungroup', label: '그룹 해제', enabled: grouped }
  ]
}

/**
 * Phase 3.41 — when a clip is locked, every "other" row is disabled (the lock
 * toggle row itself stays enabled so the user can always unlock). Helper takes
 * the locked-flag + the original row list and returns a guarded copy.
 */
function applyLockGuard(rows: MenuRow[], locked: boolean): MenuRow[] {
  if (!locked) return rows
  return rows.map((r) => ({ ...r, enabled: false }))
}

/**
 * Phase 3.41 — lock toggle row prepended to every clip kind. `locked` decides
 * the label / icon; the row itself is always enabled so the user can unlock.
 */
function lockRow(locked: boolean): MenuRow {
  return {
    key: 'toggle-lock',
    label: locked ? '🔓 잠금 해제' : '🔒 잠금',
    enabled: true
  }
}

/** Build the row list for a media clip. */
function mediaRows(
  clip: Clip,
  playheadMs: number | undefined,
  audioDetachable: boolean,
  groupable: boolean,
  grouped: boolean,
  isOnFreezeFrame: boolean,
  freezeDisabled: boolean
): MenuRow[] {
  // Strict-inside gate matches splitClipAt: must have ≥100ms on each side.
  const split = isMediaClip(clip) && playheadMs !== undefined
    ? playheadMs > clip.startMs + 100 && playheadMs < clip.endMs - 100
    : false
  const locked = isClipLocked(clip)
  return [
    lockRow(locked),
    ...applyLockGuard(
      [
        {
          key: 'split',
          label: '여기서 자르기',
          shortcut: 'S',
          enabled: split
        },
        {
          key: isOnFreezeFrame ? 'freeze-frame-remove-direct' : 'freeze-frame-add-direct',
          label: isOnFreezeFrame ? '프리즈 프레임 삭제' : '프리즈 프레임 추가',
          enabled: !freezeDisabled
        },
        { key: 'duplicate', label: '복제', shortcut: 'Ctrl+D' },
        // 오디오 분리 — split this video clip's audio onto its own audio track.
        // Enabled only for a video-track media clip that isn't already muted.
        { key: 'detach-audio', label: '오디오 분리', enabled: audioDetachable },
        // Phase 2.5 — opens the silence-remove dialog (handled by parent).
        { key: 'remove-silence', label: '무음 자동 제거…' },
        ...groupRows(groupable, grouped),
        { key: 'delete', label: '삭제', shortcut: 'Delete', destructive: true }
      ],
      locked
    )
  ]
}

function captionRows(clip: Clip, groupable: boolean, grouped: boolean): MenuRow[] {
  const locked = isClipLocked(clip)
  return [
    lockRow(locked),
    ...applyLockGuard(
      [
        { key: 'edit-caption', label: '자막 편집' },
        { key: 'duplicate', label: '복제', shortcut: 'Ctrl+D' },
        { key: 'change-style', label: '스타일 변경' },
        ...groupRows(groupable, grouped),
        { key: 'delete', label: '삭제', shortcut: 'Delete', destructive: true }
      ],
      locked
    )
  ]
}

/** Build the row list for an overlay clip (Phase 3.8). */
function overlayRows(clip: Clip, groupable: boolean, grouped: boolean): MenuRow[] {
  const locked = isClipLocked(clip)
  return [
    lockRow(locked),
    ...applyLockGuard(
      [
        { key: 'duplicate', label: '복제', shortcut: 'Ctrl+D' },
        ...groupRows(groupable, grouped),
        { key: 'delete', label: '삭제', shortcut: 'Delete', destructive: true }
      ],
      locked
    )
  ]
}

/** Default style for a shape-style fall-back (kept local to avoid an import). */
const SHAPE_STYLE_FALLBACK: ShapeStyle = {
  shape: 'rectangle',
  fill: '#ffffff',
  fillOpacity: 1,
  stroke: 'none',
  strokeWidth: 0,
  cornerRadius: 0
}

export function ClipContextMenu(props: ClipContextMenuProps): JSX.Element {
  const {
    clip,
    x,
    y,
    playheadMs,
    onAction,
    onSpeedChange,
    onTransitionChange,
    onFilterChange,
    onTransformChange,
    onTransformReset,
    onCropChange,
    onCropReset,
    sourceAspect,
    onColorAdjustChange,
    onColorAdjustReset,
    noiseReduction: noiseReductionProp,
    onNoiseReductionChange,
    voiceEnhance,
    onVoiceEnhanceChange,
    voiceChangerId,
    onVoiceChangerChange,
    blurRegions,
    onAddBlurRegion,
    onUpdateBlurRegion,
    onRemoveBlurRegion,
    motionTracks,
    onStartMotionTrackDraw,
    onCancelMotionTrack,
    onRetrackMotionTrack,
    onDeleteMotionTrack,
    motionTrackJobStatus,
    motionTrackJobPercent,
    motionTrackJobActive,
    onBindBlurRegionToTrack,
    onBindOverlayToTrack,
    onBindCaptionToTrack,
    allMotionTracks,
    boundMotionTrackId,
    onAddKeyframe,
    onRemoveKeyframeAtPlayhead,
    keyframeCount,
    isOnKeyframe,
    onAddSpeedKeyframe,
    onUpdateSpeedKeyframeAtPlayhead,
    onRemoveSpeedKeyframeAtPlayhead,
    onClearSpeedCurve,
    speedKeyframeCount,
    isOnSpeedKeyframe,
    speedAtPlayhead,
    reversed,
    canReverse,
    reverseWarnLong,
    onToggleReverse,
    onAddFreezeFrame,
    onUpdateFreezeFrameAtPlayhead,
    onRemoveFreezeFrameAtPlayhead,
    freezeFrameCount,
    isOnFreezeFrame,
    freezeDurationAtPlayhead,
    onAddVolumeKeyframe,
    onUpdateVolumeKeyframeAtPlayhead,
    onRemoveVolumeKeyframeAtPlayhead,
    onClearVolumeEnvelope,
    volumeKeyframeCount,
    isOnVolumeKeyframe,
    volumeDbAtPlayhead,
    onOverlayStyleChange,
    onOverlayShadowChange,
    audioDetachable,
    groupable,
    grouped,
    onClose
  } = props
  const ref = useRef<HTMLDivElement>(null)
  const [showSpeed, setShowSpeed] = useState(false)
  const [showFreeze, setShowFreeze] = useState(false)
  const [showVolumeCurve, setShowVolumeCurve] = useState(false)
  const [showTransition, setShowTransition] = useState(false)
  const [showFilter, setShowFilter] = useState(false)
  const [showTransform, setShowTransform] = useState(false)
  const [showCrop, setShowCrop] = useState(false)
  const [showColorAdjust, setShowColorAdjust] = useState(false)
  const [showDenoise, setShowDenoise] = useState(false)
  const [showVoiceEnhance, setShowVoiceEnhance] = useState(false)
  const [showBlur, setShowBlur] = useState(false)
  const [showMotionTrack, setShowMotionTrack] = useState(false)
  const [showShapeStyle, setShowShapeStyle] = useState(false)
  const [showOverlayShadow, setShowOverlayShadow] = useState(false)
  // Phase 3.11 — which mosaic/blur region the panel is editing. null until
  // the user picks one (or the first region is auto-selected on open).
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null)

  // Always recompute on each render so playhead/clip changes drive the gate.
  // 3-way switch on clip.kind: caption / overlay / media.
  const rows = isCaptionClip(clip)
    ? captionRows(clip, groupable === true, grouped === true)
    : isOverlayClip(clip)
      ? overlayRows(clip, groupable === true, grouped === true)
      : mediaRows(
          clip,
          playheadMs,
          audioDetachable === true,
          groupable === true,
          grouped === true,
          isOnFreezeFrame === true,
          reversed === true
        )

  // Read current speed (default 1) from the media clip; captions don't have one.
  const speed = isMediaClip(clip) ? clip.speed ?? 1 : 1
  // Phase 3.10 — a clip has an ACTIVE variable speed curve when it carries
  // >= 2 speed keyframes (mirrors `hasSpeedCurve`). Drives the curve sub-UI.
  const speedCurveActive = (speedKeyframeCount ?? 0) >= 2
  // Phase 3.30 — a clip has an ACTIVE volume envelope when it carries >= 2
  // volume keyframes (mirrors `hasVolumeEnvelope`). Drives the curve sub-UI.
  const volumeCurveActive = (volumeKeyframeCount ?? 0) >= 2
  const transitionKind: TransitionKind = isMediaClip(clip)
    ? clip.transitionIn?.kind ?? 'none'
    : 'none'
  const transitionMs = isMediaClip(clip)
    ? clip.transitionIn?.durationMs ?? DEFAULT_TRANSITION_MS
    : DEFAULT_TRANSITION_MS
  const filterPreset: FilterPreset = isMediaClip(clip)
    ? clip.filterPreset ?? 'none'
    : 'none'
  const filterIntensity = isMediaClip(clip) ? clip.filterIntensity ?? 1 : 1
  // Current transform — Phase 3.5: resolved via getTransformAt at the
  // playhead so a keyframed clip shows the INTERPOLATED value. For a static
  // clip getTransformAt falls back to the Phase 3 getClipTransform path.
  // Phase 3.8 — overlay clips carry the same ClipTransform.
  const transform: ClipTransform =
    isMediaClip(clip) || isOverlayClip(clip)
      ? getTransformAt(clip, playheadMs ?? clip.startMs)
      : { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }
  // Phase 3.6 — current crop rect (full-frame identity when no crop set).
  const cropRect: CropRect = isMediaClip(clip)
    ? getClipCropRect(clip) ?? IDENTITY_CROP
    : IDENTITY_CROP
  // Phase 3.7 — current color adjust (neutral identity when none set).
  const colorAdjust: ColorAdjust = isMediaClip(clip)
    ? getClipColorAdjust(clip) ?? NEUTRAL_COLOR_ADJUST
    : NEUTRAL_COLOR_ADJUST
  // Phase 4 — current noise-reduction strength (0 = off). Media clips only.
  // Prefer the live clip field; fall back to the prop (kept in sync by parent).
  const noiseReduction = isMediaClip(clip)
    ? clip.noiseReduction ?? noiseReductionProp ?? 0
    : 0
  const denoiseOn = noiseReduction > 0
  // Phase 3.39 — voice enhance: master is ON when payload exists AND at least
  // one sub-toggle is true. Count of enabled sub-toggles drives the header chip.
  const voiceEnhanceOn = Boolean(
    voiceEnhance && !isNeutralVoiceEnhance(voiceEnhance)
  )
  const voiceEnhanceCount = voiceEnhance
    ? (voiceEnhance.loudnorm ? 1 : 0) +
      (voiceEnhance.compress ? 1 : 0) +
      (voiceEnhance.deEss ? 1 : 0) +
      (voiceEnhance.eqLowCut ? 1 : 0) +
      (voiceEnhance.eqPresence ? 1 : 0)
    : 0
  // Phase 3.8 — current shape style for a shape overlay (fallback otherwise).
  const shapeStyle: ShapeStyle =
    isOverlayClip(clip) && clip.source.type === 'shape'
      ? clip.source.style
      : SHAPE_STYLE_FALLBACK
  // Phase 3.36 — current overlay drop shadow (null = off). The slider base
  // when the shadow is on falls back to DEFAULT_OVERLAY_SHADOW.
  const overlayShadow = isOverlayClip(clip) ? getOverlayShadow(clip) : null
  const shadowBase = overlayShadow ?? DEFAULT_OVERLAY_SHADOW
  // Source aspect ratio (W/H). Fall back to 1 when unknown so the centered
  // max-area preset math stays finite.
  const srcAspect =
    sourceAspect && Number.isFinite(sourceAspect) && sourceAspect > 0
      ? sourceAspect
      : 1

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Clamp the menu so it stays inside the viewport.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1000
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const maxMenuHeight = Math.max(240, vh - 24)
  const left = Math.min(x, Math.max(0, vw - 240))
  const top = Math.min(Math.max(12, y), Math.max(12, vh - maxMenuHeight - 12))

  return (
    <div
      ref={ref}
      style={{ ...styles.wrap, left, top, maxHeight: maxMenuHeight }}
      role="menu"
      data-testid="clip-context-menu"
      data-clip-kind={clip.kind}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rows.map((it) => {
        const enabled = it.enabled !== false
        return (
          <div
            key={it.key}
            role="menuitem"
            data-testid={`menu-${it.key}`}
            aria-disabled={!enabled}
            style={{
              ...styles.item,
              ...(it.destructive ? styles.destructive : {}),
              ...(enabled ? {} : styles.itemDisabled)
            }}
            onMouseEnter={(e) => {
              if (!enabled) return
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => {
              if (!enabled) return
              if (it.key === 'freeze-frame-add-direct') {
                onAddFreezeFrame()
                onClose()
                return
              }
              if (it.key === 'freeze-frame-remove-direct') {
                onRemoveFreezeFrameAtPlayhead()
                onClose()
                return
              }
              onAction(it.key)
              onClose()
            }}
          >
            <span>{it.label}</span>
            {it.shortcut && <span style={styles.shortcut}>{it.shortcut}</span>}
          </div>
        )
      })}

      {/* Transition sub-menu — media clips only. */}
      {isMediaClip(clip) && onTransitionChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-transition"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowTransition((v) => !v)}
          >
            <span>전환 효과{showTransition ? '' : '…'}</span>
            <span style={styles.shortcut}>
              {TRANSITION_LABELS[transitionKind] ?? transitionKind}
            </span>
          </div>
          {showTransition && (
            <div style={styles.speedPanel} data-testid="menu-transition-panel">
              {/* Reset chip — 'none' separated above the category grid. */}
              <div style={{ marginBottom: 6 }}>
                <button
                  type="button"
                  style={{
                    ...styles.preset,
                    ...(transitionKind === 'none' ? styles.presetActive : {})
                  }}
                  data-testid="menu-transition-preset-none"
                  onClick={() => onTransitionChange('none', transitionMs)}
                >
                  {TRANSITION_LABELS['none'] ?? 'none'}
                </button>
              </div>
              {TRANSITION_CATEGORIES.map((cat) => (
                <div
                  key={cat.id}
                  style={{ marginBottom: 6 }}
                  data-testid={`menu-transition-category-${cat.id}`}
                >
                  <div
                    style={{
                      fontSize: 10,
                      color: '#94a3b8',
                      marginBottom: 2,
                      fontWeight: 600
                    }}
                  >
                    {cat.title}
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))',
                      gap: 3
                    }}
                  >
                    {cat.kinds.map((k) => {
                      const active = transitionKind === k
                      return (
                        <button
                          key={k}
                          type="button"
                          style={{
                            ...styles.preset,
                            ...(active ? styles.presetActive : {})
                          }}
                          data-testid={`menu-transition-preset-${k}`}
                          onClick={() => onTransitionChange(k, transitionMs)}
                        >
                          {TRANSITION_LABELS[k] ?? k}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              <div style={styles.speedRow}>
                <input
                  type="range"
                  min={MIN_TRANSITION_MS}
                  max={MAX_TRANSITION_MS}
                  step={50}
                  value={transitionMs}
                  onChange={(e) =>
                    onTransitionChange(transitionKind, parseInt(e.target.value, 10) || DEFAULT_TRANSITION_MS)
                  }
                  style={styles.slider}
                  data-testid="menu-transition-slider"
                  aria-label="전환 길이"
                  disabled={transitionKind === 'none'}
                />
                <input
                  type="number"
                  min={MIN_TRANSITION_MS}
                  max={MAX_TRANSITION_MS}
                  step={50}
                  value={transitionMs}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    if (!Number.isFinite(v)) return
                    onTransitionChange(transitionKind, v)
                  }}
                  style={styles.speedInput}
                  data-testid="menu-transition-input"
                  aria-label="전환 길이(ms)"
                  disabled={transitionKind === 'none'}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Filter (LUT) sub-menu — media clips only. */}
      {isMediaClip(clip) && onFilterChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-filter"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowFilter((v) => !v)}
          >
            <span>필터{showFilter ? '' : '…'}</span>
            <span style={styles.shortcut}>
              {FILTER_PRESET_LABELS[filterPreset] ?? filterPreset}
            </span>
          </div>
          {showFilter && (
            <div style={styles.speedPanel} data-testid="menu-filter-panel">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 6,
                  marginBottom: 8
                }}
              >
                {FILTER_PRESETS.map((p) => {
                  const active = filterPreset === p
                  const css = filterPresetToCss(p, filterIntensity) || 'none'
                  return (
                    <button
                      key={p}
                      type="button"
                      data-testid={`menu-filter-preset-${p}`}
                      onClick={() => onFilterChange(p, filterIntensity)}
                      style={{
                        background: '#1f2937',
                        border: active ? '2px solid #10b981' : '1px solid #374151',
                        borderRadius: 4,
                        padding: 4,
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column' as const,
                        alignItems: 'center',
                        gap: 2,
                        fontSize: 10,
                        color: '#f5f5f5'
                      }}
                    >
                      <div
                        aria-hidden
                        style={{
                          width: 48,
                          height: 28,
                          background:
                            'linear-gradient(120deg, #4b5563, #9ca3af 50%, #f59e0b)',
                          borderRadius: 2,
                          filter: css === 'none' ? '' : css
                        }}
                      />
                      <div>{FILTER_PRESET_LABELS[p] ?? p}</div>
                    </button>
                  )
                })}
              </div>
              <div style={styles.speedRow}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(filterIntensity * 100)}
                  onChange={(e) =>
                    onFilterChange(
                      filterPreset,
                      Math.max(0, Math.min(1, parseInt(e.target.value, 10) / 100))
                    )
                  }
                  style={styles.slider}
                  data-testid="menu-filter-intensity-slider"
                  aria-label="필터 강도"
                  disabled={filterPreset === 'none'}
                />
                <span style={{ ...styles.shortcut, width: 36 }}>
                  {Math.round(filterIntensity * 100)}%
                </span>
              </div>
            </div>
          )}
        </>
      )}

      {/* Noise-reduction sub-menu (Phase 4) — media clips only. Per-clip
          audio noise reduction. EXPORT-ONLY: the preview audio graph is not
          denoised; the hint line states this. Modeled on the 필터 sub-menu. */}
      {isMediaClip(clip) && onNoiseReductionChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-denoise"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowDenoise((v) => !v)}
          >
            <span>노이즈 제거{showDenoise ? '' : '…'}</span>
            <span style={styles.shortcut}>
              {denoiseOn ? `켜짐 (${noiseReduction})` : '꺼짐'}
            </span>
          </div>
          {showDenoise && (
            <div style={styles.speedPanel} data-testid="menu-denoise-panel">
              {/* On/off toggle — modeled on the speed-curve checkbox. */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 8,
                  cursor: 'pointer',
                  fontSize: 11,
                  color: '#9aa0a6'
                }}
              >
                <input
                  type="checkbox"
                  checked={denoiseOn}
                  data-testid="denoise-toggle"
                  aria-label="노이즈 제거"
                  onChange={(e) => {
                    onNoiseReductionChange(
                      e.target.checked ? DEFAULT_NOISE_REDUCTION : 0
                    )
                  }}
                />
                <span>노이즈 제거 사용</span>
              </label>
              {/* Strength slider — disabled while OFF. */}
              <div style={styles.speedRow}>
                <input
                  type="range"
                  min={MIN_NOISE_REDUCTION}
                  max={MAX_NOISE_REDUCTION}
                  step={5}
                  value={noiseReduction}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    if (!Number.isFinite(v)) return
                    onNoiseReductionChange(v)
                  }}
                  style={styles.slider}
                  data-testid="menu-denoise-strength"
                  aria-label="노이즈 제거 강도"
                  disabled={!denoiseOn}
                />
                <span style={{ ...styles.shortcut, width: 36 }}>
                  {noiseReduction}
                </span>
              </div>
              {/* Export-only hint — preview is intentionally not denoised. */}
              <div style={{ ...styles.shortcut, marginTop: 6 }}>
                내보내기 시 적용 — 미리듣기에는 반영되지 않습니다
              </div>
            </div>
          )}
        </>
      )}

      {/* Voice-enhance sub-menu (Phase 3.39) — media clips only. Five boolean
          sub-toggles (loudnorm / compress / de-ess / EQ low-cut / EQ presence).
          EXPORT-ONLY: the preview audio graph is untouched. Mirrors the
          노이즈 제거 sub-menu shape (header chip + collapsible panel). */}
      {isMediaClip(clip) && onVoiceEnhanceChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-voice-enhance"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowVoiceEnhance((v) => !v)}
          >
            <span>음성 보정{showVoiceEnhance ? '' : '…'}</span>
            <span style={styles.shortcut}>
              {voiceEnhanceOn ? `켜짐 (${voiceEnhanceCount})` : '꺼짐'}
            </span>
          </div>
          {showVoiceEnhance && (
            <div
              style={styles.speedPanel}
              data-testid="menu-voice-enhance-panel"
            >
              {/* Master toggle — ON dispatches DEFAULT_VOICE_ENHANCE
                  (loudnorm-only); OFF dispatches NEUTRAL (store collapses
                  to undefined). Modeled on the denoise master toggle. */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 8,
                  cursor: 'pointer',
                  fontSize: 11,
                  color: '#9aa0a6'
                }}
              >
                <input
                  type="checkbox"
                  checked={voiceEnhanceOn}
                  data-testid="voice-enhance-toggle"
                  aria-label="음성 보정"
                  onChange={(e) => {
                    onVoiceEnhanceChange(
                      e.target.checked
                        ? DEFAULT_VOICE_ENHANCE
                        : NEUTRAL_VOICE_ENHANCE
                    )
                  }}
                />
                <span>음성 보정 사용</span>
              </label>
              {/* Sub-toggles — disabled while master is OFF. Each row dispatches
                  a single-field patch so the store's 5-field equality check
                  short-circuits no-ops. */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                  cursor: voiceEnhanceOn ? 'pointer' : 'not-allowed',
                  fontSize: 11,
                  color: voiceEnhanceOn ? '#cbd5e1' : '#475569'
                }}
              >
                <input
                  type="checkbox"
                  data-testid="vc-loudnorm"
                  checked={Boolean(voiceEnhance?.loudnorm)}
                  disabled={!voiceEnhanceOn}
                  onChange={(e) => {
                    onVoiceEnhanceChange({ loudnorm: e.target.checked })
                  }}
                />
                <span>라우드니스 정규화 (-16 LUFS)</span>
              </label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                  cursor: voiceEnhanceOn ? 'pointer' : 'not-allowed',
                  fontSize: 11,
                  color: voiceEnhanceOn ? '#cbd5e1' : '#475569'
                }}
              >
                <input
                  type="checkbox"
                  data-testid="vc-compress"
                  checked={Boolean(voiceEnhance?.compress)}
                  disabled={!voiceEnhanceOn}
                  onChange={(e) => {
                    onVoiceEnhanceChange({ compress: e.target.checked })
                  }}
                />
                <span>컴프레서</span>
              </label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                  cursor: voiceEnhanceOn ? 'pointer' : 'not-allowed',
                  fontSize: 11,
                  color: voiceEnhanceOn ? '#cbd5e1' : '#475569'
                }}
              >
                <input
                  type="checkbox"
                  data-testid="vc-deess"
                  checked={Boolean(voiceEnhance?.deEss)}
                  disabled={!voiceEnhanceOn}
                  onChange={(e) => {
                    onVoiceEnhanceChange({ deEss: e.target.checked })
                  }}
                />
                <span>디에서</span>
              </label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                  cursor: voiceEnhanceOn ? 'pointer' : 'not-allowed',
                  fontSize: 11,
                  color: voiceEnhanceOn ? '#cbd5e1' : '#475569'
                }}
              >
                <input
                  type="checkbox"
                  data-testid="vc-eqlowcut"
                  checked={Boolean(voiceEnhance?.eqLowCut)}
                  disabled={!voiceEnhanceOn}
                  onChange={(e) => {
                    onVoiceEnhanceChange({ eqLowCut: e.target.checked })
                  }}
                />
                <span>저주파 컷 (80 Hz)</span>
              </label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                  cursor: voiceEnhanceOn ? 'pointer' : 'not-allowed',
                  fontSize: 11,
                  color: voiceEnhanceOn ? '#cbd5e1' : '#475569'
                }}
              >
                <input
                  type="checkbox"
                  data-testid="vc-eqpresence"
                  checked={Boolean(voiceEnhance?.eqPresence)}
                  disabled={!voiceEnhanceOn}
                  onChange={(e) => {
                    onVoiceEnhanceChange({ eqPresence: e.target.checked })
                  }}
                />
                <span>보이스 EQ 프레즌스 (3 kHz +2 dB)</span>
              </label>
              {/* Export-only hint — preview audio graph is intentionally
                  untouched (mirrors the denoise hint). */}
              <div style={{ ...styles.shortcut, marginTop: 6 }}>
                내보내기 시 적용 — 미리듣기에는 반영되지 않습니다.
              </div>
            </div>
          )}
        </>
      )}

      {/* Phase 3.50 — voice changer preset dropdown. Media clips only. */}
      {isMediaClip(clip) && onVoiceChangerChange && (
        <>
          <div
            role="menuitem"
            data-testid="menu-voice-changer"
            style={{
              ...styles.item,
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            <span style={{ flex: 1 }}>🎙 보이스 체인저</span>
            <select
              data-testid="voice-changer-select"
              value={voiceChangerId ?? 'none'}
              onChange={(e) => {
                onVoiceChangerChange(e.target.value as VoiceChangerId)
              }}
              style={{
                background: '#1a1a1a',
                color: '#f5f5f5',
                border: '1px solid #2a2a2a',
                borderRadius: 4,
                padding: '4px 6px',
                fontSize: 11
              }}
            >
              {VOICE_CHANGER_IDS.map((id) => (
                <option key={id} value={id}>
                  {VOICE_CHANGER_LABELS[id]}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      {/* Transform sub-menu — media + overlay clips. Numeric panel is the
          committed UI for Phase 3 (on-canvas drag handles deferred). */}
      {(isMediaClip(clip) || isOverlayClip(clip)) && onTransformChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-transform"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowTransform((v) => !v)}
          >
            <span>변형{showTransform ? '' : '…'}</span>
            <span style={styles.shortcut}>
              {transform.scale.toFixed(2)}×
            </span>
          </div>
          {showTransform && (
            <div style={styles.speedPanel} data-testid="menu-transform-panel">
              {/* Keyframe controls (Phase 3.5) — above the sliders. */}
              {onAddKeyframe && (
                <div style={styles.keyframeRow}>
                  <button
                    type="button"
                    style={styles.keyframeBtn}
                    data-testid="menu-transform-add-keyframe"
                    onClick={() => onAddKeyframe()}
                  >
                    {isOnKeyframe ? '키프레임 갱신' : '현재 위치에 키프레임 추가'}
                  </button>
                  <button
                    type="button"
                    style={{
                      ...styles.keyframeBtn,
                      ...(isOnKeyframe ? {} : styles.keyframeBtnDisabled)
                    }}
                    data-testid="menu-transform-remove-keyframe"
                    disabled={!isOnKeyframe}
                    onClick={() => {
                      if (!isOnKeyframe) return
                      onRemoveKeyframeAtPlayhead?.()
                    }}
                  >
                    키프레임 삭제
                  </button>
                  <span
                    style={styles.keyframeCountBadge}
                    data-testid="keyframe-count"
                  >
                    {keyframeCount ?? 0}
                  </span>
                </div>
              )}
              {/* Scale */}
              <div style={styles.transformRow}>
                <span style={styles.transformLabel}>크기</span>
                <input
                  type="range"
                  min={MIN_TRANSFORM_SCALE}
                  max={MAX_TRANSFORM_SCALE}
                  step={0.05}
                  value={transform.scale}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onTransformChange({ scale: v })
                  }}
                  style={styles.slider}
                  data-testid="menu-transform-scale"
                  aria-label="크기"
                />
                <input
                  type="number"
                  min={MIN_TRANSFORM_SCALE}
                  max={MAX_TRANSFORM_SCALE}
                  step={0.05}
                  value={Number(transform.scale.toFixed(2))}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onTransformChange({ scale: v })
                  }}
                  style={styles.speedInput}
                  aria-label="크기 숫자"
                />
              </div>
              {/* Rotation */}
              <div style={styles.transformRow}>
                <span style={styles.transformLabel}>회전</span>
                <input
                  type="range"
                  min={MIN_TRANSFORM_ROTATION}
                  max={MAX_TRANSFORM_ROTATION}
                  step={1}
                  value={transform.rotation}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onTransformChange({ rotation: v })
                  }}
                  style={styles.slider}
                  data-testid="menu-transform-rotation"
                  aria-label="회전"
                />
                <input
                  type="number"
                  min={MIN_TRANSFORM_ROTATION}
                  max={MAX_TRANSFORM_ROTATION}
                  step={1}
                  value={Number(transform.rotation.toFixed(0))}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onTransformChange({ rotation: v })
                  }}
                  style={styles.speedInput}
                  aria-label="회전 숫자"
                />
              </div>
              {/* Opacity */}
              <div style={styles.transformRow}>
                <span style={styles.transformLabel}>불투명</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={transform.opacity}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onTransformChange({ opacity: v })
                  }}
                  style={styles.slider}
                  data-testid="menu-transform-opacity"
                  aria-label="불투명도"
                />
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={Number(transform.opacity.toFixed(2))}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onTransformChange({ opacity: v })
                  }}
                  style={styles.speedInput}
                  aria-label="불투명도 숫자"
                />
              </div>
              {/* X offset */}
              <div style={styles.transformRow}>
                <span style={styles.transformLabel}>X 위치</span>
                <input
                  type="range"
                  min={MIN_TRANSFORM_OFFSET}
                  max={MAX_TRANSFORM_OFFSET}
                  step={0.01}
                  value={transform.x}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onTransformChange({ x: v })
                  }}
                  style={styles.slider}
                  data-testid="menu-transform-x"
                  aria-label="X 위치"
                />
                <input
                  type="number"
                  min={MIN_TRANSFORM_OFFSET}
                  max={MAX_TRANSFORM_OFFSET}
                  step={0.01}
                  value={Number(transform.x.toFixed(2))}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onTransformChange({ x: v })
                  }}
                  style={styles.speedInput}
                  aria-label="X 위치 숫자"
                />
              </div>
              {/* Y offset */}
              <div style={styles.transformRow}>
                <span style={styles.transformLabel}>Y 위치</span>
                <input
                  type="range"
                  min={MIN_TRANSFORM_OFFSET}
                  max={MAX_TRANSFORM_OFFSET}
                  step={0.01}
                  value={transform.y}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onTransformChange({ y: v })
                  }}
                  style={styles.slider}
                  data-testid="menu-transform-y"
                  aria-label="Y 위치"
                />
                <input
                  type="number"
                  min={MIN_TRANSFORM_OFFSET}
                  max={MAX_TRANSFORM_OFFSET}
                  step={0.01}
                  value={Number(transform.y.toFixed(2))}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onTransformChange({ y: v })
                  }}
                  style={styles.speedInput}
                  aria-label="Y 위치 숫자"
                />
              </div>
              {onTransformReset && (
                <button
                  type="button"
                  style={styles.transformResetBtn}
                  data-testid="menu-transform-reset"
                  onClick={() => onTransformReset()}
                >
                  초기화
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* Crop sub-menu (Phase 3.6) — media clips only. Static per-clip
          source crop; no keyframes. Modeled on the 변형 sub-menu. */}
      {isMediaClip(clip) && onCropChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-crop"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowCrop((v) => !v)}
          >
            <span>크롭{showCrop ? '' : '…'}</span>
            <span style={styles.shortcut}>
              {`${Math.round(cropRect.w * 100)}×${Math.round(
                cropRect.h * 100
              )}%`}
            </span>
          </div>
          {showCrop && (
            <div style={styles.speedPanel} data-testid="menu-crop-panel">
              <CropControls
                cropRect={cropRect}
                sourceAspect={srcAspect}
                onCropChange={onCropChange}
                onCropReset={onCropReset}
                testPrefix="menu-crop"
                styles={{
                  presetRow: styles.presetRow,
                  preset: styles.preset,
                  row: styles.transformRow,
                  label: styles.transformLabel,
                  slider: styles.slider,
                  input: styles.speedInput,
                  resetButton: styles.transformResetBtn
                }}
              />
            </div>
          )}
        </>
      )}

      {/* Color-adjust sub-menu (Phase 3.7) — media clips only. Static
          per-clip manual brightness/contrast/saturation/temperature
          sliders; STACKS on top of the 필터 preset. Modeled on the 크롭
          sub-menu. */}
      {isMediaClip(clip) && onColorAdjustChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-coloradjust"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowColorAdjust((v) => !v)}
          >
            <span>조정{showColorAdjust ? '' : '…'}</span>
            <span style={styles.shortcut}>
              {
                (['brightness', 'contrast', 'saturation', 'temperature'] as const).filter(
                  (k) => colorAdjust[k] !== 0
                ).length
              }
            </span>
          </div>
          {showColorAdjust && (
            <div style={styles.speedPanel} data-testid="menu-coloradjust-panel">
              {(
                ['brightness', 'contrast', 'saturation', 'temperature'] as const
              ).map((k) => (
                <div key={k} style={styles.transformRow}>
                  <span style={styles.transformLabel}>
                    {COLOR_ADJUST_LABELS[k]}
                  </span>
                  <input
                    type="range"
                    min={MIN_COLOR_ADJUST}
                    max={MAX_COLOR_ADJUST}
                    step={1}
                    value={colorAdjust[k]}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (!Number.isFinite(v)) return
                      onColorAdjustChange({ [k]: v })
                    }}
                    style={styles.slider}
                    data-testid={`menu-coloradjust-${k}`}
                    aria-label={COLOR_ADJUST_LABELS[k]}
                  />
                  <input
                    type="number"
                    min={MIN_COLOR_ADJUST}
                    max={MAX_COLOR_ADJUST}
                    step={1}
                    value={colorAdjust[k]}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (!Number.isFinite(v)) return
                      onColorAdjustChange({ [k]: v })
                    }}
                    style={styles.speedInput}
                    data-testid={`menu-coloradjust-${k}-input`}
                    aria-label={`${COLOR_ADJUST_LABELS[k]} 숫자`}
                  />
                </div>
              ))}
              {onColorAdjustReset && (
                <button
                  type="button"
                  style={styles.transformResetBtn}
                  data-testid="menu-coloradjust-reset"
                  onClick={() => onColorAdjustReset()}
                >
                  초기화
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* Mosaic / blur sub-menu (Phase 3.11) — media clips only. Static
          per-clip masking regions (no keyframes, no on-canvas handles).
          Numeric panel modeled on the 크롭 sub-menu. */}
      {isMediaClip(clip) && onAddBlurRegion && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-blur"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowBlur((v) => !v)}
          >
            <span>모자이크/마스크{showBlur ? '' : '…'}</span>
            <span style={styles.shortcut}>{(blurRegions ?? []).length}</span>
          </div>
          {showBlur &&
            (() => {
              const regions = blurRegions ?? []
              // Resolve the selected region — fall back to the first region
              // when the stored selection no longer exists (e.g. removed).
              const selected =
                regions.find((r) => r.id === selectedRegionId) ??
                regions[0] ??
                null
              const atMax = regions.length >= MAX_BLUR_REGIONS_PER_CLIP
              return (
                <div
                  style={styles.speedPanel}
                  data-testid="menu-blur-panel"
                >
                  {/* Region selector chips. */}
                  {regions.length > 0 && (
                    <div style={styles.presetRow}>
                      {regions.map((r, i) => {
                        const active = selected?.id === r.id
                        return (
                          <button
                            key={r.id}
                            type="button"
                            style={{
                              ...styles.preset,
                              ...(active ? styles.presetActive : {})
                            }}
                            data-testid={`menu-blur-region-${r.id}`}
                            onClick={() => setSelectedRegionId(r.id)}
                          >
                            {`#${i + 1}`}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {/* Add / remove region buttons. */}
                  <div style={styles.keyframeRow}>
                    <button
                      type="button"
                      style={{
                        ...styles.keyframeBtn,
                        ...(atMax ? styles.keyframeBtnDisabled : {})
                      }}
                      data-testid="menu-blur-add"
                      disabled={atMax}
                      onClick={() => {
                        if (atMax) return
                        onAddBlurRegion()
                      }}
                    >
                      영역 추가
                    </button>
                    <button
                      type="button"
                      style={{
                        ...styles.keyframeBtn,
                        ...(selected ? {} : styles.keyframeBtnDisabled)
                      }}
                      data-testid="menu-blur-remove"
                      disabled={!selected}
                      onClick={() => {
                        if (!selected) return
                        onRemoveBlurRegion?.(selected.id)
                      }}
                    >
                      영역 삭제
                    </button>
                  </div>
                  {/* Per-region controls — only when a region is selected. */}
                  {selected && (
                    <>
                      {/* Effect toggle (모자이크 / 블러 / 오브젝트 제거). */}
                      <div style={styles.presetRow}>
                        {BLUR_EFFECT_KINDS.map((kind) => {
                          const active = selected.effect === kind
                          return (
                            <button
                              key={kind}
                              type="button"
                              style={{
                                ...styles.preset,
                                ...(active ? styles.presetActive : {})
                              }}
                              data-testid={`menu-blur-effect-${kind}`}
                              onClick={() =>
                                onUpdateBlurRegion?.(selected.id, {
                                  effect: kind
                                })
                              }
                            >
                              {kind === 'mosaic'
                                ? '모자이크'
                                : kind === 'blur'
                                  ? '블러'
                                  : '오브젝트 제거'}
                            </button>
                          )
                        })}
                      </div>
                      {/* Shape toggle (사각형 / 타원). Hidden for 'remove' —
                          delogo is rectangle-only. */}
                      {selected.effect !== 'remove' && (
                        <div style={styles.presetRow}>
                          {BLUR_REGION_SHAPES.map((shape) => {
                            const active = selected.shape === shape
                            return (
                              <button
                                key={shape}
                                type="button"
                                style={{
                                  ...styles.preset,
                                  ...(active ? styles.presetActive : {})
                                }}
                                data-testid={`menu-blur-shape-${shape}`}
                                onClick={() =>
                                  onUpdateBlurRegion?.(selected.id, { shape })
                                }
                              >
                                {shape === 'rectangle' ? '사각형' : '타원'}
                              </button>
                            )
                          })}
                        </div>
                      )}
                      {/* Helper text — shown only for 'remove'. delogo is an
                          edge-interpolation filter, not AI inpainting. */}
                      {selected.effect === 'remove' && (
                        <div
                          style={{ ...styles.shortcut, marginTop: 2 }}
                          data-testid="menu-blur-remove-hint"
                        >
                          작은 로고·워터마크 제거에 적합합니다. 배경이
                          단순할수록 깔끔하게 지워집니다.
                        </div>
                      )}
                      {/* Strength — hidden for 'remove' (delogo has no strength
                          parameter). */}
                      {selected.effect !== 'remove' && (
                        <div style={styles.transformRow}>
                          <span style={styles.transformLabel}>강도</span>
                          <input
                            type="range"
                            min={MIN_BLUR_STRENGTH}
                            max={MAX_BLUR_STRENGTH}
                            step={1}
                            value={selected.strength}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10)
                              if (!Number.isFinite(v)) return
                              onUpdateBlurRegion?.(selected.id, { strength: v })
                            }}
                            style={styles.slider}
                            data-testid="menu-blur-strength"
                            aria-label="강도"
                          />
                          <input
                            type="number"
                            min={MIN_BLUR_STRENGTH}
                            max={MAX_BLUR_STRENGTH}
                            step={1}
                            value={selected.strength}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10)
                              if (!Number.isFinite(v)) return
                              onUpdateBlurRegion?.(selected.id, { strength: v })
                            }}
                            style={styles.speedInput}
                            aria-label="강도 숫자"
                          />
                        </div>
                      )}
                      {/* X */}
                      <div style={styles.transformRow}>
                        <span style={styles.transformLabel}>X</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={selected.x}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            if (!Number.isFinite(v)) return
                            onUpdateBlurRegion?.(selected.id, { x: v })
                          }}
                          style={styles.slider}
                          data-testid="menu-blur-x"
                          aria-label="모자이크 X"
                        />
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.01}
                          value={Number(selected.x.toFixed(2))}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            if (!Number.isFinite(v)) return
                            onUpdateBlurRegion?.(selected.id, { x: v })
                          }}
                          style={styles.speedInput}
                          aria-label="모자이크 X 숫자"
                        />
                      </div>
                      {/* Y */}
                      <div style={styles.transformRow}>
                        <span style={styles.transformLabel}>Y</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={selected.y}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            if (!Number.isFinite(v)) return
                            onUpdateBlurRegion?.(selected.id, { y: v })
                          }}
                          style={styles.slider}
                          data-testid="menu-blur-y"
                          aria-label="모자이크 Y"
                        />
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.01}
                          value={Number(selected.y.toFixed(2))}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            if (!Number.isFinite(v)) return
                            onUpdateBlurRegion?.(selected.id, { y: v })
                          }}
                          style={styles.speedInput}
                          aria-label="모자이크 Y 숫자"
                        />
                      </div>
                      {/* W */}
                      <div style={styles.transformRow}>
                        <span style={styles.transformLabel}>너비</span>
                        <input
                          type="range"
                          min={MIN_BLUR_REGION_SIZE}
                          max={1}
                          step={0.01}
                          value={selected.w}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            if (!Number.isFinite(v)) return
                            onUpdateBlurRegion?.(selected.id, { w: v })
                          }}
                          style={styles.slider}
                          data-testid="menu-blur-w"
                          aria-label="모자이크 너비"
                        />
                        <input
                          type="number"
                          min={MIN_BLUR_REGION_SIZE}
                          max={1}
                          step={0.01}
                          value={Number(selected.w.toFixed(2))}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            if (!Number.isFinite(v)) return
                            onUpdateBlurRegion?.(selected.id, { w: v })
                          }}
                          style={styles.speedInput}
                          aria-label="모자이크 너비 숫자"
                        />
                      </div>
                      {/* H */}
                      <div style={styles.transformRow}>
                        <span style={styles.transformLabel}>높이</span>
                        <input
                          type="range"
                          min={MIN_BLUR_REGION_SIZE}
                          max={1}
                          step={0.01}
                          value={selected.h}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            if (!Number.isFinite(v)) return
                            onUpdateBlurRegion?.(selected.id, { h: v })
                          }}
                          style={styles.slider}
                          data-testid="menu-blur-h"
                          aria-label="모자이크 높이"
                        />
                        <input
                          type="number"
                          min={MIN_BLUR_REGION_SIZE}
                          max={1}
                          step={0.01}
                          value={Number(selected.h.toFixed(2))}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            if (!Number.isFinite(v)) return
                            onUpdateBlurRegion?.(selected.id, { h: v })
                          }}
                          style={styles.speedInput}
                          aria-label="모자이크 높이 숫자"
                        />
                      </div>
                      {/* Phase 3.13 — bind this region to a motion track on
                          the same clip. "없음" clears the binding. */}
                      {onBindBlurRegionToTrack && (
                        <div style={styles.transformRow}>
                          <span style={styles.transformLabel}>
                            모션 트랙에 고정
                          </span>
                          <select
                            data-testid={`motion-track-bind-select-${selected.id}`}
                            value={selected.motionTrackId ?? ''}
                            onChange={(e) => {
                              const v = e.target.value
                              onBindBlurRegionToTrack(
                                selected.id,
                                v === '' ? null : v
                              )
                            }}
                            style={{
                              ...styles.speedInput,
                              width: 'auto',
                              flex: 1,
                              textAlign: 'left'
                            }}
                            aria-label="모션 트랙에 고정"
                          >
                            <option value="">없음</option>
                            {(motionTracks ?? []).map((mt) => (
                              <option key={mt.id} value={mt.id}>
                                {mt.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )
            })()}
        </>
      )}

      {/* Motion-tracking sub-menu (Phase 3.13) — media clips only. Mirrors the
          모자이크/마스크 panel: a 박스 그리기 button arms the box-draw overlay
          on the preview, a progress bar + 취소 button cover a running job, and
          a per-track chip list exposes 다시 트래킹 / 삭제. */}
      {isMediaClip(clip) && onStartMotionTrackDraw && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-motion-track"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background =
                'transparent'
            }}
            onClick={() => setShowMotionTrack((v) => !v)}
          >
            <span>모션 트래킹{showMotionTrack ? '' : '…'}</span>
            <span style={styles.shortcut}>
              {(motionTracks ?? []).length}
            </span>
          </div>
          {showMotionTrack && (
            <div
              style={styles.speedPanel}
              data-testid="menu-motion-track-panel"
            >
              {/* 박스 그리기 — arms the preview box-draw overlay. Tracking
                  starts implicitly on box-draw mouse-up. */}
              <div style={styles.keyframeRow}>
                <button
                  type="button"
                  style={{
                    ...styles.keyframeBtn,
                    ...(motionTrackJobActive
                      ? styles.keyframeBtnDisabled
                      : {})
                  }}
                  data-testid="motion-track-draw-start"
                  disabled={!!motionTrackJobActive}
                  onClick={() => {
                    if (motionTrackJobActive) return
                    onStartMotionTrackDraw()
                    onClose()
                  }}
                >
                  박스 그리기
                </button>
              </div>
              {/* Live job — progress bar + 취소. */}
              {motionTrackJobActive && (
                <>
                  <div
                    data-testid="motion-track-progress"
                    data-percent={motionTrackJobPercent ?? 0}
                    data-status={motionTrackJobStatus ?? 'idle'}
                    style={{
                      height: 8,
                      borderRadius: 4,
                      background: '#1f2937',
                      overflow: 'hidden',
                      marginBottom: 8
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.max(
                          0,
                          Math.min(100, motionTrackJobPercent ?? 0)
                        )}%`,
                        background: '#10b981',
                        transition: 'width 0.2s ease'
                      }}
                    />
                  </div>
                  <div style={styles.keyframeRow}>
                    <button
                      type="button"
                      style={styles.keyframeBtn}
                      data-testid="motion-track-cancel"
                      onClick={() => onCancelMotionTrack?.()}
                    >
                      취소
                    </button>
                  </div>
                </>
              )}
              {/* Per-track chip list — 다시 트래킹 / 삭제. */}
              {(motionTracks ?? []).map((mt) => (
                <div
                  key={mt.id}
                  data-testid={`motion-track-chip-${mt.id}`}
                  data-track-status={mt.status}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginTop: 6
                  }}
                >
                  <span style={{ flex: 1, fontSize: 11 }}>
                    {mt.name}
                    <span style={styles.shortcut}>
                      {' '}
                      · {mt.points.length}점 · {mt.status}
                    </span>
                  </span>
                  <button
                    type="button"
                    style={styles.preset}
                    data-testid={`motion-track-retrack-${mt.id}`}
                    disabled={!!motionTrackJobActive}
                    onClick={() => onRetrackMotionTrack?.(mt)}
                  >
                    다시 트래킹
                  </button>
                  <button
                    type="button"
                    style={{ ...styles.preset, color: '#fca5a5' }}
                    data-testid={`motion-track-delete-${mt.id}`}
                    onClick={() => onDeleteMotionTrack?.(mt.id)}
                  >
                    삭제
                  </button>
                </div>
              ))}
              {(motionTracks ?? []).length === 0 && !motionTrackJobActive && (
                <div style={{ ...styles.shortcut, marginTop: 4 }}>
                  박스를 그려 객체를 추적하세요
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Motion-track binding dropdown (Phase 3.13) — overlay / caption clips.
          Their bindable tracks live on OTHER (media) clips, so the picker is
          populated from the whole-project track list. */}
      {(isOverlayClip(clip) && onBindOverlayToTrack) ||
      (isCaptionClip(clip) && onBindCaptionToTrack) ? (
        <>
          <div style={styles.separator} />
          <div style={styles.speedPanel} data-testid="menu-motion-track-panel">
            <div style={styles.transformRow}>
              <span style={styles.transformLabel}>모션 트랙에 고정</span>
              <select
                data-testid="motion-track-bind-select"
                value={boundMotionTrackId ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  const next = v === '' ? null : v
                  if (isOverlayClip(clip)) onBindOverlayToTrack?.(next)
                  else if (isCaptionClip(clip)) onBindCaptionToTrack?.(next)
                }}
                style={{
                  ...styles.speedInput,
                  width: 'auto',
                  flex: 1,
                  textAlign: 'left'
                }}
                aria-label="모션 트랙에 고정"
              >
                <option value="">없음</option>
                {(allMotionTracks ?? []).map((mt) => (
                  <option key={mt.id} value={mt.id}>
                    {mt.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </>
      ) : null}

      {/* Shape-style sub-menu (Phase 3.8) — shape overlay clips only.
          Fill / fill-opacity / stroke / stroke-width / corner-radius. */}
      {isOverlayClip(clip) &&
        clip.source.type === 'shape' &&
        onOverlayStyleChange && (
          <>
            <div style={styles.separator} />
            <div
              role="menuitem"
              data-testid="menu-overlay-style"
              style={styles.item}
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.background =
                  '#2a2a2a'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.background =
                  'transparent'
              }}
              onClick={() => setShowShapeStyle((v) => !v)}
            >
              <span>도형 스타일{showShapeStyle ? '' : '…'}</span>
              <span style={styles.shortcut}>{shapeStyle.shape}</span>
            </div>
            {showShapeStyle && (
              <div
                style={styles.speedPanel}
                data-testid="menu-overlay-style-panel"
              >
                {/* Fill color */}
                <div style={styles.transformRow}>
                  <span style={styles.transformLabel}>채움색</span>
                  <input
                    type="color"
                    value={
                      shapeStyle.fill === 'none' ? '#ffffff' : shapeStyle.fill
                    }
                    onChange={(e) =>
                      onOverlayStyleChange({ fill: e.target.value })
                    }
                    data-testid="menu-overlay-fill"
                    aria-label="채움색"
                    style={{ flex: 1, height: 24, cursor: 'pointer' }}
                  />
                  <button
                    type="button"
                    style={styles.preset}
                    data-testid="menu-overlay-fill-none"
                    onClick={() => onOverlayStyleChange({ fill: 'none' })}
                  >
                    없음
                  </button>
                </div>
                <BrandSwatchRow
                  label="브랜드"
                  onPick={(hex) => onOverlayStyleChange({ fill: hex })}
                />
                {/* Fill opacity */}
                <div style={styles.transformRow}>
                  <span style={styles.transformLabel}>채움 투명</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={shapeStyle.fillOpacity}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value)
                      if (!Number.isFinite(v)) return
                      onOverlayStyleChange({ fillOpacity: v })
                    }}
                    style={styles.slider}
                    data-testid="menu-overlay-fill-opacity"
                    aria-label="채움 불투명도"
                  />
                  <span style={{ ...styles.shortcut, width: 36 }}>
                    {Math.round(shapeStyle.fillOpacity * 100)}%
                  </span>
                </div>
                {/* Stroke color */}
                <div style={styles.transformRow}>
                  <span style={styles.transformLabel}>선색</span>
                  <input
                    type="color"
                    value={
                      shapeStyle.stroke === 'none'
                        ? '#ffffff'
                        : shapeStyle.stroke
                    }
                    onChange={(e) =>
                      onOverlayStyleChange({ stroke: e.target.value })
                    }
                    data-testid="menu-overlay-stroke"
                    aria-label="선색"
                    style={{ flex: 1, height: 24, cursor: 'pointer' }}
                  />
                  <button
                    type="button"
                    style={styles.preset}
                    data-testid="menu-overlay-stroke-none"
                    onClick={() => onOverlayStyleChange({ stroke: 'none' })}
                  >
                    없음
                  </button>
                </div>
                <BrandSwatchRow
                  label="브랜드"
                  onPick={(hex) => onOverlayStyleChange({ stroke: hex })}
                />
                {/* Stroke width */}
                <div style={styles.transformRow}>
                  <span style={styles.transformLabel}>선 굵기</span>
                  <input
                    type="range"
                    min={0}
                    max={40}
                    step={1}
                    value={shapeStyle.strokeWidth}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (!Number.isFinite(v)) return
                      onOverlayStyleChange({ strokeWidth: v })
                    }}
                    style={styles.slider}
                    data-testid="menu-overlay-stroke-width"
                    aria-label="선 굵기"
                  />
                  <input
                    type="number"
                    min={0}
                    max={40}
                    step={1}
                    value={shapeStyle.strokeWidth}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (!Number.isFinite(v)) return
                      onOverlayStyleChange({ strokeWidth: v })
                    }}
                    style={styles.speedInput}
                    aria-label="선 굵기 숫자"
                  />
                </div>
                {/* Corner radius — rectangle only. */}
                <div style={styles.transformRow}>
                  <span style={styles.transformLabel}>모서리</span>
                  <input
                    type="range"
                    min={0}
                    max={50}
                    step={1}
                    value={shapeStyle.cornerRadius}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (!Number.isFinite(v)) return
                      onOverlayStyleChange({ cornerRadius: v })
                    }}
                    style={styles.slider}
                    data-testid="menu-overlay-corner-radius"
                    aria-label="모서리 둥글기"
                    disabled={shapeStyle.shape !== 'rectangle'}
                  />
                  <input
                    type="number"
                    min={0}
                    max={50}
                    step={1}
                    value={shapeStyle.cornerRadius}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (!Number.isFinite(v)) return
                      onOverlayStyleChange({ cornerRadius: v })
                    }}
                    style={styles.speedInput}
                    aria-label="모서리 둥글기 숫자"
                    disabled={shapeStyle.shape !== 'rectangle'}
                  />
                </div>
              </div>
            )}
          </>
        )}

      {/* Overlay drop-shadow sub-menu (Phase 3.36) — image / sticker / shape
          overlay clips. Toggle on/off + color / X·Y offset / blur / opacity. */}
      {isOverlayClip(clip) && onOverlayShadowChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-overlay-shadow"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background =
                'transparent'
            }}
            onClick={() => setShowOverlayShadow((v) => !v)}
          >
            <span>그림자{showOverlayShadow ? '' : '…'}</span>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={overlayShadow !== null}
                data-testid="menu-overlay-shadow-toggle"
                aria-label="그림자"
                onChange={(e) =>
                  onOverlayShadowChange(
                    e.target.checked ? DEFAULT_OVERLAY_SHADOW : null
                  )
                }
              />
            </label>
          </div>
          {showOverlayShadow && overlayShadow !== null && (
            <div
              style={styles.speedPanel}
              data-testid="menu-overlay-shadow-panel"
            >
              {/* Color */}
              <div style={styles.transformRow}>
                <span style={styles.transformLabel}>색상</span>
                <input
                  type="color"
                  value={shadowBase.color}
                  onChange={(e) =>
                    onOverlayShadowChange({
                      ...shadowBase,
                      color: e.target.value
                    })
                  }
                  data-testid="menu-overlay-shadow-color"
                  aria-label="그림자 색상"
                  style={{ flex: 1, height: 24, cursor: 'pointer' }}
                />
              </div>
              {/* X offset */}
              <div style={styles.transformRow}>
                <span style={styles.transformLabel}>X 오프셋</span>
                <input
                  type="range"
                  min={-MAX_OVERLAY_SHADOW_OFFSET}
                  max={MAX_OVERLAY_SHADOW_OFFSET}
                  step={1}
                  value={shadowBase.offsetX}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    if (!Number.isFinite(v)) return
                    onOverlayShadowChange({ ...shadowBase, offsetX: v })
                  }}
                  style={styles.slider}
                  data-testid="menu-overlay-shadow-offsetx"
                  aria-label="그림자 X 오프셋"
                />
                <span style={{ ...styles.shortcut, width: 36 }}>
                  {shadowBase.offsetX}
                </span>
              </div>
              {/* Y offset */}
              <div style={styles.transformRow}>
                <span style={styles.transformLabel}>Y 오프셋</span>
                <input
                  type="range"
                  min={-MAX_OVERLAY_SHADOW_OFFSET}
                  max={MAX_OVERLAY_SHADOW_OFFSET}
                  step={1}
                  value={shadowBase.offsetY}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    if (!Number.isFinite(v)) return
                    onOverlayShadowChange({ ...shadowBase, offsetY: v })
                  }}
                  style={styles.slider}
                  data-testid="menu-overlay-shadow-offsety"
                  aria-label="그림자 Y 오프셋"
                />
                <span style={{ ...styles.shortcut, width: 36 }}>
                  {shadowBase.offsetY}
                </span>
              </div>
              {/* Blur */}
              <div style={styles.transformRow}>
                <span style={styles.transformLabel}>흐림</span>
                <input
                  type="range"
                  min={0}
                  max={MAX_OVERLAY_SHADOW_BLUR}
                  step={1}
                  value={shadowBase.blur}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    if (!Number.isFinite(v)) return
                    onOverlayShadowChange({ ...shadowBase, blur: v })
                  }}
                  style={styles.slider}
                  data-testid="menu-overlay-shadow-blur"
                  aria-label="그림자 흐림"
                />
                <span style={{ ...styles.shortcut, width: 36 }}>
                  {shadowBase.blur}
                </span>
              </div>
              {/* Opacity */}
              <div style={styles.transformRow}>
                <span style={styles.transformLabel}>불투명도</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={shadowBase.opacity}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onOverlayShadowChange({ ...shadowBase, opacity: v })
                  }}
                  style={styles.slider}
                  data-testid="menu-overlay-shadow-opacity"
                  aria-label="그림자 불투명도"
                />
                <span style={{ ...styles.shortcut, width: 36 }}>
                  {Math.round(shadowBase.opacity * 100)}%
                </span>
              </div>
            </div>
          )}
        </>
      )}

      {/* Speed sub-menu is media-only. */}
      {isMediaClip(clip) && onSpeedChange && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-speed"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowSpeed((v) => !v)}
          >
            <span>속도{showSpeed ? '' : '…'}</span>
            <span style={styles.shortcut}>{speed.toFixed(2)}×</span>
          </div>
          {showSpeed && (
            <div style={styles.speedPanel} data-testid="menu-speed-panel">
              {/* 리버스 / 역재생 — plays the clip backwards. Mutually
                  exclusive with a speed curve / freeze / 자막 편집. When
                  reverse is ON, the speed-curve toggle and freeze controls
                  below are disabled (symmetric exclusivity). */}
              {onToggleReverse && (
                <>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: reversed || !canReverse ? 4 : 8,
                      cursor: canReverse ? 'pointer' : 'not-allowed',
                      fontSize: 11,
                      color: canReverse ? '#9aa0a6' : '#5f6368'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!reversed}
                      data-testid="reverse-toggle"
                      aria-label="역재생"
                      disabled={!canReverse}
                      onChange={(e) => {
                        if (!canReverse) return
                        onToggleReverse(e.target.checked)
                      }}
                    />
                    <span>역재생</span>
                  </label>
                  {!canReverse && (
                    <div
                      data-testid="reverse-conflict-hint"
                      style={{
                        fontSize: 10,
                        color: '#5f6368',
                        marginBottom: 8,
                        lineHeight: 1.4
                      }}
                    >
                      속도 커브 · 프리즈 · 자막 편집과 함께 쓸 수 없습니다
                    </div>
                  )}
                  {reverseWarnLong && (
                    <div
                      data-testid="reverse-long-hint"
                      style={{
                        fontSize: 10,
                        color: '#f5a623',
                        marginBottom: 8,
                        lineHeight: 1.4
                      }}
                    >
                      긴 클립 역재생은 메모리를 많이 사용합니다
                    </div>
                  )}
                </>
              )}
              {/* Phase 3.10 — speed-curve toggle. When ON, the clip uses a
                  variable speed curve and the constant slider below is
                  disabled; when OFF the constant slider drives onSpeedChange
                  (unchanged legacy behavior). Disabled when the clip is
                  reversed (reverse ⊥ speed curve). */}
              {onAddSpeedKeyframe && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginBottom: 8,
                    cursor: reversed ? 'not-allowed' : 'pointer',
                    fontSize: 11,
                    color: reversed ? '#5f6368' : '#9aa0a6'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={speedCurveActive}
                    data-testid="speed-curve-toggle"
                    aria-label="속도 커브 사용"
                    disabled={!!reversed}
                    onChange={(e) => {
                      if (reversed) return
                      if (e.target.checked) {
                        // Turn ON — seed the curve (two keyframes) via the
                        // store's addSpeedKeyframe.
                        onAddSpeedKeyframe()
                      } else {
                        // Turn OFF — drop the curve, keep the constant speed.
                        onClearSpeedCurve?.()
                      }
                    }}
                  />
                  <span>속도 커브 사용</span>
                </label>
              )}
              {/* Speed-curve controls — modeled on the Phase 3.5
                  transform-keyframe row. Visible only when the curve is on. */}
              {onAddSpeedKeyframe && speedCurveActive && (
                <>
                  <div style={styles.keyframeRow}>
                    <button
                      type="button"
                      style={styles.keyframeBtn}
                      data-testid="menu-speed-add-keyframe"
                      onClick={() => onAddSpeedKeyframe()}
                    >
                      {isOnSpeedKeyframe
                        ? '속도 키프레임 갱신'
                        : '현재 위치에 속도 키프레임 추가'}
                    </button>
                    <button
                      type="button"
                      style={{
                        ...styles.keyframeBtn,
                        ...(isOnSpeedKeyframe ? {} : styles.keyframeBtnDisabled)
                      }}
                      data-testid="menu-speed-remove-keyframe"
                      disabled={!isOnSpeedKeyframe}
                      onClick={() => {
                        if (!isOnSpeedKeyframe) return
                        onRemoveSpeedKeyframeAtPlayhead?.()
                      }}
                    >
                      키프레임 삭제
                    </button>
                    <span
                      style={styles.keyframeCountBadge}
                      data-testid="speed-keyframe-count"
                    >
                      {speedKeyframeCount ?? 0}
                    </span>
                  </div>
                  {/* Per-keyframe speed slider — edits the speed of the
                      keyframe under the playhead. Disabled when not on one. */}
                  <div style={styles.transformRow}>
                    <span style={styles.transformLabel}>키프레임 속도</span>
                    <input
                      type="range"
                      min={MIN_CLIP_SPEED}
                      max={MAX_CLIP_SPEED}
                      step={0.05}
                      value={speedAtPlayhead ?? 1}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (!Number.isFinite(v)) return
                        onUpdateSpeedKeyframeAtPlayhead?.(v)
                      }}
                      style={styles.slider}
                      data-testid="menu-speed-keyframe-slider"
                      aria-label="키프레임 속도"
                      disabled={!isOnSpeedKeyframe}
                    />
                    <span style={{ ...styles.shortcut, width: 40 }}>
                      {(speedAtPlayhead ?? 1).toFixed(2)}×
                    </span>
                  </div>
                </>
              )}
              {/* Constant-speed presets + slider — drives onSpeedChange.
                  Disabled while a speed curve is active (the user must turn
                  the curve off first; setClipSpeed would otherwise clear it). */}
              <div style={styles.presetRow}>
                {SPEED_PRESETS.map((p) => {
                  const active = !speedCurveActive && Math.abs(speed - p) < 0.001
                  return (
                    <button
                      key={p}
                      type="button"
                      style={{
                        ...styles.preset,
                        ...(active ? styles.presetActive : {}),
                        ...(speedCurveActive
                          ? { opacity: 0.4, cursor: 'not-allowed' }
                          : {})
                      }}
                      data-testid={`menu-speed-preset-${p}`}
                      disabled={speedCurveActive}
                      onClick={() => {
                        if (speedCurveActive) return
                        onSpeedChange(p)
                      }}
                    >
                      {p}×
                    </button>
                  )
                })}
              </div>
              <div style={styles.speedRow}>
                <input
                  type="range"
                  min={MIN_CLIP_SPEED}
                  max={MAX_CLIP_SPEED}
                  step={0.05}
                  value={speed}
                  onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
                  style={styles.slider}
                  data-testid="menu-speed-slider"
                  aria-label="속도"
                  disabled={speedCurveActive}
                />
                <input
                  type="number"
                  min={MIN_CLIP_SPEED}
                  max={MAX_CLIP_SPEED}
                  step={0.1}
                  value={Number(speed.toFixed(2))}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    onSpeedChange(v)
                  }}
                  style={styles.speedInput}
                  data-testid="menu-speed-input"
                  aria-label="속도 숫자"
                  disabled={speedCurveActive}
                />
              </div>
            </div>
          )}
        </>
      )}
      {/* Phase 3.16 — freeze-frame sub-menu is media-only. Modeled on the
          speed panel above. A freeze inserts a held still at the playhead's
          source position; the clip then continues. */}
      {isMediaClip(clip) && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-freeze-frame"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowFreeze((v) => !v)}
          >
            <span>프리즈 프레임{showFreeze ? '' : '…'}</span>
            <span
              style={styles.keyframeCountBadge}
              data-testid="freeze-frame-count"
            >
              {freezeFrameCount}
            </span>
          </div>
          {showFreeze && (
            <div style={styles.speedPanel} data-testid="menu-freeze-frame-panel">
              {/* Symmetric exclusivity — a reversed clip cannot also have
                  freeze frames, so the freeze controls are disabled. */}
              {isOnFreezeFrame ? (
                <>
                  {/* Playhead sits inside an existing freeze — offer delete +
                      a duration slider for that freeze. */}
                  <div style={styles.keyframeRow}>
                    <button
                      type="button"
                      style={{
                        ...styles.keyframeBtn,
                        ...styles.destructive,
                        ...(reversed ? styles.keyframeBtnDisabled : {})
                      }}
                      data-testid="menu-freeze-frame-remove"
                      disabled={!!reversed}
                      onClick={() => {
                        if (reversed) return
                        onRemoveFreezeFrameAtPlayhead()
                      }}
                    >
                      프리즈 프레임 삭제
                    </button>
                  </div>
                  <div style={styles.transformRow}>
                    <span style={styles.transformLabel}>지속 시간</span>
                    <input
                      type="range"
                      min={MIN_FREEZE_MS}
                      max={MAX_FREEZE_MS}
                      step={1}
                      value={freezeDurationAtPlayhead}
                      onChange={(e) => {
                        if (reversed) return
                        const v = parseFloat(e.target.value)
                        if (!Number.isFinite(v)) return
                        onUpdateFreezeFrameAtPlayhead(v)
                      }}
                      style={styles.slider}
                      data-testid="freeze-frame-duration-slider"
                      aria-label="프리즈 프레임 지속 시간"
                      disabled={!!reversed}
                    />
                    <span style={{ ...styles.shortcut, width: 48 }}>
                      {(freezeDurationAtPlayhead / 1000).toFixed(2)}s
                    </span>
                  </div>
                </>
              ) : (
                <div style={styles.keyframeRow}>
                  <button
                    type="button"
                    style={{
                      ...styles.keyframeBtn,
                      ...(reversed ? styles.keyframeBtnDisabled : {})
                    }}
                    data-testid="menu-freeze-frame-add"
                    disabled={!!reversed}
                    onClick={() => {
                      if (reversed) return
                      onAddFreezeFrame()
                    }}
                  >
                    현재 위치에 프리즈 프레임 추가
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {/* Phase 3.30 — volume-envelope sub-menu is media-only. Modeled on the
          speed-curve block above. The envelope is a per-clip keyframed volume
          curve (manually duck music under a voiceover). When OFF the clip
          uses its constant gainDb; turning it ON seeds two keyframes at the
          current gain so the sound does not jump. */}
      {isMediaClip(clip) && onAddVolumeKeyframe && (
        <>
          <div style={styles.separator} />
          <div
            role="menuitem"
            data-testid="menu-volume-curve"
            style={styles.item}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
            onClick={() => setShowVolumeCurve((v) => !v)}
          >
            <span>볼륨 커브{showVolumeCurve ? '' : '…'}</span>
            <span
              style={styles.keyframeCountBadge}
              data-testid="volume-keyframe-count"
            >
              {volumeKeyframeCount ?? 0}
            </span>
          </div>
          {showVolumeCurve && (
            <div style={styles.speedPanel} data-testid="menu-volume-curve-panel">
              {/* On/off toggle — modeled on the speed-curve checkbox. ON seeds
                  the envelope (two keyframes) via addVolumeKeyframe; OFF drops
                  the envelope, keeping the constant gainDb. */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 8,
                  cursor: 'pointer',
                  fontSize: 11,
                  color: '#9aa0a6'
                }}
              >
                <input
                  type="checkbox"
                  checked={volumeCurveActive}
                  data-testid="volume-curve-toggle"
                  aria-label="볼륨 커브 사용"
                  onChange={(e) => {
                    if (e.target.checked) {
                      onAddVolumeKeyframe()
                    } else {
                      onClearVolumeEnvelope?.()
                    }
                  }}
                />
                <span>볼륨 커브 사용</span>
              </label>
              {/* Volume-curve controls — visible only when the envelope is on. */}
              {volumeCurveActive && (
                <>
                  <div style={styles.keyframeRow}>
                    <button
                      type="button"
                      style={styles.keyframeBtn}
                      data-testid="menu-volume-keyframe-add"
                      onClick={() => onAddVolumeKeyframe()}
                    >
                      {isOnVolumeKeyframe
                        ? '볼륨 키프레임 갱신'
                        : '현재 위치에 볼륨 키프레임 추가'}
                    </button>
                    <button
                      type="button"
                      style={{
                        ...styles.keyframeBtn,
                        ...(isOnVolumeKeyframe
                          ? {}
                          : styles.keyframeBtnDisabled)
                      }}
                      data-testid="menu-volume-keyframe-remove"
                      disabled={!isOnVolumeKeyframe}
                      onClick={() => {
                        if (!isOnVolumeKeyframe) return
                        onRemoveVolumeKeyframeAtPlayhead?.()
                      }}
                    >
                      키프레임 삭제
                    </button>
                  </div>
                  {/* Per-keyframe dB slider — edits the gain of the keyframe
                      under the playhead. Disabled when not on one. */}
                  <div style={styles.transformRow}>
                    <span style={styles.transformLabel}>키프레임 볼륨</span>
                    <input
                      type="range"
                      min={MIN_GAIN_DB}
                      max={MAX_GAIN_DB}
                      step={0.5}
                      value={volumeDbAtPlayhead ?? 0}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (!Number.isFinite(v)) return
                        onUpdateVolumeKeyframeAtPlayhead?.(v)
                      }}
                      style={styles.slider}
                      data-testid="volume-keyframe-db-slider"
                      aria-label="키프레임 볼륨"
                      disabled={!isOnVolumeKeyframe}
                    />
                    <span style={{ ...styles.shortcut, width: 48 }}>
                      {(volumeDbAtPlayhead ?? 0).toFixed(1)} dB
                    </span>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
