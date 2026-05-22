import { useEffect, useMemo, useState } from 'react'
import {
  CAPTION_ENTRANCE_KINDS,
  CAPTION_EXIT_KINDS,
  MAX_CAPTION_ANIM_MS,
  MIN_CAPTION_ANIM_MS,
  NO_CAPTION_ANIMATION,
  isCaptionClip,
  type CaptionAnimation,
  type CaptionClip,
  type CaptionEmphasis,
  type CaptionEntranceKind,
  type CaptionExitKind,
  type CaptionPreset,
  type CaptionSpan,
  type Project
} from '../../../shared/project'
import { useProjectStore } from '../store/project'
import {
  ALL_PRESETS,
  CAPTION_ANIM_LABELS,
  PRESET_LABELS,
  makeStyleFromPreset
} from '../lib/captionPresets'
import { BrandSwatchRow } from './BrandSwatchRow'

interface CaptionEditorProps {
  project: Project
  captionId: string
  onClose: () => void
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
  body: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: 14,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12
  } as React.CSSProperties,
  group: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4
  } as React.CSSProperties,
  label: {
    fontSize: 11,
    color: '#9aa0a6',
    fontWeight: 500
  } as React.CSSProperties,
  input: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12
  } as React.CSSProperties,
  textarea: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 13,
    minHeight: 80,
    resize: 'vertical' as const,
    fontFamily: 'inherit'
  } as React.CSSProperties,
  row: {
    display: 'flex',
    gap: 6
  } as React.CSSProperties,
  pillBtn: {
    flex: 1,
    background: '#1a1a1a',
    color: '#cbd5e1',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  pillBtnActive: {
    background: '#10b981',
    color: '#04231a',
    borderColor: '#10b981',
    fontWeight: 600
  } as React.CSSProperties,
  wordPreview: {
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
    lineHeight: 1.7,
    background: '#0d0d0d'
  } as React.CSSProperties,
  word: {
    display: 'inline-block',
    padding: '1px 4px',
    margin: '0 2px',
    borderRadius: 4,
    cursor: 'pointer',
    userSelect: 'none' as const
  } as React.CSSProperties,
  wordBold: { fontWeight: 800 } as React.CSSProperties,
  wordHighlight: {
    background: '#ffd400',
    color: '#1a1a1a'
  } as React.CSSProperties,
  wordPulse: { color: '#fcd34d', fontStyle: 'italic' as const } as React.CSSProperties,
  emphasisRow: {
    display: 'flex',
    gap: 4,
    marginTop: 6
  } as React.CSSProperties,
  small: {
    fontSize: 10,
    color: '#64748b'
  } as React.CSSProperties,
  warning: {
    fontSize: 11,
    color: '#fbbf24'
  } as React.CSSProperties,
  collapsible: {
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: 8,
    background: '#0d0d0d'
  } as React.CSSProperties
}

function msToMmSs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00.000'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  const remMs = ms % 1000
  return `${m}:${String(s).padStart(2, '0')}.${String(remMs).padStart(3, '0')}`
}

function mmSsToMs(s: string): number | null {
  // Accept "m:ss.SSS" or "m:ss" or plain ms.
  const trimmed = s.trim()
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  const m = /^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(trimmed)
  if (!m) return null
  const mins = Number(m[1])
  const secs = Number(m[2])
  const ms = m[3] ? Number(m[3].padEnd(3, '0')) : 0
  if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null
  return (mins * 60 + secs) * 1000 + ms
}

function splitToSpans(text: string, prev: CaptionSpan[]): CaptionSpan[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  // Preserve emphasis/color for matching positions when length unchanged.
  return words.map((w, i) => {
    const reuse = prev[i]
    if (reuse && reuse.text === w) return reuse
    return { text: w }
  })
}

function findCaption(project: Project, id: string): CaptionClip | null {
  for (const t of project.tracks) {
    if (t.kind !== 'caption') continue
    for (const c of t.clips) {
      if (isCaptionClip(c) && c.id === id) return c
    }
  }
  return null
}

