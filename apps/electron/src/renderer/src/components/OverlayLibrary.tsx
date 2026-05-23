import { useState } from 'react'
import { BUNDLED_STICKERS } from '../../../shared/project'
import {
  EMOJI_LIBRARY,
  GRAPHIC_STICKERS,
  STICKER_CATEGORY_LABELS,
  type EmojiItem,
  type StickerCategory
} from '../../../shared/bundledStickers'
import { useProjectStore } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import {
  makeImageOverlay,
  makeShapeOverlay,
  makeStickerOverlay
} from '../lib/overlays'
import {
  addEmojiOrStickerOverlay,
  getOrRasterize,
  rasterizeEmoji,
  rasterizeSvg
} from '../lib/stickerRaster'

// ---------------------------------------------------------------------------
// OverlayLibrary (Phase 3.8) — left-panel tab for placing overlay elements
// (vector shapes + user image stickers) onto the overlay track at the
// playhead. Bundled stickers are driven by BUNDLED_STICKERS (empty for now).
// ---------------------------------------------------------------------------

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: '#141414',
    minWidth: 280,
    overflowY: 'auto'
  } as React.CSSProperties,
  section: {
    padding: '12px 16px',
    borderBottom: '1px solid #2a2a2a'
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: '#cbd5e1',
    marginBottom: 8,
    letterSpacing: 0.2
  } as React.CSSProperties,
  shapeRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap'
  } as React.CSSProperties,
  shapeBtn: {
    flex: '1 1 80px',
    minWidth: 80,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '12px 8px',
    color: '#f5f5f5',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  shapeGlyph: {
    width: 36,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  } as React.CSSProperties,
  imageBtn: {
    width: '100%',
    background: '#10b981',
    color: '#04231a',
    border: 'none',
    borderRadius: 6,
    padding: '8px 12px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer'
  } as React.CSSProperties,
  hint: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 8
  } as React.CSSProperties,
  errorRow: {
    marginTop: 8,
    padding: '6px 10px',
    background: '#2a0d0d',
    border: '1px solid #4a1f1f',
    borderRadius: 6,
    color: '#fca5a5',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  stickerGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 8
  } as React.CSSProperties,
  stickerBtn: {
    aspectRatio: '1 / 1',
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  } as React.CSSProperties,
  emojiGlyph: {
    fontSize: 26,
    lineHeight: 1
  } as React.CSSProperties,
  stickerImg: {
    width: '100%',
    height: '100%',
    objectFit: 'contain'
  } as React.CSSProperties,
  catHeader: {
    fontSize: 10,
    fontWeight: 700,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    margin: '10px 0 6px'
  } as React.CSSProperties,
  empty: {
    color: '#64748b',
    fontSize: 11,
    padding: '4px 0'
  } as React.CSSProperties
}

/** Emoji categories in display order (graphic stickers get their own section). */
const EMOJI_CATEGORIES: StickerCategory[] = [
  'faces',
  'reactions',
  'gestures',
  'objects'
]

/** SVG markup → an inline data-URL for `<img>` preview. */
function svgDataUrl(svg: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

/** Read the image's intrinsic size from a `media://` URL. */
function readImageSize(
  url: string
): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = (): void =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = (): void => resolve({ width: 0, height: 0 })
    img.src = url
  })
}

