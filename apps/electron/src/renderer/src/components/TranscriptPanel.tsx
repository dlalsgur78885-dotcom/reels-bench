/**
 * 대본 (text-based editing) panel — Phase 3.17.
 *
 * Edit the video by editing its transcript. The panel shows the SELECTED media
 * clip's word-level transcript; deleting words appends non-destructive SOURCE
 * ranges to the clip (`deletedRanges`), shrinking its timeline footprint and
 * rippling later clips left. Restoring words removes the ranges. All mutation
 * goes through the project-store actions — this panel adds NO editing logic.
 *
 * Self-resolves the target clip from the live timeline selection (mirrors
 * `SttDialog`'s `resolveSelectedClip`) so it can live in the left-panel tab
 * strip without Editor having to thread `selectedClipId` down.
 *
 * Word-mode STT: the "대본 생성" button transcribes the clip's trimmed window
 * with `granularity: 'word'` and stores the result via `setClipTranscript`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  freezeAwareTimelineOffset,
  getClipDeletedRanges,
  getVisibleTranscriptWords,
  hasClipTranscript,
  isMediaClip,
  type DeletedRange,
  type TranscriptWord,
  type VideoAudioClip
} from '../../../shared/project'
import type { SttProgress, SttResult } from '../../../shared/ipc'
import { newId, useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'

// ---------------------------------------------------------------------------
// Styles — dark theme, matches the neighboring left-panel components.
// ---------------------------------------------------------------------------
const styles = {
  panel: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    minHeight: 0,
    background: '#141414',
    color: '#f5f5f5',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  } as React.CSSProperties,
  header: {
    flexShrink: 0,
    padding: '12px 14px',
    borderBottom: '1px solid #2a2a2a',
    background: '#101010'
  } as React.CSSProperties,
  title: {
    fontSize: 13,
    fontWeight: 700,
    color: '#f5f5f5'
  } as React.CSSProperties,
  subtitle: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 4
  } as React.CSSProperties,
  body: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 14
  } as React.CSSProperties,
  empty: {
    fontSize: 12,
    color: '#94a3b8',
    background: '#1a1410',
    border: '1px solid #3a2a1a',
    borderRadius: 8,
    padding: '14px 14px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
    alignItems: 'flex-start'
  } as React.CSSProperties,
  noSelection: {
    fontSize: 12,
    color: '#94a3b8',
    background: '#101820',
    border: '1px solid #1f2937',
    borderRadius: 8,
    padding: '14px 14px'
  } as React.CSSProperties,
  wordWrap: {
    lineHeight: 2,
    fontSize: 14,
    wordBreak: 'break-word' as const
  } as React.CSSProperties,
  word: {
    display: 'inline-block',
    padding: '1px 3px',
    margin: '1px 0',
    borderRadius: 4,
    cursor: 'pointer',
    color: '#e2e8f0',
    transition: 'background 80ms ease'
  } as React.CSSProperties,
  wordSelected: {
    background: '#6366f1',
    color: '#fff'
  } as React.CSSProperties,
  wordDeleted: {
    textDecoration: 'line-through',
    color: '#52525b',
    opacity: 0.6
  } as React.CSSProperties,
  wordDeletedSelected: {
    background: '#7f1d1d',
    color: '#fca5a5',
    opacity: 0.95
  } as React.CSSProperties,
  toolbar: {
    flexShrink: 0,
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 6,
    padding: '10px 14px',
    borderTop: '1px solid #2a2a2a',
    background: '#101010'
  } as React.CSSProperties,
  btn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  btnPrimary: {
    background: '#6366f1',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  btnDanger: {
    background: '#7f1d1d',
    color: '#fecaca',
    border: '1px solid #991b1b',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  btnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed'
  } as React.CSSProperties,
  note: {
    fontSize: 11,
    color: '#94a3b8',
    padding: '8px 14px',
    borderTop: '1px solid #2a2a2a',
    background: '#0d1117'
  } as React.CSSProperties,
  errorNote: {
    fontSize: 11,
    color: '#fca5a5',
    padding: '8px 14px',
    borderTop: '1px solid #4a1f1f',
    background: '#2a0d0d'
  } as React.CSSProperties,
  progress: {
    fontSize: 12,
    color: '#cbd5e1',
    background: '#0d1117',
    border: '1px solid #1f2937',
    borderRadius: 8,
    padding: '12px 14px'
  } as React.CSSProperties,
  progressTrack: {
    width: '100%',
    height: 6,
    background: '#1f2937',
    borderRadius: 999,
    overflow: 'hidden',
    marginTop: 8
  } as React.CSSProperties,
  progressFill: {
    height: '100%',
    background: '#6366f1',
    transition: 'width 200ms ease'
  } as React.CSSProperties,
  stat: {
    fontSize: 11,
    color: '#64748b'
  } as React.CSSProperties
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** True iff a word's source span is fully covered by the clip's deletions. */
function isWordDeleted(
  word: TranscriptWord,
  deleted: DeletedRange[]
): boolean {
  if (deleted.length === 0) return false
  for (const r of deleted) {
    if (
      word.sourceStartMs >= r.sourceStartMs &&
      word.sourceEndMs <= r.sourceEndMs
    ) {
      return true
    }
  }
  return false
}

