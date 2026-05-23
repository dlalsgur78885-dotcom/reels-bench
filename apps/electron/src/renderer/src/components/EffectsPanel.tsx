import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Clip,
  ClipHsl,
  ClipTransform,
  ColorAdjust,
  CropRect,
  FilterPreset,
  HslBandAdjust,
  HslBandKey,
  OverlayShadow,
  Project,
  TransitionKind
} from '../../../shared/project'
import {
  DEFAULT_OVERLAY_SHADOW,
  DEFAULT_RETOUCH,
  DEFAULT_TRANSITION_MS,
  FILTER_PRESETS,
  FILM_TONE_IDS,
  MIN_FILM_LOOK,
  MAX_FILM_LOOK,
  NEUTRAL_FILM_LOOK,
  getClipColorAdjust,
  getClipCropRect,
  getClipHsl,
  getClipMotionTracks,
  getClipRetouch,
  getFilmLook,
  getOverlayShadow,
  getTransformAt,
  hasTransformKeyframes,
  HSL_BAND_KEYS,
  IDENTITY_CROP,
  isMediaClip,
  isOverlayClip,
  MAX_CLIP_SPEED,
  MAX_COLOR_ADJUST,
  MAX_HSL_ADJUST,
  MAX_TRANSFORM_OFFSET,
  MAX_TRANSFORM_ROTATION,
  MAX_TRANSFORM_SCALE,
  MAX_TRANSITION_MS,
  MIN_CLIP_SPEED,
  MIN_COLOR_ADJUST,
  MIN_CROP_SIZE,
  MIN_HSL_ADJUST,
  MIN_KEYFRAME_GAP_MS,
  MIN_RETOUCH,
  MAX_OVERLAY_SHADOW_BLUR,
  MAX_OVERLAY_SHADOW_OFFSET,
  MAX_RETOUCH,
  MIN_TRANSFORM_OFFSET,
  MIN_TRANSFORM_ROTATION,
  MIN_TRANSFORM_SCALE,
  MIN_TRANSITION_MS,
  NEUTRAL_CLIP_HSL,
  NEUTRAL_COLOR_ADJUST,
  TRANSITION_KINDS
} from '../../../shared/project'
import {
  COLOR_ADJUST_LABELS,
  FILM_LOOK_PRESETS,
  FILM_TONE_LABELS,
  FILTER_PRESET_LABELS,
  HSL_BAND_LABELS,
  HSL_BAND_SWATCHES,
  TRANSITION_LABELS,
  filterPresetToCss
} from '../../../shared/filterPresets'
import { ZOOM_PRESETS } from '../../../shared/zoomPresets'
import { useProjectStore } from '../store/project'
import {
  computeAutoColorAdjust,
  computeColorMatchAdjust
} from '../lib/autoColorAnalysis'
import { CurveEditor } from './CurveEditor'
import { LayoutPanel } from './LayoutPanel'
import { AdjustmentLayerEditor } from './AdjustmentLayerEditor'
import { useTimelineUi } from '../store/timelineUi'

/**
 * Phase 7 — CapCut-style docked Effects panel.
 *
 * A right-docked panel (mirrors the CaptionEditor 360px slot) that surfaces the
 * SAME effect controls already available in ClipContextMenu, organized into
 * inner tabs the way CapCut's right-dock effect panel groups them.
 *
 * IMPORTANT: this panel introduces NO new effect logic. Every control calls the
 * exact same project-store action ClipContextMenu's handlers ultimately call
 * (see Timeline.tsx where ClipContextMenu is rendered). The keyframe redirect
 * for transform edits mirrors Timeline's `onTransformChange` redirect 1:1.
 *
 * Panel open/close + selected tab are transient UI state — they live here, not
 * in the project schema, and are not part of undo/redo.
 */

interface EffectsPanelProps {
  project: Project
  /**
   * Currently selected clip id (media or overlay). May be null when an
   * adjustment layer is selected instead (mutually exclusive selection) — in
   * that case the panel renders the adjustment-layer grade editor.
   */
  clipId: string | null
  /** Absolute playhead (ms) — drives keyframe gating for transform edits. */
  playheadMs: number
  onClose: () => void
}

type EffectTab =
  | 'transform'
  | 'speed'
  | 'animation'
  | 'adjust'
  | 'transition'
  | 'layout'

const TAB_LABELS: Record<EffectTab, string> = {
  transform: '변형',
  speed: '속도',
  animation: '애니메이션',
  adjust: '조정',
  transition: '전환',
  layout: '레이아웃'
}

const SPEED_PRESETS = [0.5, 1, 1.5, 2]

// Crop aspect presets — identical set to ClipContextMenu's CROP_PRESETS.
const CROP_PRESETS: ReadonlyArray<{ id: string; aspect: number | null }> = [
  { id: 'free', aspect: null },
  { id: '1:1', aspect: 1 },
  { id: '4:5', aspect: 4 / 5 },
  { id: '9:16', aspect: 9 / 16 },
  { id: '16:9', aspect: 16 / 9 }
]

/**
 * Compute a centered, maximum-area crop rect (source fractions) for a target
 * aspect ratio `aR` (W/H) within a source of aspect `srcAspect` (W/H).
 * Copied verbatim from ClipContextMenu so behaviour stays identical.
 */
function centeredCropForAspect(aR: number, srcAspect: number): CropRect {
  if (aR >= srcAspect) {
    const h = srcAspect / aR
    return { x: 0, y: (1 - h) / 2, w: 1, h }
  }
  const w = aR / srcAspect
  return { x: (1 - w) / 2, y: 0, w, h: 1 }
}

