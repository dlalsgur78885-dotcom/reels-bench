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
  Project,
  TransitionKind
} from '../../../shared/project'
import {
  DEFAULT_TRANSITION_MS,
  FILTER_PRESETS,
  getClipColorAdjust,
  getClipCropRect,
  getClipHsl,
  getClipMotionTracks,
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
  FILTER_PRESET_LABELS,
  HSL_BAND_LABELS,
  HSL_BAND_SWATCHES,
  TRANSITION_LABELS,
  filterPresetToCss
} from '../../../shared/filterPresets'
import { useProjectStore } from '../store/project'
import { computeAutoColorAdjust } from '../lib/autoColorAnalysis'
import { CurveEditor } from './CurveEditor'

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
  /** Currently selected clip id (media or overlay). */
  clipId: string
  /** Absolute playhead (ms) — drives keyframe gating for transform edits. */
  playheadMs: number
  onClose: () => void
}

type EffectTab = 'transform' | 'speed' | 'animation' | 'adjust' | 'transition'

const TAB_LABELS: Record<EffectTab, string> = {
  transform: '변형',
  speed: '속도',
  animation: '애니메이션',
  adjust: '조정',
  transition: '전환'
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
  const addTransformKeyframe = useProjectStore((s) => s.addTransformKeyframe)
  // Phase 3.13 — overlay → motion-track binding.
  const bindOverlayToTrack = useProjectStore((s) => s.bindOverlayToTrack)
  const updateTransformKeyframe = useProjectStore(
    (s) => s.updateTransformKeyframe
  )
  const removeTransformKeyframe = useProjectStore(
    (s) => s.removeTransformKeyframe
  )

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
  // Always-current selected clip id — read inside the async auto-color
  // handler to detect a clip switch that happened mid-analysis.
  const clipIdRef = useRef<string>(clipId)
  clipIdRef.current = clipId

  const clip = useMemo(() => findClip(project, clipId), [project, clipId])

  // Phase 3.15 — abort any in-flight auto-color analysis when the selected
  // clip changes or the panel unmounts, and reset the transient status so the
  // button never shows a stale "분석 중…" / error for a different clip.
  useEffect(() => {
    return (): void => {
      autoColorAbortRef.current?.abort()
      autoColorAbortRef.current = null
    }
  }, [clipId])
  useEffect(() => {
    setAutoColorStatus('idle')
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

  // Available tabs depend on the clip kind. Overlays have no speed/transition.
  const tabs: EffectTab[] = isMedia
    ? ['transform', 'speed', 'animation', 'adjust', 'transition']
    : ['transform', 'animation']
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
    parseInt10 = false
  ): JSX.Element => (
    <div style={styles.row}>
      <span style={styles.ctrlLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
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

        {/* Overlay clips: no media-only tabs — show a hint when one is picked
            while a media-only tab somehow stays active (defensive). */}
        {isOverlay && activeTab !== 'transform' && activeTab !== 'animation' && (
          <div style={styles.empty}>
            이 효과는 영상 클립에서만 사용할 수 있어요.
          </div>
        )}
      </div>
    </div>
  )
}
