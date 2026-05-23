import { useMemo, useRef, useState } from 'react'
import type { CurveChannelKey } from '../../../shared/project'
import {
  CURVE_CHANNEL_KEYS,
  IDENTITY_CLIP_CURVES,
  MIN_CURVE_POINTS,
  getClipCurves,
  resolveClipCurves
} from '../../../shared/project'
import {
  CURVE_CHANNEL_LABELS,
  sampleCurveTable
} from '../../../shared/filterPresets'
import { useProjectStore } from '../store/project'

/**
 * Phase 3.12 — SVG-based tone-curve editor.
 *
 * Renders a square graph where the X axis is INPUT (0..1) and the Y axis is
 * OUTPUT (0..1). SVG y is inverted, so output 1 = top of the graph. The active
 * channel is editable (bold/tinted); the other three are drawn faint as
 * reference. All edits route through the project store (curve actions), so
 * undo/redo works for free.
 */

interface CurveEditorProps {
  /**
   * Id of the entity whose tone curves are being edited. With `mode='clip'`
   * (default) this is a media clip id; with `mode='adjustmentLayer'` it is an
   * adjustment-layer id.
   */
  clipId: string
  /**
   * Phase 3.32 — which store entity the curve edits route to. `'clip'` uses
   * the per-clip curve actions; `'adjustmentLayer'` uses the
   * `setAdjustmentLayerCurvePoint` action. Adjustment-layer mode supports
   * dragging existing points (4-channel identity baseline) — add/remove of
   * intermediate points is clip-only.
   */
  mode?: 'clip' | 'adjustmentLayer'
}

const GRAPH = 240
const PAD = 14
/** Inner drawable square (graph area minus padding on all sides). */
const INNER = GRAPH - PAD * 2
/** Curve sampling resolution for the polyline. */
const SAMPLE_STEPS = 64
/** Handle hit radius (px). */
const HANDLE_R = 5

/** Per-channel stroke color when ACTIVE (editable). */
const CHANNEL_STROKE: Record<CurveChannelKey, string> = {
  master: '#f5f5f5',
  red: '#e5484d',
  green: '#46a758',
  blue: '#3b82f6'
}

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8
  } as React.CSSProperties,
  channelRow: {
    display: 'flex',
    gap: 4
  } as React.CSSProperties,
  channelBtn: {
    flex: 1,
    background: '#1a1a1a',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '4px 6px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  svg: {
    background: '#0a0a0a',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    touchAction: 'none',
    cursor: 'crosshair',
    display: 'block',
    alignSelf: 'center' as const
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
  hint: { fontSize: 10, color: '#64748b', margin: 0 } as React.CSSProperties
}

/** Graph-space (0..1, 0..1 with y-up) → SVG px coordinates. */
function toSvgX(x: number): number {
  return PAD + Math.min(1, Math.max(0, x)) * INNER
}
function toSvgY(y: number): number {
  // y=1 (max output) → top of graph (small SVG y).
  return PAD + (1 - Math.min(1, Math.max(0, y))) * INNER
}
/** SVG px → graph-space 0..1 (x), inverting y so 1 = top. */
function fromSvgX(px: number): number {
  return Math.min(1, Math.max(0, (px - PAD) / INNER))
}
function fromSvgY(px: number): number {
  return Math.min(1, Math.max(0, 1 - (px - PAD) / INNER))
}