/**
 * The FINAL timeline ms of a non-deleted word's start — for seeking. The word's
 * source offset (`sourceStartMs - trimInMs`) is mapped through the freeze-aware
 * forward map, then we subtract the timeline length of every deletion that ends
 * at/before it (deletions before the word compact the timeline). The result is
 * `clip.startMs + finalOffset`.
 */
function wordTimelineMs(clip: VideoAudioClip, word: TranscriptWord): number {
  const srcOffset = Math.max(0, word.sourceStartMs - clip.trimInMs)
  const preDeletionOffset = freezeAwareTimelineOffset(clip, srcOffset)
  let cutBefore = 0
  for (const r of getClipDeletedRanges(clip)) {
    const cutStartOff = r.sourceStartMs - clip.trimInMs
    const cutEndOff = r.sourceEndMs - clip.trimInMs
    if (cutEndOff <= srcOffset) {
      // Whole deletion is before the word — its full timeline span is removed.
      cutBefore +=
        freezeAwareTimelineOffset(clip, cutEndOff) -
        freezeAwareTimelineOffset(clip, cutStartOff)
    } else if (cutStartOff < srcOffset) {
      // The word falls inside a deletion (defensive — deleted words don't seek):
      // remove only the portion up to the word.
      cutBefore +=
        freezeAwareTimelineOffset(clip, srcOffset) -
        freezeAwareTimelineOffset(clip, cutStartOff)
    }
  }
  return Math.round(clip.startMs + Math.max(0, preDeletionOffset - cutBefore))
}

