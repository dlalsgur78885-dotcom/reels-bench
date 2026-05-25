/**
 * Phase 3.3 — "분석 결과 가져오기" modal.
 *
 * Opens from the editor top bar (button or Ctrl+I). Lists the user's
 * analyzed reels (with metadata enrichment), lets the user pick one, then
 * calls `prefillFromReel` to bootstrap the timeline.
 *
 * Implementation notes:
 *   - Two-stage load: first `listMyReels()` gives shortcodes + collected_at,
 *     then we lazily fetch metadata per visible card to surface thumbnails
 *     + caption + duration. The metadata fetch is fire-and-forget so the
 *     dialog never blocks on it.
 *   - Search filter is client-side over (caption_text + author_username).
 *   - "더 보기" reveals the next 24 cards (we keep paging cheap because
 *     listMyReels already caps at 100).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import { listMyReels, getReelMetadata, type ReelMetadata, type ReelSummary } from '../lib/api'
import { prefillFromReel, type PrefillResult } from '../lib/prefillFromReel'

const PAGE_SIZE = 24

interface PrefillDialogProps {
  open: boolean
  onClose: () => void
  onComplete: (result: PrefillResult) => void
}

interface EnrichedReel {
  summary: ReelSummary
  metadata: ReelMetadata | null
  metadataError: string | null
  metadataLoading: boolean
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function truncate(s: string | undefined, max = 80): string {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  } as React.CSSProperties,
  modal: {
    width: 'min(960px, 92vw)',
    maxHeight: '88vh',
    background: '#0f0f0f',
    border: '1px solid #2a2a2a',
    borderRadius: 12,
    color: '#f5f5f5',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  } as React.CSSProperties,
  header: {
    padding: '16px 20px',
    borderBottom: '1px solid #2a2a2a',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0
  } as React.CSSProperties,
  title: {
    fontSize: 16,
    fontWeight: 700,
    flex: 1
  } as React.CSSProperties,
  closeBtn: {
    background: 'transparent',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer'
  } as React.CSSProperties,
  search: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 13,
    width: 240
  } as React.CSSProperties,
  body: {
    overflow: 'auto',
    padding: 16,
    flex: 1
  } as React.CSSProperties,
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: 12
  } as React.CSSProperties,
  card: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    cursor: 'pointer',
    transition: 'border-color 120ms'
  } as React.CSSProperties,
  thumb: {
    width: '100%',
    aspectRatio: '9 / 16',
    background: '#0d0d0d',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#475569',
    fontSize: 11,
    objectFit: 'cover'
  } as React.CSSProperties,
  cardBody: {
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    flex: 1
  } as React.CSSProperties,
  cardAuthor: {
    fontSize: 12,
    fontWeight: 600,
    color: '#e2e8f0'
  } as React.CSSProperties,
  cardCaption: {
    fontSize: 11,
    color: '#94a3b8',
    minHeight: 30
  } as React.CSSProperties,
  cardMeta: {
    fontSize: 10,
    color: '#64748b',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  } as React.CSSProperties,
  pickBtn: {
    background: '#6366f1',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  empty: {
    padding: '48px 24px',
    textAlign: 'center',
    color: '#94a3b8'
  } as React.CSSProperties,
  loading: {
    padding: '48px 24px',
    textAlign: 'center',
    color: '#94a3b8'
  } as React.CSSProperties,
  error: {
    padding: '12px',
    background: '#2a0d0d',
    border: '1px solid #4a1f1f',
    color: '#fca5a5',
    borderRadius: 6,
    fontSize: 12,
    marginBottom: 12
  } as React.CSSProperties,
  loadMore: {
    margin: '16px auto 0',
    display: 'block',
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 12,
    cursor: 'pointer'
  } as React.CSSProperties,
  progressOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: 12,
    color: '#f5f5f5',
    fontSize: 14,
    zIndex: 10
  } as React.CSSProperties
}

export function PrefillDialog({
  open,
  onClose,
  onComplete
}: PrefillDialogProps): JSX.Element | null {
  const [reels, setReels] = useState<EnrichedReel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [progressStep, setProgressStep] = useState<string | null>(null)
  const enrichmentStarted = useRef<Set<string>>(new Set())

  // Reset state on open.
  useEffect(() => {
    if (!open) return
    setReels([])
    setError(null)
    setFilter('')
    setVisibleCount(PAGE_SIZE)
    setProgressStep(null)
    enrichmentStarted.current.clear()
    setLoading(true)

    let cancelled = false
    listMyReels()
      .then((rows) => {
        if (cancelled) return
        const enriched: EnrichedReel[] = rows.map((r) => ({
          summary: r,
          metadata: null,
          metadataError: null,
          metadataLoading: false
        }))
        setReels(enriched)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open])

  // Lazy metadata enrichment for the visible slice.
  useEffect(() => {
    if (!open || reels.length === 0) return
    const slice = reels.slice(0, visibleCount)
    for (const r of slice) {
      const sc = r.summary.shortcode
      if (enrichmentStarted.current.has(sc)) continue
      if (r.metadata || r.metadataError) continue
      enrichmentStarted.current.add(sc)
      // Fire metadata fetch — fire-and-forget; setState on completion.
      void getReelMetadata(sc)
        .then((md) => {
          setReels((prev) =>
            prev.map((p) =>
              p.summary.shortcode === sc
                ? { ...p, metadata: md, metadataLoading: false }
                : p
            )
          )
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          setReels((prev) =>
            prev.map((p) =>
              p.summary.shortcode === sc
                ? { ...p, metadataError: msg, metadataLoading: false }
                : p
            )
          )
        })
    }
  }, [open, reels, visibleCount])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return reels
    return reels.filter((r) => {
      const caption = (r.metadata?.caption_text || '').toLowerCase()
      const author = (r.metadata?.author_username || '').toLowerCase()
      const sc = r.summary.shortcode.toLowerCase()
      return (
        caption.includes(q) ||
        author.includes(q) ||
        sc.includes(q)
      )
    })
  }, [reels, filter])

  const visible = filtered.slice(0, visibleCount)
  const hasMore = filtered.length > visibleCount

  const handlePick = useCallback(
    async (shortcode: string) => {
      setProgressStep('시작 중...')
      try {
        const result = await prefillFromReel(shortcode, (step) => {
          setProgressStep(step)
        })
        onComplete(result)
      } catch (err) {
        // prefillFromReel should not throw, but guard for safety.
        onComplete({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      } finally {
        setProgressStep(null)
      }
    },
    [onComplete]
  )

  const focusTrapRef = useFocusTrap<HTMLDivElement>(open)

  if (!open) return null

  return (
    <div
      style={styles.backdrop}
      onClick={(e) => {
        // Click on backdrop (but not modal) closes — only when not busy.
        if (e.target === e.currentTarget && !progressStep) onClose()
      }}
      data-testid="prefill-dialog"
    >
      <div
        ref={focusTrapRef}
        style={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prefill-dialog-title"
      >
        <div style={styles.header}>
          <div id="prefill-dialog-title" style={styles.title}>분석 결과 가져오기</div>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="검색 (작성자 / 캡션 / 코드)"
            style={styles.search}
            data-testid="prefill-search"
            disabled={!!progressStep}
          />
          <button
            type="button"
            onClick={onClose}
            style={styles.closeBtn}
            data-testid="prefill-close"
            disabled={!!progressStep}
          >
            닫기
          </button>
        </div>

        <div style={styles.body} data-testid="prefill-body">
          {error && (
            <div style={styles.error} data-testid="prefill-error">
              불러오기 실패: {error}
            </div>
          )}

          {loading && (
            <div style={styles.loading} data-testid="prefill-loading">
              릴스 목록 불러오는 중...
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div style={styles.empty} data-testid="prefill-empty">
              {reels.length === 0
                ? '분석된 릴스가 없습니다. 웹 앱에서 먼저 분석해주세요.'
                : '검색 결과가 없습니다.'}
            </div>
          )}

          {!loading && filtered.length > 0 && (
            <>
              <div style={styles.grid} data-testid="prefill-grid">
                {visible.map((r) => {
                  const sc = r.summary.shortcode
                  const md = r.metadata
                  const thumbUrl = md?.thumbnail_url
                  const author = md?.author_username || '—'
                  const caption = truncate(md?.caption_text, 80)
                  return (
                    <div
                      key={sc}
                      style={styles.card}
                      data-testid={`prefill-card-${sc}`}
                      onClick={() => handlePick(sc)}
                    >
                      {thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumbUrl}
                          alt={`${sc} thumbnail`}
                          style={styles.thumb}
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                          }}
                        />
                      ) : (
                        <div style={styles.thumb}>{sc}</div>
                      )}
                      <div style={styles.cardBody}>
                        <div style={styles.cardAuthor}>@{author}</div>
                        <div style={styles.cardCaption}>{caption || ' '}</div>
                        <div style={styles.cardMeta}>
                          <span>{formatDuration(md?.video_duration)}</span>
                          <button
                            type="button"
                            style={styles.pickBtn}
                            onClick={(e) => {
                              e.stopPropagation()
                              handlePick(sc)
                            }}
                            data-testid={`prefill-pick-${sc}`}
                            disabled={!!progressStep}
                          >
                            선택
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              {hasMore && (
                <button
                  type="button"
                  style={styles.loadMore}
                  onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
                  data-testid="prefill-load-more"
                  disabled={!!progressStep}
                >
                  더 보기 ({filtered.length - visibleCount}개)
                </button>
              )}
            </>
          )}
        </div>
        {progressStep && (
          <div style={styles.progressOverlay} data-testid="prefill-progress">
            <div style={{ fontSize: 24 }}>⏳</div>
            <div>{progressStep}</div>
          </div>
        )}
      </div>
    </div>
  )
}