export function CurveEditor(props: CurveEditorProps): JSX.Element {
  const { clipId, mode = 'clip' } = props
  const isLayer = mode === 'adjustmentLayer'

  const project = useProjectStore((s) => s.project)
  const setCurvePoint = useProjectStore((s) => s.setCurvePoint)
  const addCurvePoint = useProjectStore((s) => s.addCurvePoint)
  const removeCurvePoint = useProjectStore((s) => s.removeCurvePoint)
  const resetCurves = useProjectStore((s) => s.resetCurves)
  // Phase 3.32 — adjustment-layer curve action.
  const setAdjustmentLayerCurvePoint = useProjectStore(
    (s) => s.setAdjustmentLayerCurvePoint
  )

  const [channel, setChannel] = useState<CurveChannelKey>('master')
  /** Index of the handle being dragged, or -1 when idle. */
  const dragRef = useRef<number>(-1)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // Resolve the entity's curves (null = identity → fall back to identity).
  const curves = useMemo(() => {
    if (isLayer) {
      const layer = (project.adjustmentLayers ?? []).find(
        (l) => l.id === clipId
      )
      return layer
        ? resolveClipCurves(layer.curves) ?? IDENTITY_CLIP_CURVES
        : IDENTITY_CLIP_CURVES
    }
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => cc.id === clipId)
      if (c && c.kind === 'media') return getClipCurves(c) ?? IDENTITY_CLIP_CURVES
    }
    return IDENTITY_CLIP_CURVES
  }, [project, clipId, isLayer])

  // Route a point edit to the clip OR the adjustment-layer store action.
  const applySetCurvePoint = (
    ch: CurveChannelKey,
    index: number,
    partial: { x?: number; y?: number }
  ): void => {
    if (isLayer) setAdjustmentLayerCurvePoint(clipId, ch, index, partial)
    else setCurvePoint(clipId, ch, index, partial)
  }

  const activePts = curves[channel]
  // Adjustment-layer mode keeps the identity 2-point baseline (no add/remove).
  const canRemove = !isLayer && activePts.length > MIN_CURVE_POINTS

  /** Convert a pointer event to graph-space {x,y}. */
  const eventToGraph = (
    e: React.PointerEvent | React.MouseEvent
  ): { x: number; y: number } => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    // The SVG viewBox is GRAPH×GRAPH; map client px → viewBox px.
    const sx = ((e.clientX - rect.left) / rect.width) * GRAPH
    const sy = ((e.clientY - rect.top) / rect.height) * GRAPH
    return { x: fromSvgX(sx), y: fromSvgY(sy) }
  }

  const handlePointerDownHandle = (
    e: React.PointerEvent,
    index: number
  ): void => {
    e.stopPropagation()
    dragRef.current = index
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent): void => {
    const index = dragRef.current
    if (index < 0) return
    const g = eventToGraph(e)
    // Endpoint handles are x-locked (index 0 → x=0, last → x=1) so the curve
    // stays valid; they may still move in y.
    const isFirst = index === 0
    const isLast = index === activePts.length - 1
    const partial = isFirst
      ? { x: 0, y: g.y }
      : isLast
        ? { x: 1, y: g.y }
        : { x: g.x, y: g.y }
    applySetCurvePoint(channel, index, partial)
  }

  const handlePointerUp = (e: React.PointerEvent): void => {
    if (dragRef.current >= 0) {
      ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    }
    dragRef.current = -1
  }

  /** Click on empty graph area → add a control point there (clip mode only). */
  const handleSvgClick = (e: React.MouseEvent): void => {
    // Ignore the click that ends a drag.
    if (dragRef.current >= 0) return
    // Adjustment-layer mode keeps the fixed 2-point identity baseline.
    if (isLayer) return
    const g = eventToGraph(e)
    addCurvePoint(clipId, channel, g)
  }

  // Sampled polyline points for one channel's curve.
  const polyFor = (key: CurveChannelKey): string => {
    const table = sampleCurveTable(curves[key], SAMPLE_STEPS)
    return table
      .map((y, i) => {
        const x = i / (table.length - 1)
        return `${toSvgX(x).toFixed(2)},${toSvgY(y).toFixed(2)}`
      })
      .join(' ')
  }

  // Faint reference channels (everything except the active one).
  const otherChannels = CURVE_CHANNEL_KEYS.filter((k) => k !== channel)

  return (
    <div style={styles.wrap} data-testid="curve-editor">
      {/* Channel switcher */}
      <div style={styles.channelRow}>
        {CURVE_CHANNEL_KEYS.map((k) => {
          const active = channel === k
          return (
            <button
              key={k}
              type="button"
              data-testid={`curve-channel-${k}`}
              aria-pressed={active}
              onClick={() => setChannel(k)}
              style={{
                ...styles.channelBtn,
                ...(active
                  ? {
                      background: CHANNEL_STROKE[k],
                      color: k === 'master' ? '#0a0a0a' : '#fff',
                      borderColor: CHANNEL_STROKE[k]
                    }
                  : {})
              }}
            >
              {CURVE_CHANNEL_LABELS[k]}
            </button>
          )
        })}
      </div>

      {/* Graph */}
      <svg
        ref={svgRef}
        width={GRAPH}
        height={GRAPH}
        viewBox={`0 0 ${GRAPH} ${GRAPH}`}
        style={styles.svg}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onClick={handleSvgClick}
      >
        {/* Grid (quarters). */}
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g}>
            <line
              x1={toSvgX(g)}
              y1={toSvgY(0)}
              x2={toSvgX(g)}
              y2={toSvgY(1)}
              stroke="#1f1f1f"
              strokeWidth={1}
            />
            <line
              x1={toSvgX(0)}
              y1={toSvgY(g)}
              x2={toSvgX(1)}
              y2={toSvgY(g)}
              stroke="#1f1f1f"
              strokeWidth={1}
            />
          </g>
        ))}
        {/* Border square. */}
        <rect
          x={toSvgX(0)}
          y={toSvgY(1)}
          width={INNER}
          height={INNER}
          fill="none"
          stroke="#2f2f2f"
          strokeWidth={1}
        />
        {/* Faint diagonal reference (identity). */}
        <line
          x1={toSvgX(0)}
          y1={toSvgY(0)}
          x2={toSvgX(1)}
          y2={toSvgY(1)}
          stroke="#333"
          strokeWidth={1}
          strokeDasharray="3 3"
        />

        {/* Inactive channels — faint reference curves. */}
        {otherChannels.map((k) => (
          <polyline
            key={k}
            points={polyFor(k)}
            fill="none"
            stroke={CHANNEL_STROKE[k]}
            strokeOpacity={0.22}
            strokeWidth={1.25}
          />
        ))}

        {/* Active channel — bold curve. */}
        <polyline
          points={polyFor(channel)}
          fill="none"
          stroke={CHANNEL_STROKE[channel]}
          strokeWidth={2.25}
          strokeLinejoin="round"
        />

        {/* Draggable handles for the active channel. */}
        {activePts.map((p, i) => (
          <circle
            key={i}
            data-testid={`curve-point-${channel}-${i}`}
            cx={toSvgX(p.x)}
            cy={toSvgY(p.y)}
            r={HANDLE_R}
            fill={CHANNEL_STROKE[channel]}
            stroke="#0a0a0a"
            strokeWidth={1.5}
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => handlePointerDownHandle(e, i)}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (canRemove) removeCurvePoint(clipId, channel, i)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (canRemove) removeCurvePoint(clipId, channel, i)
            }}
          />
        ))}
      </svg>

      <p style={styles.hint}>
        빈 곳을 클릭해 점 추가 · 점을 드래그해 조정 · 더블클릭/우클릭으로 삭제
        (양 끝점은 삭제 불가)
      </p>

      <button
        type="button"
        style={styles.resetBtn}
        data-testid="curve-reset"
        onClick={() => {
          if (isLayer) {
            // Layer mode keeps the 2-point baseline — snap every channel's
            // two endpoints back to the identity diagonal (the store
            // neutral-collapses to `undefined` once all-identity).
            for (const k of CURVE_CHANNEL_KEYS) {
              setAdjustmentLayerCurvePoint(clipId, k, 0, { x: 0, y: 0 })
              setAdjustmentLayerCurvePoint(clipId, k, 1, { x: 1, y: 1 })
            }
          } else {
            resetCurves(clipId)
          }
        }}
      >
        곡선 초기화
      </button>
    </div>
  )
}
