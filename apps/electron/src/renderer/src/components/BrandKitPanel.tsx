// BrandKitPanel — the '🎨 브랜드 키트' import tab.
//
// Save a logo (light/dark), brand colors, and a brand font ONCE; reuse them
// across projects. Rendered by ImportPanel for the 'brand' tab. Styling
// follows ImportPanel's existing dark token palette.
//
// Three sections:
//   로고      — light/dark slots: preview + upload/change + delete +
//               one-click "로고 추가" (inserts the logo on the timeline).
//   브랜드 컬러 — a swatch grid with a hover ✕ to remove + a trailing add cell.
//   브랜드 폰트 — a free-text font-family name input.
import { useEffect, useState } from 'react'
import { useBrandKit, MAX_BRAND_COLORS, normalizeHex } from '../store/brandKit'
import { toMediaUrl } from '../lib/mediaUrl'
import { makeImageOverlay } from '../lib/overlays'
import { useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import type { BrandLogoVariant } from '../../../shared/ipc'

interface BrandKitPanelProps {
  /** 토스트/안내 메시지 보고 (부모의 배너로 흘려보냄). */
  onNotice: (message: string, kind: 'info' | 'error') => void
}

// ---------------------------------------------------------------------------
// Styles — ImportPanel.tsx 톤과 일치.
// ---------------------------------------------------------------------------
const styles = {
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 16
  } as React.CSSProperties,
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: '#cbd5e1',
    letterSpacing: 0.2
  } as React.CSSProperties,
  hint: {
    fontSize: 10,
    color: '#64748b',
    lineHeight: 1.5
  } as React.CSSProperties,
  logoSlots: {
    display: 'flex',
    gap: 8
  } as React.CSSProperties,
  logoSlot: {
    flex: 1,
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  } as React.CSSProperties,
  logoSlotLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#9aa0a6'
  } as React.CSSProperties,
  logoPreview: {
    width: '100%',
    height: 84,
    objectFit: 'contain',
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 6
  } as React.CSSProperties,
  logoPlaceholder: {
    width: '100%',
    height: 84,
    background: '#0d0d0d',
    border: '1px dashed #334155',
    borderRadius: 6,
    color: '#475569',
    fontSize: 11,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  } as React.CSSProperties,
  logoBtnRow: {
    display: 'flex',
    gap: 4
  } as React.CSSProperties,
  smallBtn: {
    flex: 1,
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '5px 6px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  dangerBtn: {
    flex: 1,
    background: '#1f0d0d',
    color: '#fca5a5',
    border: '1px solid #4a1f1f',
    borderRadius: 6,
    padding: '5px 6px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  addLogoBtn: {
    background: '#10b981',
    color: '#04231a',
    border: 'none',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer'
  } as React.CSSProperties,
  colorGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(40px, 1fr))',
    gap: 6
  } as React.CSSProperties,
  swatchCell: {
    position: 'relative',
    aspectRatio: '1 / 1',
    borderRadius: 6,
    border: '1px solid #2a2a2a',
    cursor: 'pointer'
  } as React.CSSProperties,
  swatchRemove: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    border: 'none',
    background: 'rgba(13,13,13,0.85)',
    color: '#fca5a5',
    fontSize: 11,
    lineHeight: 1,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  } as React.CSSProperties,
  addCell: {
    aspectRatio: '1 / 1',
    borderRadius: 6,
    border: '1px dashed #334155',
    background: '#0d0d0d',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    padding: 2
  } as React.CSSProperties,
  colorInput: {
    width: 24,
    height: 20,
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer'
  } as React.CSSProperties,
  hexInput: {
    width: '100%',
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '4px 6px',
    fontSize: 11,
    boxSizing: 'border-box'
  } as React.CSSProperties,
  fontInput: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    width: '100%',
    boxSizing: 'border-box'
  } as React.CSSProperties,
  hexRow: {
    display: 'flex',
    gap: 4,
    alignItems: 'center',
    width: '100%'
  } as React.CSSProperties,
  state: {
    color: '#9aa0a6',
    fontSize: 12,
    padding: 16,
    textAlign: 'center'
  } as React.CSSProperties
}

