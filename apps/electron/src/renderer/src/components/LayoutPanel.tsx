import { useEffect, useMemo, useState } from 'react'
import {
  LAYOUT_PRESETS,
  getLayoutPreset,
  type LayoutPreset,
  type LayoutPresetId
} from '../../../shared/layoutPresets'
import type { Clip, Project } from '../../../shared/project'
import { isMediaClip, isOverlayClip } from '../../../shared/project'
import { useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'

/**
 * Phase 3.18 — collage / split-screen layout picker.
 *
 * Operates on the current multi-selection of media/overlay clips (read from
 * the timeline UI store). The user picks a preset, optionally reorders which
 * clip lands in which cell, then "적용" calls the store's `applyLayout`. If
 * the selected clips already share a `layoutGroupId`, a "레이아웃 해제" button
 * calls `clearLayout`.
 *
 * Renderer-only: `applyLayout` writes the existing `transform`/`cropRect`
 * clip fields + a UI-only `layoutGroupId`; export is byte-identical for any
 * clip this panel never touches.
 */

const styles = {
  root: {
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
  hint: { fontSize: 10, color: '#64748b', margin: 0 } as React.CSSProperties,
  presetGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 6
  } as React.CSSProperties,
  presetCell: {
    background: '#1f2937',
    borderRadius: 4,
    padding: 4,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 3,
    fontSize: 10,
    color: '#f5f5f5'
  } as React.CSSProperties,
  /** 9:16 box the cell rectangles are drawn into. */
  thumb: {
    position: 'relative' as const,
    width: 34,
    height: 60,
    background: '#0a0a0a',
    borderRadius: 2,
    overflow: 'hidden'
  } as React.CSSProperties,
  thumbCell: {
    position: 'absolute' as const,
    background: '#475569',
    border: '1px solid #1f2937',
    boxSizing: 'border-box' as const
  } as React.CSSProperties,
  thumbCellTop: {
    background: '#6366f1'
  } as React.CSSProperties,
  slotList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4
  } as React.CSSProperties,
  slot: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '4px 6px'
  } as React.CSSProperties,
  slotIndex: {
    width: 18,
    height: 18,
    borderRadius: 4,
    background: '#6366f1',
    color: '#fff',
    fontSize: 10,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  } as React.CSSProperties,
  slotName: {
    flex: 1,
    fontSize: 11,
    color: '#f5f5f5',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const
  } as React.CSSProperties,
  slotBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 4,
    width: 22,
    height: 22,
    fontSize: 11,
    cursor: 'pointer',
    padding: 0
  } as React.CSSProperties,
  slotBtnDisabled: {
    color: '#475569',
    cursor: 'not-allowed'
  } as React.CSSProperties,
  applyBtn: {
    background: '#10b981',
    color: '#04231a',
    border: '1px solid #10b981',
    borderRadius: 4,
    padding: '7px 10px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    width: '100%'
  } as React.CSSProperties,
  clearBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 11,
    cursor: 'pointer',
    width: '100%'
  } as React.CSSProperties,
  emptyHint: {
    padding: 12,
    color: '#94a3b8',
    fontSize: 12,
    background: '#0d0d0d',
    border: '1px dashed #374151',
    borderRadius: 6
  } as React.CSSProperties,
  divider: {
    height: 1,
    background: '#2a2a2a',
    margin: '2px 0',
    border: 'none'
  } as React.CSSProperties,
  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: '#9aa0a6'
  } as React.CSSProperties
}

/** Small CSS rendering of a preset's cells inside a 9:16 box. */
function PresetThumb(props: { preset: LayoutPreset }): JSX.Element {
  const { preset } = props
  const lastIdx = preset.cells.length - 1
  return (
    <div style={styles.thumb} aria-hidden>
      {preset.cells.map((cell, i) => (
        <div
          key={i}
          style={{
            ...styles.thumbCell,
            // The LAST cell renders on top (PiP inset) — tint it.
            ...(i === lastIdx && preset.cells.length > 1
              ? styles.thumbCellTop
              : {}),
            left: `${cell.x * 100}%`,
            top: `${cell.y * 100}%`,
            width: `${cell.w * 100}%`,
            height: `${cell.h * 100}%`,
            // Higher cell index → higher z so PiP draws over the base.
            zIndex: i + 1
          }}
        />
      ))}
    </div>
  )
}

interface SelectedClip {
  id: string
  label: string
  layoutGroupId?: string
}

