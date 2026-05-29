import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { MediaLibrary } from '../components/MediaLibrary'
import { OverlayLibrary } from '../components/OverlayLibrary'
import { TranscriptPanel } from '../components/TranscriptPanel'
import { PreviewCanvas, PreviewGuidesControl } from '../components/PreviewCanvas'
import { AudioMeter } from '../components/AudioMeter'
import { ColorScopes } from '../components/ColorScopes'
import { SocialPreviewSelector } from '../components/SocialPreviewOverlay'
import { SilenceRemoveDialog } from '../components/SilenceRemoveDialog'
import { Timeline } from '../components/Timeline'
import { Transport } from '../components/Transport'
import { CaptionEditor } from '../components/CaptionEditor'
import { TextTemplatePicker } from '../components/TextTemplatePicker'
import { EffectsPanel } from '../components/EffectsPanel'
import { ExportDialog } from '../components/ExportDialog'
import { BatchExportDialog } from '../components/BatchExportDialog'
import { PrefillDialog } from '../components/PrefillDialog'
import { SttDialog } from '../components/SttDialog'
import { AutoEditDialog } from '../components/AutoEditDialog'
import { AutoReframeDialog } from '../components/AutoReframeDialog'
import { Toast, type ToastVariant } from '../components/Toast'
import { Tooltip } from '../components/Tooltip'
import { UpdateStatusPanel } from '../components/UpdateStatusPanel'
import type { PrefillResult } from '../lib/prefillFromReel'
import type { AutoEditSummary } from '../lib/autoEdit'
import { runBeatCut } from '../lib/beatCut'
import {
  getLastVisualMs,
  getTotalDurationMs,
  useProjectStore,
  useUndoRedo,
  newId
} from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import { markersToChapters } from '../lib/markerExport'
import {
  DEFAULT_CANVAS_BACKGROUND_COLOR,
  getCanvasBackground,
  isCaptionClip,
  isClipLocked,
  isMediaClip,
  isOverlayClip,
  MIN_PROGRESS_BAR_HEIGHT_FRAC,
  MAX_PROGRESS_BAR_HEIGHT_FRAC,
  type AspectRatio,
  type CanvasBackgroundKind,
  type Clip,
  type ProgressBarPosition,
  type Project,
  type VideoAudioClip
} from '../../../shared/project'
import {
  captionsToSubtitle,
  type SubtitleFormat
} from '../../../shared/subtitleExport'
import {
  addClipsToStore,
  cuesToClips,
  insertCaptionAtPlayhead,
  insertTextTemplateAtPlayhead
} from '../lib/captions'
import { getTextTemplate } from '../../../shared/textTemplates'

interface EditorProps {
  onBack: () => void
}

const ASPECT_OPTIONS: AspectRatio[] = ['9:16', '1:1', '16:9', '4:5']

