import { useCallback, useEffect, useMemo, useState } from 'react'
import { MediaLibrary } from '../components/MediaLibrary'
import { OverlayLibrary } from '../components/OverlayLibrary'
import { TranscriptPanel } from '../components/TranscriptPanel'
import { PreviewCanvas } from '../components/PreviewCanvas'
import { SocialPreviewSelector } from '../components/SocialPreviewOverlay'
import { SilenceRemoveDialog } from '../components/SilenceRemoveDialog'
import { Timeline } from '../components/Timeline'
import { Transport } from '../components/Transport'
import { CaptionEditor } from '../components/CaptionEditor'
import { EffectsPanel } from '../components/EffectsPanel'
import { ExportDialog } from '../components/ExportDialog'
import { BatchExportDialog } from '../components/BatchExportDialog'
import { PrefillDialog } from '../components/PrefillDialog'
import { SttDialog } from '../components/SttDialog'
import { AutoEditDialog } from '../components/AutoEditDialog'
import { Toast, type ToastVariant } from '../components/Toast'
import type { PrefillResult } from '../lib/prefillFromReel'
import type { AutoEditSummary } from '../lib/autoEdit'
import { getTotalDurationMs, useProjectStore, useUndoRedo } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import {
  isMediaClip,
  isOverlayClip,
  type AspectRatio,
  type Clip,
  type VideoAudioClip
} from '../../../shared/project'
import {
  addClipsToStore,
  cuesToClips,
  insertCaptionAtPlayhead
} from '../lib/captions'

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
    gridTemplateColumns: 'minmax(280px, 320px) 1fr',
    overflow: 'hidden'
  } as React.CSSProperties,
  bodyWithEditor: {
    flex: 1,
    display: 'grid',
    gridTemplateColumns: 'minmax(280px, 320px) 1fr 360px',
    overflow: 'hidden'
  } as React.CSSProperties,
  right: {
    display: 'grid',
    // Preview takes flex space, transport is auto-sized, timeline gets a
    // bounded row so it can scroll without pushing the preview off-screen.
    gridTemplateRows: '1fr auto minmax(220px, 320px)',
    overflow: 'hidden'
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
  // Left-panel tab host (미디어 / 오버레이).
  leftPanel: {
    display: 'flex',
    flexDirection: 'column' as const,
    minWidth: 280,
    background: '#141414',
    borderRight: '1px solid #2a2a2a',
    overflow: 'hidden'
  } as React.CSSProperties,
  leftTabBar: {
    flexShrink: 0,
    display: 'flex',
    gap: 4,
    padding: '8px 10px',
    borderBottom: '1px solid #2a2a2a',
    background: '#101010'
  } as React.CSSProperties,
  leftTabBtn: {
    flex: 1,
    background: '#1a1a1a',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  leftTabBtnActive: {
    background: '#6366f1',
    color: '#fff',
    borderColor: '#6366f1'
  } as React.CSSProperties,
  leftPanelBody: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden'
  } as React.CSSProperties
}