export function OverlayLibrary(): JSX.Element {
  const addOverlay = useProjectStore((s) => s.addOverlay)
  const [error, setError] = useState<string | null>(null)

  // Place new overlays at the current playhead.
  const playheadAt = (): number => useTimelineUi.getState().playheadMs

  const addShape = (shape: 'rectangle' | 'ellipse' | 'line'): void => {
    addOverlay(makeShapeOverlay(shape, playheadAt()))
  }

  const onAddImage = async (): Promise<void> => {
    setError(null)
    if (!window.electron?.fs?.pickFiles) {
      setError('파일 선택을 사용할 수 없습니다')
      return
    }
    const picked = await window.electron.fs.pickFiles({
      filters: [
        { name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
      ]
    })
    if (!picked || picked.length === 0) return
    for (const path of picked) {
      try {
        // Whitelist the path so the media:// protocol + export can read it.
        await window.electron.fs.allowPath(path)
        const { toMediaUrl } = await import('../lib/mediaUrl')
        const { width, height } = await readImageSize(toMediaUrl(path))
        addOverlay(
          makeImageOverlay({
            path,
            naturalWidth: width,
            naturalHeight: height,
            startMs: playheadAt()
          })
        )
      } catch (err) {
        setError(
          `이미지 추가 실패: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  // Rasterize an emoji char → persist → add as a normal IMAGE overlay.
  const onAddEmoji = async (item: EmojiItem): Promise<void> => {
    setError(null)
    try {
      const bytes = await getOrRasterize(item.id, () =>
        rasterizeEmoji(item.char)
      )
      await addEmojiOrStickerOverlay({
        assetId: item.id,
        bytes,
        startMs: playheadAt()
      })
    } catch (err) {
      setError(
        `스티커 추가 실패: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // Rasterize an SVG sticker → persist → add as a normal IMAGE overlay.
  const onAddGraphicSticker = async (
    id: string,
    svg: string
  ): Promise<void> => {
    setError(null)
    try {
      const bytes = await getOrRasterize(id, () => rasterizeSvg(svg))
      await addEmojiOrStickerOverlay({
        assetId: id,
        bytes,
        startMs: playheadAt()
      })
    } catch (err) {
      setError(
        `스티커 추가 실패: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return (
    <div style={styles.wrap} data-testid="overlay-library">
      {/* ── 도형 ── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>도형</div>
        <div style={styles.shapeRow}>
          <button
            type="button"
            style={styles.shapeBtn}
            data-testid="overlay-add-rectangle"
            onClick={() => addShape('rectangle')}
          >
            <span style={styles.shapeGlyph} aria-hidden>
              <svg width="32" height="32" viewBox="0 0 32 32">
                <rect
                  x="3"
                  y="6"
                  width="26"
                  height="20"
                  rx="3"
                  fill="#cbd5e1"
                />
              </svg>
            </span>
            사각형
          </button>
          <button
            type="button"
            style={styles.shapeBtn}
            data-testid="overlay-add-ellipse"
            onClick={() => addShape('ellipse')}
          >
            <span style={styles.shapeGlyph} aria-hidden>
              <svg width="32" height="32" viewBox="0 0 32 32">
                <ellipse cx="16" cy="16" rx="13" ry="11" fill="#cbd5e1" />
              </svg>
            </span>
            원
          </button>
          <button
            type="button"
            style={styles.shapeBtn}
            data-testid="overlay-add-line"
            onClick={() => addShape('line')}
          >
            <span style={styles.shapeGlyph} aria-hidden>
              <svg width="32" height="32" viewBox="0 0 32 32">
                <line
                  x1="4"
                  y1="16"
                  x2="28"
                  y2="16"
                  stroke="#cbd5e1"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            선
          </button>
        </div>
      </div>

      {/* ── 이미지 ── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>이미지</div>
        <button
          type="button"
          style={styles.imageBtn}
          data-testid="overlay-add-image"
          onClick={() => {
            void onAddImage()
          }}
        >
          이미지 추가
        </button>
        <div style={styles.hint}>
          PNG · JPG · WEBP — 재생 헤드 위치에 추가됩니다
        </div>
        {error && (
          <div
            style={styles.errorRow}
            role="button"
            onClick={() => setError(null)}
          >
            {error}
          </div>
        )}
      </div>

      {/* ── 기본 스티커 ── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>기본 스티커</div>
        {BUNDLED_STICKERS.length === 0 ? (
          <div style={styles.empty}>등록된 기본 스티커가 없습니다</div>
        ) : (
          <div style={styles.stickerGrid} data-testid="overlay-sticker-grid">
            {BUNDLED_STICKERS.map((s) => (
              <button
                key={s.id}
                type="button"
                title={s.label}
                style={styles.stickerBtn}
                data-testid={`overlay-add-sticker-${s.id}`}
                onClick={() =>
                  addOverlay(makeStickerOverlay(s.id, playheadAt()))
                }
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── 이모지 ── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>이모지</div>
        {EMOJI_CATEGORIES.map((cat) => {
          const items = EMOJI_LIBRARY.filter((e) => e.category === cat)
          if (items.length === 0) return null
          return (
            <div key={cat}>
              <div style={styles.catHeader}>
                {STICKER_CATEGORY_LABELS[cat]}
              </div>
              <div style={styles.stickerGrid}>
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    title={item.label}
                    style={styles.stickerBtn}
                    data-testid={`overlay-add-emoji-${item.id}`}
                    onClick={() => {
                      void onAddEmoji(item)
                    }}
                  >
                    <span style={styles.emojiGlyph} aria-hidden>
                      {item.char}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── 그래픽 스티커 ── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>
          {STICKER_CATEGORY_LABELS.graphic}
        </div>
        <div style={styles.stickerGrid}>
          {GRAPHIC_STICKERS.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              style={styles.stickerBtn}
              data-testid={`overlay-add-sticker-${item.id}`}
              onClick={() => {
                void onAddGraphicSticker(item.id, item.svg)
              }}
            >
              <img
                src={svgDataUrl(item.svg)}
                alt={item.label}
                style={styles.stickerImg}
                draggable={false}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
