import { useCallback, useEffect, useMemo, useState } from 'react'
import { MediaLibrary } from '../components/MediaLibrary'
import { PreviewCanvas } from '../components/PreviewCanvas'
import { SilenceRemoveDialog } from '../components/SilenceRemoveDialog'
import { Timeline } from '../components/Timeline'
import { Transport } from '../components/Transport'
import { CaptionEditor } from '../components/CaptionEditor'
import { ExportDialog } from '../components/ExportDialog'
import { PrefillDialog } from '../components/PrefillDialog'
import { Toast, type ToastVariant } from '../components/Toast'
import type { PrefillResult } from '../lib/prefillFromReel'
import { getTotalDurationMs, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import {
  isMediaClip,
  type AspectRatio,
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
  } as React.CSSProperties
}

export function Editor({ onBack }: EditorProps): JSX.Element {
  const project = useProjectStore((s) => s.project)
  const hydrated = useProjectStore((s) => s.hydrated)
  const setName = useProjectStore((s) => s.setName)
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio)
  const removeClip = useProjectStore((s) => s.removeClip)

  // Phase 2.2: playhead lives in the timelineUi store so Transport's rAF
  // loop and PreviewCanvas's <video>/<audio> sync share a single source of
  // truth.
  const playheadMs = useTimelineUi((s) => s.playheadMs)
  const setPlayheadMs = useTimelineUi((s) => s.setPlayheadMs)

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
  const [prefillOpen, setPrefillOpen] = useState(false)
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
      if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
          onClick={() => setExportOpen(true)}
          data-testid="open-export-dialog"
          title="내보내기 (Ctrl+E)"
        >
          내보내기
        </button>

        {!hydrated && (
          <div style={styles.hint}>프로젝트 로딩 중…</div>
        )}
      </div>

      <div style={editingCaptionId ? styles.bodyWithEditor : styles.body}>
        <MediaLibrary />
        <div style={styles.right}>
          <div style={styles.previewArea}>
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
      <PrefillDialog
        open={prefillOpen}
        onClose={() => setPrefillOpen(false)}
        onComplete={handlePrefillComplete}
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