// ---------------------------------------------------------------------------
// Logo slot.
// ---------------------------------------------------------------------------
function LogoSlot({
  variant,
  onNotice
}: {
  variant: BrandLogoVariant
  onNotice: BrandKitPanelProps['onNotice']
}): JSX.Element {
  const logo = useBrandKit((s) =>
    s.kit.logos.find((l) => l.variant === variant)
  )
  const importLogo = useBrandKit((s) => s.importLogo)
  const removeLogo = useBrandKit((s) => s.removeLogo)
  const label = variant === 'light' ? '라이트' : '다크'

  const onAddToTimeline = async (): Promise<void> => {
    if (!logo) return
    try {
      // Defensive allowlist — the path is app-managed, but allowing it again
      // is harmless and keeps the media:// protocol + export happy.
      await window.electron.fs.allowPath(logo.path)
      const clip = makeImageOverlay({
        path: logo.path,
        naturalWidth: logo.naturalWidth,
        naturalHeight: logo.naturalHeight,
        startMs: useTimelineUi.getState().playheadMs
      })
      useProjectStore.getState().addOverlay(clip)
      onNotice(`${label} 로고를 타임라인에 추가했습니다`, 'info')
    } catch (e) {
      onNotice(
        `로고 추가 실패: ${e instanceof Error ? e.message : String(e)}`,
        'error'
      )
    }
  }

  return (
    <div style={styles.logoSlot} data-testid={`brand-logo-slot-${variant}`}>
      <div style={styles.logoSlotLabel}>{label} 로고</div>
      {logo ? (
        <img
          src={toMediaUrl(logo.path)}
          alt={`${label} 로고`}
          style={styles.logoPreview}
        />
      ) : (
        <div style={styles.logoPlaceholder}>로고 없음</div>
      )}
      <div style={styles.logoBtnRow}>
        <button
          type="button"
          style={styles.smallBtn}
          data-testid={`brand-logo-upload-${variant}`}
          onClick={() => void importLogo(variant)}
        >
          {logo ? '변경' : '업로드'}
        </button>
        {logo && (
          <button
            type="button"
            style={styles.dangerBtn}
            data-testid={`brand-logo-remove-${variant}`}
            onClick={() => void removeLogo(variant)}
          >
            삭제
          </button>
        )}
      </div>
      <button
        type="button"
        style={{
          ...styles.addLogoBtn,
          opacity: logo ? 1 : 0.4,
          cursor: logo ? 'pointer' : 'not-allowed'
        }}
        data-testid={`brand-logo-add-${variant}`}
        disabled={!logo}
        onClick={() => void onAddToTimeline()}
      >
        로고 추가
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Brand colors.
// ---------------------------------------------------------------------------
function ColorSection(): JSX.Element {
  const colors = useBrandKit((s) => s.kit.colors)
  const addColor = useBrandKit((s) => s.addColor)
  const removeColor = useBrandKit((s) => s.removeColor)
  const [hoverHex, setHoverHex] = useState<string | null>(null)
  const [pickerHex, setPickerHex] = useState('#10b981')
  const [hexText, setHexText] = useState('')

  const atCap = colors.length >= MAX_BRAND_COLORS

  const commitHex = (raw: string): void => {
    const norm = normalizeHex(raw)
    if (!norm) return
    addColor(norm)
    setHexText('')
  }

  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>브랜드 컬러</div>
      <div style={styles.colorGrid} data-testid="brand-color-grid">
        {colors.map((hex) => (
          <div
            key={hex}
            style={{ ...styles.swatchCell, background: hex }}
            data-testid={`brand-color-swatch-${hex}`}
            title={hex}
            onMouseEnter={() => setHoverHex(hex)}
            onMouseLeave={() => setHoverHex(null)}
          >
            {hoverHex === hex && (
              <button
                type="button"
                style={styles.swatchRemove}
                aria-label={`${hex} 삭제`}
                onClick={() => removeColor(hex)}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {!atCap && (
          <div style={styles.addCell} data-testid="brand-color-add">
            <input
              type="color"
              value={pickerHex}
              style={styles.colorInput}
              aria-label="색상 선택"
              onChange={(e) => setPickerHex(e.target.value)}
            />
            <div style={styles.hexRow}>
              <input
                type="text"
                value={hexText}
                placeholder="#hex"
                style={styles.hexInput}
                aria-label="hex 색상 코드"
                onChange={(e) => setHexText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitHex(hexText || pickerHex)
                  }
                }}
                onBlur={() => {
                  if (hexText.trim()) commitHex(hexText)
                }}
              />
            </div>
            <button
              type="button"
              style={{ ...styles.smallBtn, flex: 'none', width: '100%' }}
              onClick={() => commitHex(hexText || pickerHex)}
            >
              추가
            </button>
          </div>
        )}
      </div>
      {atCap && (
        <div style={styles.hint}>
          브랜드 컬러는 최대 {MAX_BRAND_COLORS}개까지 저장할 수 있어요.
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Brand font.
// ---------------------------------------------------------------------------
function FontSection(): JSX.Element {
  const fontFamily = useBrandKit((s) => s.kit.fontFamily)
  const setFontFamily = useBrandKit((s) => s.setFontFamily)
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>브랜드 폰트</div>
      <input
        type="text"
        value={fontFamily ?? ''}
        placeholder="예: Pretendard"
        style={styles.fontInput}
        data-testid="brand-font-input"
        onChange={(e) => setFontFamily(e.target.value)}
      />
      <div style={styles.hint}>캡션·자막에 적용할 글꼴 이름</div>
    </div>
  )
}

// ===========================================================================
// Panel.
// ===========================================================================
export function BrandKitPanel({ onNotice }: BrandKitPanelProps): JSX.Element {
  const loaded = useBrandKit((s) => s.loaded)
  const error = useBrandKit((s) => s.error)
  const load = useBrandKit((s) => s.load)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  if (!loaded) {
    return <div style={styles.state}>브랜드 키트 불러오는 중…</div>
  }

  return (
    <div style={styles.body} data-testid="brand-kit-panel">
      {error && <div style={styles.hint}>⚠ {error}</div>}

      {/* ── 로고 ── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>로고</div>
        <div style={styles.logoSlots}>
          <LogoSlot variant="light" onNotice={onNotice} />
          <LogoSlot variant="dark" onNotice={onNotice} />
        </div>
        <div style={styles.hint}>
          [로고 추가]를 누르면 재생 헤드 위치에 로고가 오버레이로 들어갑니다.
        </div>
      </div>

      {/* ── 브랜드 컬러 ── */}
      <ColorSection />

      {/* ── 브랜드 폰트 ── */}
      <FontSection />
    </div>
  )
}
