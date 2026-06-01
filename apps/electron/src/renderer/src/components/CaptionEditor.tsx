import { useEffect, useMemo, useState } from 'react'
import type { CustomCaptionFont } from '../../../shared/ipc'
import { useFocusTrap } from '../lib/useFocusTrap'
import {
  CAPTION_ENTRANCE_KINDS,
  CAPTION_EXIT_KINDS,
  DEFAULT_CAPTION_GLOW,
  DEFAULT_CAPTION_SHADOW,
  DEFAULT_CAPTION_STROKE_COLOR,
  DEFAULT_CAPTION_STROKE_WIDTH,
  KARAOKE_STYLES,
  MAX_CAPTION_ANIM_MS,
  MAX_CAPTION_BG_FRAC,
  MAX_CAPTION_SHADOW_BLUR,
  MAX_CAPTION_SHADOW_OFFSET,
  MAX_CAPTION_STROKE_WIDTH,
  MIN_CAPTION_ANIM_MS,
  NO_CAPTION_ANIMATION,
  NO_CAPTION_KARAOKE,
  evenSplitWords,
  isCaptionClip,
  CAPTION_FONT_FAMILIES,
  resolveCaptionWords,
  type CaptionAnimation,
  type CaptionClip,
  type CaptionEmphasis,
  type CaptionEntranceKind,
  type CaptionExitKind,
  type CaptionFontFamilyId,
  type CaptionKaraoke,
  type CaptionKaraokeStyle,
  type CaptionPreset,
  type CaptionSpan,
  type CaptionStyle,
  type CaptionTextShadow,
  type CaptionTextStroke,
  type Project
} from '../../../shared/project'
import { useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import {
  ALL_PRESETS,
  CAPTION_ANIM_LABELS,
  PRESET_LABELS,
  makeStyleFromPreset
} from '../lib/captionPresets'
import { BrandSwatchRow } from './BrandSwatchRow'
import { toMediaUrl } from '../lib/mediaUrl'

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
  inlineBtn: {
    background: '#1f2937',
    color: '#cbd5e1',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 11,
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  collapsible: {
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: 8,
    background: '#0d0d0d'
  } as React.CSSProperties,
  karaokeToggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8
  } as React.CSSProperties,
  karaokeHint: {
    fontSize: 10,
    color: '#64748b',
    lineHeight: 1.5
  } as React.CSSProperties,
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: '#9aa0a6'
  } as React.CSSProperties
}

function fontFormatSource(format: CustomCaptionFont['format']): string {
  return format
}

