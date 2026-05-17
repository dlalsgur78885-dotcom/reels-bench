import { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { api, thumbUrl } from '../api'
import type { AdItem, AdsFilters } from '../api'
import { fmtNum } from '../utils'
import Pagination from '../components/Pagination'
import Thumb from '../components/Thumb'

const PAGE_SIZE = 30

export default function Ads() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const initialQ = searchParams.get('q') || ''
  const [items, setItems] = useState<AdItem[]>([])
  const [total, setTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [params, setParams] = useState<AdsFilters>({ sort: 'recent', q: initialQ || undefined })
  const [search, setSearch] = useState(initialQ)
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

  // URL ?q= 변경 시 검색어 동기화 (광고주 → /ads?q=... 네비 후 다시 다른 광고주 클릭 등)
  useEffect(() => {
    const q = searchParams.get('q') || ''
    setSearch(q)
    setParams(prev => ({ ...prev, q: q || undefined }))
  }, [searchParams])

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
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12,
        }}>
          {items.map(ad => (
            <button
              key={ad.shortcode}
              type="button"
              className="reel-card"
              onClick={() => navigate(`/bench/${ad.shortcode}`)}
              aria-label={`${ad.page_name || '광고주 미상'} 광고 분석 보기`}
            >
              <div style={{ position: 'relative' }}>
                <Thumb
                  src={ad.shortcode ? thumbUrl(ad.shortcode) : undefined}
                  shortcode={ad.shortcode}
                  style={{ width: '100%', aspectRatio: '4/5', objectFit: 'cover', display: 'block', background: 'var(--bg-elevated)' }}
                />
                <span style={{
                  position: 'absolute', top: 6, left: 6, fontSize: 10, padding: '2px 6px',
                  background: '#3b82f6', color: '#fff', borderRadius: 3, fontWeight: 700,
                }}>FB</span>
                {ad.video_duration > 0 && (
                  <span style={{
                    position: 'absolute', bottom: 6, right: 6, fontSize: 10, padding: '2px 5px',
                    background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: 3,
                  }}>{Math.round(ad.video_duration)}s</span>
                )}
              </div>
              <div className="card-info">
                <div className="card-author">{ad.page_name || '광고주 미상'}</div>
                <div className="card-stats">
                  <span className="stat-pill">가동 {ad.start_date || '미상'}</span>
                  <span className="stat-pill">수집 {fmtDate(ad.collected_at)}</span>
                </div>
                {ad.caption && (
                  <div style={{
                    fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4, marginTop: 4,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>{ad.caption}</div>
                )}
                {ad.platforms && ad.platforms.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                    {ad.platforms.map(pf => (
                      <span key={pf} className="tag-pill tag-pill--small">{pf}</span>
                    ))}
                  </div>
                )}
              </div>
            </button>
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
