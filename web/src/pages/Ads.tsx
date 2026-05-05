import { useEffect, useState, useCallback, useRef } from 'react'
import { api } from '../api'
import type { AdItem, AdsFilters } from '../api'
import { fmtNum } from '../utils'
import Pagination from '../components/Pagination'

const PAGE_SIZE = 30

export default function Ads() {
  const [items, setItems] = useState<AdItem[]>([])
  const [total, setTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [params, setParams] = useState<AdsFilters>({ sort: 'recent' })
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const load = useCallback(async (page: number, p: AdsFilters) => {
    setLoading(true)
    try {
      const res = await api.ads({ ...p, page, limit: PAGE_SIZE })
      setItems(res.items)
      setTotal(res.total)
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [])

  useEffect(() => {
    setCurrentPage(1)
    load(1, params)
  }, [params, load])

  const goPage = (p: number) => {
    if (p < 1 || p > totalPages || p === currentPage) return
    setCurrentPage(p)
    load(p, params)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const onSearch = (v: string) => {
    setSearch(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setParams(prev => ({ ...prev, q: v || undefined }))
    }, 300)
  }

  const applyDateRange = () => {
    setParams(prev => ({
      ...prev,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
    }))
  }

  const clearFilters = () => {
    setSearch(''); setDateFrom(''); setDateTo('')
    setParams({ sort: params.sort })
  }

  const activeFilterCount = (params.date_from ? 1 : 0) + (params.date_to ? 1 : 0)

  const fmtDate = (iso: string) => {
    if (!iso) return '-'
    return iso.slice(0, 10)
  }

  return (
    <>
      <div className="page-header">
        <h1>광고</h1>
        <p>{loading ? '불러오는 중…' : `${fmtNum(total)}개`}</p>
      </div>

      <div className={`bench-toolbar${showFilters ? ' with-filters' : ''}`}>
        <div className="bench-search-wrap">
          <svg className="bench-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3.5 3.5" />
          </svg>
          <input
            className="search-input bench-search"
            placeholder="광고주, 카피로 검색"
            value={search}
            onChange={e => onSearch(e.target.value)}
            aria-label="광고주/카피 검색"
          />
        </div>
        <div className="bench-toolbar-spacer" />
        <div className="segment-group" role="radiogroup" aria-label="정렬 기준">
          {([['recent', '최신순'], ['oldest', '오래된순']] as const).map(([k, l]) => (
            <button
              key={k}
              type="button"
              className={`btn-segment${params.sort === k ? ' active' : ''}`}
              role="radio"
              aria-checked={params.sort === k}
              onClick={() => setParams(prev => ({ ...prev, sort: k }))}
            >{l}</button>
          ))}
        </div>
        <button
          type="button"
          className={`btn-filter-toggle${activeFilterCount > 0 ? ' has-filters' : ''}`}
          aria-expanded={showFilters}
          onClick={() => setShowFilters(!showFilters)}
        >
          <svg className="filter-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 3h12M4 8h8M6 13h4" />
          </svg>
          필터
          {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
        </button>
      </div>

      {showFilters && (
        <div className="filter-panel">
          <section>
            <div className="filter-section-title">
              기간
              <span className="filter-section-title-helper">수집일 기준 (가동 시작일 컬럼 채워지면 그쪽 기준)</span>
            </div>
            <div className="filter-section-grid">
              <div>
                <label className="filter-field-label" htmlFor="ads-date-from">시작일</label>
                <input id="ads-date-from" className="filter-input" type="date"
                  value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                  onBlur={applyDateRange} />
              </div>
              <div>
                <label className="filter-field-label" htmlFor="ads-date-to">종료일</label>
                <input id="ads-date-to" className="filter-input" type="date"
                  value={dateTo} onChange={e => setDateTo(e.target.value)}
                  onBlur={applyDateRange} />
              </div>
            </div>
          </section>

          {activeFilterCount > 0 && (
            <div className="filter-actions">
              <button type="button" className="btn-reset" onClick={clearFilters}>초기화</button>
            </div>
          )}
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="empty-state">조건에 맞는 광고가 없습니다</div>
      )}

      {items.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 14,
        }}>
          {items.map(ad => (
            <article key={ad.shortcode} style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)', overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
            }}>
              {ad.thumbnail_url || ad.video_url ? (
                <div style={{ position: 'relative', aspectRatio: '4/5', background: 'var(--bg-elevated)' }}>
                  {ad.video_url ? (
                    <video src={ad.video_url} poster={ad.thumbnail_url || undefined}
                      controls preload="metadata" muted
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', background: '#000' }}
                    />
                  ) : (
                    <img src={ad.thumbnail_url} alt="" loading="lazy" decoding="async"
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  )}
                  <span style={{
                    position: 'absolute', top: 8, left: 8,
                    fontSize: 10, fontWeight: 700, padding: '2px 8px',
                    background: 'rgba(0,0,0,0.7)', color: '#fff', borderRadius: 999,
                    textTransform: 'uppercase', letterSpacing: '.04em',
                  }}>{ad.media_type}</span>
                </div>
              ) : (
                <div style={{ aspectRatio: '4/5', background: 'var(--bg-elevated)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>
                  미디어 없음
                </div>
              )}

              <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ad.page_name || '광고주 미상'}
                </div>
                <div style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                  <span>가동 {ad.start_date || '미상'}</span>
                  <span>·</span>
                  <span>수집 {fmtDate(ad.collected_at)}</span>
                  {ad.video_duration > 0 && <><span>·</span><span>{Math.round(ad.video_duration)}초</span></>}
                </div>
                {ad.caption && (
                  <p style={{
                    fontSize: 12, color: 'var(--text-secondary)',
                    margin: 0, lineHeight: 1.45,
                    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>{ad.caption}</p>
                )}
                {ad.platforms && ad.platforms.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {ad.platforms.map(pf => (
                      <span key={pf} className="tag-pill tag-pill--small">{pf}</span>
                    ))}
                  </div>
                )}
                {ad.url && (
                  <a href={ad.url} target="_blank" rel="noopener noreferrer"
                    className="external-link"
                    style={{ fontSize: 11, marginTop: 'auto' }}>
                    Ad Library ↗
                  </a>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {!loading && items.length > 0 && totalPages > 1 && (
        <div style={{ marginTop: 16 }}>
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            total={total}
            onChange={goPage}
          />
        </div>
      )}
    </>
  )
}