const styles = {
  page: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#0d0d0d',
    color: '#f5f5f5',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  } as React.CSSProperties,
  topbar: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 16px',
    background: '#111',
    borderBottom: '1px solid #2a2a2a',
    minHeight: 52
  } as React.CSSProperties,
  backBtn: {
    background: 'transparent',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer'
  } as React.CSSProperties,
  nameInput: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 14,
    fontWeight: 600,
    width: 280
  } as React.CSSProperties,
  select: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer'
  } as React.CSSProperties,
  flex1: { flex: 1 } as React.CSSProperties,
  body: {
    flex: 1,
    display: 'grid',
    // Phase 3.45 — CapCut-style: 56px vertical icon rail + 280-320 secondary
    // panel + center work area. The rail switches which panel content shows.
    gridTemplateColumns: '56px minmax(280px, 320px) 1fr',
    overflow: 'hidden'
  } as React.CSSProperties,
  bodyWithEditor: {
    flex: 1,
    display: 'grid',
    gridTemplateColumns: '56px minmax(280px, 320px) 1fr 360px',
    overflow: 'hidden'
  } as React.CSSProperties,
  right: {
    display: 'grid',
    // pptx10 슬라이드 12 — preview / transport / [splitter] / timeline.
    // timeline row 높이는 사용자 drag 로 조절 (useState `timelinePanelHeight`).
    // splitter row 는 4px 고정. inline style 로 row template 매번 override.
    overflow: 'hidden'
  } as React.CSSProperties,
  rowSplitter: {
    cursor: 'row-resize',
    background: '#0a0a0a',
    borderTop: '1px solid #2a2a2a',
    borderBottom: '1px solid #2a2a2a',
    position: 'relative',
    transition: 'background 80ms ease'
  } as React.CSSProperties,
  rowSplitterActive: {
    background: '#4f46e5'
  } as React.CSSProperties,
  previewArea: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0a0a0a',
    borderBottom: '1px solid #2a2a2a',
    padding: 24,
    overflow: 'hidden',
    position: 'relative'
  } as React.CSSProperties,
  previewBox: {
    background: '#000',
    borderRadius: 8,
    width: '100%',
    height: '100%',
    maxWidth: '100%',
    maxHeight: '100%',
    boxSizing: 'border-box' as const
  } as React.CSSProperties,
  hint: {
    fontSize: 11,
    color: '#475569',
    marginLeft: 12
  } as React.CSSProperties,
  primaryBtn: {
    background: '#6366f1',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  secondaryBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer'
  } as React.CSSProperties,
  playheadInput: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 11,
    width: 90
  } as React.CSSProperties,
  undoBtn: {
    background: 'transparent',
    color: '#cbd5e1',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 14,
    lineHeight: 1,
    cursor: 'pointer',
    minWidth: 32,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4
  } as React.CSSProperties,
  undoBtnDisabled: {
    background: 'transparent',
    color: '#3f3f46',
    border: '1px solid #1f1f1f',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 14,
    lineHeight: 1,
    cursor: 'not-allowed',
    minWidth: 32,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4
  } as React.CSSProperties,
  undoBadge: {
    fontSize: 9,
    color: '#94a3b8',
    fontVariantNumeric: 'tabular-nums'
  } as React.CSSProperties,
  // Phase 3.45 — CapCut-style vertical icon rail (replaces the horizontal
  // text tabs that used to sit at the top of the left panel).
  iconRail: {
    display: 'flex',
    flexDirection: 'column' as const,
    background: '#101010',
    borderRight: '1px solid #2a2a2a',
    padding: '8px 4px',
    gap: 4,
    overflow: 'hidden'
  } as React.CSSProperties,
  iconRailBtn: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    background: 'transparent',
    color: '#9aa0a6',
    border: '1px solid transparent',
    borderRadius: 8,
    padding: '8px 4px',
    fontSize: 10,
    fontWeight: 600,
    cursor: 'pointer',
    lineHeight: 1.2
  } as React.CSSProperties,
  iconRailBtnActive: {
    background: '#1f2937',
    color: '#f5f5f5',
    borderColor: '#374151'
  } as React.CSSProperties,
  iconRailIcon: {
    fontSize: 20,
    lineHeight: 1
  } as React.CSSProperties,
  // Left-panel content host (no longer carries its own tab bar — the rail
  // beside it owns the switching).
  leftPanel: {
    display: 'flex',
    flexDirection: 'column' as const,
    minWidth: 280,
    background: '#141414',
    borderRight: '1px solid #2a2a2a',
    overflow: 'hidden'
  } as React.CSSProperties,
  leftPanelBody: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden'
  } as React.CSSProperties,
  // Phase 3.46 — popover menu styles for compact CapCut-style topbar.
  menuTriggerBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4
  } as React.CSSProperties,
  menuPopover: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: 10,
    boxShadow: '0 8px 20px rgba(0,0,0,0.6)',
    zIndex: 1000,
    minWidth: 200,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8
  } as React.CSSProperties,
  menuGroupLabel: {
    fontSize: 11,
    color: '#9aa0a6',
    fontWeight: 600
  } as React.CSSProperties,
  menuRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap' as const
  } as React.CSSProperties,
  exportSplit: {
    display: 'inline-flex',
    alignItems: 'center',
    position: 'relative'
  } as React.CSSProperties,
  exportSplitMainBtn: {
    background: '#6366f1',
    color: '#fff',
    border: 'none',
    borderTopLeftRadius: 6,
    borderBottomLeftRadius: 6,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  exportSplitChevronBtn: {
    background: '#4f46e5',
    color: '#fff',
    border: 'none',
    borderLeft: '1px solid rgba(255,255,255,0.18)',
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderTopRightRadius: 6,
    borderBottomRightRadius: 6,
    padding: '6px 8px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties
}

// ---------------------------------------------------------------------------
// Phase 3.46 — compact CapCut-style topbar. ToolbarMenu is a tiny click-to-
// open popover: trigger button (with a `▾` suffix) + an absolutely positioned
// panel below it. Clicking outside closes the popover (mousedown listener on
// the document). The popover's children render vertically so each control
// gets its own row.
// ---------------------------------------------------------------------------
interface ToolbarMenuProps {
  label: string
  testId: string
  children: ReactNode
}

function ToolbarMenu({ label, testId, children }: ToolbarMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const root = rootRef.current
      if (!root) return
      if (e.target instanceof Node && root.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  return (
    <div
      ref={rootRef}
      style={{ position: 'relative', display: 'inline-flex' }}
      data-testid={`${testId}-root`}
    >
      <button
        type="button"
        style={styles.menuTriggerBtn}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid={testId}
      >
        <span>{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          style={styles.menuPopover}
          data-testid={`${testId}-popover`}
        >
          {children}
        </div>
      )}
    </div>
  )
}

// Split button used for 내보내기 — primary action stays a visible button on
// the toolbar; the chevron opens a popover that hosts the secondary 일괄
// 내보내기 action.
interface ExportSplitButtonProps {
  onMain: () => void
  onBatch: () => void
}

function ExportSplitButton({
  onMain,
  onBatch
}: ExportSplitButtonProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const root = rootRef.current
      if (!root) return
      if (e.target instanceof Node && root.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  return (
    <div
      ref={rootRef}
      style={styles.exportSplit}
      data-testid="topbar-menu-export-root"
    >
      <button
        type="button"
        style={styles.exportSplitMainBtn}
        onClick={onMain}
        data-testid="open-export-dialog"
        title="내보내기 (Ctrl+E)"
      >
        내보내기
      </button>
      <button
        type="button"
        style={styles.exportSplitChevronBtn}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="내보내기 옵션"
        data-testid="topbar-menu-export"
      >
        ▾
      </button>
      {open && (
        <div
          role="menu"
          style={styles.menuPopover}
          data-testid="topbar-menu-export-popover"
        >
          <button
            style={styles.secondaryBtn}
            onClick={() => {
              setOpen(false)
              onBatch()
            }}
            data-testid="open-batch-export-dialog"
            title="여러 프리셋으로 한 번에 내보내기"
          >
            일괄 내보내기
          </button>
        </div>
      )}
    </div>
  )
}

export function Editor({ onBack }: EditorProps): JSX.Element {
  const project = useProjectStore((s) => s.project)
  const hydrated = useProjectStore((s) => s.hydrated)
  const setName = useProjectStore((s) => s.setName)
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio)
  const setCoverMs = useProjectStore((s) => s.setCoverMs)
  const clearCoverMs = useProjectStore((s) => s.clearCoverMs)
  const setProgressBar = useProjectStore((s) => s.setProgressBar)
  const toggleProgressBar = useProjectStore((s) => s.toggleProgressBar)
  const setCanvasBackground = useProjectStore((s) => s.setCanvasBackground)
  const canvasBg = getCanvasBackground(project)
  const removeClip = useProjectStore((s) => s.removeClip)
  const { undo, redo, canUndo, canRedo, pastCount, futureCount } = useUndoRedo()

  // Phase 2.2: playhead lives in the timelineUi store so Transport's rAF
  // loop and PreviewCanvas's <video>/<audio> sync share a single source of
  // truth.
  const playheadMs = useTimelineUi((s) => s.playheadMs)
  const setPlayheadMs = useTimelineUi((s) => s.setPlayheadMs)

  // pptx10 슬라이드 12 — timeline panel 높이를 사용자 drag 로 조절.
  // 캡컷 처럼 한번에 여러 트랙 보고 싶을 때 위로 끌어올림. localStorage
  // 로 persist. range: 160 ~ window.innerHeight * 0.7 (preview 최소 영역
  // 보장).
  const [timelinePanelHeight, setTimelinePanelHeight] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('reels-timeline-panel-height')
      const n = raw ? parseInt(raw, 10) : NaN
      return Number.isFinite(n) && n >= 160 ? n : 280
    } catch { return 280 }
  })
  const [splitterDragging, setSplitterDragging] = useState(false)

  // pptx10 슬라이드 13 — 프리뷰 분리 (pop-out). previewArea 통째로
  // position: fixed 로 floating, drag로 위치 + resize 가능. PreviewCanvas
  // 자체는 같은 DOM 위치 (video element reload 방지) 유지하고 wrapper
  // (previewArea) 의 style 만 변경. localStorage persist.
  const [previewDetached, setPreviewDetached] = useState<boolean>(() => {
    try { return localStorage.getItem('reels-preview-detached') === '1' } catch { return false }
  })

  // pptx10 슬라이드 13 (확장) — 진짜 BrowserWindow 분리 토글. 분리 ON 시
  // main process 가 OS-level window 띄움 → 다른 모니터 가능. main 안
  // floating placeholder 는 그대로 (분리 mode 표시용).
  type PrevExt = {
    previewWindow?: {
      openDetached: () => Promise<boolean>
      closeDetached: () => Promise<boolean>
      broadcast: (payload: unknown) => void
      onSyncApply: (cb: (payload: unknown) => void) => () => void
    }
  }
  useEffect(() => {
    const ext = (window as unknown as { electron?: PrevExt }).electron
    if (!ext?.previewWindow) return
    if (previewDetached) void ext.previewWindow.openDetached()
    else void ext.previewWindow.closeDetached()
  }, [previewDetached])
  // 양방향 sync — main 의 project/playhead/playing 변경마다 broadcast +
  // detached 의 변경 수신.
  const applyingSyncRef = useRef(false)
  useEffect(() => {
    const ext = (window as unknown as { electron?: PrevExt }).electron
    if (!ext?.previewWindow) return
    // 받기: detached 가 보낸 변경 적용.
    const off = ext.previewWindow.onSyncApply((payload) => {
      const msg = payload as { kind: string; value: unknown }
      if (!msg || typeof msg !== 'object') return
      applyingSyncRef.current = true
      try {
        if (msg.kind === 'request-initial-state') {
          // detached 가 hydrate 요청 → 현재 project 와 playhead 같이 보냄.
          const proj = useProjectStore.getState().project
          ext.previewWindow!.broadcast({ kind: 'project', value: proj })
          ext.previewWindow!.broadcast({ kind: 'playheadMs', value: useTimelineUi.getState().playheadMs })
          ext.previewWindow!.broadcast({ kind: 'playing', value: useTimelineUi.getState().playing })
          ext.previewWindow!.broadcast({ kind: 'previewSpeed', value: useTimelineUi.getState().previewSpeed })
        } else if (msg.kind === 'request-merge-back') {
          // Reels 11 슬라이드 13 — 분리 윈도우의 합치기 버튼 클릭 → 메인의
          // previewDetached 도 false 로 토글하여 placeholder 가 사라지고
          // in-app preview 가 다시 그려지도록 함.
          setPreviewDetached(false)
        } else if (msg.kind === 'project') {
          useProjectStore.getState()._hydrateFromDisk(msg.value as Project)
        } else if (msg.kind === 'playheadMs') {
          useTimelineUi.getState().setPlayheadMs(msg.value as number)
        } else if (msg.kind === 'playing') {
          useTimelineUi.getState().setPlaying(Boolean(msg.value))
        } else if (msg.kind === 'previewSpeed') {
          useTimelineUi.getState().setPreviewSpeed(Number(msg.value) || 1)
        }
      } finally {
        applyingSyncRef.current = false
      }
    })
    // 보내기: project 변경 마다 broadcast.
    const unsubProj = useProjectStore.subscribe((s, prev) => {
      if (applyingSyncRef.current) return
      if (s.project !== prev.project) {
        ext.previewWindow!.broadcast({ kind: 'project', value: s.project })
      }
    })
    const unsubUi = useTimelineUi.subscribe((s, prev) => {
      if (applyingSyncRef.current) return
      if (s.playheadMs !== prev.playheadMs) {
        ext.previewWindow!.broadcast({ kind: 'playheadMs', value: s.playheadMs })
      }
      if (s.playing !== prev.playing) {
        ext.previewWindow!.broadcast({ kind: 'playing', value: s.playing })
      }
      if (s.previewSpeed !== prev.previewSpeed) {
        ext.previewWindow!.broadcast({ kind: 'previewSpeed', value: s.previewSpeed })
      }
    })
    return () => { off(); unsubProj(); unsubUi() }
  }, [])
  const [detachedRect, setDetachedRect] = useState<{ x: number; y: number; w: number; h: number }>(() => {
    try {
      const raw = localStorage.getItem('reels-preview-detached-rect')
      if (raw) {
        const r = JSON.parse(raw)
        if (typeof r.x === 'number' && typeof r.y === 'number' && typeof r.w === 'number' && typeof r.h === 'number') return r
      }
    } catch {/*ignore*/}
    return { x: 80, y: 80, w: 360, h: 640 }
  })
  useEffect(() => {
    try {
      localStorage.setItem('reels-preview-detached', previewDetached ? '1' : '0')
      localStorage.setItem('reels-preview-detached-rect', JSON.stringify(detachedRect))
    } catch {/*ignore*/}
  }, [previewDetached, detachedRect])
  const onDetachedTitleMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX, startY = e.clientY
    const start = { ...detachedRect }
    const onMove = (mv: MouseEvent): void => {
      setDetachedRect({
        ...start,
        x: Math.max(0, Math.min(window.innerWidth - 100, start.x + (mv.clientX - startX))),
        y: Math.max(0, Math.min(window.innerHeight - 60, start.y + (mv.clientY - startY)))
      })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const onDetachedResizeMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX, startY = e.clientY
    const start = { ...detachedRect }
    const onMove = (mv: MouseEvent): void => {
      setDetachedRect({
        ...start,
        w: Math.max(200, start.w + (mv.clientX - startX)),
        h: Math.max(160, start.h + (mv.clientY - startY))
      })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  useEffect(() => {
    try {
      localStorage.setItem('reels-timeline-panel-height', String(timelinePanelHeight))
    } catch {/*ignore*/}
  }, [timelinePanelHeight])
  const onSplitterMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    setSplitterDragging(true)
    const startY = e.clientY
    const startH = timelinePanelHeight
    const onMove = (mv: MouseEvent): void => {
      const dy = startY - mv.clientY  // up-drag → larger timeline
      const max = Math.max(200, window.innerHeight * 0.7)
      const next = Math.max(160, Math.min(max, startH + dy))
      setTimelinePanelHeight(next)
    }
    const onUp = (): void => {
      setSplitterDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  // Phase 3.81 — preview playback speed.
  const previewSpeed = useTimelineUi((s) => s.previewSpeed)
  const setPreviewSpeed = useTimelineUi((s) => s.setPreviewSpeed)

  // Auto-pause playback when the editor unmounts (e.g., user clicks ← 홈).
  // Without this, `playing` stays true in the store, the rAF loop keeps
  // advancing the playhead while no video element exists, and remounting the
  // editor doesn't auto-resume due to a src-set/play() race.
  useEffect(() => {
    return () => {
      useTimelineUi.getState().setPlaying(false)
    }
  }, [])

  // Phase 3.81 — propagate previewSpeed to every <video>/<audio> element on
  // the page. Pure UI accelerator — doesn't touch the project or export.
  //
  // audit #13: the previous implementation re-applied after a 250ms
  // setTimeout to catch elements mounted right after the effect ran (e.g.
  // PreviewCanvas re-renders on clip change). That race broke on slow
  // disks where mount took longer. MutationObserver subscribes to the live
  // DOM and applies the rate to every <video>/<audio> the moment it lands —
  // no fixed deadline, no missed mounts.
  useEffect(() => {
    const apply = (el: HTMLMediaElement): void => {
      if (el.playbackRate !== previewSpeed) el.playbackRate = previewSpeed
    }
    // Pass 1 — every existing element.
    document
      .querySelectorAll<HTMLMediaElement>('video, audio')
      .forEach(apply)
    // Pass 2 — watch for new ones. We attach to <body> so any subtree
    // change (PreviewCanvas / AudioMeter / future panels) is observed.
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return
          if (node instanceof HTMLMediaElement) {
            apply(node)
          } else {
            node
              .querySelectorAll<HTMLMediaElement>('video, audio')
              .forEach(apply)
          }
        })
      }
    })
    obs.observe(document.body, { childList: true, subtree: true })
    return () => obs.disconnect()
  }, [previewSpeed])

  // Phase 3.72 — fullscreen preview. `F` key toggles the preview wrapper
  // into the browser's fullscreen mode; Esc / F again exits. The wrapper
  // already lays out as `aspectRatio: project.width / project.height`, so
  // the fullscreened view stays correctly letterboxed.
  const previewWrapRef = useRef<HTMLDivElement | null>(null)
  const togglePreviewFullscreen = useCallback((): void => {
    const el = previewWrapRef.current
    if (!el) return
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => {})
    } else {
      void el.requestFullscreen().catch(() => {})
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Ignore when the user is typing into an input / textarea / contenteditable.
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (t && t.isContentEditable)
      ) {
        return
      }
      // Plain `F` (no modifier) toggles preview fullscreen. Browsers reserve
      // F11 for window fullscreen; Electron lets the page intercept it but
      // we stick with plain F so the page-level shortcut composes cleanly.
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        togglePreviewFullscreen()
      }
      // Phase 3.80 — frame-step preview. `,` (or `<`) moves the playhead
      // one frame BACK; `.` (or `>`) moves it one frame FORWARD. Step is
      // derived from the project's framerate (defaults 30fps).
      if (
        (e.key === ',' || e.key === '<' || e.key === '.' || e.key === '>') &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const fps =
          (project as { fps?: number }).fps && (project as { fps?: number }).fps! > 0
            ? (project as { fps?: number }).fps!
            : 30
        const frameMs = 1000 / fps
        const back = e.key === ',' || e.key === '<'
        const cur = useTimelineUi.getState().playheadMs
        const next = Math.max(0, Math.round(cur + (back ? -frameMs : frameMs)))
        useTimelineUi.getState().setPlayheadMs(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePreviewFullscreen, project])

  // Local mirror so the input feels responsive; flush to store on blur/enter.
  const [draftName, setDraftName] = useState(project.name)
  useEffect(() => {
    setDraftName(project.name)
  }, [project.name])

  const commitName = (): void => {
    const trimmed = (draftName ?? '').trim()
    if (!trimmed) {
      setDraftName(project.name)
      return
    }
    if (trimmed !== project.name) setName(trimmed)
  }

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [editingCaptionId, setEditingCaptionId] = useState<string | null>(null)

  // pptx10 슬라이드 17 — Application Menu (Edit) → renderer dispatch.
  const clipboardRef = useRef<Clip[]>([])
  useEffect(() => {
    type ElectronExt = { appMenu?: { onAction: (cb: (a: string) => void) => () => void } }
    const ext = (window as unknown as { electron?: ElectronExt }).electron
    if (!ext?.appMenu?.onAction) return
    const off = ext.appMenu.onAction((action) => {
      const projStore = useProjectStore.getState()
      const uiStore = useTimelineUi.getState()
      const project = projStore.project
      const selIds = Array.from(uiStore.selectedClipIds)
      const collectSelected = (): Clip[] => {
        const out: Clip[] = []
        for (const t of project.tracks) for (const c of t.clips) if (selIds.includes(c.id)) out.push(c)
        return out
      }
      switch (action) {
        case 'undo':
          useProjectStore.temporal.getState().undo()
          break
        case 'redo':
          useProjectStore.temporal.getState().redo()
          break
        case 'selectAll': {
          const ids: string[] = []
          for (const t of project.tracks) for (const c of t.clips) ids.push(c.id)
          useTimelineUi.setState({
            selectedClipIds: new Set(ids),
            selectedAdjustmentLayerId: null
          })
          break
        }
        case 'copy':
          clipboardRef.current = collectSelected().map((c) => ({ ...c }))
          break
        case 'cut': {
          const sel = collectSelected()
          clipboardRef.current = sel.map((c) => ({ ...c }))
          for (const c of sel) projStore.removeClip(c.id)
          uiStore.clearSelection()
          break
        }
        case 'paste': {
          if (clipboardRef.current.length === 0) break
          const phead = uiStore.playheadMs
          const minStart = clipboardRef.current.reduce(
            (m, c) => Math.min(m, c.startMs), Infinity
          )
          for (const src of clipboardRef.current) {
            const offset = src.startMs - minStart
            const dur = src.endMs - src.startMs
            const newClip = {
              ...src,
              id: newId(),
              startMs: phead + offset,
              endMs: phead + offset + dur,
              groupId: undefined
            }
            projStore.addClip(newClip as Clip)
          }
          break
        }
        case 'delete': {
          for (const c of collectSelected()) {
            try { projStore.removeClip(c.id) } catch {/*locked*/}
          }
          const adjId = uiStore.selectedAdjustmentLayerId
          if (adjId) projStore.removeAdjustmentLayer(adjId)
          uiStore.clearSelection()
          break
        }
        case 'duplicate': {
          for (const c of collectSelected()) projStore.duplicateClip(c.id)
          break
        }
        case 'split': {
          const phead = uiStore.playheadMs
          for (const c of collectSelected()) {
            if (phead > c.startMs && phead < c.endMs) {
              try { projStore.splitClipAt(c.id, phead) } catch {/*ignore*/}
            }
          }
          break
        }
      }
    })
    return () => off()
  }, [])
  const [srtError, setSrtError] = useState<string | null>(null)
  // Phase 3.34 — subtitle (.srt/.vtt) export. Transient UI state only.
  const [subtitleFormat, setSubtitleFormat] = useState<SubtitleFormat>('srt')

  // Live count of caption clips across all caption tracks — drives the
  // 자막 파일 내보내기 button's disabled state. Read via a selector so it
  // re-renders when captions are added/removed.
  const captionClipCount = useProjectStore((s) =>
    s.project.tracks
      .filter((t) => t.kind === 'caption')
      .reduce((sum, t) => sum + t.clips.length, 0)
  )
  const [silenceTargetClipId, setSilenceTargetClipId] = useState<string | null>(
    null
  )
  const [exportOpen, setExportOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  // Phase 7 — CapCut-style docked 효과 panel. Transient UI state only: this
  // toggle and the panel's inner tab are NOT part of the project schema/undo.
  const [effectsOpen, setEffectsOpen] = useState(false)
  // Left-panel tab — 미디어 / 오버레이 / 대본 (Phase 3.8 + 3.17).
  const [leftTab, setLeftTab] = useState<'media' | 'overlay' | 'transcript'>(
    'media'
  )
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [prefillOpen, setPrefillOpen] = useState(false)
  const [sttOpen, setSttOpen] = useState(false)
  const [autoEditOpen, setAutoEditOpen] = useState(false)
  const [autoReframeOpen, setAutoReframeOpen] = useState(false)
  const [toast, setToast] = useState<{
    message: string
    variant: ToastVariant
    id: number
    /** Optional override for Toast's variant-based default duration. */
    durationMs?: number
  } | null>(null)

  const handlePrefillComplete = useCallback((result: PrefillResult): void => {
    if (result.ok) {
      const parts = [`릴스 ${result.shortcode}의 분석 결과를 가져왔습니다`]
      const inner: string[] = []
      inner.push(`자막 ${result.captionsAdded}개`)
      if (result.beatsAdded > 0) inner.push(`비트 ${result.beatsAdded}개`)
      if (result.bgmSegmentsDetected > 0) {
        inner.push(`BGM 구간 ${result.bgmSegmentsDetected}개 감지`)
      }
      const message = `${parts[0]} (${inner.join(', ')})`
      setToast({ message, variant: 'success', id: Date.now() })
      setPrefillOpen(false)
    } else {
      setToast({
        message: `가져오기 실패: ${result.error}`,
        variant: 'error',
        id: Date.now()
      })
      // Keep dialog open on error so the user can retry.
    }
  }, [])

  const handleSttComplete = useCallback((count: number): void => {
    setToast({
      message: `자막 ${count}개를 생성했습니다 · Ctrl+Z로 되돌리기`,
      variant: 'success',
      // 6s — long enough to read the undo hint without sticking around.
      durationMs: 6000,
      id: Date.now()
    })
    setSttOpen(false)
  }, [])

  const handleAutoEditComplete = useCallback(
    (summary: AutoEditSummary): void => {
      const parts = [
        `무음 ${summary.rangesRemoved}개 구간 · ${(
          summary.msRemoved / 1000
        ).toFixed(1)}초 제거`
      ]
      if (summary.captionsAdded > 0) {
        parts.push(`자막 ${summary.captionsAdded}개 생성`)
      }
      setToast({
        message: `자동 편집 완료 — ${parts.join(', ')}`,
        variant: 'success',
        id: Date.now()
      })
    },
    []
  )

  // Phase 2.5 — manual BPM + beat snap UI.
  const bpm = useTimelineUi((s) => s.bpm)
  const setBpm = useTimelineUi((s) => s.setBpm)
  const beatSnapEnabled = useTimelineUi((s) => s.beatSnapEnabled)
  const setBeatSnapEnabled = useTimelineUi((s) => s.setBeatSnapEnabled)
  const setBeats = useTimelineUi((s) => s.setBeats)

  const totalDuration = useMemo(
    () => getTotalDurationMs(project),
    [project]
  )

  // The currently selected clip, if it's effect-eligible (media or overlay).
  // Captions are edited via CaptionEditor instead, so they don't qualify.
  const effectsClipId = useMemo<string | null>(() => {
    if (!selectedClipId) return null
    let found: Clip | null = null
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => cc.id === selectedClipId)
      if (c) {
        found = c
        break
      }
    }
    if (!found) return null
    return isMediaClip(found) || isOverlayClip(found) ? found.id : null
  }, [selectedClipId, project])

  // Phase 3.32 — when an adjustment layer is selected, the 효과 panel shows
  // its grade editor. Selecting a layer is itself an explicit edit intent, so
  // the panel auto-shows for a layer regardless of the `effectsOpen` toggle.
  const selectedAdjustmentLayerId = useTimelineUi(
    (s) => s.selectedAdjustmentLayerId
  )

  // The 효과 panel is shown when the user has toggled it on AND an effect-
  // eligible clip is selected, OR whenever an adjustment layer is selected.
  // The caption editor takes the same 360px right slot, so it wins when a
  // caption is being edited.
  const showEffectsPanel =
    !editingCaptionId &&
    ((effectsOpen && !!effectsClipId) || !!selectedAdjustmentLayerId)

  const findClipById = useCallback(
    (id: string | null): Clip | null => {
      if (!id) return null
      for (const t of project.tracks) {
        const c = t.clips.find((cc) => cc.id === id)
        if (c) return c
      }
      return null
    },
    [project]
  )

  const handleSelectClip = useCallback(
    (id: string | null): void => {
      setSelectedClipId(id)
      const clip = findClipById(id)
      if (clip && !isCaptionClip(clip)) {
        setEditingCaptionId(null)
      }
    },
    [findClipById]
  )

  const handleOpenEffectsClip = useCallback(
    (id: string): void => {
      const clip = findClipById(id)
      if (!clip || (!isMediaClip(clip) && !isOverlayClip(clip))) return
      setSelectedClipId(id)
      setEditingCaptionId(null)
      setEffectsOpen(true)
    },
    [findClipById]
  )

  const openTextTemplatePicker = useCallback((): void => {
    setEditingCaptionId(null)
    setEffectsOpen(false)
    useTimelineUi.getState().setSelectedAdjustmentLayerId(null)
    setTemplatePickerOpen(true)
  }, [])

  // Recompute beats whenever BPM or total duration changes — but ONLY if
  // current beats originated from the metronome. When prefill loads real
  // detected beats (`beatsSource === 'detected'`), preserve them so the
  // metronome doesn't overwrite real timestamps.
  useEffect(() => {
    if (useTimelineUi.getState().beatsSource !== 'metronome') return
    const periodMs = (60 * 1000) / Math.max(1, bpm)
    const cap = Math.max(0, totalDuration)
    if (cap <= 0 || !Number.isFinite(periodMs) || periodMs <= 0) {
      setBeats([], 'metronome')
      return
    }
    const beats: number[] = []
    const MAX_BEATS = 4096
    for (let t = 0; t <= cap && beats.length < MAX_BEATS; t += periodMs) {
      beats.push(Math.round(t))
    }
    setBeats(beats, 'metronome')
  }, [bpm, totalDuration, setBeats])

  const handleAddCaption = useCallback((): void => {
    const id = insertCaptionAtPlayhead(playheadMs)
    if (id) {
      setSelectedClipId(id)
      setEditingCaptionId(id)
    }
  }, [playheadMs])

  // Phase 3.82 — preset position add. Inserts a caption then patches its
  // `style.yPosition` to a fixed value (top / center / bottom). 0 = canvas
  // top, 1 = canvas bottom; we use 0.15 / 0.5 / 0.85 to avoid hugging the
  // edges.
  const handleAddCaptionAt = useCallback(
    (yPos: number): void => {
      const id = insertCaptionAtPlayhead(playheadMs)
      if (!id) return
      // Style merge is shallow in `updateCaption` — only yPosition is
      // touched, every other style field on the inserted caption survives.
      useProjectStore
        .getState()
        .updateCaption(id, {
          style: { yPosition: yPos } as unknown as never
        })
      setSelectedClipId(id)
      setEditingCaptionId(id)
    },
    [playheadMs]
  )

  // Phase 3.24 — apply a text template. Inserts a plain caption clip, then
  // selects it + opens CaptionEditor (mirrors handleAddCaption) so the user
  // can immediately edit the template's sample text.
  const handleApplyTemplate = useCallback(
    (templateId: string): void => {
      const tpl = getTextTemplate(templateId)
      if (!tpl) return
      const id = insertTextTemplateAtPlayhead(tpl, playheadMs)
      if (id) {
        setSelectedClipId(id)
        setEditingCaptionId(id)
        setTemplatePickerOpen(false)
      }
    },
    [playheadMs]
  )

  // Phase 3.48 — BPM-based beat-sync auto-cut. Reads the global BPM from
  // timelineUi and the first selected media clip; reports the result via toast.
  const handleBeatCut = useCallback((step: 1 | 2 | 4 = 1): void => {
    const result = runBeatCut({ step })
    if (result.reason === 'no-bpm') {
      setToast({
        message: 'BPM을 먼저 입력하세요 (옵션 메뉴)',
        variant: 'error',
        id: Date.now()
      })
      return
    }
    if (result.reason === 'no-selection') {
      setToast({
        message: '비트로 자를 클립을 먼저 선택하세요',
        variant: 'error',
        id: Date.now()
      })
      return
    }
    if (result.reason === 'not-media-clip') {
      setToast({
        message: '미디어 클립만 비트로 자를 수 있어요',
        variant: 'error',
        id: Date.now()
      })
      return
    }
    if (result.reason === 'clip-locked') {
      setToast({
        message: '잠긴 클립은 자를 수 없어요',
        variant: 'error',
        id: Date.now()
      })
      return
    }
    if (result.reason === 'no-beats-in-range') {
      setToast({
        message: '클립 범위 안에 비트가 없습니다 — BPM을 확인하세요',
        variant: 'info',
        id: Date.now()
      })
      return
    }
    setToast({
      message: `비트로 ${result.cuts}회 잘랐어요 (Ctrl+Z 로 되돌리기)`,
      variant: 'success',
      id: Date.now()
    })
  }, [])

  const handleImportSrt = useCallback(async (): Promise<void> => {
    setSrtError(null)
    try {
      const picked = await window.electron.fs.pickFile([
        { name: 'Captions', extensions: ['srt', 'vtt'] }
      ])
      if (!picked) return
      const cues = await window.electron.captions.importSrt(picked)
      if (!cues || cues.length === 0) {
        setSrtError('자막 파일에 큐를 찾지 못했어요.')
        return
      }
      const clips = cuesToClips(cues)
      addClipsToStore(clips)
    } catch (err) {
      setSrtError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // Phase 3.34 — export caption clips as a `.srt` / `.vtt` file. Read-only on
  // the project store: gathers caption clips, builds the subtitle document,
  // and writes it via the allow-listed `captions.exportSubtitle` IPC. Never
  // mutates the project and does not touch the video/mp4 export pipeline.
  const handleExportSubtitle = useCallback(async (): Promise<void> => {
    setSrtError(null)
    try {
      const clips = project.tracks
        .filter((t) => t.kind === 'caption')
        .flatMap((t) => t.clips)
        .filter(isCaptionClip)
      if (clips.length === 0) return
      const content = captionsToSubtitle(clips, subtitleFormat)
      const picked = await window.electron.fs.saveFile(
        `captions.${subtitleFormat}`
      )
      if (!picked) return
      const result = await window.electron.captions.exportSubtitle(
        picked,
        content
      )
      if (result.ok) {
        setToast({
          message: `자막 파일을 내보냈습니다 (${result.bytesWritten.toLocaleString()} bytes)`,
          variant: 'success',
          id: Date.now()
        })
      } else {
        setSrtError(result.error)
      }
    } catch (err) {
      setSrtError(err instanceof Error ? err.message : String(err))
    }
  }, [project, subtitleFormat])

  // -----------------------------------------------------------------------
  // Keyboard shortcuts (Space is handled by Transport).
  //   C                     insert caption at playhead
  //   Delete / Backspace    remove the selected clip (media OR caption)
  //   Ctrl+D / Cmd+D        duplicate the selected clip
  //   S                     split selected media clip at playhead
  //   ← / →                 move playhead by 1 frame (1000/fps ms)
  //   Shift+← / Shift+→     move playhead by 1 second
  //   Home / End            playhead to 0 / total duration
  // -----------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      const inputType = (target as HTMLInputElement | null)?.type ?? ''
      // pptx11 슬라이드 22 — 색보정/필터 슬라이더(input[type=range])에 focus
      // 가 있는 상태로 Ctrl+Z 를 누르면 keydown 핸들러가 input 이라는 이유로
      // early-return 해서 undo 가 안 먹힘. range/number/checkbox/radio/button
      // 같이 텍스트 편집과 무관한 input 은 native cut/copy/paste/undo 행동이
      // 없으므로 우리 단축키가 동작해도 안전.
      const isNonTextInput =
        tag === 'input' &&
        ['range', 'number', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(inputType)
      if (
        (tag === 'input' && !isNonTextInput) ||
        tag === 'textarea' ||
        tag === 'select' ||
        target?.isContentEditable
      ) {
        return
      }

      // 단독 C 키 → 자막 추가. Ctrl+C 는 아래의 Copy 핸들러로 흘려보냄.
      if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        handleAddCaption()
        return
      }

      // Ctrl/Cmd+Shift+Z OR Ctrl/Cmd+Y → redo. Check redo BEFORE plain
      // Ctrl+Z so the shift combo isn't swallowed.
      if (
        (e.ctrlKey || e.metaKey) &&
        ((e.shiftKey && (e.key === 'z' || e.key === 'Z' || e.key === 'ㅋ')) ||
          (e.key === 'y' || e.key === 'Y' || e.key === 'ㅛ'))
      ) {
        e.preventDefault()
        useProjectStore.temporal.getState().redo()
        return
      }

      // Ctrl/Cmd+Z (no shift) → undo.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        (e.key === 'z' || e.key === 'Z' || e.key === 'ㅋ')
      ) {
        e.preventDefault()
        useProjectStore.temporal.getState().undo()
        return
      }

      // Ctrl/Cmd+E → open export dialog.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        setExportOpen(true)
        return
      }

      // Ctrl/Cmd+I → open prefill (분석 결과 가져오기) dialog.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        setPrefillOpen(true)
        return
      }

      // Ctrl/Cmd+T → open the 자동 자막 생성 (STT) dialog.
      if ((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        setSttOpen(true)
        return
      }

      // Ctrl/Cmd+Shift+A → open the 자동 편집 (auto rough-cut) dialog.
      // 'ㅁ' = the Hangul 2-set key under A (matches the undo/redo 'ㅋ' style).
      // The Shift combo here can't clash with redo (redo keys on z/Z/ㅋ or y).
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        (e.key === 'a' || e.key === 'A' || e.key === 'ㅁ')
      ) {
        e.preventDefault()
        setAutoEditOpen(true)
        return
      }

      // Ctrl/Cmd+A → 모든 클립 선택. pptx11 슬라이드 15 follow-up — appMenu.ts
      // accelerator만 있을 때 (focus 위치에 따라) OS / browser 가 Ctrl+A 를
      // 먼저 잡아가서 메뉴 click 이 fire 되지 않는 일이 있음. renderer
      // keydown 도 같이 잡아 fallback (Ctrl+D, Ctrl+B 가 이미 같은 패턴).
      // Ctrl+Shift+A 는 위에서 이미 분기 처리 후 return 했으므로 여기 안 들어옴.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === 'a' || e.key === 'A' || e.key === 'ㅁ')
      ) {
        e.preventDefault()
        const proj = useProjectStore.getState().project
        const ids: string[] = []
        for (const t of proj.tracks) for (const c of t.clips) ids.push(c.id)
        useTimelineUi.setState({
          selectedClipIds: new Set(ids),
          selectedAdjustmentLayerId: null
        })
        return
      }

      // Ctrl/Cmd+X (Cut), Ctrl/Cmd+C (Copy), Ctrl/Cmd+V (Paste) — pptx11
      // 슬라이드 15 follow-up. appMenu accelerator 가 focus 위치에 따라 안
      // 먹히는 케이스 fallback. 위쪽 input/textarea 가드를 이미 통과한 상태
      // (타임라인 등 일반 element focus) 라 native 텍스트 cut/copy/paste 와는
      // 충돌하지 않음. clipboardRef 는 Editor 함수 컴포넌트 상단(line ~798)
      // 에서 선언, IPC 핸들러와 같은 ref 를 공유 → 메뉴 click 이든 keydown
      // 이든 같은 buffer 를 채우고/읽는다.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === 'x' || e.key === 'X' || e.key === 'ㅌ')
      ) {
        e.preventDefault()
        const proj = useProjectStore.getState().project
        const selIds = Array.from(useTimelineUi.getState().selectedClipIds)
        const selClips: Clip[] = []
        for (const t of proj.tracks)
          for (const c of t.clips)
            if (selIds.includes(c.id)) selClips.push(c)
        clipboardRef.current = selClips.map((c) => ({ ...c }))
        for (const c of selClips) useProjectStore.getState().removeClip(c.id)
        useTimelineUi.getState().clearSelection()
        return
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === 'c' || e.key === 'C' || e.key === 'ㅊ')
      ) {
        e.preventDefault()
        const proj = useProjectStore.getState().project
        const selIds = Array.from(useTimelineUi.getState().selectedClipIds)
        const selClips: Clip[] = []
        for (const t of proj.tracks)
          for (const c of t.clips)
            if (selIds.includes(c.id)) selClips.push(c)
        clipboardRef.current = selClips.map((c) => ({ ...c }))
        return
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === 'v' || e.key === 'V' || e.key === 'ㅍ')
      ) {
        e.preventDefault()
        if (clipboardRef.current.length === 0) return
        const phead = useTimelineUi.getState().playheadMs
        const minStart = clipboardRef.current.reduce(
          (m, c) => Math.min(m, c.startMs),
          Infinity
        )
        for (const src of clipboardRef.current) {
          const offset = src.startMs - minStart
          const dur = src.endMs - src.startMs
          const newClip = {
            ...src,
            id: newId(),
            startMs: phead + offset,
            endMs: phead + offset + dur,
            groupId: undefined
          }
          useProjectStore.getState().addClip(newClip as Clip)
        }
        return
      }

      const store = useProjectStore.getState()
      const ui = useTimelineUi.getState()
      const fps = store.project.fps || 30
      const frameMs = Math.max(1, Math.round(1000 / fps))

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const step = e.shiftKey ? 1000 : frameMs
        ui.setPlayheadMs(Math.max(0, ui.playheadMs - step))
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        const step = e.shiftKey ? 1000 : frameMs
        const cap = getTotalDurationMs(store.project)
        // pptx10 슬라이드 10 — clip 범위 half-open (`ms < endMs`) 이라 cap
        // 도달 시 빈 화면. 1ms 안쪽으로 clamp.
        const maxPark = cap > 0 ? Math.max(0, cap - 1) : Infinity
        ui.setPlayheadMs(Math.min(maxPark, ui.playheadMs + step))
        return
      }
      if (e.key === 'Home') {
        e.preventDefault()
        ui.setPlayheadMs(0)
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        // pptx11 슬라이드 7 — End 키도 Transport "끝" 버튼과 동일 의미.
        // 비디오 트랙의 마지막 프레임 (audio/caption 너머 검은 화면 방지).
        const cap = getLastVisualMs(store.project)
        ui.setPlayheadMs(Math.max(0, cap - 1))
        return
      }

      // pptx10 슬라이드 11 — 조정 레이어 선택 + Delete/Backspace 로 삭제.
      // 이전엔 효과 탭의 빨간 "조정 레이어 삭제" 버튼만 동작했음. clip
      // selection 검사 전에 먼저 처리. 다른 키 (split, duplicate 등) 는
      // 조정 레이어 대상 없으므로 Delete/Backspace 만 단축처리.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const adjId = useTimelineUi.getState().selectedAdjustmentLayerId
        if (adjId) {
          e.preventDefault()
          store.removeAdjustmentLayer(adjId)
          useTimelineUi.getState().clearSelection()
          setToast({
            message: '조정 레이어 삭제됨 · Ctrl+Z로 되돌리기',
            variant: 'info',
            durationMs: 6000,
            id: Date.now()
          })
          return
        }
        // Reels 11 슬라이드 9 — 갭 선택 + DEL → ripple 삭제(뒷 클립 좌이동).
        const gap = useTimelineUi.getState().selectedGap
        if (gap) {
          e.preventDefault()
          store.rippleRemoveGap(gap.trackId, gap.startMs, gap.endMs)
          useTimelineUi.getState().setSelectedGap(null)
          setToast({
            message: '빈 공간 삭제됨 · Ctrl+Z로 되돌리기',
            variant: 'info',
            durationMs: 6000,
            id: Date.now()
          })
          return
        }
      }

      const sel = useTimelineUi.getState().selectedClipIds
      const firstSelected = (sel.size > 0 ? sel.values().next().value : null) ?? null
      if (!firstSelected) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        // Reels 11 슬라이드 8 — multi-select 일괄 삭제. selectedClipIds 전부를
        // 한 번에 제거 (locked 멤버는 skip). 토스트는 마지막 삭제 클립 종류로
        // 표시(혼합이면 "클립").
        const selectedIds = [...sel]
        type Found = { clip: Clip; trackKind: 'video' | 'audio' | 'overlay' | 'caption' }
        const found: Found[] = []
        for (const id of selectedIds) {
          for (const t of store.project.tracks) {
            const c = t.clips.find((cc) => cc.id === id)
            if (c) {
              found.push({ clip: c, trackKind: t.kind as Found['trackKind'] })
              break
            }
          }
        }
        const deletable = found.filter((f) => !isClipLocked(f.clip))
        if (deletable.length === 0) return
        let kindLabel = '클립'
        if (deletable.length === 1) {
          const only = deletable[0]
          if (only.clip.kind === 'caption') kindLabel = '자막'
          else if (only.clip.kind === 'overlay') kindLabel = '오버레이'
          else if (only.clip.kind === 'media') {
            kindLabel = only.trackKind === 'audio' ? '오디오' : '클립'
          }
        } else {
          kindLabel = `${deletable.length}개 클립`
        }
        for (const { clip } of deletable) {
          store.removeClip(clip.id)
        }
        useTimelineUi.getState().clearSelection()
        const deletedIds = new Set(deletable.map((d) => d.clip.id))
        setSelectedClipId((cur) => (cur && deletedIds.has(cur) ? null : cur))
        if (editingCaptionId && deletedIds.has(editingCaptionId)) {
          setEditingCaptionId(null)
        }
        setToast({
          message: `${kindLabel} 삭제됨 · Ctrl+Z로 되돌리기`,
          variant: 'info',
          durationMs: 6000,
          id: Date.now()
        })
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        // Reels 11 슬라이드 8 — multi-select 일괄 복제. 선택된 모든 클립을
        // 차례대로 duplicate. 마지막 새 id 를 active 로.
        const selectedIds = [...sel]
        const newIds: string[] = []
        for (const id of selectedIds) {
          const nid = store.duplicateClip(id)
          if (nid) newIds.push(nid)
        }
        if (newIds.length > 0) {
          useTimelineUi.setState({
            selectedClipIds: new Set(newIds),
            selectedAdjustmentLayerId: null
          })
          setSelectedClipId(newIds[newIds.length - 1])
        }
        return
      }
      // 분할(자르기): S (모디파이어 없음) 또는 Ctrl/Cmd+B (캡컷 표준 단축키).
      // 'ㅠ' = 한글 2벌식 자판에서 B 키 (undo/redo의 'ㅋ' 처리와 동일 패턴).
      const isSplitKey =
        ((e.key === 's' || e.key === 'S') &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey) ||
        ((e.ctrlKey || e.metaKey) &&
          !e.altKey &&
          !e.shiftKey &&
          (e.key === 'b' || e.key === 'B' || e.key === 'ㅠ'))
      if (isSplitKey) {
        e.preventDefault()
        // Reels 11 슬라이드 8 — multi-select 일괄 split. 선택된 media 클립
        // 중 playhead 가 그 안에 걸린 것들만 잘림.
        const ph = useTimelineUi.getState().playheadMs
        for (const id of [...sel]) {
          for (const t of store.project.tracks) {
            const c = t.clips.find((cc) => cc.id === id)
            if (c) {
              if (isMediaClip(c) && c.startMs < ph && ph < c.endMs) {
                store.splitClipAt(id, ph)
              }
              break
            }
          }
        }
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleAddCaption, editingCaptionId])

  return (
    <div style={styles.page} data-testid="editor-page">
      <div style={styles.topbar}>
        <button
          style={styles.backBtn}
          onClick={onBack}
          data-testid="editor-back-button"
        >
          ← 홈
        </button>
        <input
          style={styles.nameInput}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              ;(e.target as HTMLInputElement).blur()
            } else if (e.key === 'Escape') {
              setDraftName(project.name)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          placeholder="프로젝트 이름"
          aria-label="프로젝트 이름"
          data-testid="project-name-input"
        />

        <label style={styles.hint} htmlFor="aspect-ratio-select">
          비율
        </label>
        <select
          id="aspect-ratio-select"
          style={styles.select}
          value={project.aspectRatio}
          onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
          data-testid="aspect-ratio-select"
        >
          {ASPECT_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <div style={styles.hint}>
          {project.width}×{project.height} · {project.fps}fps
        </div>

        {/* Phase 3.46 — testid 보존을 위해 빈 hint 노드만 남긴다 (e2e 의존). */}
        <span data-testid="aspect-ratio-hint" style={{ display: 'none' }} />

        <div style={styles.flex1} />

        {/* audit #12 — undo/redo wrapped in <Tooltip>. The wrapper also
            keeps the native `title=` so anything that doesn't see the
            popover (screen readers, some ATs) still gets the hint. */}
        <Tooltip label="실행 취소 (Ctrl+Z)">
          <button
            type="button"
            style={canUndo ? styles.undoBtn : styles.undoBtnDisabled}
            onClick={() => undo()}
            disabled={!canUndo}
            aria-label="실행 취소"
            data-testid="undo-button"
            data-can-undo={canUndo ? 'true' : 'false'}
          >
            <span aria-hidden>↶</span>
            {pastCount > 0 && <span style={styles.undoBadge}>{pastCount}</span>}
          </button>
        </Tooltip>
        <Tooltip label="다시 실행 (Ctrl+Shift+Z)">
          <button
            type="button"
            style={canRedo ? styles.undoBtn : styles.undoBtnDisabled}
            onClick={() => redo()}
            disabled={!canRedo}
            aria-label="다시 실행"
            data-testid="redo-button"
            data-can-redo={canRedo ? 'true' : 'false'}
          >
            <span aria-hidden>↷</span>
            {futureCount > 0 && <span style={styles.undoBadge}>{futureCount}</span>}
          </button>
        </Tooltip>

        {/* Phase 3.46 — 자막 메뉴 popover: 자막 추가/SRT 가져오기/형식/내보내기 */}
        <ToolbarMenu label="자막" testId="topbar-menu-captions">
          <button
            style={styles.primaryBtn}
            onClick={handleAddCaption}
            data-testid="add-caption-button"
          >
            + 자막 추가
          </button>
          {/* Phase 3.82 — quick position-preset add buttons. */}
          <div style={styles.menuGroupLabel}>위치 프리셋</div>
          <div style={styles.menuRow}>
            <button
              type="button"
              style={{ ...styles.secondaryBtn, flex: 1 }}
              onClick={() => handleAddCaptionAt(0.15)}
              data-testid="add-caption-top"
              title="상단(15%) 위치에 자막 추가"
            >
              ↑ 상단
            </button>
            <button
              type="button"
              style={{ ...styles.secondaryBtn, flex: 1 }}
              onClick={() => handleAddCaptionAt(0.5)}
              data-testid="add-caption-center"
              title="중앙(50%) 위치에 자막 추가"
            >
              ↔ 중앙
            </button>
            <button
              type="button"
              style={{ ...styles.secondaryBtn, flex: 1 }}
              onClick={() => handleAddCaptionAt(0.85)}
              data-testid="add-caption-bottom"
              title="하단(85%) 위치에 자막 추가"
            >
              ↓ 하단
            </button>
          </div>
          <button
            style={styles.secondaryBtn}
            onClick={handleImportSrt}
            data-testid="import-srt-button"
          >
            SRT 가져오기
          </button>
          <div style={styles.menuGroupLabel}>자막 파일 내보내기</div>
          <div style={styles.menuRow}>
            <select
              style={styles.select}
              value={subtitleFormat}
              onChange={(e) =>
                setSubtitleFormat(e.target.value as SubtitleFormat)
              }
              aria-label="자막 파일 형식"
              data-testid="export-subtitle-format"
            >
              <option value="srt">srt</option>
              <option value="vtt">vtt</option>
            </select>
            <button
              style={{
                ...styles.secondaryBtn,
                ...(captionClipCount === 0
                  ? { opacity: 0.5, cursor: 'not-allowed' }
                  : {})
              }}
              onClick={handleExportSubtitle}
              disabled={captionClipCount === 0}
              data-testid="export-srt-button"
              title="자막 클립을 .srt/.vtt 파일로 내보내기"
            >
              자막 파일 내보내기
            </button>
          </div>
        </ToolbarMenu>

        {/* Phase 3.46 — AI 메뉴 popover */}
        <ToolbarMenu label="AI" testId="topbar-menu-ai">
          <button
            style={styles.primaryBtn}
            onClick={() => setPrefillOpen(true)}
            data-testid="open-prefill-dialog"
            title="분석 결과 가져오기 (Ctrl+I)"
          >
            분석 결과 가져오기
          </button>
          <button
            style={styles.primaryBtn}
            onClick={() => setSttOpen(true)}
            data-testid="open-stt-dialog"
            title="자동 자막 생성 (Ctrl+T)"
          >
            자동 자막 생성
          </button>
          <button
            style={styles.primaryBtn}
            onClick={() => setAutoEditOpen(true)}
            data-testid="open-autoedit-dialog"
            title="자동 러프컷 (Ctrl+Shift+A)"
          >
            자동 편집
          </button>
          <button
            style={styles.primaryBtn}
            onClick={() => setAutoReframeOpen(true)}
            data-testid="open-autoreframe-dialog"
            title="자동 리프레임 (사람 추적 키프레임)"
          >
            자동 리프레임
          </button>
          {/* Phase 3.48 — BPM 기반 비트 싱크 자동 컷. step=1 모든 비트,
              step=2 반박자(절반), step=4 다운비트(4박마다). */}
          <div style={styles.menuGroupLabel}>비트로 자르기 (BPM 사용)</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              style={{ ...styles.primaryBtn, flex: 1 }}
              onClick={() => handleBeatCut(1)}
              data-testid="beat-cut-every"
              title="선택한 클립을 매 비트마다 자릅니다"
            >
              매 비트
            </button>
            <button
              style={{ ...styles.secondaryBtn, flex: 1 }}
              onClick={() => handleBeatCut(2)}
              data-testid="beat-cut-half"
              title="선택한 클립을 2박마다 자릅니다"
            >
              2박
            </button>
            <button
              style={{ ...styles.secondaryBtn, flex: 1 }}
              onClick={() => handleBeatCut(4)}
              data-testid="beat-cut-down"
              title="선택한 클립을 다운비트(4박)마다 자릅니다"
            >
              4박
            </button>
          </div>
          <button
            style={styles.secondaryBtn}
            onClick={openTextTemplatePicker}
            data-testid="open-text-template-picker"
            title="미리 디자인된 텍스트 블록 삽입"
          >
            텍스트 템플릿
          </button>
        </ToolbarMenu>

        {/* Phase 3.46 — 옵션 메뉴 popover: BPM/비트 스냅/커버/진행 바/캔버스 배경/플레이헤드 */}
        <ToolbarMenu label="옵션" testId="topbar-menu-options">
          {/* 현재 설치 버전 표시. 업데이트는 웹 /editor 에서 설치 파일을
              다시 내려받는 수동 배포 방식으로 운영한다. */}
          <UpdateStatusPanel />
          <div style={styles.menuGroupLabel}>BPM · 비트 스냅</div>
          <div style={styles.menuRow}>
            <label style={styles.hint} htmlFor="bpm-input">
              BPM
            </label>
            <input
              id="bpm-input"
              type="number"
              min={30}
              max={300}
              step={1}
              value={bpm}
              onChange={(e) => {
                // User typing the BPM is an explicit request for metronome
                // generation — flip the source so the regen effect runs.
                useTimelineUi.getState().markBeatsAsMetronome()
                setBpm(Number(e.target.value))
              }}
              style={{ ...styles.playheadInput, width: 64 }}
              aria-label="BPM"
              data-testid="bpm-input"
            />
            <button
              type="button"
              style={{
                ...styles.secondaryBtn,
                ...(beatSnapEnabled
                  ? { background: '#3b82f6', borderColor: '#2563eb' }
                  : {})
              }}
              onClick={() => setBeatSnapEnabled(!beatSnapEnabled)}
              aria-pressed={beatSnapEnabled}
              data-testid="beat-snap-toggle"
            >
              비트 스냅 {beatSnapEnabled ? 'ON' : 'OFF'}
            </button>
          </div>

          <div style={styles.menuGroupLabel}>플레이헤드 (ms)</div>
          <input
            style={styles.playheadInput}
            type="number"
            min={0}
            step={100}
            value={playheadMs}
            onChange={(e) => setPlayheadMs(Math.max(0, Number(e.target.value) || 0))}
            aria-label="플레이헤드(ms)"
            data-testid="playhead-input"
          />

          {/* Phase 3.73 — chapter markers → YouTube format clipboard copy. */}
          <div style={styles.menuGroupLabel}>챕터 마커</div>
          <div style={styles.menuRow}>
            <button
              type="button"
              style={styles.secondaryBtn}
              onClick={async () => {
                const markers = useTimelineUi.getState().markers
                if (markers.length === 0) {
                  setToast({
                    message: '마커가 없습니다 — 타임라인에 마커를 먼저 추가하세요',
                    variant: 'info',
                    id: Date.now()
                  })
                  return
                }
                const text = markersToChapters(markers, 'youtube')
                try {
                  await navigator.clipboard.writeText(text)
                  setToast({
                    message: `챕터 ${markers.length}개를 클립보드에 복사했습니다`,
                    variant: 'success',
                    id: Date.now()
                  })
                } catch {
                  setToast({
                    message: '클립보드 복사 실패 — 권한을 확인하세요',
                    variant: 'error',
                    id: Date.now()
                  })
                }
              }}
              data-testid="copy-chapter-markers"
              title="타임라인 마커를 YouTube 챕터 형식으로 클립보드에 복사"
            >
              YouTube 챕터로 복사
            </button>
          </div>

          <div style={styles.menuGroupLabel}>커버 프레임</div>
          <div style={styles.menuRow}>
            <button
              type="button"
              style={styles.secondaryBtn}
              onClick={() => setCoverMs(playheadMs)}
              data-testid="set-cover-frame"
              title="현재 플레이헤드 프레임을 커버(썸네일)로 지정"
            >
              커버로 지정
            </button>
            {project.coverMs != null && (
              <button
                type="button"
                style={styles.secondaryBtn}
                onClick={() => clearCoverMs()}
                data-testid="clear-cover-frame"
                title="커버 프레임 지정 해제"
              >
                커버 해제 ({(project.coverMs / 1000).toFixed(1)}s)
              </button>
            )}
          </div>

          {/* Phase 3.35 — 진행 바 오버레이 토글 + 인라인 설정. */}
          <div style={styles.menuGroupLabel}>진행 바</div>
          <button
            type="button"
            style={{
              ...styles.secondaryBtn,
              ...(project.progressBar?.enabled
                ? { background: '#6366f1', borderColor: '#6366f1', color: '#fff' }
                : {})
            }}
            onClick={() => toggleProgressBar()}
            aria-pressed={project.progressBar?.enabled ?? false}
            data-testid="toggle-progress-bar"
            title="영상 길이에 맞춰 차오르는 진행 바 오버레이"
          >
            진행 바 {project.progressBar?.enabled ? 'ON' : 'OFF'}
          </button>
          {project.progressBar?.enabled && (
            <div style={styles.menuRow}>
              <select
                style={styles.select}
                value={project.progressBar.position}
                onChange={(e) =>
                  setProgressBar({
                    position: e.target.value as ProgressBarPosition
                  })
                }
                aria-label="진행 바 위치"
                data-testid="progress-bar-position"
              >
                <option value="top">상단</option>
                <option value="bottom">하단</option>
              </select>
              <input
                type="color"
                value={project.progressBar.color}
                onChange={(e) => setProgressBar({ color: e.target.value })}
                aria-label="진행 바 색상"
                data-testid="progress-bar-color"
                style={{
                  width: 32,
                  height: 28,
                  padding: 0,
                  border: '1px solid #2a2a2a',
                  borderRadius: 6,
                  background: '#0d0d0d',
                  cursor: 'pointer'
                }}
              />
              <input
                type="range"
                min={MIN_PROGRESS_BAR_HEIGHT_FRAC}
                max={MAX_PROGRESS_BAR_HEIGHT_FRAC}
                step={0.001}
                value={project.progressBar.heightFrac}
                onChange={(e) =>
                  setProgressBar({ heightFrac: Number(e.target.value) })
                }
                aria-label="진행 바 두께"
                data-testid="progress-bar-height"
                style={{ width: 80, cursor: 'pointer' }}
              />
            </div>
          )}

          {/* Phase 3.44 — 캔버스 배경 (블러/단색). 'blur' 선택 시
              setCanvasBackground(null) 로 필드를 absent 로 collapse 하여 legacy
              DOM/export 와 byte-identical 을 유지한다. */}
          <div style={styles.menuGroupLabel}>캔버스 배경</div>
          <div style={styles.menuRow}>
            <select
              style={styles.select}
              value={canvasBg.kind}
              onChange={(e) => {
                const kind = e.target.value as CanvasBackgroundKind
                if (kind === 'color') {
                  setCanvasBackground({
                    kind: 'color',
                    color:
                      canvasBg.kind === 'color' && canvasBg.color
                        ? canvasBg.color
                        : DEFAULT_CANVAS_BACKGROUND_COLOR
                  })
                } else if (kind === 'blur') {
                  setCanvasBackground(null)
                } else {
                  setCanvasBackground({ kind })
                }
              }}
              aria-label="캔버스 배경"
              data-testid="canvas-bg-kind"
              title="캔버스 가장자리 배경 — 블러(기본) / 검정 / 흰색 / 컬러"
            >
              <option value="blur">흐림(블러)</option>
              <option value="black">검정</option>
              <option value="white">흰색</option>
              <option value="color">컬러</option>
            </select>
            {canvasBg.kind === 'color' && (
              <input
                type="color"
                value={canvasBg.color ?? DEFAULT_CANVAS_BACKGROUND_COLOR}
                onChange={(e) =>
                  setCanvasBackground({ kind: 'color', color: e.target.value })
                }
                aria-label="캔버스 배경 색상"
                data-testid="canvas-bg-color"
                style={{
                  width: 32,
                  height: 28,
                  padding: 0,
                  border: '1px solid #2a2a2a',
                  borderRadius: 6,
                  background: '#0d0d0d',
                  cursor: 'pointer'
                }}
              />
            )}
            <button
              type="button"
              style={styles.secondaryBtn}
              onClick={() =>
                setCanvasBackground(canvasBg.kind === 'blur' ? null : canvasBg)
              }
              data-testid="canvas-bg-apply-all"
              title="현재 캔버스 배경을 프로젝트 전체에 적용"
            >
              전체 적용
            </button>
          </div>
        </ToolbarMenu>

        <button
          type="button"
          style={{
            ...styles.secondaryBtn,
            ...(effectsOpen
              ? { background: '#6366f1', borderColor: '#6366f1', color: '#fff' }
              : {}),
            ...(effectsClipId ? {} : { opacity: 0.5, cursor: 'not-allowed' })
          }}
          onClick={() => {
            if (editingCaptionId) {
              setEditingCaptionId(null)
              setEffectsOpen(true)
              return
            }
            setEffectsOpen((v) => !v)
          }}
          disabled={!effectsClipId}
          aria-pressed={effectsOpen}
          data-testid="toggle-effects-panel"
          title="효과 패널 — 영상/오버레이 클립 선택 시 사용"
        >
          효과
        </button>

        {/* Phase 3.46 — 내보내기 split button: 본 버튼 + ▾ 팝오버 (일괄 내보내기) */}
        <ExportSplitButton
          onMain={() => setExportOpen(true)}
          onBatch={() => setBatchOpen(true)}
        />

        {!hydrated && (
          <div style={styles.hint}>프로젝트 로딩 중…</div>
        )}
      </div>

      <div
        style={
          editingCaptionId || templatePickerOpen || showEffectsPanel
            ? styles.bodyWithEditor
            : styles.body
        }
      >
        {/* Phase 3.45 — CapCut-style vertical icon rail. Click an icon to swap
            what the secondary panel shows. The 텍스트 rail icon opens the
            existing TextTemplatePicker modal (no separate panel — it floats
            over the layout grid via `bodyWithEditor`). */}
        <div style={styles.iconRail} data-testid="left-icon-rail" role="tablist">
          {(
            [
              { key: 'media', icon: '', label: '미디어', testid: 'left-rail-media' },
              { key: 'overlay', icon: '', label: '스티커', testid: 'left-rail-sticker' },
              { key: 'text', icon: '', label: '텍스트', testid: 'left-rail-text' },
              { key: 'transcript', icon: '', label: '대본', testid: 'left-rail-transcript' }
            ] as const
          ).map((item) => {
            const isText = item.key === 'text'
            const active = isText
              ? templatePickerOpen
              : leftTab === item.key
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={item.testid}
                title={item.label}
                style={{
                  ...styles.iconRailBtn,
                  ...(active ? styles.iconRailBtnActive : {})
                }}
                onClick={() => {
                  if (isText) {
                    openTextTemplatePicker()
                    return
                  }
                  setLeftTab(item.key)
                }}
              >
                {item.icon && (
                  <span style={styles.iconRailIcon} aria-hidden="true">{item.icon}</span>
                )}
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
        <div style={styles.leftPanel}>
          <div style={styles.leftPanelBody}>
            {leftTab === 'media' ? (
              <MediaLibrary />
            ) : leftTab === 'overlay' ? (
              <OverlayLibrary />
            ) : (
              <TranscriptPanel />
            )}
          </div>
        </div>
        <div
          style={{
            ...styles.right,
            gridTemplateRows: `1fr auto 4px ${timelinePanelHeight}px`
          }}
        >
          {/* pptx10 슬라이드 13 — 분리 시 main grid slot 은 placeholder. */}
          {previewDetached ? (
            <div
              data-testid="preview-detached-placeholder"
              style={{
                ...styles.previewArea,
                flexDirection: 'column',
                color: '#94a3b8',
                fontSize: 13,
                gap: 8
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: '#cbd5e1' }}>프리뷰가 별도 창으로 분리됨</div>
              <button
                type="button"
                onClick={() => setPreviewDetached(false)}
                data-testid="preview-reattach-btn"
                style={{
                  background: '#1f2937', color: '#cbd5e1', border: '1px solid #374151',
                  borderRadius: 4, padding: '6px 12px', cursor: 'pointer'
                }}
              >
                ← 합치기
              </button>
            </div>
          ) : null}
          {/* Reels 11 슬라이드 13 — 분리 시 in-app 플로팅 프리뷰는 더 이상
              그리지 않음. 별도 BrowserWindow(PreviewOnly) 한 곳에서만 표시.
              이전엔 placeholder + in-app floater + 별도 BrowserWindow 가
              동시에 떠 두 개의 프리뷰가 보였음. data-detached='true' 시 div
              자체를 unmount 하여 중복 제거. */}
          {!previewDetached && (
          <div
            data-detached="false"
            style={styles.previewArea}
          >
            {previewDetached && (
              <div
                onMouseDown={onDetachedTitleMouseDown}
                data-testid="preview-detached-titlebar"
                style={{
                  cursor: 'move', background: '#1f2937', color: '#cbd5e1',
                  padding: '6px 10px', display: 'flex', justifyContent: 'space-between',
                  alignItems: 'center', borderTopLeftRadius: 8, borderTopRightRadius: 8,
                  fontSize: 12, userSelect: 'none'
                }}
              >
                <span>플레이어 — 분리됨</span>
                <button
                  type="button"
                  onClick={() => setPreviewDetached(false)}
                  data-testid="preview-detached-close"
                  style={{
                    background: 'transparent', color: '#cbd5e1', border: 'none',
                    cursor: 'pointer', fontSize: 14
                  }}
                  title="원래 자리로"
                >×</button>
              </div>
            )}
            <div style={previewDetached ? { flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } : { display: 'contents' }}>
            {/* Phase 6 — SNS 플랫폼 미리보기 selector.
                Moved to top-LEFT in 0.2.5 because the top-right cluster
                (AudioMeter / ColorScopes / 풀스크린 / preview-speed) shared
                the same absolute slot and visually hid the picker. Picking a
                platform overlays its UI chrome onto the preview (purely
                visual — no effect on export). */}
            <div
              style={{
                position: 'absolute',
                top: 8,
                left: 8,
                zIndex: 5
              }}
            >
              <SocialPreviewSelector />
            </div>
            {/* Phase 3.43 — preview-only horizontal guideline rules control.
                Sibling positioned to the LEFT of the selector so both stay
                visible in the same row. Pure preview chrome — guides never
                affect the export filter graph. */}
            <div
              style={{
                position: 'absolute',
                top: 8,
                right: 168,
                zIndex: 5
              }}
            >
              <PreviewGuidesControl />
            </div>
            <div
              ref={previewWrapRef}
              style={{
                ...styles.previewBox,
                aspectRatio: `${project.width} / ${project.height}`,
                maxHeight: '100%',
                maxWidth: '100%',
                minHeight: 240,
                height: '85%',
                width: 'auto'
              }}
              data-testid="preview-placeholder"
            >
              <PreviewCanvas project={project} playheadMs={playheadMs} />
              <div
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  zIndex: 5,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-end',
                  gap: 4
                }}
              >
                <AudioMeter />
                <ColorScopes />
                <button
                  type="button"
                  onClick={togglePreviewFullscreen}
                  data-testid="preview-fullscreen-toggle"
                  title="프리뷰 풀스크린 (F)"
                  style={{
                    background: '#1f2937',
                    color: '#cbd5e1',
                    border: '1px solid #374151',
                    borderRadius: 4,
                    padding: '3px 8px',
                    fontSize: 10,
                    cursor: 'pointer',
                    fontWeight: 600
                  }}
                >
                  ⛶ 풀스크린
                </button>
                {/* pptx10 슬라이드 13 — 프리뷰 분리 toggle. detached 상태면
                    버튼 텍스트가 "합치기" 로 바뀜. */}
                <button
                  type="button"
                  onClick={() => setPreviewDetached((v) => !v)}
                  data-testid="preview-detach-toggle"
                  title={previewDetached ? '원래 자리로 합치기' : '별도 창으로 분리'}
                  style={{
                    background: previewDetached ? '#4f46e5' : '#1f2937',
                    color: previewDetached ? '#fff' : '#cbd5e1',
                    border: '1px solid #374151',
                    borderRadius: 4,
                    padding: '3px 8px',
                    fontSize: 10,
                    cursor: 'pointer',
                    fontWeight: 600
                  }}
                >
                  {previewDetached ? '⤡ 합치기' : '⧉ 분리'}
                </button>
                {/* Phase 3.81 — preview speed (UI-only playbackRate). */}
                <select
                  value={previewSpeed}
                  onChange={(e) =>
                    setPreviewSpeed(parseFloat(e.target.value) || 1)
                  }
                  data-testid="preview-speed-select"
                  title="프리뷰 재생 속도"
                  style={{
                    background: '#0d0d0d',
                    color: '#cbd5e1',
                    border: '1px solid #2a2a2a',
                    borderRadius: 4,
                    padding: '2px 6px',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  <option value="0.25">0.25×</option>
                  <option value="0.5">0.5×</option>
                  <option value="1">1×</option>
                  <option value="1.5">1.5×</option>
                  <option value="2">2×</option>
                  <option value="4">4×</option>
                </select>
              </div>
            </div>
            {srtError && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 12,
                  left: 12,
                  right: 12,
                  background: '#2a0d0d',
                  border: '1px solid #4a1f1f',
                  color: '#fca5a5',
                  padding: '8px 12px',
                  borderRadius: 6,
                  fontSize: 11
                }}
                onClick={() => setSrtError(null)}
                role="button"
                data-testid="srt-error"
              >
                {srtError}
              </div>
            )}
            </div>
            {previewDetached && (
              <div
                onMouseDown={onDetachedResizeMouseDown}
                data-testid="preview-detached-resize"
                title="끌어서 크기 조절"
                style={{
                  position: 'absolute', right: 0, bottom: 0, width: 14, height: 14,
                  cursor: 'nwse-resize',
                  background:
                    'linear-gradient(135deg, transparent 50%, #475569 50%, #475569 65%, transparent 65%, transparent 75%, #475569 75%, #475569 90%, transparent 90%)'
                }}
              />
            )}
          </div>
          )}
          {/* Transport bar sits between preview and timeline. */}
          <Transport />
          {/* pptx10 슬라이드 12 — preview↔timeline splitter. drag 로 timeline
              panel 높이 조절. cursor: row-resize 로 발견성 확보. */}
          <div
            style={
              splitterDragging
                ? { ...styles.rowSplitter, ...styles.rowSplitterActive }
                : styles.rowSplitter
            }
            data-testid="timeline-splitter"
            title="끌어서 타임라인 크기 조절 (더블클릭으로 기본값 복원)"
            onMouseDown={onSplitterMouseDown}
            onDoubleClick={() => setTimelinePanelHeight(280)}
          />
          <div data-testid="timeline-placeholder" style={{ overflow: 'hidden' }}>
            <Timeline
              project={project}
              playheadMs={playheadMs}
              onSeek={setPlayheadMs}
              selectedClipId={selectedClipId}
              onSelectClip={handleSelectClip}
              onOpenEffectsClip={handleOpenEffectsClip}
              onEditCaption={(id) => {
                setSelectedClipId(id)
                setEditingCaptionId(id)
              }}
              onDeleteClip={(id) => {
                // Resolve the clip BEFORE removing so we know what kind to
                // name in the undo-hint Toast. Misclicking on the context
                // menu's destructive 삭제 was the audit's #1 Critical risk
                // (instant delete, no confirm, no surfaced undo hint).
                let kindLabel = '클립'
                for (const t of project.tracks) {
                  const c = t.clips.find((c) => c.id === id)
                  if (!c) continue
                  if (c.kind === 'caption') kindLabel = '자막'
                  else if (c.kind === 'overlay') kindLabel = '오버레이'
                  else if (c.kind === 'media') {
                    kindLabel = t.kind === 'audio' ? '오디오' : '클립'
                  }
                  break
                }
                removeClip(id)
                if (editingCaptionId === id) setEditingCaptionId(null)
                if (selectedClipId === id) setSelectedClipId(null)
                setToast({
                  message: `${kindLabel} 삭제됨 · Ctrl+Z로 되돌리기`,
                  variant: 'info',
                  // 6s — long enough to read + reach for Ctrl+Z without
                  // being a sticky modal.
                  durationMs: 6000,
                  id: Date.now()
                })
              }}
              onOpenSilenceDialog={(id) => {
                // Verify the clip is still a media clip before opening.
                let target: VideoAudioClip | null = null
                for (const t of project.tracks)
                  for (const c of t.clips)
                    if (c.id === id && isMediaClip(c)) target = c
                if (target) setSilenceTargetClipId(target.id)
              }}
            />
          </div>
        </div>
        {editingCaptionId ? (
          <CaptionEditor
            project={project}
            captionId={editingCaptionId}
            onClose={() => setEditingCaptionId(null)}
          />
        ) : templatePickerOpen ? (
          <TextTemplatePicker
            onClose={() => setTemplatePickerOpen(false)}
            onApply={handleApplyTemplate}
          />
        ) : showEffectsPanel ? (
          <EffectsPanel
            project={project}
            clipId={effectsClipId}
            playheadMs={playheadMs}
            onClose={() => {
              setEffectsOpen(false)
              useTimelineUi.getState().setSelectedAdjustmentLayerId(null)
            }}
          />
        ) : null}
      </div>
      {silenceTargetClipId && (
        <SilenceRemoveDialog
          project={project}
          clipId={silenceTargetClipId}
          onClose={() => setSilenceTargetClipId(null)}
        />
      )}
      {exportOpen && (
        <ExportDialog project={project} onClose={() => setExportOpen(false)} />
      )}
      <BatchExportDialog
        project={project}
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
      />
      <PrefillDialog
        open={prefillOpen}
        onClose={() => setPrefillOpen(false)}
        onComplete={handlePrefillComplete}
      />
      <SttDialog
        open={sttOpen}
        onClose={() => setSttOpen(false)}
        onComplete={handleSttComplete}
      />
      <AutoEditDialog
        open={autoEditOpen}
        onClose={() => setAutoEditOpen(false)}
        onComplete={handleAutoEditComplete}
      />
      <AutoReframeDialog
        open={autoReframeOpen}
        onClose={() => setAutoReframeOpen(false)}
        onComplete={(s) =>
          setToast({
            message: `자동 리프레임 완료 — ${s.clipsReframed}개 클립에 키프레임 생성`,
            variant: 'success',
            id: Date.now()
          })
        }
      />
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          variant={toast.variant}
          durationMs={toast.durationMs}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  )
}