const styles = {
  panel: {
    width: 360,
    background: '#141414',
    borderLeft: '1px solid #2a2a2a',
    color: '#f5f5f5',
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'hidden'
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    borderBottom: '1px solid #2a2a2a'
  } as React.CSSProperties,
  title: { fontSize: 13, fontWeight: 600 } as React.CSSProperties,
  closeBtn: {
    background: 'transparent',
    color: '#9aa0a6',
    border: 'none',
    fontSize: 16,
    cursor: 'pointer',
    padding: 4,
    lineHeight: 1
  } as React.CSSProperties,
  tabBar: {
    flexShrink: 0,
    display: 'flex',
    gap: 2,
    padding: '6px 8px',
    borderBottom: '1px solid #2a2a2a',
    background: '#101010',
    flexWrap: 'wrap' as const
  } as React.CSSProperties,
  tabBtn: {
    flex: 1,
    minWidth: 56,
    background: '#1a1a1a',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '5px 6px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  tabBtnActive: {
    background: '#6366f1',
    color: '#fff',
    borderColor: '#6366f1'
  } as React.CSSProperties,
  body: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: 14,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12
  } as React.CSSProperties,
  sectionLabel: {
    fontSize: 11,
    color: '#9aa0a6',
    fontWeight: 600,
    margin: 0
  } as React.CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8
  } as React.CSSProperties,
  ctrlLabel: {
    width: 56,
    fontSize: 11,
    color: '#9aa0a6',
    flexShrink: 0
  } as React.CSSProperties,
  slider: { flex: 1 } as React.CSSProperties,
  numInput: {
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '3px 6px',
    fontSize: 11,
    width: 60,
    textAlign: 'right' as const
  } as React.CSSProperties,
  presetRow: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap' as const
  } as React.CSSProperties,
  preset: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '4px 9px',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  presetActive: {
    background: '#10b981',
    border: '1px solid #10b981',
    color: '#04231a',
    fontWeight: 600
  } as React.CSSProperties,
  resetBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '5px 10px',
    fontSize: 11,
    cursor: 'pointer',
    width: '100%'
  } as React.CSSProperties,
  keyframeBtn: {
    flex: 1,
    background: '#312e81',
    color: '#e0e7ff',
    border: '1px solid #6366f1',
    borderRadius: 4,
    padding: '6px 8px',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  keyframeBtnDisabled: {
    background: '#1f2937',
    color: '#475569',
    border: '1px solid #374151',
    cursor: 'not-allowed'
  } as React.CSSProperties,
  keyframeBadge: {
    flexShrink: 0,
    background: '#6366f1',
    color: '#f5f5f5',
    borderRadius: 999,
    padding: '2px 8px',
    fontSize: 10,
    fontWeight: 700,
    minWidth: 22,
    textAlign: 'center' as const
  } as React.CSSProperties,
  hint: { fontSize: 10, color: '#64748b', margin: 0 } as React.CSSProperties,
  empty: { padding: 16, color: '#94a3b8', fontSize: 12 } as React.CSSProperties,
  divider: {
    height: 1,
    background: '#2a2a2a',
    margin: '2px 0',
    border: 'none'
  } as React.CSSProperties,
  filterGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 6
  } as React.CSSProperties,
  filterCell: {
    background: '#1f2937',
    borderRadius: 4,
    padding: 4,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 2,
    fontSize: 10,
    color: '#f5f5f5'
  } as React.CSSProperties,
  filterSwatch: {
    width: '100%',
    height: 28,
    background: 'linear-gradient(120deg, #4b5563, #9ca3af 50%, #f59e0b)',
    borderRadius: 2
  } as React.CSSProperties,
  oosBox: {
    border: '1px dashed #374151',
    borderRadius: 6,
    padding: 10,
    background: '#0d0d0d'
  } as React.CSSProperties,
  oosItem: {
    fontSize: 11,
    color: '#475569',
    padding: '3px 0'
  } as React.CSSProperties
}

function findClip(project: Project, id: string): Clip | null {
  for (const t of project.tracks) {
    const c = t.clips.find((cc) => cc.id === id)
    if (c) return c
  }
  return null
}

