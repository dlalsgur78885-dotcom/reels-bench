import {
  TEXT_TEMPLATES,
  TEXT_TEMPLATE_CATEGORY_LABELS,
  type TextTemplate,
  type TextTemplateCategory
} from '../../../shared/textTemplates'

/**
 * Text-template picker (Phase 3.24) — a side panel listing pre-designed caption
 * blocks grouped by category. Clicking a card inserts a plain `CaptionClip`
 * (see `insertTextTemplateAtPlayhead`); the card preview is a CSS approximation
 * of the template's style — the real caption renders in PreviewCanvas once
 * inserted. Shares the dark-panel styling idiom of `CaptionEditor`.
 */
interface TextTemplatePickerProps {
  onClose: () => void
  onApply: (templateId: string) => void
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
    gap: 16
  } as React.CSSProperties,
  section: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8
  } as React.CSSProperties,
  sectionLabel: {
    fontSize: 11,
    color: '#9aa0a6',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4
  } as React.CSSProperties,
  card: {
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    background: '#0d0d0d',
    padding: 10,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    textAlign: 'left' as const,
    width: '100%'
  } as React.CSSProperties,
  cardLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#f5f5f5'
  } as React.CSSProperties,
  previewBox: {
    minHeight: 56,
    borderRadius: 6,
    background:
      'repeating-conic-gradient(#1a1a1a 0% 25%, #161616 0% 50%) 50% / 16px 16px',
    display: 'flex',
    alignItems: 'center',
    padding: '8px 10px',
    overflow: 'hidden'
  } as React.CSSProperties,
  hint: {
    fontSize: 10,
    color: '#64748b'
  } as React.CSSProperties
}

/** Preview font size scaled down so a 96px caption still fits the card. */
const PREVIEW_MAX_FONT = 22

/** Map a template's CaptionStyle to an approximate CSS preview style. */
function previewTextStyle(t: TextTemplate): React.CSSProperties {
  const { style } = t
  const scaled = Math.min(
    PREVIEW_MAX_FONT,
    Math.max(11, Math.round(style.fontSize / 4))
  )
  const css: React.CSSProperties = {
    fontSize: scaled,
    fontWeight: 800,
    color: '#ffffff',
    lineHeight: 1.25,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '100%'
  }
  if (style.textStroke) {
    // Scale the stroke width down with the font; keep it visible.
    const w = Math.max(0.5, style.textStroke.width / 4)
    ;(css as Record<string, unknown>).WebkitTextStroke =
      `${w}px ${style.textStroke.color}`
    ;(css as Record<string, unknown>).paintOrder = 'stroke fill'
  }
  if (style.textShadow) {
    const s = style.textShadow
    css.textShadow = `${s.offsetX / 4}px ${s.offsetY / 4}px ${
      s.blur / 4
    }px ${s.color}`
  }
  return css
}

/** Map the template's background field to a chip wrapper style. */
function previewChipStyle(t: TextTemplate): React.CSSProperties {
  const bg = t.style.background
  const base: React.CSSProperties = {
    display: 'inline-block',
    maxWidth: '100%'
  }
  if (bg === 'solid') {
    return { ...base, background: '#000000', padding: '2px 8px', borderRadius: 3 }
  }
  if (bg === 'pill') {
    return {
      ...base,
      background: '#000000',
      padding: '3px 12px',
      borderRadius: 999
    }
  }
  if (bg === 'highlight') {
    return { ...base, background: '#ffd400', padding: '2px 6px', borderRadius: 2 }
  }
  return base
}

/** Section order for the body — every category, even if currently empty. */
const CATEGORY_ORDER: TextTemplateCategory[] = [
  'title',
  'lower-third',
  'cta',
  'hook',
  'list'
]

export function TextTemplatePicker(
  props: TextTemplatePickerProps
): JSX.Element {
  const { onClose, onApply } = props

  return (
    <div style={styles.panel} data-testid="text-template-picker">
      <div style={styles.header}>
        <div style={styles.title}>텍스트 템플릿</div>
        <button
          style={styles.closeBtn}
          onClick={onClose}
          aria-label="닫기"
          data-testid="text-template-picker-close"
        >
          ✕
        </button>
      </div>
      <div style={styles.body}>
        {CATEGORY_ORDER.map((cat) => {
          const items = TEXT_TEMPLATES.filter((t) => t.category === cat)
          if (items.length === 0) return null
          return (
            <div key={cat} style={styles.section}>
              <div style={styles.sectionLabel}>
                {TEXT_TEMPLATE_CATEGORY_LABELS[cat]}
              </div>
              {items.map((t) => {
                const text = t.spans.map((s) => s.text).join(' ')
                const align =
                  t.style.align === 'left'
                    ? 'flex-start'
                    : t.style.align === 'right'
                      ? 'flex-end'
                      : 'center'
                return (
                  <button
                    key={t.id}
                    type="button"
                    style={styles.card}
                    onClick={() => onApply(t.id)}
                    data-testid={`text-template-card-${t.id}`}
                  >
                    <div style={styles.cardLabel}>{t.label}</div>
                    <div
                      style={{ ...styles.previewBox, justifyContent: align }}
                    >
                      <span style={previewChipStyle(t)}>
                        <span style={previewTextStyle(t)}>{text}</span>
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          )
        })}
        <div style={styles.hint}>
          템플릿을 누르면 플레이헤드 위치에 자막으로 추가돼요. 추가 후 바로
          내용을 편집할 수 있어요.
        </div>
      </div>
    </div>
  )
}