export function CaptionEditor(props: CaptionEditorProps): JSX.Element | null {
  const { project, captionId, onClose } = props
  const updateCaption = useProjectStore((s) => s.updateCaption)
  const removeCaption = useProjectStore((s) => s.removeCaption)

  const caption = useMemo(() => findCaption(project, captionId), [project, captionId])

  // Local draft for text field — flush on blur.
  const [draftText, setDraftText] = useState(
    caption ? caption.spans.map((s) => s.text).join(' ') : ''
  )
  const [draftStart, setDraftStart] = useState(caption ? msToMmSs(caption.startMs) : '')
  const [draftEnd, setDraftEnd] = useState(caption ? msToMmSs(caption.endMs) : '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [selectedSpanIdx, setSelectedSpanIdx] = useState<number | null>(null)

  useEffect(() => {
    if (caption) {
      setDraftText(caption.spans.map((s) => s.text).join(' '))
      setDraftStart(msToMmSs(caption.startMs))
      setDraftEnd(msToMmSs(caption.endMs))
    }
  }, [caption?.id]) // re-sync when switching to a different caption

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!caption) {
    return (
      <div style={styles.panel} data-testid="caption-editor">
        <div style={styles.header}>
          <div style={styles.title}>자막 편집</div>
          <button style={styles.closeBtn} onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div style={{ padding: 16, color: '#94a3b8' }}>
          자막을 찾을 수 없습니다.
        </div>
      </div>
    )
  }

  const commitText = (): void => {
    const next = splitToSpans(draftText, caption.spans)
    if (next.length === 0) {
      // Allow empty for now but warn — keep at least one empty span.
      updateCaption(captionId, { spans: [{ text: '' }] })
    } else {
      updateCaption(captionId, { spans: next })
    }
  }

  const commitTime = (which: 'start' | 'end'): void => {
    const raw = which === 'start' ? draftStart : draftEnd
    const parsed = mmSsToMs(raw)
    if (parsed === null) {
      // Reset to current.
      if (which === 'start') setDraftStart(msToMmSs(caption.startMs))
      else setDraftEnd(msToMmSs(caption.endMs))
      return
    }
    if (which === 'start') {
      const startMs = Math.min(parsed, caption.endMs - 100)
      updateCaption(captionId, { startMs })
    } else {
      const endMs = Math.max(parsed, caption.startMs + 100)
      updateCaption(captionId, { endMs })
    }
  }

  const applyPreset = (preset: CaptionPreset): void => {
    const fresh = makeStyleFromPreset(preset)
    updateCaption(captionId, { style: fresh })
  }

  const toggleEmphasis = (spanIdx: number, e: CaptionEmphasis): void => {
    const next = caption.spans.map((s, i) => {
      if (i !== spanIdx) return s
      return { ...s, emphasis: s.emphasis === e ? undefined : e }
    })
    updateCaption(captionId, { spans: next })
  }

  const setSpanColor = (spanIdx: number, color: string | undefined): void => {
    const next = caption.spans.map((s, i) =>
      i === spanIdx ? { ...s, color } : s
    )
    updateCaption(captionId, { spans: next })
  }

  // Phase 3.9 — caption animation. Merge a partial onto the current spec
  // (back-filling NO_CAPTION_ANIMATION when the clip has none yet). Reuses
  // updateCaption — `animation` flows through its `{...c,...partial}` spread,
  // and undo is automatic (updateCaption → set + temporal).
  const anim: CaptionAnimation = caption.animation ?? NO_CAPTION_ANIMATION
  const setAnim = (partial: Partial<CaptionAnimation>): void => {
    updateCaption(captionId, {
      animation: { ...(caption.animation ?? NO_CAPTION_ANIMATION), ...partial }
    })
  }

  return (
    <div style={styles.panel} data-testid="caption-editor">
      <div style={styles.header}>
        <div style={styles.title}>자막 편집</div>
        <button
          style={styles.closeBtn}
          onClick={onClose}
          aria-label="닫기"
          data-testid="caption-editor-close"
        >
          ✕
        </button>
      </div>
      <div style={styles.body}>
        {/* Text */}
        <div style={styles.group}>
          <div style={styles.label}>자막 내용</div>
          <textarea
            style={styles.textarea}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onBlur={commitText}
            data-testid="caption-text-input"
          />
          <div style={styles.small}>
            단어 단위로 분리되어 강조를 적용할 수 있어요.
          </div>
        </div>

        {/* Time */}
        <div style={styles.row}>
          <div style={{ ...styles.group, flex: 1 }}>
            <div style={styles.label}>시작 (m:ss.SSS)</div>
            <input
              style={styles.input}
              value={draftStart}
              onChange={(e) => setDraftStart(e.target.value)}
              onBlur={() => commitTime('start')}
              data-testid="caption-start-input"
            />
          </div>
          <div style={{ ...styles.group, flex: 1 }}>
            <div style={styles.label}>끝 (m:ss.SSS)</div>
            <input
              style={styles.input}
              value={draftEnd}
              onChange={(e) => setDraftEnd(e.target.value)}
              onBlur={() => commitTime('end')}
              data-testid="caption-end-input"
            />
          </div>
        </div>

        {/* Preset */}
        <div style={styles.group}>
          <div style={styles.label}>스타일 프리셋</div>
          <select
            style={styles.input}
            value={caption.style.preset}
            onChange={(e) => applyPreset(e.target.value as CaptionPreset)}
            data-testid="caption-preset-select"
          >
            {ALL_PRESETS.map((p) => (
              <option key={p} value={p}>
                {PRESET_LABELS[p]}
              </option>
            ))}
          </select>
        </div>

        {/* Font size */}
        <div style={styles.group}>
          <div style={styles.label}>
            글자 크기: {caption.style.fontSize}px
          </div>
          <input
            type="range"
            min={16}
            max={96}
            step={1}
            value={caption.style.fontSize}
            onChange={(e) =>
              updateCaption(captionId, {
                style: { ...caption.style, fontSize: Number(e.target.value) }
              })
            }
            data-testid="caption-fontsize-slider"
          />
        </div>

        {/* Vertical position */}
        <div style={styles.group}>
          <div style={styles.label}>
            세로 위치: {caption.style.yPosition.toFixed(2)}
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={caption.style.yPosition}
            onChange={(e) =>
              updateCaption(captionId, {
                style: { ...caption.style, yPosition: Number(e.target.value) }
              })
            }
            data-testid="caption-yposition-slider"
          />
        </div>

        {/* Alignment */}
        <div style={styles.group}>
          <div style={styles.label}>정렬</div>
          <div style={styles.row}>
            {(['left', 'center', 'right'] as const).map((a) => (
              <button
                key={a}
                style={{
                  ...styles.pillBtn,
                  ...(caption.style.align === a ? styles.pillBtnActive : {})
                }}
                onClick={() =>
                  updateCaption(captionId, {
                    style: { ...caption.style, align: a }
                  })
                }
                data-testid={`caption-align-${a}`}
              >
                {a === 'left' ? '왼쪽' : a === 'center' ? '가운데' : '오른쪽'}
              </button>
            ))}
          </div>
        </div>

        {/* Background */}
        <div style={styles.group}>
          <div style={styles.label}>배경</div>
          <div style={styles.row}>
            {(['none', 'solid', 'pill', 'highlight'] as const).map((bg) => (
              <button
                key={bg}
                style={{
                  ...styles.pillBtn,
                  ...(caption.style.background === bg ? styles.pillBtnActive : {})
                }}
                onClick={() =>
                  updateCaption(captionId, {
                    style: { ...caption.style, background: bg }
                  })
                }
                data-testid={`caption-bg-${bg}`}
              >
                {bg === 'none'
                  ? '없음'
                  : bg === 'solid'
                    ? '블록'
                    : bg === 'pill'
                      ? '필'
                      : '하이라이트'}
              </button>
            ))}
          </div>
        </div>

        {/* Animation (Phase 3.9) — entrance/exit + per-direction durations */}
        <div style={styles.group}>
          <div style={styles.label}>애니메이션</div>
          <div style={styles.row}>
            <div style={{ ...styles.group, flex: 1 }}>
              <div style={styles.label}>등장</div>
              <select
                style={styles.input}
                value={anim.entrance}
                onChange={(e) =>
                  setAnim({
                    entrance: e.target.value as CaptionEntranceKind
                  })
                }
                data-testid="caption-anim-entrance"
              >
                {CAPTION_ENTRANCE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {CAPTION_ANIM_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ ...styles.group, flex: 1 }}>
              <div style={styles.label}>퇴장</div>
              <select
                style={styles.input}
                value={anim.exit}
                onChange={(e) =>
                  setAnim({ exit: e.target.value as CaptionExitKind })
                }
                data-testid="caption-anim-exit"
              >
                {CAPTION_EXIT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {CAPTION_ANIM_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {anim.entrance !== 'none' && (
            <div style={styles.group}>
              <div style={styles.label}>등장 시간: {anim.inMs}ms</div>
              <input
                type="range"
                min={MIN_CAPTION_ANIM_MS}
                max={MAX_CAPTION_ANIM_MS}
                step={50}
                value={anim.inMs}
                onChange={(e) => setAnim({ inMs: Number(e.target.value) })}
                data-testid="caption-anim-in"
              />
            </div>
          )}
          {anim.exit !== 'none' && (
            <div style={styles.group}>
              <div style={styles.label}>퇴장 시간: {anim.outMs}ms</div>
              <input
                type="range"
                min={MIN_CAPTION_ANIM_MS}
                max={MAX_CAPTION_ANIM_MS}
                step={50}
                value={anim.outMs}
                onChange={(e) => setAnim({ outMs: Number(e.target.value) })}
                data-testid="caption-anim-out"
              />
            </div>
          )}
        </div>

        {/* Word preview / emphasis picker */}
        <div style={styles.group}>
          <div style={styles.label}>키워드 강조 (단어 클릭)</div>
          <div style={styles.wordPreview} data-testid="caption-word-preview">
            {caption.spans.length === 0 || caption.spans[0].text === '' ? (
              <span style={styles.small}>자막 내용을 먼저 입력하세요.</span>
            ) : (
              caption.spans.map((s, i) => (
                <span
                  key={i}
                  style={{
                    ...styles.word,
                    ...(s.emphasis === 'bold' ? styles.wordBold : {}),
                    ...(s.emphasis === 'highlight' ? styles.wordHighlight : {}),
                    ...(s.emphasis === 'pulse' ? styles.wordPulse : {}),
                    ...(selectedSpanIdx === i
                      ? { outline: '1px dashed #10b981' }
                      : {}),
                    color: s.color ?? undefined
                  }}
                  onClick={() => setSelectedSpanIdx(i)}
                  data-testid={`caption-word-${i}`}
                  data-emphasis={s.emphasis ?? 'none'}
                >
                  {s.text}
                </span>
              ))
            )}
          </div>
          {selectedSpanIdx !== null && caption.spans[selectedSpanIdx] && (
            <>
              <div style={styles.emphasisRow}>
                {(['bold', 'highlight', 'pulse'] as const).map((e) => {
                  const isActive =
                    caption.spans[selectedSpanIdx!]?.emphasis === e
                  return (
                    <button
                      key={e}
                      style={{
                        ...styles.pillBtn,
                        ...(isActive ? styles.pillBtnActive : {})
                      }}
                      onClick={() => toggleEmphasis(selectedSpanIdx!, e)}
                      data-testid={`emphasis-${e}`}
                    >
                      {e === 'bold' ? '굵게' : e === 'highlight' ? '강조' : '펄스'}
                    </button>
                  )
                })}
              </div>
              <button
                style={{
                  ...styles.pillBtn,
                  marginTop: 4
                }}
                onClick={() => setShowAdvanced((v) => !v)}
                data-testid="caption-toggle-advanced"
              >
                {showAdvanced ? '고급 닫기' : '고급'}
              </button>
              {showAdvanced && (
                <div style={styles.collapsible}>
                  <div style={styles.label}>단어 색상</div>
                  <input
                    type="color"
                    value={
                      caption.spans[selectedSpanIdx!]?.color ?? '#ffffff'
                    }
                    onChange={(e) =>
                      setSpanColor(selectedSpanIdx!, e.target.value)
                    }
                    data-testid="caption-word-color"
                  />
                  <button
                    style={{
                      ...styles.pillBtn,
                      marginLeft: 8
                    }}
                    onClick={() => setSpanColor(selectedSpanIdx!, undefined)}
                    data-testid="caption-word-color-clear"
                  >
                    초기화
                  </button>
                  <BrandSwatchRow
                    label="브랜드"
                    onPick={(hex) => setSpanColor(selectedSpanIdx!, hex)}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Delete button */}
        <button
          style={{
            ...styles.pillBtn,
            color: '#fca5a5',
            borderColor: '#4a1f1f',
            background: '#1f0d0d'
          }}
          onClick={() => {
            removeCaption(captionId)
            onClose()
          }}
          data-testid="caption-delete-btn"
        >
          자막 삭제
        </button>
      </div>
    </div>
  )
}
