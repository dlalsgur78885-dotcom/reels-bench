import type { CropRect } from '../../../shared/project'
import type { CSSProperties } from 'react'
import { MIN_CROP_SIZE } from '../../../shared/project'

export const CROP_PRESETS: ReadonlyArray<{ id: string; aspect: number | null }> = [
  { id: 'free', aspect: null },
  { id: '1:1', aspect: 1 },
  { id: '4:5', aspect: 4 / 5 },
  { id: '9:16', aspect: 9 / 16 },
  { id: '16:9', aspect: 16 / 9 }
]

export function centeredCropForAspect(aR: number, srcAspect: number): CropRect {
  if (aR >= srcAspect) {
    const h = srcAspect / aR
    return { x: 0, y: (1 - h) / 2, w: 1, h }
  }
  const w = aR / srcAspect
  return { x: (1 - w) / 2, y: 0, w, h: 1 }
}

export function resizeCropWidthAroundCenter(
  c: CropRect,
  w: number
): Partial<CropRect> {
  const nextW = Math.max(MIN_CROP_SIZE, Math.min(1, w))
  const centerX = c.x + c.w / 2
  const x = Math.max(0, Math.min(1 - nextW, centerX - nextW / 2))
  return { x, w: nextW }
}

export function resizeCropHeightAroundCenter(
  c: CropRect,
  h: number
): Partial<CropRect> {
  const nextH = Math.max(MIN_CROP_SIZE, Math.min(1, h))
  const centerY = c.y + c.h / 2
  const y = Math.max(0, Math.min(1 - nextH, centerY - nextH / 2))
  return { y, h: nextH }
}

interface CropControlStyles {
  presetRow: CSSProperties
  preset: CSSProperties
  row: CSSProperties
  label: CSSProperties
  slider: CSSProperties
  input: CSSProperties
  resetButton: CSSProperties
}

interface CropControlsProps {
  cropRect: CropRect
  sourceAspect: number
  onCropChange: (partial: Partial<CropRect>) => void
  onCropReset?: () => void
  testPrefix: string
  styles: CropControlStyles
  showNumberInputs?: boolean
  resetLabel?: string
}

function cropRow(
  label: string,
  field: 'x' | 'y' | 'w' | 'h',
  value: number,
  cropRect: CropRect,
  onCropChange: (partial: Partial<CropRect>) => void,
  testPrefix: string,
  styles: CropControlStyles,
  showNumberInputs: boolean
): JSX.Element {
  const isSize = field === 'w' || field === 'h'
  const min = isSize ? MIN_CROP_SIZE : 0
  const apply = (raw: number): void => {
    if (!Number.isFinite(raw)) return
    if (field === 'w') onCropChange(resizeCropWidthAroundCenter(cropRect, raw))
    else if (field === 'h') onCropChange(resizeCropHeightAroundCenter(cropRect, raw))
    else onCropChange({ [field]: raw } as Partial<CropRect>)
  }

  return (
    <div style={styles.row}>
      <span style={styles.label}>{label}</span>
      <input
        type="range"
        min={min}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => apply(parseFloat(e.target.value))}
        style={styles.slider}
        data-testid={`${testPrefix}-${field}`}
        aria-label={`크롭 ${label}`}
      />
      {showNumberInputs && (
        <input
          type="number"
          min={min}
          max={1}
          step={0.01}
          value={Number(value.toFixed(2))}
          onChange={(e) => apply(parseFloat(e.target.value))}
          style={styles.input}
          data-testid={`${testPrefix}-${field}-input`}
          aria-label={`크롭 ${label} 숫자`}
        />
      )}
    </div>
  )
}

export function CropControls(props: CropControlsProps): JSX.Element {
  const {
    cropRect,
    onCropChange,
    onCropReset,
    resetLabel = '초기화',
    showNumberInputs = true,
    sourceAspect,
    styles,
    testPrefix
  } = props

  return (
    <>
      <div style={styles.presetRow}>
        {CROP_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            style={styles.preset}
            data-testid={`${testPrefix}-preset-${p.id}`}
            onClick={() => {
              if (p.aspect === null) return
              onCropChange(centeredCropForAspect(p.aspect, sourceAspect))
            }}
          >
            {p.id === 'free' ? '자유' : p.id}
          </button>
        ))}
      </div>
      {cropRow(
        'X',
        'x',
        cropRect.x,
        cropRect,
        onCropChange,
        testPrefix,
        styles,
        showNumberInputs
      )}
      {cropRow(
        'Y',
        'y',
        cropRect.y,
        cropRect,
        onCropChange,
        testPrefix,
        styles,
        showNumberInputs
      )}
      {cropRow(
        '너비',
        'w',
        cropRect.w,
        cropRect,
        onCropChange,
        testPrefix,
        styles,
        showNumberInputs
      )}
      {cropRow(
        '높이',
        'h',
        cropRect.h,
        cropRect,
        onCropChange,
        testPrefix,
        styles,
        showNumberInputs
      )}
      {onCropReset && (
        <button
          type="button"
          style={styles.resetButton}
          data-testid={`${testPrefix}-reset`}
          onClick={() => onCropReset()}
        >
          {resetLabel}
        </button>
      )}
    </>
  )
}
