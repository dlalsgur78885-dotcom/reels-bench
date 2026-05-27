import { useState } from 'react'
import type {
  AdjustmentLayer,
  ClipHsl,
  ClipTransform,
  ColorAdjust,
  FilterPreset,
  HslBandAdjust,
  HslBandKey
} from '../../../shared/project'
import {
  FILTER_PRESETS,
  getAdjustmentLayerTransform,
  HSL_BAND_KEYS,
  MAX_COLOR_ADJUST,
  MAX_HSL_ADJUST,
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
  const removeAdjustmentLayer = useProjectStore((s) => s.removeAdjustmentLayer)
  const setSelectedAdjustmentLayerId = useTimelineUi(
    (s) => s.setSelectedAdjustmentLayerId
  )

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
  const transform: ClipTransform = getAdjustmentLayerTransform(layer)

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
      <p style={styles.sectionLabel}>위치 / 크기</p>
      <div style={{ height: 6 }} />
      {sliderRow(
        'X',
        Math.round(transform.x * 100),
        -200,
        200,
        (v) => setAdjustmentLayerTransform(layer.id, { x: v / 100 }),
        'adjustment-transform-x'
      )}
      {sliderRow(
        'Y',
        Math.round(transform.y * 100),
        -200,
        200,
        (v) => setAdjustmentLayerTransform(layer.id, { y: v / 100 }),
        'adjustment-transform-y'
      )}
      {sliderRow(
        '크기',
        Math.round(transform.scale * 100),
        Math.round(MIN_TRANSFORM_SCALE * 100),
        100,
        (v) => setAdjustmentLayerTransform(layer.id, { scale: v / 100 }),
        'adjustment-transform-scale'
      )}
      {sliderRow(
        '투명도',
        Math.round(transform.opacity * 100),
        0,
        100,
        (v) => setAdjustmentLayerTransform(layer.id, { opacity: v / 100 }),
        'adjustment-transform-opacity'
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
      <p style={{ ...styles.hint, marginTop: 6 }}>
        크기를 줄이면 조정 효과가 해당 사각 영역 안에만 적용됩니다.
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
    <div data-testid="adjustment-tab-animation" style={styles.emptyHint}>
      구간 동안 grade 가 시간에 따라 변하는 키프레임 애니메이션은 추후 지원
      예정입니다. 지금은 [전환] 탭의 시작/끝 페이드로 강도 램프만 적용 가능.
    </div>
  )
  const layoutPanel = (
    <div data-testid="adjustment-tab-layout" style={styles.emptyHint}>
      조정 레이어는 프레임 전체에 grade 가 합성되므로 레이아웃(분할 / 그리드)
      적용 대상이 아닙니다.
    </div>
  )

  return (
    <div data-testid="adjustment-layer-editor" data-layer-id={layer.id}>
      <p style={styles.meta}>
        조정 레이어 · {(layer.startMs / 1000).toFixed(2)}s –{' '}
        {(layer.endMs / 1000).toFixed(2)}s
      </p>
      <p style={styles.hint}>
        이 구간 아래의 모든 트랙에 색 보정이 적용됩니다.
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