/** Resolve the first selected timeline clip if it is a media clip. */
function useSelectedMediaClip(): {
  clip: VideoAudioClip | null
  mediaPath: string | null
} {
  const project = useProjectStore((s) => s.project)
  const selectedIds = useTimelineUi((s) => s.selectedClipIds)
  return useMemo(() => {
    const firstId =
      selectedIds.size > 0 ? (selectedIds.values().next().value ?? null) : null
    if (!firstId) return { clip: null, mediaPath: null }
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (c.id === firstId && isMediaClip(c)) {
          const media = project.media[c.mediaId]
          return { clip: c, mediaPath: media?.path ?? null }
        }
      }
    }
    return { clip: null, mediaPath: null }
  }, [project, selectedIds])
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------
export function TranscriptPanel(): JSX.Element {
  const { clip, mediaPath } = useSelectedMediaClip()
  const setClipTranscript = useProjectStore((s) => s.setClipTranscript)
  const deleteTranscriptWords = useProjectStore((s) => s.deleteTranscriptWords)
  const restoreTranscriptWords = useProjectStore(
    (s) => s.restoreTranscriptWords
  )
  const removeFillerWords = useProjectStore((s) => s.removeFillerWords)
  const clearTranscriptDeletions = useProjectStore(
    (s) => s.clearTranscriptDeletions
  )
  const setPlayheadMs = useTimelineUi((s) => s.setPlayheadMs)

  // Selection state — a set of word ids + the anchor for shift-range extension.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [errorNote, setErrorNote] = useState<string | null>(null)

  // Word-mode STT job state.
  const [sttBusy, setSttBusy] = useState(false)
  const [sttProgress, setSttProgress] = useState<SttProgress | null>(null)
  const sttJobIdRef = useRef<string | null>(null)
  const sttUnsubRef = useRef<(() => void) | null>(null)

  const clipId = clip?.id ?? null

  // Clear transient state whenever the selected clip changes.
  useEffect(() => {
    setSelectedIds(new Set())
    setAnchorId(null)
    setNote(null)
    setErrorNote(null)
  }, [clipId])

  // Cancel + unsubscribe any in-flight STT job on unmount.
  useEffect(() => {
    return () => {
      const jid = sttJobIdRef.current
      if (jid) {
        void window.electron.stt.cancel(jid).catch(() => {})
        sttJobIdRef.current = null
      }
      if (sttUnsubRef.current) {
        sttUnsubRef.current()
        sttUnsubRef.current = null
      }
    }
  }, [])

  const words = useMemo(
    () => (clip ? getVisibleTranscriptWords(clip) : []),
    [clip]
  )
  const deletedRanges = useMemo(
    () => (clip ? getClipDeletedRanges(clip) : []),
    [clip]
  )
  // Memoized id→deleted lookup so each word span is O(1).
  const deletedWordIds = useMemo(() => {
    const out = new Set<string>()
    for (const w of words) {
      if (isWordDeleted(w, deletedRanges)) out.add(w.id)
    }
    return out
  }, [words, deletedRanges])

  // --- selection helpers --------------------------------------------------
  const toggleWord = useCallback(
    (wordId: string, shiftKey: boolean): void => {
      setNote(null)
      setSelectedIds((prev) => {
        if (shiftKey && anchorId) {
          // Extend a contiguous range between the anchor and this word.
          const aIdx = words.findIndex((w) => w.id === anchorId)
          const bIdx = words.findIndex((w) => w.id === wordId)
          if (aIdx !== -1 && bIdx !== -1) {
            const lo = Math.min(aIdx, bIdx)
            const hi = Math.max(aIdx, bIdx)
            const next = new Set<string>()
            for (let i = lo; i <= hi; i++) next.add(words[i].id)
            return next
          }
        }
        // Plain click — toggle this single word, reset the anchor.
        const next = new Set(prev)
        if (next.has(wordId)) next.delete(wordId)
        else next.add(wordId)
        return next
      })
      if (!shiftKey) setAnchorId(wordId)
    },
    [anchorId, words]
  )

  // A non-deleted word click also seeks the playhead.
  const handleWordClick = useCallback(
    (e: React.MouseEvent, word: TranscriptWord): void => {
      toggleWord(word.id, e.shiftKey)
      if (clip && !deletedWordIds.has(word.id)) {
        setPlayheadMs(wordTimelineMs(clip, word))
      }
    },
    [toggleWord, clip, deletedWordIds, setPlayheadMs]
  )

  // --- editing actions ----------------------------------------------------
  const selectedArray = useMemo(() => [...selectedIds], [selectedIds])
  const hasSelection = selectedArray.length > 0
  // The selection splits into deletable (live) and restorable (struck) words.
  const liveSelected = useMemo(
    () => selectedArray.filter((id) => !deletedWordIds.has(id)),
    [selectedArray, deletedWordIds]
  )
  const struckSelected = useMemo(
    () => selectedArray.filter((id) => deletedWordIds.has(id)),
    [selectedArray, deletedWordIds]
  )

  const handleDelete = useCallback((): void => {
    if (!clipId || liveSelected.length === 0) return
    deleteTranscriptWords(clipId, liveSelected)
    setSelectedIds(new Set())
    setAnchorId(null)
    setNote(`${liveSelected.length}개 단어를 삭제했습니다`)
  }, [clipId, liveSelected, deleteTranscriptWords])

  const handleRestore = useCallback((): void => {
    if (!clipId || struckSelected.length === 0) return
    restoreTranscriptWords(clipId, struckSelected)
    setSelectedIds(new Set())
    setAnchorId(null)
    setNote(`${struckSelected.length}개 단어를 복원했습니다`)
  }, [clipId, struckSelected, restoreTranscriptWords])

  const handleRemoveFiller = useCallback((): void => {
    if (!clipId) return
    const removed = removeFillerWords(clipId)
    setSelectedIds(new Set())
    setAnchorId(null)
    setNote(
      removed.length > 0
        ? `필러 단어 ${removed.length}개 제거됨`
        : '제거할 필러 단어가 없습니다'
    )
  }, [clipId, removeFillerWords])

  const handleClear = useCallback((): void => {
    if (!clipId) return
    clearTranscriptDeletions(clipId)
    setSelectedIds(new Set())
    setAnchorId(null)
    setNote('대본 편집을 초기화했습니다')
  }, [clipId, clearTranscriptDeletions])

  // Delete key removes the live selection (when focus is inside the panel).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (liveSelected.length > 0) {
          e.preventDefault()
          handleDelete()
        }
      }
    },
    [liveSelected, handleDelete]
  )

  // --- word-mode STT ------------------------------------------------------
  const handleGenerate = useCallback(async (): Promise<void> => {
    if (!clip || !mediaPath || sttBusy) return
    setErrorNote(null)
    setNote(null)
    const jobId = newId()
    sttJobIdRef.current = jobId
    setSttBusy(true)
    setSttProgress({ jobId, phase: 'preparing', percent: 0 })

    const unsub = window.electron.stt.onProgress((e: SttProgress) => {
      if (e.jobId !== jobId) return
      setSttProgress(e)
    })
    sttUnsubRef.current = unsub

    const teardown = (): void => {
      if (sttUnsubRef.current) {
        sttUnsubRef.current()
        sttUnsubRef.current = null
      }
      sttJobIdRef.current = null
    }

    let result: SttResult
    try {
      result = await window.electron.stt.transcribe({
        jobId,
        sourcePath: mediaPath,
        startMs: Math.max(0, Math.round(clip.trimInMs)),
        endMs: Math.max(0, Math.round(clip.trimOutMs)),
        granularity: 'word',
        model: 'base'
      })
    } catch (err) {
      teardown()
      setSttBusy(false)
      setSttProgress(null)
      setErrorNote(
        err instanceof Error
          ? err.message
          : '대본 생성에 실패했습니다. 잠시 후 다시 시도해주세요'
      )
      return
    }

    teardown()
    setSttBusy(false)
    setSttProgress(null)

    if (!result.ok) {
      if (result.code === 'cancelled') return
      setErrorNote('대본 생성에 실패했습니다. 잠시 후 다시 시도해주세요')
      return
    }

    const rawWords = result.words ?? []
    if (rawWords.length === 0) {
      setErrorNote('선택한 구간에서 단어를 인식하지 못했습니다')
      return
    }
    setClipTranscript(clip.id, {
      words: rawWords.map((w) => ({
        id: newId(),
        text: w.text,
        sourceStartMs: w.startMs,
        sourceEndMs: w.endMs
      })),
      language: result.language,
      generatedAt: Date.now()
    })
    setNote(`${rawWords.length}개 단어로 대본을 생성했습니다`)
  }, [clip, mediaPath, sttBusy, setClipTranscript])

  // -----------------------------------------------------------------------
  // Render.
  // -----------------------------------------------------------------------
  if (!clip) {
    return (
      <div
        style={styles.panel}
        data-testid="transcript-panel"
        data-has-clip="false"
      >
        <div style={styles.header}>
          <div style={styles.title}>대본 편집</div>
          <div style={styles.subtitle}>
            대본으로 영상 편집 — 단어를 지우면 해당 구간이 잘립니다
          </div>
        </div>
        <div style={styles.body}>
          <div style={styles.noSelection} data-testid="transcript-no-clip">
            타임라인에서 영상/오디오 클립을 선택하면 대본을 편집할 수
            있습니다.
          </div>
        </div>
      </div>
    )
  }

  const transcribed = hasClipTranscript(clip)

  return (
    <div
      style={styles.panel}
      data-testid="transcript-panel"
      data-has-clip="true"
      data-has-transcript={transcribed ? 'true' : 'false'}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div style={styles.header}>
        <div style={styles.title}>대본 편집</div>
        <div style={styles.subtitle}>
          단어를 클릭해 선택, Shift+클릭으로 범위 선택 · 삭제하면 그 구간이
          잘립니다
        </div>
      </div>

      {sttBusy && sttProgress ? (
        <div style={styles.body}>
          <div style={styles.progress} data-testid="transcript-stt-progress">
            <div>
              대본 생성 중…{' '}
              {Math.max(0, Math.min(100, Math.round(sttProgress.percent)))}%
            </div>
            <div style={styles.progressTrack}>
              <div
                style={{
                  ...styles.progressFill,
                  width: `${Math.max(
                    0,
                    Math.min(100, Math.round(sttProgress.percent))
                  )}%`
                }}
              />
            </div>
          </div>
        </div>
      ) : !transcribed ? (
        <div style={styles.body}>
          <div style={styles.empty} data-testid="transcript-empty">
            <div>
              이 클립은 아직 대본이 없습니다. 대본을 생성하면 단어 단위로
              영상을 편집할 수 있습니다.
            </div>
            <button
              type="button"
              style={mediaPath ? styles.btnPrimary : { ...styles.btnPrimary, ...styles.btnDisabled }}
              onClick={() => void handleGenerate()}
              disabled={!mediaPath}
              data-testid="transcript-generate-btn"
            >
              대본 생성
            </button>
            {!mediaPath && (
              <div style={styles.stat}>
                이 클립의 미디어 파일을 찾을 수 없습니다.
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div style={styles.body}>
            <div style={styles.wordWrap}>
              {words.map((w) => {
                const isDel = deletedWordIds.has(w.id)
                const isSel = selectedIds.has(w.id)
                return (
                  <span
                    key={w.id}
                    data-testid="transcript-word"
                    data-word-id={w.id}
                    data-deleted={isDel ? 'true' : 'false'}
                    data-selected={isSel ? 'true' : 'false'}
                    style={{
                      ...styles.word,
                      ...(isDel ? styles.wordDeleted : {}),
                      ...(isSel && isDel
                        ? styles.wordDeletedSelected
                        : isSel
                          ? styles.wordSelected
                          : {})
                    }}
                    onClick={(e) => handleWordClick(e, w)}
                  >
                    {w.text}
                  </span>
                )
              })}
            </div>
            <div style={{ marginTop: 12, ...styles.stat }}>
              단어 {words.length}개
              {deletedRanges.length > 0 &&
                ` · 삭제 구간 ${deletedRanges.length}개`}
              {hasSelection && ` · 선택 ${selectedArray.length}개`}
            </div>
          </div>

          {note && (
            <div style={styles.note} data-testid="transcript-note">
              {note}
            </div>
          )}
          {errorNote && (
            <div style={styles.errorNote} data-testid="transcript-error">
              {errorNote}
            </div>
          )}

          <div style={styles.toolbar}>
            <button
              type="button"
              style={{
                ...styles.btnDanger,
                ...(liveSelected.length === 0 ? styles.btnDisabled : {})
              }}
              onClick={handleDelete}
              disabled={liveSelected.length === 0}
              data-testid="transcript-delete-btn"
            >
              삭제{liveSelected.length > 0 ? ` (${liveSelected.length})` : ''}
            </button>
            <button
              type="button"
              style={{
                ...styles.btn,
                ...(struckSelected.length === 0 ? styles.btnDisabled : {})
              }}
              onClick={handleRestore}
              disabled={struckSelected.length === 0}
              data-testid="transcript-restore-btn"
            >
              복원
              {struckSelected.length > 0 ? ` (${struckSelected.length})` : ''}
            </button>
            <button
              type="button"
              style={styles.btn}
              onClick={handleRemoveFiller}
              data-testid="transcript-filler-btn"
              title="음·어·그 같은 군더더기 단어를 한 번에 제거"
            >
              필러 단어 제거 (음·어·그)
            </button>
            <button
              type="button"
              style={{
                ...styles.btn,
                ...(deletedRanges.length === 0 ? styles.btnDisabled : {})
              }}
              onClick={handleClear}
              disabled={deletedRanges.length === 0}
              data-testid="transcript-clear-btn"
            >
              대본 편집 초기화
            </button>
          </div>
        </>
      )}
    </div>
  )
}