export function EffectsPanel(props: EffectsPanelProps): JSX.Element {
  const { project, clipId, playheadMs, onClose } = props

  // Phase 3.32 — when an adjustment layer is selected (mutually exclusive
  // with clip selection), the panel shows the adjustment-layer grade editor
  // INSTEAD of the clip editor. Resolve the id here (hook called every render).
  const selectedAdjustmentLayerId = useTimelineUi(
    (s) => s.selectedAdjustmentLayerId
  )
  const adjustmentLayer =
    selectedAdjustmentLayerId != null
      ? (project.adjustmentLayers ?? []).find(
          (l) => l.id === selectedAdjustmentLayerId
        ) ?? null
      : null

  // --- Store actions: the EXACT same ones ClipContextMenu's handlers use. ---
  const setClipSpeed = useProjectStore((s) => s.setClipSpeed)
  const setClipTransitionIn = useProjectStore((s) => s.setClipTransitionIn)
  const setClipFilter = useProjectStore((s) => s.setClipFilter)
  const setClipTransform = useProjectStore((s) => s.setClipTransform)
  const resetClipTransform = useProjectStore((s) => s.resetClipTransform)
  const setClipCrop = useProjectStore((s) => s.setClipCrop)
  const resetClipCrop = useProjectStore((s) => s.resetClipCrop)
  const setClipColorAdjust = useProjectStore((s) => s.setClipColorAdjust)
  const resetClipColorAdjust = useProjectStore((s) => s.resetClipColorAdjust)
  const applyAutoColorAdjust = useProjectStore((s) => s.applyAutoColorAdjust)
  const setClipHslBand = useProjectStore((s) => s.setClipHslBand)
  const resetClipHsl = useProjectStore((s) => s.resetClipHsl)
  const setClipRetouch = useProjectStore((s) => s.setClipRetouch)
  const setClipFilmLook = useProjectStore((s) => s.setClipFilmLook)
  const addTransformKeyframe = useProjectStore((s) => s.addTransformKeyframe)
  // Phase 3.13 — overlay → motion-track binding.
  const bindOverlayToTrack = useProjectStore((s) => s.bindOverlayToTrack)
  const updateOverlay = useProjectStore((s) => s.updateOverlay)
  const updateTransformKeyframe = useProjectStore(
    (s) => s.updateTransformKeyframe
  )
  const removeTransformKeyframe = useProjectStore(
    (s) => s.removeTransformKeyframe
  )
  // Phase 3.31 — auto-zoom / punch-in presets.
  const applyZoomPreset = useProjectStore((s) => s.applyZoomPreset)

  const [tab, setTab] = useState<EffectTab>('transform')
  // HSL band selection — transient UI state (not in the project schema).
  const [hslBand, setHslBand] = useState<HslBandKey>('red')

  // Phase 3.15 — auto color correction: transient analysis status + an
  // AbortController so a clip change / unmount cancels an in-flight analysis
  // (prevents a stale write onto the wrong — or a gone — clip).
  const [autoColorStatus, setAutoColorStatus] = useState<
    'idle' | 'analyzing' | 'error'
  >('idle')
  const autoColorAbortRef = useRef<AbortController | null>(null)

  // Color match — transient (NOT schema) state: the chosen reference clip id,
  // the analysis status, and an AbortController so a clip change / unmount
  // cancels an in-flight match (prevents a stale write onto the wrong clip).
  const [colorMatchRefId, setColorMatchRefId] = useState<string>('')
  const [colorMatchStatus, setColorMatchStatus] = useState<
    'idle' | 'analyzing' | 'error'
  >('idle')
  const colorMatchAbortRef = useRef<AbortController | null>(null)
  // Always-current selected clip id — read inside the async auto-color
  // handler to detect a clip switch that happened mid-analysis.
  const clipIdRef = useRef<string>(clipId ?? '')
  clipIdRef.current = clipId ?? ''

  const clip = useMemo(
    () => (clipId ? findClip(project, clipId) : null),
    [project, clipId]
  )

  // Phase 3.15 — abort any in-flight auto-color analysis when the selected
  // clip changes or the panel unmounts, and reset the transient status so the
  // button never shows a stale "분석 중…" / error for a different clip.
  useEffect(() => {
    return (): void => {
      autoColorAbortRef.current?.abort()
      autoColorAbortRef.current = null
      colorMatchAbortRef.current?.abort()
      colorMatchAbortRef.current = null
    }
  }, [clipId])
  useEffect(() => {
    setAutoColorStatus('idle')
    setColorMatchStatus('idle')
    setColorMatchRefId('')
  }, [clipId])

  // Keyframe index under the playhead — mirrors Timeline's ctxKeyframeIndex.
  const keyframeIndex = useMemo<number>(() => {
    if (!clip || (!isMediaClip(clip) && !isOverlayClip(clip))) return -1
    const kfs = clip.transformKeyframes
    if (!kfs || kfs.length === 0) return -1
    const localMs = playheadMs - clip.startMs
    let bestIdx = -1
    let bestDist = MIN_KEYFRAME_GAP_MS
    for (let i = 0; i < kfs.length; i++) {
      const d = Math.abs(kfs[i].atMs - localMs)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    return bestIdx
  }, [clip, playheadMs])

  // Phase 3.32 — adjustment-layer grade editor takes priority. When a layer
  // is selected, render its grade editor INSTEAD of the clip editor (the
  // SAME color-adjust / curve / HSL / filter UI, wired to the layer actions).
  if (adjustmentLayer) {
    return (
      <div style={styles.panel} data-testid="effects-panel">
        <div style={styles.header}>
          <div style={styles.title}>효과 · 조정 레이어</div>
          <button
            style={styles.closeBtn}
            onClick={onClose}
            aria-label="닫기"
            data-testid="effects-panel-close"
          >
            ✕
          </button>
        </div>
        <div style={styles.body}>
          <AdjustmentLayerEditor layer={adjustmentLayer} />
        </div>
      </div>
    )
  }

  if (!clip || (!isMediaClip(clip) && !isOverlayClip(clip))) {
    return (
      <div style={styles.panel} data-testid="effects-panel">
        <div style={styles.header}>
          <div style={styles.title}>효과</div>
          <button
            style={styles.closeBtn}
            onClick={onClose}
            aria-label="닫기"
            data-testid="effects-panel-close"
          >
            ✕
          </button>
        </div>
        <div style={styles.empty} data-testid="effects-panel-empty">
          영상 또는 오버레이 클립을 선택하면 효과를 편집할 수 있어요.
        </div>
      </div>
    )
  }

  const isMedia = isMediaClip(clip)
  const isOverlay = isOverlayClip(clip)

  // --- Derived current values (same getters as ClipContextMenu). ---
  const transform: ClipTransform = getTransformAt(clip, playheadMs)
  const cropRect: CropRect = isMedia
    ? getClipCropRect(clip) ?? IDENTITY_CROP
    : IDENTITY_CROP
  const colorAdjust: ColorAdjust = isMedia
    ? getClipColorAdjust(clip) ?? NEUTRAL_COLOR_ADJUST
    : NEUTRAL_COLOR_ADJUST
  const hsl: ClipHsl = isMedia
    ? getClipHsl(clip) ?? NEUTRAL_CLIP_HSL
    : NEUTRAL_CLIP_HSL
  const hslBandAdjust: HslBandAdjust = hsl[hslBand]
  // Retouch / beauty — current strength (0 = off). Media clips only.
  const retouch = isMediaClip(clip) ? getClipRetouch(clip) ?? 0 : 0
  // Film look — resolved value (NEUTRAL when absent/neutral). Media clips only.
  const film = isMediaClip(clip)
    ? getFilmLook(clip) ?? NEUTRAL_FILM_LOOK
    : NEUTRAL_FILM_LOOK
  const speed = isMedia ? clip.speed ?? 1 : 1
  const transitionKind: TransitionKind = isMedia
    ? clip.transitionIn?.kind ?? 'none'
    : 'none'
  const transitionMs = isMedia
    ? clip.transitionIn?.durationMs ?? DEFAULT_TRANSITION_MS
    : DEFAULT_TRANSITION_MS
  const filterPreset: FilterPreset = isMedia ? clip.filterPreset ?? 'none' : 'none'
  const filterIntensity = isMedia ? clip.filterIntensity ?? 1 : 1
  const keyframeCount = clip.transformKeyframes?.length ?? 0
  const isOnKeyframe = keyframeIndex >= 0

  // Source aspect ratio for the crop presets.
  const srcAspect = ((): number => {
    if (isMedia) {
      const m = project.media[clip.mediaId]
      if (m && m.width > 0 && m.height > 0) return m.width / m.height
    }
    return 1
  })()

  /**
   * Transform edit — mirrors Timeline's `onTransformChange` redirect EXACTLY:
   *  - keyframe track + playhead on a keyframe → update that keyframe
   *  - keyframe track but not on a keyframe → insert one at the playhead
   *  - no keyframe track → static transform
   */
  const handleTransform = (partial: Partial<ClipTransform>): void => {
    if (hasTransformKeyframes(clip)) {
      if (keyframeIndex >= 0) {
        updateTransformKeyframe(clip.id, keyframeIndex, { transform: partial })
      } else {
        addTransformKeyframe(clip.id, playheadMs - clip.startMs, partial)
      }
    } else {
      setClipTransform(clip.id, partial)
    }
  }

  /**
   * Auto color correction — analyze the selected clip's media and replace the
   * 4-slider color adjustment in one shot. Guards against a stale write: the
   * clip id is captured in the closure and the result is only applied if that
   * clip is still selected (an AbortController also cancels on clip change).
   */
  const handleAutoColor = async (): Promise<void> => {
    if (!isMedia) return
    const media = project.media[clip.mediaId]
    if (!media || media.kind === 'audio') {
      setAutoColorStatus('error')
      return
    }
    // Cancel any prior in-flight analysis before starting a new one.
    autoColorAbortRef.current?.abort()
    const controller = new AbortController()
    autoColorAbortRef.current = controller
    const targetClipId = clip.id
    setAutoColorStatus('analyzing')
    try {
      const result = await computeAutoColorAdjust(clip, media.path, {
        signal: controller.signal
      })
      // Stale-write guard: only apply if this analysis is still the current
      // one AND its clip is still the selected clip.
      if (
        autoColorAbortRef.current === controller &&
        !controller.signal.aborted &&
        clipIdRef.current === targetClipId
      ) {
        applyAutoColorAdjust(targetClipId, result)
        setAutoColorStatus('idle')
      }
    } catch (err) {
      // An abort is expected on clip change / unmount — not an error to show.
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (autoColorAbortRef.current === controller) {
        setAutoColorStatus('error')
      }
    } finally {
      if (autoColorAbortRef.current === controller) {
        autoColorAbortRef.current = null
      }
    }
  }

  /**
   * Color match — analyze the selected clip AND a chosen reference clip, grade
   * the selected clip's color toward the reference, and replace the 4-slider
   * color adjustment in one shot. Structurally identical to `handleAutoColor`:
   * same stale-write guard (clip-id closure capture + AbortController + the
   * controller-identity check) so a mid-analysis clip switch is discarded.
   */
  const handleColorMatch = async (): Promise<void> => {
    if (!isMedia) return
    const media = project.media[clip.mediaId]
    if (!media || media.kind === 'audio') {
      setColorMatchStatus('error')
      return
    }
    const refClip = findClip(project, colorMatchRefId)
    if (!refClip || !isMediaClip(refClip)) {
      setColorMatchStatus('error')
      return
    }
    const refMedia = project.media[refClip.mediaId]
    if (!refMedia || refMedia.kind === 'audio') {
      setColorMatchStatus('error')
      return
    }
    // Cancel any prior in-flight match before starting a new one.
    colorMatchAbortRef.current?.abort()
    const controller = new AbortController()
    colorMatchAbortRef.current = controller
    const targetClipId = clip.id
    setColorMatchStatus('analyzing')
    try {
      const result = await computeColorMatchAdjust(
        clip,
        media.path,
        refClip,
        refMedia.path,
        { signal: controller.signal }
      )
      // Stale-write guard: only apply if this match is still the current one
      // AND its clip is still the selected clip.
      if (
        colorMatchAbortRef.current === controller &&
        !controller.signal.aborted &&
        clipIdRef.current === targetClipId
      ) {
        applyAutoColorAdjust(targetClipId, result)
        setColorMatchStatus('idle')
      }
    } catch (err) {
      // An abort is expected on clip change / unmount — not an error to show.
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (colorMatchAbortRef.current === controller) {
        setColorMatchStatus('error')
      }
    } finally {
      if (colorMatchAbortRef.current === controller) {
        colorMatchAbortRef.current = null
      }
    }
  }

  // Available tabs depend on the clip kind. Overlays have no speed/transition.
  // The 레이아웃 tab is always present (it works on the multi-selection, not
  // the single `clipId` this panel is anchored to).
  const tabs: EffectTab[] = isMedia
    ? ['transform', 'speed', 'animation', 'adjust', 'transition', 'layout']
    : ['transform', 'animation', 'layout']
  // Guard: if the current tab isn't valid for this clip, fall back.
  const activeTab: EffectTab = tabs.includes(tab) ? tab : 'transform'

  const sliderRow = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    testid: string,
    decimals = 2,
    parseInt10 = false,
    disabled = false
  ): JSX.Element => (
    <div style={styles.row}>
      <span style={styles.ctrlLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const v = parseInt10
            ? parseInt(e.target.value, 10)
            : parseFloat(e.target.value)
          if (!Number.isFinite(v)) return
          onChange(v)
        }}
        style={styles.slider}
        data-testid={`${testid}-slider`}
        aria-label={label}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={parseInt10 ? value : Number(value.toFixed(decimals))}
        disabled={disabled}
        onChange={(e) => {
          const v = parseInt10
            ? parseInt(e.target.value, 10)
            : parseFloat(e.target.value)
          if (!Number.isFinite(v)) return
          onChange(v)
        }}
        style={styles.numInput}
        data-testid={`${testid}-input`}
        aria-label={`${label} 숫자`}
      />
    </div>
  )

  return (
    <div
      style={styles.panel}
      data-testid="effects-panel"
      data-clip-kind={clip.kind}
    >
      <div style={styles.header}>
        <div style={styles.title}>효과 · {isMedia ? '영상' : '오버레이'}</div>
        <button
          style={styles.closeBtn}
          onClick={onClose}
          aria-label="닫기"
          data-testid="effects-panel-close"
        >
          ✕
        </button>
      </div>

      <div style={styles.tabBar} data-testid="effects-panel-tabs">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            style={{
              ...styles.tabBtn,
              ...(activeTab === t ? styles.tabBtnActive : {})
            }}
            onClick={() => setTab(t)}
            aria-pressed={activeTab === t}
            data-testid={`effects-tab-${t}`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div style={styles.body}>
        {/* ---------------- 변형 (transform) ---------------- */}
        {activeTab === 'transform' && (
          <div data-testid="effects-section-transform">
            <p style={styles.sectionLabel}>크기 · 회전 · 위치</p>
            <div style={{ height: 6 }} />
            {sliderRow(
              '크기',
              transform.scale,
              MIN_TRANSFORM_SCALE,
              MAX_TRANSFORM_SCALE,
              0.05,
              (v) => handleTransform({ scale: v }),
              'effects-transform-scale'
            )}
            {sliderRow(
              '회전',
              transform.rotation,
              MIN_TRANSFORM_ROTATION,
              MAX_TRANSFORM_ROTATION,
              1,
              (v) => handleTransform({ rotation: v }),
              'effects-transform-rotation',
              0
            )}
            {sliderRow(
              '불투명',
              transform.opacity,
              0,
              1,
              0.05,
              (v) => handleTransform({ opacity: v }),
              'effects-transform-opacity'
            )}
            {sliderRow(
              'X 위치',
              transform.x,
              MIN_TRANSFORM_OFFSET,
              MAX_TRANSFORM_OFFSET,
              0.01,
              (v) => handleTransform({ x: v }),
              'effects-transform-x'
            )}
            {sliderRow(
              'Y 위치',
              transform.y,
              MIN_TRANSFORM_OFFSET,
              MAX_TRANSFORM_OFFSET,
              0.01,
              (v) => handleTransform({ y: v }),
              'effects-transform-y'
            )}
            <div style={{ height: 8 }} />
            <button
              type="button"
              style={styles.resetBtn}
              onClick={() => resetClipTransform(clip.id)}
              data-testid="effects-transform-reset"
            >
              변형 초기화
            </button>
            {hasTransformKeyframes(clip) && (
              <p style={{ ...styles.hint, marginTop: 8 }}>
                키프레임 애니메이션 적용 중 — 슬라이더 조정은 재생헤드 위치의
                키프레임에 반영돼요. (애니메이션 탭 참고)
              </p>
            )}
            {/* Phase 3.13 — bind an overlay clip to a motion track. The
                bindable tracks live on the project's media clips. */}
            {isOverlay && (
              <div style={{ marginTop: 12 }} data-testid="effects-section-motion-track">
                <p style={styles.sectionLabel}>모션 트랙에 고정</p>
                <div style={{ height: 6 }} />
                <select
                  data-testid={`motion-track-bind-select-${clip.id}`}
                  value={isOverlayClip(clip) ? clip.motionTrackId ?? '' : ''}
                  onChange={(e) => {
                    const v = e.target.value
                    bindOverlayToTrack(clip.id, v === '' ? null : v)
                  }}
                  style={{
                    width: '100%',
                    background: '#0a0a0a',
                    color: '#f5f5f5',
                    border: '1px solid #2a2a2a',
                    borderRadius: 4,
                    padding: '4px 6px',
                    fontSize: 12
                  }}
                  aria-label="모션 트랙에 고정"
                >
                  <option value="">없음</option>
                  {project.tracks
                    .flatMap((t) =>
                      t.clips.flatMap((c) =>
                        isMediaClip(c) ? getClipMotionTracks(c) : []
                      )
                    )
                    .map((mt) => (
                      <option key={mt.id} value={mt.id}>
                        {mt.name}
                      </option>
                    ))}
                </select>
              </div>
            )}
            {/* Phase 3.36 — overlay drop shadow (image / sticker / shape).
                Mirrors the ClipContextMenu 그림자 control; persists via
                updateOverlay. Distinct `-fx` testids so both panels can mount. */}
            {isOverlay &&
              (() => {
                const shadow = isOverlayClip(clip)
                  ? getOverlayShadow(clip)
                  : null
                const base = shadow ?? DEFAULT_OVERLAY_SHADOW
                const setShadow = (next: OverlayShadow | null): void => {
                  updateOverlay(clip.id, { shadow: next ?? undefined })
                }
                return (
                  <div
                    style={{ marginTop: 12 }}
                    data-testid="effects-section-overlay-shadow"
                  >
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        cursor: 'pointer'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={shadow !== null}
                        data-testid="effects-overlay-shadow-toggle"
                        aria-label="그림자"
                        onChange={(e) =>
                          setShadow(
                            e.target.checked ? DEFAULT_OVERLAY_SHADOW : null
                          )
                        }
                      />
                      <span style={styles.sectionLabel}>그림자</span>
                    </label>
                    {shadow !== null && (
                      <div
                        style={{ marginTop: 6 }}
                        data-testid="effects-overlay-shadow-panel"
                      >
                        <div style={styles.row}>
                          <span style={styles.ctrlLabel}>색상</span>
                          <input
                            type="color"
                            value={base.color}
                            onChange={(e) =>
                              setShadow({ ...base, color: e.target.value })
                            }
                            data-testid="effects-overlay-shadow-color"
                            aria-label="그림자 색상"
                            style={{ flex: 1, height: 24, cursor: 'pointer' }}
                          />
                        </div>
                        {sliderRow(
                          'X 오프셋',
                          base.offsetX,
                          -MAX_OVERLAY_SHADOW_OFFSET,
                          MAX_OVERLAY_SHADOW_OFFSET,
                          1,
                          (v) => setShadow({ ...base, offsetX: v }),
                          'effects-overlay-shadow-offsetx',
                          0,
                          true
                        )}
                        {sliderRow(
                          'Y 오프셋',
                          base.offsetY,
                          -MAX_OVERLAY_SHADOW_OFFSET,
                          MAX_OVERLAY_SHADOW_OFFSET,
                          1,
                          (v) => setShadow({ ...base, offsetY: v }),
                          'effects-overlay-shadow-offsety',
                          0,
                          true
                        )}
                        {sliderRow(
                          '흐림',
                          base.blur,
                          0,
                          MAX_OVERLAY_SHADOW_BLUR,
                          1,
                          (v) => setShadow({ ...base, blur: v }),
                          'effects-overlay-shadow-blur',
                          0,
                          true
                        )}
                        {sliderRow(
                          '불투명도',
                          base.opacity,
                          0,
                          1,
                          0.05,
                          (v) => setShadow({ ...base, opacity: v }),
                          'effects-overlay-shadow-opacity'
                        )}
                      </div>
                    )}
                  </div>
                )
              })()}
          </div>
        )}

        {/* ---------------- 속도 (speed) ---------------- */}
        {activeTab === 'speed' && isMedia && (
          <div data-testid="effects-section-speed">
            <p style={styles.sectionLabel}>재생 속도</p>
            <div style={{ height: 6 }} />
            <div style={styles.presetRow}>
              {SPEED_PRESETS.map((p) => {
                const active = Math.abs(speed - p) < 0.001
                return (
                  <button
                    key={p}
                    type="button"
                    style={{
                      ...styles.preset,
                      ...(active ? styles.presetActive : {})
                    }}
                    onClick={() => setClipSpeed(clip.id, p)}
                    data-testid={`effects-speed-preset-${p}`}
                  >
                    {p}×
                  </button>
                )
              })}
            </div>
            <div style={{ height: 8 }} />
            {sliderRow(
              '속도',
              speed,
              MIN_CLIP_SPEED,
              MAX_CLIP_SPEED,
              0.05,
              (v) => setClipSpeed(clip.id, v),
              'effects-speed'
            )}
          </div>
        )}

        {/* ---------------- 애니메이션 (keyframes) ---------------- */}
        {activeTab === 'animation' && (
          <div data-testid="effects-section-animation">
            {/* Phase 3.31 — auto-zoom / punch-in presets. One click writes the
                clip's transform-keyframe track (replacing any prior one). */}
            <div data-testid="effects-section-zoom-presets">
              <p style={styles.sectionLabel}>오토 줌 프리셋</p>
              <div style={{ height: 6 }} />
              <div style={styles.presetRow}>
                {ZOOM_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    style={styles.preset}
                    title={preset.description}
                    onClick={() => applyZoomPreset(clip.id, preset.id)}
                    data-testid={`zoom-preset-${preset.id}`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              {hasTransformKeyframes(clip) && (
                <p style={{ ...styles.hint, marginTop: 6 }}>
                  프리셋을 적용하면 기존 키프레임이 대체돼요.
                </p>
              )}
            </div>
            <hr style={styles.divider} />
            <p style={styles.sectionLabel}>변형 키프레임</p>
            <div style={{ height: 6 }} />
            <div style={styles.row}>
              <button
                type="button"
                style={styles.keyframeBtn}
                onClick={() =>
                  addTransformKeyframe(clip.id, playheadMs - clip.startMs)
                }
                data-testid="effects-add-keyframe"
              >
                {isOnKeyframe ? '키프레임 갱신' : '현재 위치에 키프레임 추가'}
              </button>
              <button
                type="button"
                style={{
                  ...styles.keyframeBtn,
                  ...(isOnKeyframe ? {} : styles.keyframeBtnDisabled)
                }}
                disabled={!isOnKeyframe}
                onClick={() => {
                  if (keyframeIndex >= 0) {
                    removeTransformKeyframe(clip.id, keyframeIndex)
                  }
                }}
                data-testid="effects-remove-keyframe"
              >
                키프레임 삭제
              </button>
              <span
                style={styles.keyframeBadge}
                data-testid="effects-keyframe-count"
              >
                {keyframeCount}
              </span>
            </div>
            <p style={{ ...styles.hint, marginTop: 8 }}>
              재생헤드를 옮긴 뒤 변형 탭의 슬라이더를 조정하면 그 지점에
              키프레임이 생겨 자연스럽게 보간돼요.
            </p>
          </div>
        )}

        {/* ---------------- 조정 (filter + color + crop) ---------------- */}
        {activeTab === 'adjust' && isMedia && (
          <div data-testid="effects-section-adjust">
            {/* Filter preset */}
            <p style={styles.sectionLabel}>필터</p>
            <div style={{ height: 6 }} />
            <div style={styles.filterGrid}>
              {FILTER_PRESETS.map((p) => {
                const active = filterPreset === p
                const css = filterPresetToCss(p, filterIntensity) || 'none'
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setClipFilter(clip.id, p, filterIntensity)}
                    data-testid={`effects-filter-preset-${p}`}
                    style={{
                      ...styles.filterCell,
                      border: active
                        ? '2px solid #10b981'
                        : '1px solid #374151'
                    }}
                  >
                    <div
                      aria-hidden
                      style={{
                        ...styles.filterSwatch,
                        filter: css === 'none' ? '' : css
                      }}
                    />
                    <div>{FILTER_PRESET_LABELS[p] ?? p}</div>
                  </button>
                )
              })}
            </div>
            <div style={{ height: 8 }} />
            <div style={styles.row}>
              <span style={styles.ctrlLabel}>강도</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(filterIntensity * 100)}
                onChange={(e) =>
                  setClipFilter(
                    clip.id,
                    filterPreset,
                    Math.max(0, Math.min(1, parseInt(e.target.value, 10) / 100))
                  )
                }
                style={styles.slider}
                data-testid="effects-filter-intensity-slider"
                aria-label="필터 강도"
                disabled={filterPreset === 'none'}
              />
              <span style={{ ...styles.hint, width: 36 }}>
                {Math.round(filterIntensity * 100)}%
              </span>
            </div>

            <hr style={styles.divider} />

            {/* Color adjust */}
            <p style={styles.sectionLabel}>색 보정</p>
            <div style={{ height: 6 }} />
            {/* Auto color correction (Phase 3.15) — one-tap analyze + fill. */}
            <button
              type="button"
              style={{
                ...styles.resetBtn,
                ...(autoColorStatus === 'analyzing'
                  ? styles.keyframeBtnDisabled
                  : null)
              }}
              onClick={() => {
                void handleAutoColor()
              }}
              disabled={autoColorStatus === 'analyzing'}
              data-testid="effects-coloradjust-auto"
            >
              {autoColorStatus === 'analyzing' ? '분석 중…' : '자동 보정'}
            </button>
            {autoColorStatus === 'error' && (
              <p
                style={{ ...styles.hint, marginTop: 4 }}
                data-testid="effects-coloradjust-auto-error"
              >
                자동 보정에 실패했어요.
              </p>
            )}
            {/* Color match — pick a reference clip and grade toward it. */}
            <div style={{ height: 6 }} />
            <select
              data-testid="effects-coloradjust-match-ref"
              value={colorMatchRefId}
              onChange={(e) => setColorMatchRefId(e.target.value)}
              disabled={colorMatchStatus === 'analyzing'}
              style={{
                width: '100%',
                background: '#0a0a0a',
                color: '#f5f5f5',
                border: '1px solid #2a2a2a',
                borderRadius: 4,
                padding: '4px 6px',
                fontSize: 12
              }}
              aria-label="참조 클립"
            >
              <option value="">참조 클립 선택…</option>
              {project.tracks
                .flatMap((t) => t.clips)
                .filter(
                  (c) =>
                    isMediaClip(c) &&
                    c.id !== clip.id &&
                    project.media[c.mediaId]?.kind !== 'audio'
                )
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {isMediaClip(c)
                      ? project.media[c.mediaId]?.fileName ?? c.id
                      : c.id}
                  </option>
                ))}
            </select>
            <div style={{ height: 6 }} />
            <button
              type="button"
              style={{
                ...styles.resetBtn,
                ...(colorMatchStatus === 'analyzing'
                  ? styles.keyframeBtnDisabled
                  : null)
              }}
              onClick={() => {
                void handleColorMatch()
              }}
              disabled={colorMatchStatus === 'analyzing' || colorMatchRefId === ''}
              data-testid="effects-coloradjust-match"
            >
              {colorMatchStatus === 'analyzing' ? '매칭 중…' : '컬러 매치'}
            </button>
            {colorMatchStatus === 'error' && (
              <p
                style={{ ...styles.hint, marginTop: 4 }}
                data-testid="effects-coloradjust-match-error"
              >
                컬러 매치에 실패했어요.
              </p>
            )}
            <div style={{ height: 8 }} />
            {(
              ['brightness', 'contrast', 'saturation', 'temperature'] as const
            ).map((k) =>
              sliderRow(
                COLOR_ADJUST_LABELS[k],
                colorAdjust[k],
                MIN_COLOR_ADJUST,
                MAX_COLOR_ADJUST,
                1,
                (v) => setClipColorAdjust(clip.id, { [k]: v }),
                `effects-coloradjust-${k}`,
                0,
                true
              )
            )}
            <div style={{ height: 8 }} />
            <button
              type="button"
              style={styles.resetBtn}
              onClick={() => resetClipColorAdjust(clip.id)}
              data-testid="effects-coloradjust-reset"
            >
              색 보정 초기화
            </button>

            <hr style={styles.divider} />

            {/* Tone curves (Phase 3.12) */}
            <p style={styles.sectionLabel}>곡선</p>
            <div style={{ height: 6 }} />
            <div data-testid="effects-section-curves">
              <CurveEditor clipId={clip.id} />
            </div>

            <hr style={styles.divider} />

            {/* HSL secondary grading (Phase 3.12) */}
            <p style={styles.sectionLabel}>HSL</p>
            <div style={{ height: 6 }} />
            <div data-testid="hsl-panel">
              {/* Band selector — 6 color swatches, one active. */}
              <div style={styles.presetRow}>
                {HSL_BAND_KEYS.map((b) => {
                  const active = hslBand === b
                  return (
                    <button
                      key={b}
                      type="button"
                      data-testid={`hsl-band-${b}`}
                      aria-pressed={active}
                      onClick={() => setHslBand(b)}
                      title={HSL_BAND_LABELS[b]}
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 6,
                        background: HSL_BAND_SWATCHES[b],
                        border: active
                          ? '2px solid #f5f5f5'
                          : '1px solid #374151',
                        cursor: 'pointer',
                        padding: 0
                      }}
                    />
                  )
                })}
              </div>
              <div style={{ height: 8 }} />
              {(['hue', 'saturation', 'luminance'] as const).map((field) => {
                const label =
                  field === 'hue'
                    ? '색상'
                    : field === 'saturation'
                      ? '채도'
                      : '광도'
                return (
                  <div key={field} data-testid={`hsl-slider-${field}`}>
                    {sliderRow(
                      label,
                      hslBandAdjust[field],
                      MIN_HSL_ADJUST,
                      MAX_HSL_ADJUST,
                      1,
                      (v) => setClipHslBand(clip.id, hslBand, { [field]: v }),
                      `hsl-slider-${field}`,
                      0,
                      true
                    )}
                  </div>
                )
              })}
              <p style={{ ...styles.hint, marginTop: 6 }}>
                미리보기는 근사값입니다 — 정확한 색은 내보내기 결과를
                확인하세요.
              </p>
              <div style={{ height: 8 }} />
              <button
                type="button"
                style={styles.resetBtn}
                onClick={() => resetClipHsl(clip.id)}
                data-testid="hsl-reset"
              >
                HSL 초기화
              </button>
            </div>

            {/* 리터치 / 뷰티 — edge-preserving skin smoothing. VIDEO clips
                only (hidden for audio-kind media). EXPORT-accurate; the
                preview only approximates with a tiny CSS blur. */}
            {isMediaClip(clip) &&
              project.media[clip.mediaId]?.kind !== 'audio' && (
                <div data-testid="effects-section-retouch">
                  <hr style={styles.divider} />
                  <p style={styles.sectionLabel}>리터치 / 뷰티</p>
                  <div style={{ height: 6 }} />
                  {/* On/off toggle — ON applies DEFAULT_RETOUCH. */}
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 11,
                      color: '#9aa0a6',
                      marginBottom: 8
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={retouch > 0}
                      data-testid="retouch-toggle"
                      aria-label="리터치 / 뷰티"
                      onChange={(e) => {
                        setClipRetouch(
                          clip.id,
                          e.target.checked ? DEFAULT_RETOUCH : 0
                        )
                      }}
                    />
                    <span>리터치 / 뷰티</span>
                  </label>
                  <div style={{ opacity: retouch > 0 ? 1 : 0.5 }}>
                    {sliderRow(
                      '강도',
                      retouch,
                      MIN_RETOUCH,
                      MAX_RETOUCH,
                      1,
                      (v) => setClipRetouch(clip.id, v),
                      'effects-retouch',
                      0,
                      true,
                      retouch <= 0
                    )}
                  </div>
                  <p style={{ ...styles.hint, marginTop: 6 }}>
                    내보내기 시 적용 — 미리보기는 근사값입니다.
                  </p>
                </div>
              )}

            {/* 필름 룩 — vignette / grain / faded tone finishing filter.
                VIDEO clips only (hidden for audio-kind media), mirroring the
                retouch section gate. Tone + vignette preview live; grain is
                export-only. */}
            {isMediaClip(clip) &&
              project.media[clip.mediaId]?.kind !== 'audio' && (
                <div data-testid="effects-section-filmlook">
                  <hr style={styles.divider} />
                  <p style={styles.sectionLabel}>필름 룩</p>
                  <div style={{ height: 6 }} />
                  {/* One-click presets */}
                  <div style={styles.presetRow}>
                    {FILM_LOOK_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        style={styles.preset}
                        data-testid={`filmlook-preset-${p.id}`}
                        onClick={() => setClipFilmLook(clip.id, p.value)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ height: 8 }} />
                  {/* Tone dropdown */}
                  <div style={styles.row}>
                    <span style={styles.ctrlLabel}>톤</span>
                    <select
                      data-testid="filmlook-tone"
                      value={film.toneId}
                      onChange={(e) =>
                        setClipFilmLook(clip.id, {
                          toneId: e.target.value as (typeof FILM_TONE_IDS)[number]
                        })
                      }
                      style={{
                        flex: 1,
                        background: '#0a0a0a',
                        color: '#f5f5f5',
                        border: '1px solid #2a2a2a',
                        borderRadius: 4,
                        padding: '4px 6px',
                        fontSize: 12
                      }}
                      aria-label="필름 톤"
                    >
                      {FILM_TONE_IDS.map((t) => (
                        <option key={t} value={t}>
                          {FILM_TONE_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={{ height: 6 }} />
                  {/* Vignette strength */}
                  {sliderRow(
                    '비네트',
                    film.vignette,
                    MIN_FILM_LOOK,
                    MAX_FILM_LOOK,
                    1,
                    (v) => setClipFilmLook(clip.id, { vignette: v }),
                    'effects-filmlook-vignette',
                    0,
                    true
                  )}
                  {/* Grain strength */}
                  {sliderRow(
                    '그레인',
                    film.grain,
                    MIN_FILM_LOOK,
                    MAX_FILM_LOOK,
                    1,
                    (v) => setClipFilmLook(clip.id, { grain: v }),
                    'effects-filmlook-grain',
                    0,
                    true
                  )}
                  <p style={{ ...styles.hint, marginTop: 6 }}>
                    그레인은 내보내기 시 적용됩니다 — 미리보기는 톤·비네트만
                    표시합니다.
                  </p>
                </div>
              )}

            <hr style={styles.divider} />

            {/* Crop */}
            <p style={styles.sectionLabel}>크롭</p>
            <div style={{ height: 6 }} />
            <div style={styles.presetRow}>
              {CROP_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  style={styles.preset}
                  data-testid={`effects-crop-preset-${p.id}`}
                  onClick={() => {
                    if (p.aspect === null) return
                    setClipCrop(
                      clip.id,
                      centeredCropForAspect(p.aspect, srcAspect)
                    )
                  }}
                >
                  {p.id === 'free' ? '자유' : p.id}
                </button>
              ))}
            </div>
            <div style={{ height: 8 }} />
            {sliderRow(
              'X',
              cropRect.x,
              0,
              1,
              0.01,
              (v) => setClipCrop(clip.id, { x: v }),
              'effects-crop-x'
            )}
            {sliderRow(
              'Y',
              cropRect.y,
              0,
              1,
              0.01,
              (v) => setClipCrop(clip.id, { y: v }),
              'effects-crop-y'
            )}
            {sliderRow(
              '너비',
              cropRect.w,
              MIN_CROP_SIZE,
              1,
              0.01,
              (v) => setClipCrop(clip.id, { w: v }),
              'effects-crop-w'
            )}
            {sliderRow(
              '높이',
              cropRect.h,
              MIN_CROP_SIZE,
              1,
              0.01,
              (v) => setClipCrop(clip.id, { h: v }),
              'effects-crop-h'
            )}
            <div style={{ height: 8 }} />
            <button
              type="button"
              style={styles.resetBtn}
              onClick={() => resetClipCrop(clip.id)}
              data-testid="effects-crop-reset"
            >
              크롭 초기화
            </button>

            {/* Out-of-scope effects — surfaced as disabled placeholders so the
                panel mirrors CapCut's category list without faking features
                that need ML/CV models. */}
            <hr style={styles.divider} />
            <p style={styles.sectionLabel}>고급 (준비 중)</p>
            <div style={{ height: 6 }} />
            <div style={styles.oosBox} data-testid="effects-oos-placeholders">
              {[
                '배경 제거',
                '마스크',
                '손떨림 보정',
                'AI 스타일',
                '품질 보정'
              ].map((name) => (
                <div key={name} style={styles.oosItem}>
                  • {name} — 추후 지원 예정
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ---------------- 전환 (transition) ---------------- */}
        {activeTab === 'transition' && isMedia && (
          <div data-testid="effects-section-transition">
            <p style={styles.sectionLabel}>시작 전환 효과</p>
            <div style={{ height: 6 }} />
            <div style={styles.presetRow}>
              {TRANSITION_KINDS.map((k) => {
                const active = transitionKind === k
                return (
                  <button
                    key={k}
                    type="button"
                    style={{
                      ...styles.preset,
                      ...(active ? styles.presetActive : {})
                    }}
                    data-testid={`effects-transition-preset-${k}`}
                    onClick={() => setClipTransitionIn(clip.id, k, transitionMs)}
                  >
                    {TRANSITION_LABELS[k] ?? k}
                  </button>
                )
              })}
            </div>
            <div style={{ height: 8 }} />
            <div style={styles.row}>
              <span style={styles.ctrlLabel}>길이</span>
              <input
                type="range"
                min={MIN_TRANSITION_MS}
                max={MAX_TRANSITION_MS}
                step={50}
                value={transitionMs}
                onChange={(e) =>
                  setClipTransitionIn(
                    clip.id,
                    transitionKind,
                    parseInt(e.target.value, 10) || DEFAULT_TRANSITION_MS
                  )
                }
                style={styles.slider}
                data-testid="effects-transition-slider"
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
                  setClipTransitionIn(clip.id, transitionKind, v)
                }}
                style={styles.numInput}
                data-testid="effects-transition-input"
                aria-label="전환 길이(ms)"
                disabled={transitionKind === 'none'}
              />
            </div>
          </div>
        )}

        {/* ---------------- 레이아웃 (collage / split-screen) ---------------- */}
        {activeTab === 'layout' && (
          <div data-testid="effects-section-layout">
            <LayoutPanel />
          </div>
        )}

        {/* Overlay clips: no media-only tabs — show a hint when one is picked
            while a media-only tab somehow stays active (defensive). */}
        {isOverlay &&
          activeTab !== 'transform' &&
          activeTab !== 'animation' &&
          activeTab !== 'layout' && (
            <div style={styles.empty}>
              이 효과는 영상 클립에서만 사용할 수 있어요.
            </div>
          )}
      </div>
    </div>
  )
}