function injectCustomCaptionFonts(fonts: CustomCaptionFont[]): void {
  if (typeof document === 'undefined') return
  const id = 'reels-custom-caption-fonts'
  let styleEl = document.getElementById(id) as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = id
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = fonts
    .map((font) => {
      const url = toMediaUrl(font.path)
      return `@font-face{font-family:'${font.familyName}';src:url("${url}") format('${fontFormatSource(font.format)}');font-weight:400 900;font-style:normal;font-display:swap;}`
    })
    .join('\n')
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

function bulkCaptionIds(
  project: Project,
  selectedClipIds: ReadonlySet<string>,
  captionId: string
): string[] {
  if (!selectedClipIds.has(captionId)) return [captionId]
  const ids: string[] = []
  for (const t of project.tracks) {
    if (t.kind !== 'caption') continue
    for (const c of t.clips) {
      if (isCaptionClip(c) && selectedClipIds.has(c.id)) ids.push(c.id)
    }
  }
  return ids.length > 1 ? ids : [captionId]
}

export function CaptionEditor(props: CaptionEditorProps): JSX.Element | null {
  const { project, captionId, onClose } = props
  const updateCaption = useProjectStore((s) => s.updateCaption)
  const updateCaptions = useProjectStore((s) => s.updateCaptions)
  const removeCaption = useProjectStore((s) => s.removeCaption)
  const selectedClipIds = useTimelineUi((s) => s.selectedClipIds)

  const caption = useMemo(() => findCaption(project, captionId), [project, captionId])
  const styleTargetIds = useMemo(
    () => bulkCaptionIds(project, selectedClipIds, captionId),
    [project, selectedClipIds, captionId]
  )

  // Local draft for text field — flush on blur.
  const [draftText, setDraftText] = useState(
    caption ? caption.spans.map((s) => s.text).join(' ') : ''
  )
  const [draftStart, setDraftStart] = useState(caption ? msToMmSs(caption.startMs) : '')
  const [draftEnd, setDraftEnd] = useState(caption ? msToMmSs(caption.endMs) : '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [selectedSpanIdx, setSelectedSpanIdx] = useState<number | null>(null)
  const [fontSearch, setFontSearch] = useState('')
  const [customFonts, setCustomFonts] = useState<CustomCaptionFont[]>([])
  const [fontImportError, setFontImportError] = useState<string | null>(null)

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

  useEffect(() => {
    let cancelled = false
    const ext = window.electron?.captionFonts
    if (!ext) return
    void ext.list().then((fonts) => {
      if (cancelled) return
      setCustomFonts(fonts)
      injectCustomCaptionFonts(fonts)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Hook declared at top-level to keep call order stable across the two
  // possible returns below. Trap is always active while CaptionEditor is
  // mounted — the parent controls mount based on `editingCaptionId`.
  const focusTrapRef = useFocusTrap<HTMLDivElement>(true)

  if (!caption) {
    return (
      <div
        ref={focusTrapRef}
        style={styles.panel}
        data-testid="caption-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="caption-editor-title"
      >
        <div style={styles.header}>
          <div id="caption-editor-title" style={styles.title}>자막 편집</div>
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
    updateCaptions(styleTargetIds, { style: fresh })
  }

  const updateCaptionStyle = (partial: Partial<CaptionStyle>): void => {
    updateCaptions(styleTargetIds, { style: partial })
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
    updateCaptions(styleTargetIds, {
      animation: { ...(caption.animation ?? NO_CAPTION_ANIMATION), ...partial }
    })
  }

  // Phase 3.22 — karaoke (word-level highlight). `words` resolves the clip's
  // per-word timing; karaoke is only usable once word timing exists (from STT
  // or an even-split fallback). Writes flow through updateCaption (zundo undo).
  const words = resolveCaptionWords(caption)
  const hasWordTiming = words.length > 0
  const karaoke = caption.karaoke
  const karaokeOn = karaoke?.enabled === true
  const setKaraoke = (partial: Partial<CaptionKaraoke>): void => {
    updateCaption(captionId, {
      karaoke: { ...(caption.karaoke ?? NO_CAPTION_KARAOKE), ...partial }
    })
  }
  // Toggle karaoke on/off. Turning ON also resets a typewriter entrance to
  // 'none' — the two reveal mechanisms must not fight (see disabled option).
  const toggleKaraoke = (): void => {
    if (karaokeOn) {
      setKaraoke({ enabled: false })
      return
    }
    const patch: Partial<CaptionClip> = {
      karaoke: { ...(caption.karaoke ?? NO_CAPTION_KARAOKE), enabled: true }
    }
    if ((caption.animation ?? NO_CAPTION_ANIMATION).entrance === 'typewriter') {
      patch.animation = {
        ...(caption.animation ?? NO_CAPTION_ANIMATION),
        entrance: 'none'
      }
    }
    updateCaption(captionId, patch)
  }

  // Phase 3.23 — caption text decoration (outline / drop-shadow / glow).
  // `style.textStroke` / `style.textShadow` absent ⇒ byte-identical legacy
  // caption. Writes flow through updateCaption (zundo undo). `null` clears the
  // field; a partial merges over the current value (back-filling the default
  // when the field is absent so the first toggle seeds a sensible look).
  const textStroke = caption.style.textStroke
  const textShadow = caption.style.textShadow
  const setTextStroke = (partial: Partial<CaptionTextStroke> | null): void => {
    if (partial === null) {
      updateCaptionStyle({ textStroke: undefined })
      return
    }
    updateCaptionStyle({
      textStroke: {
        ...(caption.style.textStroke ?? {
          color: DEFAULT_CAPTION_STROKE_COLOR,
          width: DEFAULT_CAPTION_STROKE_WIDTH
        }),
        ...partial
      }
    })
  }
  const setTextShadow = (partial: Partial<CaptionTextShadow> | null): void => {
    if (partial === null) {
      updateCaptionStyle({ textShadow: undefined })
      return
    }
    updateCaptionStyle({
      textShadow: {
        ...(caption.style.textShadow ?? DEFAULT_CAPTION_SHADOW),
        ...partial
      }
    })
  }

  const fontOptions = useMemo(() => {
    const builtIn = CAPTION_FONT_FAMILIES.map((f) => ({
      id: f.id as CaptionFontFamilyId,
      label: f.label,
      stack: f.stack,
      custom: false
    }))
    const custom = customFonts.map((f) => ({
      id: f.id as CaptionFontFamilyId,
      label: `${f.label} (파일)`,
      stack: `'${f.familyName}'`,
      custom: true
    }))
    const q = fontSearch.trim().toLowerCase()
    const all = [...builtIn, ...custom]
    if (!q) return all
    return all.filter(
      (f) =>
        f.label.toLowerCase().includes(q) ||
        f.id.toLowerCase().includes(q) ||
        f.stack.toLowerCase().includes(q)
    )
  }, [customFonts, fontSearch])

  const selectedFontAvailable = fontOptions.some(
    (f) => f.id === (caption.style.fontFamilyId ?? 'pretendard')
  )

  const importFontFile = async (): Promise<void> => {
    setFontImportError(null)
    const ext = window.electron
    if (!ext?.fs || !ext.captionFonts) return
    const picked = await ext.fs.pickFile([
      { name: 'Font files', extensions: ['otf', 'ttf', 'woff', 'woff2'] }
    ])
    if (!picked) return
    const result = await ext.captionFonts.importFont(picked)
    if (!result.ok) {
      setFontImportError('폰트 파일을 가져오지 못했습니다.')
      return
    }
    const next = await ext.captionFonts.list()
    setCustomFonts(next)
    injectCustomCaptionFonts(next)
    updateCaptionStyle({ fontFamilyId: result.font.id })
    setFontSearch('')
  }

  return (
    <div
      ref={focusTrapRef}
      style={styles.panel}
      data-testid="caption-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="caption-editor-title"
    >
      <div style={styles.header}>
        <div id="caption-editor-title" style={styles.title}>자막 편집</div>
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

        {/* Font family */}
        <div style={styles.group}>
          <div style={styles.label}>폰트</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              style={{ ...styles.input, flex: 1 }}
              value={fontSearch}
              onChange={(e) => setFontSearch(e.target.value)}
              placeholder="폰트 검색"
              data-testid="caption-fontfamily-search"
            />
            <button
              type="button"
              style={styles.inlineBtn}
              onClick={importFontFile}
              data-testid="caption-font-import"
            >
              파일 추가
            </button>
          </div>
          <select
            style={styles.input}
            value={caption.style.fontFamilyId ?? 'pretendard'}
            onChange={(e) =>
              updateCaptionStyle({
                fontFamilyId: e.target.value as CaptionFontFamilyId
              })
            }
            data-testid="caption-fontfamily-select"
          >
            {!selectedFontAvailable && (
              <option value={caption.style.fontFamilyId ?? 'pretendard'}>
                현재 선택된 폰트
              </option>
            )}
            {fontOptions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          {fontImportError && <div style={styles.warning}>{fontImportError}</div>}
        </div>

        {/* Font size */}
        <div style={styles.group}>
          <div style={styles.label}>
            글자 크기: {caption.style.fontSize}px
          </div>
          {/* pptx12 슬라이드 12 — 사용자 보고 "최대 크기가 너무 작음"
              (이전 max=96). 500 으로 확장. 입력란도 함께 노출해서 정밀
              값 지정 가능 (슬라이더로는 1px 단위 큰 범위 미세 조정이
              번거로움). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={16}
              max={500}
              step={1}
              value={caption.style.fontSize}
              onChange={(e) =>
                updateCaptionStyle({ fontSize: Number(e.target.value) })
              }
              style={{ flex: 1 }}
              data-testid="caption-fontsize-slider"
            />
            <input
              type="number"
              min={16}
              max={500}
              step={1}
              value={caption.style.fontSize}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!Number.isFinite(v)) return
                const clamped = Math.max(16, Math.min(500, Math.round(v)))
                updateCaptionStyle({ fontSize: clamped })
              }}
              style={{
                width: 64,
                background: '#0a0a0a',
                color: '#f5f5f5',
                border: '1px solid #2a2a2a',
                borderRadius: 4,
                padding: '3px 6px',
                fontSize: 11,
                textAlign: 'right'
              }}
              data-testid="caption-fontsize-input"
              aria-label="글자 크기 (px)"
            />
          </div>
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
              updateCaptionStyle({ yPosition: Number(e.target.value) })
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
                  updateCaptionStyle({ align: a })
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
                  updateCaptionStyle({ background: bg })
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

        {caption.style.background !== 'none' && caption.style.background !== 'highlight' && (
          <div style={styles.group}>
            <div style={styles.label}>자막 배경 크기</div>

            <div style={{ ...styles.label, marginTop: 8 }}>
              자막 배경 높이: {Math.round((caption.style.backgroundHeightFrac ?? 0) * 100)}%
            </div>
            <input
              type="range"
              min={0}
              max={MAX_CAPTION_BG_FRAC}
              step={0.01}
              value={caption.style.backgroundHeightFrac ?? 0}
              onChange={(e) =>
                updateCaptionStyle({ backgroundHeightFrac: Number(e.target.value) })
              }
              data-testid="caption-bg-height-frac"
            />

            <div style={{ ...styles.label, marginTop: 8 }}>
              자막 배경 너비: {Math.round((caption.style.backgroundWidthFrac ?? 0) * 100)}%
            </div>
            <input
              type="range"
              min={0}
              max={MAX_CAPTION_BG_FRAC}
              step={0.01}
              value={caption.style.backgroundWidthFrac ?? 0}
              onChange={(e) =>
                updateCaptionStyle({ backgroundWidthFrac: Number(e.target.value) })
              }
              data-testid="caption-bg-width-frac"
            />
          </div>
        )}

        {/* Text effects (Phase 3.23) — outline / drop-shadow / glow */}
        <div style={styles.group}>
          <div style={styles.label}>텍스트 효과</div>

          {/* Outline */}
          <div style={styles.collapsible}>
            <label style={styles.checkRow}>
              <input
                type="checkbox"
                checked={textStroke !== undefined}
                onChange={(e) =>
                  setTextStroke(e.target.checked ? {} : null)
                }
                data-testid="caption-stroke-toggle"
              />
              외곽선
            </label>
            {textStroke && (
              <>
                <div style={{ ...styles.label, marginTop: 8 }}>
                  외곽선 색상
                </div>
                <input
                  type="color"
                  value={textStroke.color}
                  onChange={(e) =>
                    setTextStroke({ color: e.target.value })
                  }
                  data-testid="caption-stroke-color"
                />
                <div style={{ ...styles.label, marginTop: 8 }}>
                  외곽선 굵기: {textStroke.width}px
                </div>
                <input
                  type="range"
                  min={0}
                  max={MAX_CAPTION_STROKE_WIDTH}
                  step={1}
                  value={textStroke.width}
                  onChange={(e) =>
                    setTextStroke({ width: Number(e.target.value) })
                  }
                  data-testid="caption-stroke-width"
                />
              </>
            )}
          </div>

          {/* Drop-shadow / glow */}
          <div style={{ ...styles.collapsible, marginTop: 8 }}>
            <label style={styles.checkRow}>
              <input
                type="checkbox"
                checked={textShadow !== undefined}
                onChange={(e) =>
                  setTextShadow(e.target.checked ? {} : null)
                }
                data-testid="caption-shadow-toggle"
              />
              그림자
            </label>
            {textShadow && (
              <>
                <div style={{ ...styles.label, marginTop: 8 }}>
                  그림자 색상
                </div>
                <input
                  type="color"
                  value={textShadow.color}
                  onChange={(e) =>
                    setTextShadow({ color: e.target.value })
                  }
                  data-testid="caption-shadow-color"
                />
                <div style={{ ...styles.label, marginTop: 8 }}>
                  가로 위치: {textShadow.offsetX}px
                </div>
                <input
                  type="range"
                  min={-MAX_CAPTION_SHADOW_OFFSET}
                  max={MAX_CAPTION_SHADOW_OFFSET}
                  step={1}
                  value={textShadow.offsetX}
                  onChange={(e) =>
                    setTextShadow({ offsetX: Number(e.target.value) })
                  }
                  data-testid="caption-shadow-offset-x"
                />
                <div style={{ ...styles.label, marginTop: 8 }}>
                  세로 위치: {textShadow.offsetY}px
                </div>
                <input
                  type="range"
                  min={-MAX_CAPTION_SHADOW_OFFSET}
                  max={MAX_CAPTION_SHADOW_OFFSET}
                  step={1}
                  value={textShadow.offsetY}
                  onChange={(e) =>
                    setTextShadow({ offsetY: Number(e.target.value) })
                  }
                  data-testid="caption-shadow-offset-y"
                />
                <div style={{ ...styles.label, marginTop: 8 }}>
                  번짐: {textShadow.blur}px
                </div>
                <input
                  type="range"
                  min={0}
                  max={MAX_CAPTION_SHADOW_BLUR}
                  step={1}
                  value={textShadow.blur}
                  onChange={(e) =>
                    setTextShadow({ blur: Number(e.target.value) })
                  }
                  data-testid="caption-shadow-blur"
                />
              </>
            )}
            <button
              style={{ ...styles.pillBtn, marginTop: 8 }}
              onClick={() => setTextShadow(DEFAULT_CAPTION_GLOW)}
              data-testid="caption-glow-btn"
            >
              글로우 적용
            </button>
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
                  <option
                    key={k}
                    value={k}
                    // Typewriter + karaoke are two competing reveal
                    // mechanisms — disable typewriter while karaoke is on.
                    disabled={k === 'typewriter' && karaokeOn}
                  >
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

        {/* Karaoke — word-level highlight (Phase 3.22) */}
        <div style={styles.group}>
          <div style={styles.label}>단어별 강조 (가라오케)</div>
          <div style={styles.karaokeToggleRow}>
            <input
              type="checkbox"
              checked={karaokeOn}
              disabled={!hasWordTiming}
              onChange={toggleKaraoke}
              data-testid="caption-karaoke-toggle"
            />
            <span style={{ fontSize: 11, color: '#cbd5e1' }}>
              말하는 단어를 실시간으로 강조
            </span>
          </div>
          {!hasWordTiming && (
            <>
              <div style={styles.karaokeHint}>
                STT로 생성한 자막에서 쓸 수 있어요. 직접 입력한 자막은 아래
                버튼으로 단어 타이밍을 만들 수 있어요.
              </div>
              <button
                style={{ ...styles.pillBtn, marginTop: 4 }}
                onClick={() =>
                  updateCaption(captionId, { words: evenSplitWords(caption) })
                }
                data-testid="caption-karaoke-evensplit"
              >
                단어 타이밍 균등 분배
              </button>
            </>
          )}
          {karaokeOn && (
            <div style={styles.collapsible}>
              {/* Highlight style */}
              <div style={styles.label}>강조 방식</div>
              <select
                style={styles.input}
                value={
                  caption.karaoke?.highlightStyle ??
                  NO_CAPTION_KARAOKE.highlightStyle
                }
                onChange={(e) =>
                  setKaraoke({
                    highlightStyle: e.target.value as CaptionKaraokeStyle
                  })
                }
                data-testid="caption-karaoke-style"
              >
                {KARAOKE_STYLES.map((s) => (
                  <option key={s} value={s}>
                    {s === 'color-fill' ? '색상 채우기' : '확대 팝'}
                  </option>
                ))}
              </select>
              {/* Highlight color */}
              <div style={{ ...styles.label, marginTop: 8 }}>강조 색상</div>
              <input
                type="color"
                value={
                  caption.karaoke?.highlightColor ??
                  NO_CAPTION_KARAOKE.highlightColor
                }
                onChange={(e) =>
                  setKaraoke({ highlightColor: e.target.value })
                }
                data-testid="caption-karaoke-color"
              />
              {/* Highlight box — color-fill only */}
              {(caption.karaoke?.highlightStyle ??
                NO_CAPTION_KARAOKE.highlightStyle) === 'color-fill' && (
                <label
                  style={{ ...styles.checkRow, marginTop: 8 }}
                  data-testid="caption-karaoke-box-row"
                >
                  <input
                    type="checkbox"
                    checked={caption.karaoke?.highlightBox === true}
                    onChange={(e) =>
                      setKaraoke({ highlightBox: e.target.checked })
                    }
                    data-testid="caption-karaoke-box"
                  />
                  강조 단어에 박스 배경
                </label>
              )}
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