export function LayoutPanel(): JSX.Element {
  const project = useProjectStore((s) => s.project)
  const applyLayout = useProjectStore((s) => s.applyLayout)
  const clearLayout = useProjectStore((s) => s.clearLayout)
  const selectedClipIds = useTimelineUi((s) => s.selectedClipIds)

  // Resolve the current multi-selection to layout-eligible clips (media or
  // overlay — the transform/crop carriers), in a stable order.
  const selectedClips = useMemo<SelectedClip[]>(() => {
    const out: SelectedClip[] = []
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (!selectedClipIds.has(c.id)) continue
        if (!isMediaClip(c) && !isOverlayClip(c)) continue
        out.push({
          id: c.id,
          label: clipLabel(project, c),
          layoutGroupId: c.layoutGroupId
        })
      }
    }
    return out
  }, [project, selectedClipIds])

  const [presetId, setPresetId] = useState<LayoutPresetId | null>(null)
  // Ordered clip ids for the cell slots (selection order by default).
  const [slotOrder, setSlotOrder] = useState<string[]>([])

  // Keep slotOrder synced with the live selection — drop ids that left the
  // selection, append newly selected ids at the end.
  useEffect(() => {
    const ids = selectedClips.map((c) => c.id)
    setSlotOrder((prev) => {
      const kept = prev.filter((id) => ids.includes(id))
      const added = ids.filter((id) => !kept.includes(id))
      const next = [...kept, ...added]
      // Avoid a state churn loop when nothing actually changed.
      if (
        next.length === prev.length &&
        next.every((id, i) => id === prev[i])
      ) {
        return prev
      }
      return next
    })
  }, [selectedClips])

  const preset = getLayoutPreset(presetId)

  // The clips that would actually be placed (capped at the preset cell count).
  const cellCount = preset ? preset.cells.length : 0
  const orderedClipIds = useMemo<string[]>(() => {
    if (!preset) return []
    return slotOrder.slice(0, Math.min(slotOrder.length, cellCount))
  }, [preset, slotOrder, cellCount])

  // A shared layout group across the whole selection → offer "해제".
  const sharedGroupId = useMemo<string | null>(() => {
    if (selectedClips.length < 2) return null
    const first = selectedClips[0].layoutGroupId
    if (!first) return null
    return selectedClips.every((c) => c.layoutGroupId === first)
      ? first
      : null
  }, [selectedClips])

  const labelById = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>()
    for (const c of selectedClips) m.set(c.id, c.label)
    return m
  }, [selectedClips])

  const moveSlot = (index: number, dir: -1 | 1): void => {
    setSlotOrder((prev) => {
      const j = index + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      const tmp = next[index]
      next[index] = next[j]
      next[j] = tmp
      return next
    })
  }

  const handleApply = (): void => {
    if (!presetId || orderedClipIds.length < 2) return
    applyLayout(presetId, orderedClipIds)
  }

  return (
    <div style={styles.root} data-testid="layout-panel">
      <p style={styles.sectionLabel}>콜라주 · 분할화면</p>

      {selectedClips.length < 2 ? (
        <div style={styles.emptyHint} data-testid="layout-select-hint">
          클립을 2개 이상 선택하세요. 선택한 영상/오버레이 클립이 분할화면
          칸에 배치됩니다.
        </div>
      ) : (
        <p style={styles.hint}>
          {selectedClips.length}개 클립 선택됨 — 레이아웃을 고르세요.
        </p>
      )}

      {/* ---- Preset grid ---- */}
      <div style={styles.presetGrid} data-testid="layout-preset-grid">
        {LAYOUT_PRESETS.map((p) => {
          const active = presetId === p.id
          return (
            <button
              key={p.id}
              type="button"
              data-testid={`layout-preset-${p.id}`}
              aria-pressed={active}
              onClick={() => setPresetId(p.id)}
              style={{
                ...styles.presetCell,
                border: active
                  ? '2px solid #10b981'
                  : '1px solid #374151'
              }}
            >
              <PresetThumb preset={p} />
              <div>{p.label}</div>
            </button>
          )
        })}
      </div>

      {/* ---- Clip → cell slots ---- */}
      {preset && selectedClips.length >= 2 && (
        <>
          <hr style={styles.divider} />
          <p style={styles.sectionLabel}>
            칸 배치 ({orderedClipIds.length} / {cellCount})
          </p>
          {slotOrder.length > cellCount && (
            <p style={styles.hint}>
              이 레이아웃은 {cellCount}칸입니다 — 앞쪽 {cellCount}개 클립만
              배치돼요.
            </p>
          )}
          <div style={styles.slotList} data-testid="layout-slot-list">
            {slotOrder.map((id, index) => {
              const inUse = index < cellCount
              return (
                <div
                  key={id}
                  style={{
                    ...styles.slot,
                    ...(inUse ? {} : { opacity: 0.4 })
                  }}
                  data-testid={`layout-slot-${index}`}
                  data-clip-id={id}
                >
                  <span style={styles.slotIndex}>
                    {inUse ? index + 1 : '-'}
                  </span>
                  <span style={styles.slotName}>
                    {labelById.get(id) ?? id}
                  </span>
                  <button
                    type="button"
                    style={{
                      ...styles.slotBtn,
                      ...(index === 0 ? styles.slotBtnDisabled : {})
                    }}
                    disabled={index === 0}
                    onClick={() => moveSlot(index, -1)}
                    aria-label="위로"
                    data-testid={`layout-slot-${index}-up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    style={{
                      ...styles.slotBtn,
                      ...(index === slotOrder.length - 1
                        ? styles.slotBtnDisabled
                        : {})
                    }}
                    disabled={index === slotOrder.length - 1}
                    onClick={() => moveSlot(index, 1)}
                    aria-label="아래로"
                    data-testid={`layout-slot-${index}-down`}
                  >
                    ↓
                  </button>
                </div>
              )
            })}
          </div>
          <button
            type="button"
            style={styles.applyBtn}
            onClick={handleApply}
            disabled={orderedClipIds.length < 2}
            data-testid="layout-apply"
          >
            적용
          </button>
        </>
      )}

      {/* ---- Clear an existing layout ---- */}
      {sharedGroupId && (
        <>
          <hr style={styles.divider} />
          <p style={styles.hint}>
            선택한 클립이 이미 레이아웃에 묶여 있어요.
          </p>
          <button
            type="button"
            style={styles.clearBtn}
            onClick={() => clearLayout(sharedGroupId)}
            data-testid="layout-clear"
          >
            레이아웃 해제
          </button>
        </>
      )}
    </div>
  )
}

/** Short human label for a clip — its media file name, else its id tail. */
function clipLabel(project: Project, clip: Clip): string {
  if (isMediaClip(clip)) {
    const m = project.media[clip.mediaId]
    if (m && typeof m.fileName === 'string' && m.fileName) return m.fileName
    return `영상 ${clip.id.slice(-4)}`
  }
  if (isOverlayClip(clip)) return `오버레이 ${clip.id.slice(-4)}`
  return clip.id.slice(-4)
}