export function Editor({ onBack }: EditorProps): JSX.Element {
  const project = useProjectStore((s) => s.project)
  const hydrated = useProjectStore((s) => s.hydrated)
  const setName = useProjectStore((s) => s.setName)
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio)
  const removeClip = useProjectStore((s) => s.removeClip)
  const { undo, redo, canUndo, canRedo, pastCount, futureCount } = useUndoRedo()

  // Phase 2.2: playhead lives in the timelineUi store so Transport's rAF
  // loop and PreviewCanvas's <video>/<audio> sync share a single source of
  // truth.
  const playheadMs = useTimelineUi((s) => s.playheadMs)
  const setPlayheadMs = useTimelineUi((s) => s.setPlayheadMs)

  // Auto-pause playback when the editor unmounts (e.g., user clicks ← 홈).
  // Without this, `playing` stays true in the store, the rAF loop keeps
  // advancing the playhead while no video element exists, and remounting the
  // editor doesn't auto-resume due to a src-set/play() race.
  useEffect(() => {
    return () => {
      useTimelineUi.getState().setPlaying(false)
    }
  }, [])

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
  const [srtError, setSrtError] = useState<string | null>(null)
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
  const [prefillOpen, setPrefillOpen] = useState(false)
  const [sttOpen, setSttOpen] = useState(false)
  const [autoEditOpen, setAutoEditOpen] = useState(false)
  const [toast, setToast] = useState<{
    message: string
    variant: ToastVariant
    id: number
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
      message: `자막 ${count}개를 생성했습니다`,
      variant: 'success',
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

  // The 효과 panel is shown only when the user has toggled it on AND an
  // effect-eligible clip is selected. The caption editor takes the same
  // 360px right slot, so it wins when a caption is being edited.
  const showEffectsPanel = effectsOpen && !editingCaptionId && !!effectsClipId

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
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        target?.isContentEditable
      ) {
        return
      }

      if (e.key === 'c' || e.key === 'C') {
        if (e.ctrlKey || e.metaKey) return
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
        ui.setPlayheadMs(
          cap > 0 ? Math.min(cap, ui.playheadMs + step) : ui.playheadMs + step
        )
        return
      }
      if (e.key === 'Home') {
        e.preventDefault()
        ui.setPlayheadMs(0)
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        ui.setPlayheadMs(getTotalDurationMs(store.project))
        return
      }

      const sel = useTimelineUi.getState().selectedClipIds
      const firstSelected = (sel.size > 0 ? sel.values().next().value : null) ?? null
      if (!firstSelected) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        store.removeClip(firstSelected)
        useTimelineUi.getState().clearSelection()
        setSelectedClipId((cur) => (cur === firstSelected ? null : cur))
        if (editingCaptionId === firstSelected) setEditingCaptionId(null)
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        const nid = store.duplicateClip(firstSelected)
        if (nid) {
          useTimelineUi.getState().selectClip(nid)
          setSelectedClipId(nid)
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
        let target = null as null | { kind: string }
        for (const t of store.project.tracks) {
          const c = t.clips.find((cc) => cc.id === firstSelected)
          if (c) {
            target = c
            break
          }
        }
        if (target && isMediaClip(target as never)) {
          store.splitClipAt(firstSelected, useTimelineUi.getState().playheadMs)
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

        <div style={styles.flex1} />

        <button
          type="button"
          style={canUndo ? styles.undoBtn : styles.undoBtnDisabled}
          onClick={() => undo()}
          disabled={!canUndo}
          aria-label="실행 취소"
          title="실행 취소 (Ctrl+Z)"
          data-testid="undo-button"
          data-can-undo={canUndo ? 'true' : 'false'}
        >
          <span aria-hidden>↶</span>
          {pastCount > 0 && <span style={styles.undoBadge}>{pastCount}</span>}
        </button>
        <button
          type="button"
          style={canRedo ? styles.undoBtn : styles.undoBtnDisabled}
          onClick={() => redo()}
          disabled={!canRedo}
          aria-label="다시 실행"
          title="다시 실행 (Ctrl+Shift+Z)"
          data-testid="redo-button"
          data-can-redo={canRedo ? 'true' : 'false'}
        >
          <span aria-hidden>↷</span>
          {futureCount > 0 && <span style={styles.undoBadge}>{futureCount}</span>}
        </button>

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
          style={{ ...styles.playheadInput, width: 56 }}
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
          onClick={handleAddCaption}
          data-testid="add-caption-button"
        >
          + 자막 추가
        </button>
        <button
          style={styles.secondaryBtn}
          onClick={handleImportSrt}
          data-testid="import-srt-button"
        >
          SRT 가져오기
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
          type="button"
          style={{
            ...styles.secondaryBtn,
            ...(effectsOpen
              ? { background: '#6366f1', borderColor: '#6366f1', color: '#fff' }
              : {}),
            ...(effectsClipId ? {} : { opacity: 0.5, cursor: 'not-allowed' })
          }}
          onClick={() => setEffectsOpen((v) => !v)}
          disabled={!effectsClipId}
          aria-pressed={effectsOpen}
          data-testid="toggle-effects-panel"
          title="효과 패널 — 영상/오버레이 클립 선택 시 사용"
        >
          효과
        </button>
        <button
          style={styles.primaryBtn}
          onClick={() => setExportOpen(true)}
          data-testid="open-export-dialog"
          title="내보내기 (Ctrl+E)"
        >
          내보내기
        </button>
        <button
          style={styles.secondaryBtn}
          onClick={() => setBatchOpen(true)}
          data-testid="open-batch-export-dialog"
          title="여러 프리셋으로 한 번에 내보내기"
        >
          일괄 내보내기
        </button>

        {!hydrated && (
          <div style={styles.hint}>프로젝트 로딩 중…</div>
        )}
      </div>

      <div
        style={
          editingCaptionId || showEffectsPanel
            ? styles.bodyWithEditor
            : styles.body
        }
      >
        <div style={styles.leftPanel}>
          <div style={styles.leftTabBar} data-testid="left-panel-tabs">
            <button
              type="button"
              style={{
                ...styles.leftTabBtn,
                ...(leftTab === 'media' ? styles.leftTabBtnActive : {})
              }}
              onClick={() => setLeftTab('media')}
              data-testid="media-library-tab"
              aria-pressed={leftTab === 'media'}
            >
              미디어
            </button>
            <button
              type="button"
              style={{
                ...styles.leftTabBtn,
                ...(leftTab === 'overlay' ? styles.leftTabBtnActive : {})
              }}
              onClick={() => setLeftTab('overlay')}
              data-testid="media-overlay-tab"
              aria-pressed={leftTab === 'overlay'}
            >
              오버레이
            </button>
            <button
              type="button"
              style={{
                ...styles.leftTabBtn,
                ...(leftTab === 'transcript' ? styles.leftTabBtnActive : {})
              }}
              onClick={() => setLeftTab('transcript')}
              data-testid="media-transcript-tab"
              aria-pressed={leftTab === 'transcript'}
            >
              대본
            </button>
          </div>
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
        <div style={styles.right}>
          <div style={styles.previewArea}>
            {/* Phase 6 — SNS 플랫폼 미리보기 selector. Pinned to the preview
                area's top-right; picking a platform overlays its UI chrome
                onto the preview (purely visual — no effect on export). */}
            <div
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                zIndex: 5
              }}
            >
              <SocialPreviewSelector />
            </div>
            <div
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
          {/* Transport bar sits between preview and timeline. */}
          <Transport />
          <div data-testid="timeline-placeholder" style={{ overflow: 'hidden' }}>
            <Timeline
              project={project}
              playheadMs={playheadMs}
              onSeek={setPlayheadMs}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              onEditCaption={(id) => {
                setSelectedClipId(id)
                setEditingCaptionId(id)
              }}
              onDeleteClip={(id) => {
                removeClip(id)
                if (editingCaptionId === id) setEditingCaptionId(null)
                if (selectedClipId === id) setSelectedClipId(null)
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
        {editingCaptionId && (
          <CaptionEditor
            project={project}
            captionId={editingCaptionId}
            onClose={() => setEditingCaptionId(null)}
          />
        )}
        {/* Phase 7 — docked 효과 panel. Mutually exclusive with the caption
            editor (both occupy the right 360px slot). Renders only for an
            effect-eligible (media/overlay) clip while toggled on. */}
        {showEffectsPanel && effectsClipId && (
          <EffectsPanel
            project={project}
            clipId={effectsClipId}
            playheadMs={playheadMs}
            onClose={() => setEffectsOpen(false)}
          />
        )}
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
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          variant={toast.variant}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  )
}
