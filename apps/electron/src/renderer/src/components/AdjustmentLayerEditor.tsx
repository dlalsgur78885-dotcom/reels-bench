import { useMemo, useState } from 'react'
import type {
  AdjustmentLayer,
  ClipHsl,
  ClipTransform,
  ColorAdjust,
  EasingKind,
  FilterPreset,
  HslBandAdjust,
  HslBandKey
} from '../../../shared/project'
import {
  EASING_KINDS,
  EASING_LABELS,
  FILTER_PRESETS,
  getAdjustmentLayerTransform,
  getAdjustmentLayerTransformAt,
  hasAdjustmentLayerTransformKeyframes,
  HSL_BAND_KEYS,
  MAX_COLOR_ADJUST,
  MAX_HSL_ADJUST,
  MAX_TRANSFORM_OFFSET,
  MAX_TRANSFORM_ROTATION,
  MAX_TRANSFORM_SCALE,
  MIN_KEYFRAME_GAP_MS,
  MIN_TRANSFORM_OFFSET,
  MIN_TRANSFORM_ROTATION,
  MIN_TRANSFORM_SCALE,
  MIN_COLOR_ADJUST,
  MIN_HSL_ADJUST,
  NEUTRAL_CLIP_HSL,
  NEUTRAL_COLOR_ADJUST,
  resolveClipHsl,
  resolveColorAdjust
} from '../../../shared/project'
import {
  COLOR_ADJUST_LABELS,
  FILTER_PRESET_LABELS,
  HSL_BAND_LABELS,
  HSL_BAND_SWATCHES,
  filterPresetToCss
} from '../../../shared/filterPresets'
import { useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import { CurveEditor } from './CurveEditor'

/**
 * Phase 3.32 — the grade editor for a selected adjustment layer.
 *
 * Renders the SAME color-adjust sliders + tone-curve editor + HSL UI + filter-
 * preset picker the per-clip 조정 tab uses, but every control is wired to the
 * `setAdjustmentLayer*` store actions (instead of the per-clip grade actions).
 * Rendered by `EffectsPanel` when `selectedAdjustmentLayerId` resolves.
 *
 * Introduces NO new grade logic — it reuses the shared payload helpers and the
 * generalized `CurveEditor` (mode='adjustmentLayer').
 */

interface AdjustmentLayerEditorProps {
  /** The adjustment layer being edited (resolved by EffectsPanel). */
  layer: AdjustmentLayer
}

const styles = {
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
  slider: { flex: 1, minWidth: 0 } as React.CSSProperties,
  numInput: {
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '3px 6px',
    fontSize: 11,
    width: 60,
    flexShrink: 0,
    textAlign: 'right' as const
  } as React.CSSProperties,
  hint: { fontSize: 10, color: '#64748b', margin: 0 } as React.CSSProperties,
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
  presetRow: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap' as const
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
  kfBtn: {
    flex: 1,
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '5px 8px',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  kfBtnDisabled: {
    color: '#475569',
    cursor: 'not-allowed'
  } as React.CSSProperties,
  kfBadge: {
    minWidth: 22,
    textAlign: 'center' as const,
    fontSize: 11,
    color: '#c4b5fd',
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '3px 6px'
  } as React.CSSProperties,
  deleteBtn: {
    background: '#7f1d1d',
    color: '#fecaca',
    border: '1px solid #b91c1c',
    borderRadius: 4,
    padding: '7px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    width: '100%'
  } as React.CSSProperties,
  meta: {
    fontSize: 11,
    color: '#c4b5fd',
    margin: 0
  } as React.CSSProperties,
  // pptx12 슬라이드 18 — 일반 EffectsPanel 과 동일한 6탭 바.
  tabBar: {
    display: 'flex',
    gap: 2,
    margin: '8px 0 4px',
    flexWrap: 'wrap' as const
  } as React.CSSProperties,
  tabBtn: {
    flex: 1,
    minWidth: 48,
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
  emptyHint: {
    padding: '24px 12px',
    fontSize: 11,
    color: '#94a3b8',
    background: '#111',
    border: '1px dashed #2a2a2a',
    borderRadius: 6,
    lineHeight: 1.6,
    margin: '8px 0'
  } as React.CSSProperties
}

// pptx12 슬라이드 18 — 일반 효과 패널과 동일 6탭 라벨.
type AdjTab = 'transform' | 'speed' | 'animation' | 'adjust' | 'transition' | 'layout'
const ADJ_TAB_LABELS: Record<AdjTab, string> = {
  transform: '변형',
  speed: '속도',
  animation: '애니메이션',
  adjust: '조정',
  transition: '전환',
  layout: '레이아웃'
}
const ADJ_TABS: AdjTab[] = [
  'transform',
  'speed',
  'animation',
  'adjust',
  'transition',
  'layout'
]

export function AdjustmentLayerEditor(
  props: AdjustmentLayerEditorProps
): JSX.Element {
  const { layer } = props

  // --- Adjustment-layer grade actions (mirror the per-clip grade actions). ---
  const setAdjustmentLayerColorAdjust = useProjectStore(
    (s) => s.setAdjustmentLayerColorAdjust
  )
  const setAdjustmentLayerHslBand = useProjectStore(
    (s) => s.setAdjustmentLayerHslBand
  )
  const setAdjustmentLayerFilterPreset = useProjectStore(
    (s) => s.setAdjustmentLayerFilterPreset
  )
  const setAdjustmentLayerFade = useProjectStore(
    (s) => s.setAdjustmentLayerFade
  )
  const setAdjustmentLayerTransform = useProjectStore(
    (s) => s.setAdjustmentLayerTransform
  )
  const resetAdjustmentLayerTransform = useProjectStore(
    (s) => s.resetAdjustmentLayerTransform
  )
  const addAdjustmentLayerTransformKeyframe = useProjectStore(
    (s) => s.addAdjustmentLayerTransformKeyframe
  )
  const updateAdjustmentLayerTransformKeyframe = useProjectStore(
    (s) => s.updateAdjustmentLayerTransformKeyframe
  )
  const removeAdjustmentLayerTransformKeyframe = useProjectStore(
    (s) => s.removeAdjustmentLayerTransformKeyframe
  )
  const clearAdjustmentLayerTransformKeyframes = useProjectStore(
    (s) => s.clearAdjustmentLayerTransformKeyframes
  )
  const removeAdjustmentLayer = useProjectStore((s) => s.removeAdjustmentLayer)
  const setSelectedAdjustmentLayerId = useTimelineUi(
    (s) => s.setSelectedAdjustmentLayerId
  )
  const playheadMs = useTimelineUi((s) => s.playheadMs)
  const setPlayheadMs = useTimelineUi((s) => s.setPlayheadMs)

  // HSL band selection — transient UI state (not in the project schema).
  const [hslBand, setHslBand] = useState<HslBandKey>('red')
  // pptx12 슬라이드 18 — 6탭 활성. 기본은 가장 자주 쓰는 '조정'.
  const [activeTab, setActiveTab] = useState<AdjTab>('adjust')

  // --- Derived current values (resolved via the shared payload helpers). ---
  const colorAdjust: ColorAdjust =
    resolveColorAdjust(layer.colorAdjust) ?? NEUTRAL_COLOR_ADJUST
  const hsl: ClipHsl = resolveClipHsl(layer.hsl) ?? NEUTRAL_CLIP_HSL
  const hslBandAdjust: HslBandAdjust = hsl[hslBand]
  const filterPreset: FilterPreset = layer.filterPreset ?? 'none'
  const filterIntensity = layer.filterIntensity ?? 1
  // Effective transform at the playhead — interpolated when a keyframe track
  // is active, otherwise the static layer transform.
  const transform: ClipTransform = getAdjustmentLayerTransformAt(
    layer,
    playheadMs
  )
  const hasKeyframes = hasAdjustmentLayerTransformKeyframes(layer)
  const keyframeCount = layer.transformKeyframes?.length ?? 0

  // Index of the keyframe under the playhead (within ±MIN_KEYFRAME_GAP_MS), or -1.
  const keyframeIndex = useMemo<number>(() => {
    const kfs = layer.transformKeyframes
    if (!kfs || kfs.length === 0) return -1
    const localMs = playheadMs - layer.startMs
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
  }, [layer, playheadMs])
  const isOnKeyframe = keyframeIndex >= 0

  // Slider drag: route to the keyframe track when one is active (update the kf
  // under the playhead, else insert one), otherwise edit the static transform.
  const handleTransform = (partial: Partial<ClipTransform>): void => {
    if (hasKeyframes) {
      if (keyframeIndex >= 0) {
        updateAdjustmentLayerTransformKeyframe(layer.id, keyframeIndex, {
          transform: partial
        })
      } else {
        addAdjustmentLayerTransformKeyframe(
          layer.id,
          playheadMs - layer.startMs,
          partial
        )
      }
    } else {
      setAdjustmentLayerTransform(layer.id, partial)
    }
  }

  // ◇ diamond click: seed/insert a keyframe for this property at the playhead.
  const handleAddKeyframe = (partial: Partial<ClipTransform>): void => {
    if (hasKeyframes && keyframeIndex >= 0) {
      updateAdjustmentLayerTransformKeyframe(layer.id, keyframeIndex, {
        transform: partial
      })
      return
    }
    addAdjustmentLayerTransformKeyframe(
      layer.id,
      playheadMs - layer.startMs,
      partial
    )
  }

  /**
   * Float slider + number input + optional ◇ keyframe button — mirrors the
   * per-clip transform tab (EffectsPanel) so adjustment layers get the SAME
   * keyframe UX (릴스벤치14 슬라이드 6).
   */
  const transformSliderRow = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    testid: string,
    decimals: number,
    keyframe: { active: boolean; onAdd: () => void; testid: string }
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
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onChange(v)
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
        value={Number(value.toFixed(decimals))}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
        style={styles.numInput}
        data-testid={`${testid}-input`}
        aria-label={`${label} 숫자`}
      />
      <button
        type="button"
        onClick={keyframe.onAdd}
        data-testid={keyframe.testid}
        data-kf-active={keyframe.active ? 'true' : 'false'}
        title={
          keyframe.active
            ? '현재 위치에 키프레임 있음 (클릭 시 갱신)'
            : '현재 위치에 키프레임 추가'
        }
        aria-label={`${label} 키프레임 추가`}
        aria-pressed={keyframe.active}
        style={{
          width: 24,
          height: 24,
          flexShrink: 0,
          marginLeft: 6,
          padding: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 11,
            height: 11,
            transform: 'rotate(45deg)',
            background: keyframe.active ? '#3b82f6' : 'transparent',
            border: `1.5px solid ${keyframe.active ? '#3b82f6' : '#64748b'}`,
            borderRadius: 2
          }}
        />
      </button>
    </div>
  )

  /** A labelled range + number-input pair (mirrors EffectsPanel's sliderRow). */
  const sliderRow = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
    testid: string
  ): JSX.Element => (
    <div style={styles.row}>
      <span style={styles.ctrlLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10)
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
        step={1}
        value={value}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10)
          if (!Number.isFinite(v)) return
          onChange(v)
        }}
        style={styles.numInput}
        data-testid={`${testid}-input`}
        aria-label={`${label} 숫자`}
      />
    </div>
  )

  // pptx12 slide 18 — scaled adjustment layers need a real region transform:
  // the grade applies only inside the resized/moved rectangle.
  const transformPanel = (
    <div data-testid="adjustment-tab-transform">
      <p style={styles.sectionLabel}>크기 · 회전 · 위치</p>
      <div style={{ height: 6 }} />
      {transformSliderRow(
        '크기',
        transform.scale,
        MIN_TRANSFORM_SCALE,
        MAX_TRANSFORM_SCALE,
        0.05,
        (v) => handleTransform({ scale: v }),
        'adjustment-transform-scale',
        2,
        {
          active: isOnKeyframe,
          onAdd: () => handleAddKeyframe({ scale: transform.scale }),
          testid: 'adjustment-transform-scale-kf'
        }
      )}
      {transformSliderRow(
        '회전',
        transform.rotation,
        MIN_TRANSFORM_ROTATION,
        MAX_TRANSFORM_ROTATION,
        1,
        (v) => handleTransform({ rotation: v }),
        'adjustment-transform-rotation',
        0,
        {
          active: isOnKeyframe,
          onAdd: () => handleAddKeyframe({ rotation: transform.rotation }),
          testid: 'adjustment-transform-rotation-kf'
        }
      )}
      {transformSliderRow(
        '불투명',
        transform.opacity,
        0,
        1,
        0.05,
        (v) => handleTransform({ opacity: v }),
        'adjustment-transform-opacity',
        2,
        {
          active: isOnKeyframe,
          onAdd: () => handleAddKeyframe({ opacity: transform.opacity }),
          testid: 'adjustment-transform-opacity-kf'
        }
      )}
      {transformSliderRow(
        'X 위치',
        transform.x,
        MIN_TRANSFORM_OFFSET,
        MAX_TRANSFORM_OFFSET,
        0.01,
        (v) => handleTransform({ x: v }),
        'adjustment-transform-x',
        2,
        {
          active: isOnKeyframe,
          onAdd: () => handleAddKeyframe({ x: transform.x }),
          testid: 'adjustment-transform-x-kf'
        }
      )}
      {transformSliderRow(
        'Y 위치',
        transform.y,
        MIN_TRANSFORM_OFFSET,
        MAX_TRANSFORM_OFFSET,
        0.01,
        (v) => handleTransform({ y: v }),
        'adjustment-transform-y',
        2,
        {
          active: isOnKeyframe,
          onAdd: () => handleAddKeyframe({ y: transform.y }),
          testid: 'adjustment-transform-y-kf'
        }
      )}
      <div style={{ height: 8 }} />
      <button
        type="button"
        style={styles.resetBtn}
        onClick={() => resetAdjustmentLayerTransform(layer.id)}
        data-testid="adjustment-transform-reset"
      >
        변형 초기화
      </button>
      {hasKeyframes && (
        <p style={{ ...styles.hint, marginTop: 8 }}>
          키프레임 애니메이션 적용 중 — 슬라이더 조정은 재생헤드 위치의
          키프레임에 반영돼요. (애니메이션 탭)
        </p>
      )}
      <p style={{ ...styles.hint, marginTop: 6 }}>
        조정 효과는 이 사각 영역 안에만 적용됩니다.
      </p>
    </div>
  )
  const speedPanel = (
    <div data-testid="adjustment-tab-speed" style={styles.emptyHint}>
      조정 레이어는 자체 미디어를 가지지 않으므로 재생 속도가 의미 없습니다.
      구간 시작 / 끝 ms 는 타임라인에서 드래그로 조절하세요.
    </div>
  )
  const animationPanel = (
    <div data-testid="adjustment-tab-animation">
      <p style={styles.sectionLabel}>변형 키프레임</p>
      <div style={{ height: 6 }} />
      <div style={styles.row}>
        <button
          type="button"
          style={styles.kfBtn}
          onClick={() =>
            addAdjustmentLayerTransformKeyframe(
              layer.id,
              playheadMs - layer.startMs
            )
          }
          data-testid="adjustment-add-keyframe"
        >
          {isOnKeyframe ? '키프레임 갱신' : '현재 위치에 키프레임 추가'}
        </button>
        <button
          type="button"
          style={{
            ...styles.kfBtn,
            ...(isOnKeyframe ? {} : styles.kfBtnDisabled)
          }}
          disabled={!isOnKeyframe}
          onClick={() => {
            if (keyframeIndex >= 0) {
              removeAdjustmentLayerTransformKeyframe(layer.id, keyframeIndex)
            }
          }}
          data-testid="adjustment-remove-keyframe"
        >
          키프레임 삭제
        </button>
        <span style={styles.kfBadge} data-testid="adjustment-keyframe-count">
          {keyframeCount}
        </span>
      </div>

      {hasKeyframes && (
        <>
          {/* 현재 키프레임의 OUTGOING 이징 (다음 키프레임까지 보간 곡선). */}
          <div
            style={{ ...styles.row, marginTop: 8 }}
            data-testid="adjustment-keyframe-easing-row"
          >
            <span style={styles.ctrlLabel}>이징</span>
            <select
              value={
                isOnKeyframe && keyframeIndex >= 0
                  ? ((layer.transformKeyframes?.[keyframeIndex]
                      ?.easing as EasingKind) ?? 'linear')
                  : 'linear'
              }
              onChange={(e) => {
                if (!isOnKeyframe || keyframeIndex < 0) return
                const v = e.target.value as EasingKind
                updateAdjustmentLayerTransformKeyframe(layer.id, keyframeIndex, {
                  easing: v === 'linear' ? null : v
                })
              }}
              disabled={!isOnKeyframe}
              style={{
                ...styles.numInput,
                width: 140,
                opacity: isOnKeyframe ? 1 : 0.5
              }}
              data-testid="adjustment-keyframe-easing-select"
              aria-label="현재 키프레임의 이징"
            >
              {EASING_KINDS.map((k) => (
                <option key={k} value={k}>
                  {EASING_LABELS[k]}
                </option>
              ))}
            </select>
          </div>

          {/* 키프레임 리스트 — 행 클릭 시 그 시점으로 재생헤드 점프. */}
          <div
            data-testid="adjustment-keyframe-list"
            style={{
              marginTop: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 4
            }}
          >
            {(layer.transformKeyframes ?? []).map((kf, idx) => (
              <div
                key={`${idx}-${kf.atMs}`}
                data-testid={`adjustment-keyframe-row-${idx}`}
                data-kf-at-ms={kf.atMs}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 6px',
                  background: keyframeIndex === idx ? '#1e293b' : '#0f172a',
                  border: `1px solid ${
                    keyframeIndex === idx ? '#3b82f6' : '#1f2937'
                  }`,
                  borderRadius: 4,
                  cursor: 'pointer'
                }}
                onClick={() => setPlayheadMs(layer.startMs + kf.atMs)}
              >
                <span style={{ color: '#94a3b8', fontSize: 11, width: 18 }}>
                  #{idx + 1}
                </span>
                <span style={{ flex: 1, fontSize: 11, color: '#cbd5e1' }}>
                  {(kf.atMs / 1000).toFixed(2)}s
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeAdjustmentLayerTransformKeyframe(layer.id, idx)
                  }}
                  data-testid={`adjustment-keyframe-remove-${idx}`}
                  aria-label={`${idx + 1}번 키프레임 삭제`}
                  style={{
                    background: 'transparent',
                    color: '#f87171',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 14,
                    padding: '0 4px'
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div style={{ height: 8 }} />
          <button
            type="button"
            style={styles.resetBtn}
            onClick={() => clearAdjustmentLayerTransformKeyframes(layer.id)}
            data-testid="adjustment-clear-keyframes"
          >
            키프레임 전체 삭제
          </button>
        </>
      )}

      <p style={{ ...styles.hint, marginTop: 8 }}>
        [변형] 탭의 ◇ 를 눌러 재생헤드 위치에 키프레임을 추가하세요. 두 개
        이상이면 구간 동안 크기·회전·위치·투명도가 보간됩니다. (내보내기는
        현재 정적 변형을 사용합니다)
      </p>
    </div>
  )
  const layoutPanel = (
    <div data-testid="adjustment-tab-layout" style={styles.emptyHint}>
      조정 레이어는 캔버스 위의 독립 영역으로 배치됩니다. 분할 / 그리드
      레이아웃은 미디어 클립에 적용하세요.
    </div>
  )

  return (
    <div data-testid="adjustment-layer-editor" data-layer-id={layer.id}>
      <p style={styles.meta}>
        조정 레이어 · {(layer.startMs / 1000).toFixed(2)}s –{' '}
        {(layer.endMs / 1000).toFixed(2)}s
      </p>
      <p style={styles.hint}>
        이 구간의 선택 영역 안에 있는 화면에만 색 보정이 적용됩니다.
      </p>

      {/* pptx12 슬라이드 18 — 일반 효과 패널과 동일한 6탭 바. */}
      <div style={styles.tabBar} data-testid="adjustment-editor-tabs">
        {ADJ_TABS.map((t) => (
          <button
            key={t}
            type="button"
            data-testid={`adjustment-effects-tab-${t}`}
            aria-pressed={activeTab === t}
            onClick={() => setActiveTab(t)}
            style={{
              ...styles.tabBtn,
              ...(activeTab === t ? styles.tabBtnActive : {})
            }}
          >
            {ADJ_TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {activeTab === 'transform' && transformPanel}
      {activeTab === 'speed' && speedPanel}
      {activeTab === 'animation' && animationPanel}
      {activeTab === 'layout' && layoutPanel}

      {activeTab === 'adjust' && (
        <div data-testid="adjustment-tab-adjust">
      <hr style={styles.divider} />

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
              onClick={() =>
                setAdjustmentLayerFilterPreset(layer.id, p, filterIntensity)
              }
              data-testid={`adjustment-filter-preset-${p}`}
              style={{
                ...styles.filterCell,
                border: active ? '2px solid #a78bfa' : '1px solid #374151'
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
            setAdjustmentLayerFilterPreset(
              layer.id,
              filterPreset,
              Math.max(0, Math.min(1, parseInt(e.target.value, 10) / 100))
            )
          }
          style={styles.slider}
          data-testid="adjustment-filter-intensity-slider"
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
      {(['brightness', 'contrast', 'saturation', 'temperature'] as const).map(
        (k) =>
          sliderRow(
            COLOR_ADJUST_LABELS[k],
            colorAdjust[k],
            MIN_COLOR_ADJUST,
            MAX_COLOR_ADJUST,
            (v) => setAdjustmentLayerColorAdjust(layer.id, { [k]: v }),
            `adjustment-coloradjust-${k}`
          )
      )}
      <div style={{ height: 8 }} />
      <button
        type="button"
        style={styles.resetBtn}
        onClick={() =>
          setAdjustmentLayerColorAdjust(layer.id, {
            brightness: 0,
            contrast: 0,
            saturation: 0,
            temperature: 0
          })
        }
        data-testid="adjustment-coloradjust-reset"
      >
        색 보정 초기화
      </button>

      <hr style={styles.divider} />

      {/* Tone curves — reuses the generalized CurveEditor in layer mode. */}
      <p style={styles.sectionLabel}>곡선</p>
      <div style={{ height: 6 }} />
      <div data-testid="adjustment-section-curves">
        <CurveEditor clipId={layer.id} mode="adjustmentLayer" />
      </div>

      <hr style={styles.divider} />

      {/* HSL secondary grading */}
      <p style={styles.sectionLabel}>HSL</p>
      <div style={{ height: 6 }} />
      <div data-testid="adjustment-hsl-panel">
        <div style={styles.presetRow}>
          {HSL_BAND_KEYS.map((b) => {
            const active = hslBand === b
            return (
              <button
                key={b}
                type="button"
                data-testid={`adjustment-hsl-band-${b}`}
                aria-pressed={active}
                onClick={() => setHslBand(b)}
                title={HSL_BAND_LABELS[b]}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 6,
                  background: HSL_BAND_SWATCHES[b],
                  border: active ? '2px solid #f5f5f5' : '1px solid #374151',
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
            <div key={field} data-testid={`adjustment-hsl-slider-${field}`}>
              {sliderRow(
                label,
                hslBandAdjust[field],
                MIN_HSL_ADJUST,
                MAX_HSL_ADJUST,
                (v) =>
                  setAdjustmentLayerHslBand(layer.id, hslBand, {
                    [field]: v
                  }),
                `adjustment-hsl-slider-${field}`
              )}
            </div>
          )
        })}
        <p style={{ ...styles.hint, marginTop: 6 }}>
          미리보기는 근사값입니다 — 정확한 색은 내보내기 결과를 확인하세요.
        </p>
      </div>
        </div>
      )}

      {activeTab === 'transition' && (
        <div data-testid="adjustment-tab-transition">
          {/* pptx11 슬라이드 23 — 전환: fade-in / fade-out. ms 단위.
              최대값은 layer 길이 절반 (clamp 는 store 에서). */}
          <p style={styles.sectionLabel}>전환 (페이드)</p>
          <div style={{ height: 6 }} />
          {(() => {
            const dur = Math.max(0, layer.endMs - layer.startMs)
            const halfDur = Math.floor(dur / 2)
            const fadeIn = Math.min(halfDur, layer.fadeInMs ?? 0)
            const fadeOut = Math.min(halfDur, layer.fadeOutMs ?? 0)
            return (
              <div data-testid="adjustment-fade-panel">
                {sliderRow(
                  '시작 페이드',
                  fadeIn,
                  0,
                  halfDur,
                  (v) => setAdjustmentLayerFade(layer.id, v, fadeOut),
                  'adjustment-fade-in'
                )}
                {sliderRow(
                  '끝 페이드',
                  fadeOut,
                  0,
                  halfDur,
                  (v) => setAdjustmentLayerFade(layer.id, fadeIn, v),
                  'adjustment-fade-out'
                )}
                <p style={{ ...styles.hint, marginTop: 6 }}>
                  페이드 구간에선 색 보정 / 필터 강도가 점진적으로 적용됩니다.
                </p>
              </div>
            )
          })()}
        </div>
      )}

      <hr style={styles.divider} />

      <button
        type="button"
        style={styles.deleteBtn}
        data-testid="delete-adjustment-layer"
        onClick={() => {
          removeAdjustmentLayer(layer.id)
          setSelectedAdjustmentLayerId(null)
        }}
      >
        조정 레이어 삭제
      </button>
    </div>
  )
}
