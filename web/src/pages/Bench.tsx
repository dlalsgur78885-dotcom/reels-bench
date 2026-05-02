import { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, thumbUrl } from '../api'
import type { BenchItem, BenchFilters } from '../api'
import { fmtNum, engagementRate } from '../utils'
import Thumb from '../components/Thumb'

const PAGE_SIZE = 50

function FilterChips({ title, options, selected, onToggle }:
  { title: string; options: string[]; selected: Set<string>; onToggle: (v: string) => void }) {
  return (
    <div className="filter-chip-group">
      <div className="filter-field-label">{title}</div>
      <div className="filter-chip-row">
        {options.map(o => {
          const on = selected.has(o)
          return (
            <button
              key={o}
              type="button"
              className={`filter-chip${on ? ' active' : ''}`}
              aria-pressed={on}
              onClick={() => onToggle(o)}
            >{o}</button>
          )
        })}
      </div>
    </div>
  )
}

function Pagination({ currentPage, totalPages, total, onChange }:
  { currentPage: number; totalPages: number; total: number; onChange: (p: number) => void }) {
  const pages: (number | 'gap')[] = []
  const push = (p: number) => { if (!pages.includes(p)) pages.push(p) }
  push(1)
  if (currentPage - 2 > 2) pages.push('gap')
  for (let p = Math.max(2, currentPage - 1); p <= Math.min(totalPages - 1, currentPage + 1); p++) push(p)
  if (currentPage + 2 < totalPages - 1) pages.push('gap')
  if (totalPages > 1) push(totalPages)

  return (
    <nav className="pagination" aria-label="페이지 이동">
      <button
        type="button"
        className="pagination-btn"
        aria-label="이전 페이지"
        onClick={() => onChange(currentPage - 1)}
        disabled={currentPage <= 1}
      >‹</button>
      {pages.map((p, i) => p === 'gap'
        ? <span key={`g${i}`} className="pagination-gap" aria-hidden="true">…</span>
        : (
          <button
            key={p}
            type="button"
            className={`pagination-btn${p === currentPage ? ' active' : ''}`}
            aria-label={`${p}페이지`}
            aria-current={p === currentPage ? 'page' : undefined}
            onClick={() => onChange(p)}
          >{p}</button>
        ))}
      <button
        type="button"
        className="pagination-btn"
        aria-label="다음 페이지"
        onClick={() => onChange(currentPage + 1)}
        disabled={currentPage >= totalPages}
      >›</button>
      <span className="pagination-meta">
        {fmtNum(total)}개 · {currentPage}/{totalPages}쪽
      </span>
    </nav>
  )
}

export default function Bench() {
  const [items, setItems] = useState<BenchItem[]>([])
  const [stats, setStats] = useState<{ total_reels: number; total_plays: number; total_likes: number; analyzed_count: number } | null>(null)
  const [total, setTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'plays' | 'likes' | 'er' | 'recent'>('plays')
  const [loading, setLoading] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const [playsMin, setPlaysMin] = useState('')
  const [playsMax, setPlaysMax] = useState('')
  const [erMin, setErMin] = useState('')
  const [erMax, setErMax] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [adSuit, setAdSuit] = useState<Set<string>>(new Set())
  const [uspCount, setUspCount] = useState<Set<string>>(new Set())
  const [bodyStruct, setBodyStruct] = useState<Set<string>>(new Set())
  const [hookT, setHookT] = useState<Set<string>>(new Set())
  const [ctaT, setCtaT] = useState<Set<string>>(new Set())
  const toggle = (s: Set<string>, v: string, setter: (n: Set<string>) => void) => {
    const next = new Set(s)
    if (next.has(v)) next.delete(v); else next.add(v)
    setter(next)
  }

  const navigate = useNavigate()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const buildParams = useCallback((): BenchFilters => ({
    sort,
    q: search || undefined,
    plays_min: playsMin ? Number(playsMin) : undefined,
    plays_max: playsMax ? Number(playsMax) : undefined,
    er_min: erMin ? Number(erMin) : undefined,
    er_max: erMax ? Number(erMax) : undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    ad_suitability: adSuit.size ? Array.from(adSuit).join(',') : undefined,
    usp_count: uspCount.size ? Array.from(uspCount).join(',') : undefined,
    body_structure: bodyStruct.size ? Array.from(bodyStruct).join(',') : undefined,
    hook_type: hookT.size ? Array.from(hookT).join(',') : undefined,
    cta_type: ctaT.size ? Array.from(ctaT).join(',') : undefined,
  }), [sort, search, playsMin, playsMax, erMin, erMax, dateFrom, dateTo, adSuit, uspCount, bodyStruct, hookT, ctaT])

  const load = useCallback(async (page: number) => {
    setLoading(true)
    try {
      const res = await api.bench({ ...buildParams(), page, limit: PAGE_SIZE })
      setItems(res.items)
      setStats(res.stats)
      setTotal(res.total)
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [buildParams])

  useEffect(() => {
    setCurrentPage(1)
    load(1)
  }, [load])

  const goPage = (p: number) => {
    if (p < 1 || p > totalPages || p === currentPage) return
    setCurrentPage(p)
    load(p)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const onSearch = (v: string) => {
    setSearch(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { setCurrentPage(1); load(1) }, 300)
  }

  const activeFilterCount = [playsMin, playsMax, erMin, erMax, dateFrom, dateTo].filter(Boolean).length
    + adSuit.size + uspCount.size + bodyStruct.size + hookT.size + ctaT.size

  const clearFilters = () => {
    setPlaysMin(''); setPlaysMax(''); setErMin(''); setErMax(''); setDateFrom(''); setDateTo('')
    setAdSuit(new Set()); setUspCount(new Set()); setBodyStruct(new Set()); setHookT(new Set()); setCtaT(new Set())
  }

  // 활성 필터를 인라인 칩으로 표시
  const removeFromSet = (s: Set<string>, v: string, setter: (n: Set<string>) => void) => {
    const n = new Set(s); n.delete(v); setter(n)
  }
  type ActiveFilter = { id: string; key?: string; label: string; remove: () => void }
  const activeFilters: ActiveFilter[] = []
  if (playsMin) activeFilters.push({ id: 'pmin', key: '조회수', label: `${fmtNum(Number(playsMin))}+`, remove: () => setPlaysMin('') })
  if (playsMax) activeFilters.push({ id: 'pmax', key: '조회수', label: `~${fmtNum(Number(playsMax))}`, remove: () => setPlaysMax('') })
  if (erMin) activeFilters.push({ id: 'emin', key: 'ER', label: `${erMin}%+`, remove: () => setErMin('') })
  if (erMax) activeFilters.push({ id: 'emax', key: 'ER', label: `~${erMax}%`, remove: () => setErMax('') })
  if (dateFrom) activeFilters.push({ id: 'df', key: '시작', label: dateFrom, remove: () => setDateFrom('') })
  if (dateTo) activeFilters.push({ id: 'dt', key: '종료', label: dateTo, remove: () => setDateTo('') })
  adSuit.forEach(v => activeFilters.push({ id: `ad-${v}`, key: '광고', label: v, remove: () => removeFromSet(adSuit, v, setAdSuit) }))
  uspCount.forEach(v => activeFilters.push({ id: `usp-${v}`, key: 'USP', label: v, remove: () => removeFromSet(uspCount, v, setUspCount) }))
  bodyStruct.forEach(v => activeFilters.push({ id: `bs-${v}`, key: 'Body', label: v, remove: () => removeFromSet(bodyStruct, v, setBodyStruct) }))
  hookT.forEach(v => activeFilters.push({ id: `h-${v}`, key: 'Hook', label: v, remove: () => removeFromSet(hookT, v, setHookT) }))
  ctaT.forEach(v => activeFilters.push({ id: `c-${v}`, key: 'CTA', label: v, remove: () => removeFromSet(ctaT, v, setCtaT) }))

  const subtitleParts: string[] = []
  if (stats) {
    subtitleParts.push(`${fmtNum(stats.total_reels)}개`)
    subtitleParts.push(`분석 ${fmtNum(stats.analyzed_count)}`)
    if (total !== stats.total_reels) subtitleParts.push(`필터 ${fmtNum(total)}`)
  }

  return (
    <>
      <div className="page-header">
        <h1>벤치마크</h1>
        <p>{stats ? subtitleParts.join(' · ') : '불러오는 중…'}</p>
      </div>

      <div className={`bench-toolbar${showFilters ? ' with-filters' : ''}`}>
        <input
          className="search-input bench-search"
          placeholder="작성자·코드 검색"
          value={search}
          onChange={e => onSearch(e.target.value)}
          aria-label="작성자 또는 코드로 검색"
        />
        <div className="bench-toolbar-spacer" />
        <div className="segment-group" role="tablist" aria-label="정렬 기준">
          {([['plays', '조회수'], ['likes', '좋아요'], ['er', 'ER'], ['recent', '최신순']] as const).map(([k, l]) => (
            <button
              key={k}
              type="button"
              className={`btn-segment${sort === k ? ' active' : ''}`}
              role="tab"
              aria-selected={sort === k}
              onClick={() => setSort(k)}
            >{l}</button>
          ))}
        </div>
        <button
          type="button"
          className={`btn-filter-toggle${activeFilterCount > 0 ? ' has-filters' : ''}`}
          aria-expanded={showFilters}
          aria-controls="filter-panel"
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
        <div id="filter-panel" className="filter-panel">
          <div>
            <label className="filter-field-label" htmlFor="bench-plays-min">최소 조회수</label>
            <input id="bench-plays-min" className="filter-input" type="number" inputMode="numeric"
              placeholder="예: 10000" value={playsMin}
              onChange={e => setPlaysMin(e.target.value)} />
          </div>
          <div>
            <label className="filter-field-label" htmlFor="bench-plays-max">최대 조회수</label>
            <input id="bench-plays-max" className="filter-input" type="number" inputMode="numeric"
              placeholder="예: 1000000" value={playsMax}
              onChange={e => setPlaysMax(e.target.value)} />
          </div>
          <div>
            <label className="filter-field-label" htmlFor="bench-er-min">최소 ER (%)</label>
            <input id="bench-er-min" className="filter-input" type="number" inputMode="decimal" step="0.1"
              placeholder="예: 1.0" value={erMin}
              onChange={e => setErMin(e.target.value)} />
          </div>
          <div>
            <label className="filter-field-label" htmlFor="bench-er-max">최대 ER (%)</label>
            <input id="bench-er-max" className="filter-input" type="number" inputMode="decimal" step="0.1"
              placeholder="예: 10.0" value={erMax}
              onChange={e => setErMax(e.target.value)} />
          </div>
          <div>
            <label className="filter-field-label" htmlFor="bench-date-from">시작일</label>
            <input id="bench-date-from" className="filter-input" type="date" value={dateFrom}
              onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="filter-field-label" htmlFor="bench-date-to">종료일</label>
            <input id="bench-date-to" className="filter-input" type="date" value={dateTo}
              onChange={e => setDateTo(e.target.value)} />
          </div>
          {activeFilterCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button type="button" className="btn-reset" onClick={clearFilters}>초기화</button>
            </div>
          )}
          <div className="filter-panel-section">
            <FilterChips title="광고 적합성" options={['광고형','정보형','후기형','브랜딩형','유머형','일상형']}
              selected={adSuit} onToggle={v => toggle(adSuit, v, setAdSuit)} />
            <FilterChips title="USP 개수" options={['1','2','3','4','5']}
              selected={uspCount} onToggle={v => toggle(uspCount, v, setUspCount)} />
            <FilterChips title="Body 구조" options={['단일진행','멀티USP1:1','단일USP다각도','비교형']}
              selected={bodyStruct} onToggle={v => toggle(bodyStruct, v, setBodyStruct)} />
            <FilterChips title="Hook 유형" options={['시나리오형','질문형','충격형','통계형','명령형','공감형']}
              selected={hookT} onToggle={v => toggle(hookT, v, setHookT)} />
            <FilterChips title="CTA 유형" options={['댓글유도','행동촉구','저장유도','링크유도','정보제공','없음']}
              selected={ctaT} onToggle={v => toggle(ctaT, v, setCtaT)} />
          </div>
        </div>
      )}

      {activeFilters.length > 0 && (
        <div className="active-filter-strip" role="region" aria-label="적용된 필터">
          <span className="active-filter-strip-label">적용</span>
          {activeFilters.map(f => (
            <button
              key={f.id}
              type="button"
              className="active-filter-chip"
              onClick={f.remove}
              aria-label={`${f.key ? f.key + ' ' : ''}${f.label} 해제`}
            >
              {f.key && <span className="active-filter-chip-key">{f.key}</span>}
              {f.label}
              <span className="active-filter-chip-x" aria-hidden="true">×</span>
            </button>
          ))}
          <button type="button" className="active-filter-clear" onClick={clearFilters}>
            모두 지우기
          </button>
        </div>
      )}

      <div className="reel-grid">
        {items.map(r => {
          const er = engagementRate(r.like_count, r.play_count)
          return (
            <button
              key={r.shortcode}
              type="button"
              className="reel-card"
              onClick={() => navigate(`/bench/${r.shortcode}`)}
              aria-label={`@${r.author || '알 수 없음'} 릴스 분석 보기`}
            >
              <div style={{ position: 'relative' }}>
                <Thumb
                  src={r.shortcode ? thumbUrl(r.shortcode) : undefined}
                  shortcode={r.shortcode}
                  style={{ width: '100%', aspectRatio: '4/5', objectFit: 'cover', display: 'block', background: 'var(--bg-elevated)' }}
                />
                {r.ad_suitability && (
                  <span className="reel-overlay-tl">{r.ad_suitability}</span>
                )}
                {r.analyzed && (
                  <span className="reel-overlay-tr">분석완료</span>
                )}
              </div>
              <div className="card-info">
                <div className="card-author">@{r.author || '?'}</div>
                <div className="card-stats">
                  <span className="stat-pill">{fmtNum(r.play_count)}</span>
                  <span className="stat-pill">&#9829; {fmtNum(r.like_count)}</span>
                  {er > 0 && <span className="stat-pill">{er}%</span>}
                </div>
                {(r.usp_count || r.body_structure || r.hook_type) && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                    {r.usp_count && <span className="tag-pill tag-pill--small">USP {r.usp_count}</span>}
                    {r.body_structure && <span className="tag-pill tag-pill--small">{r.body_structure}</span>}
                    {r.hook_type && <span className="tag-pill tag-pill--small">{r.hook_type}</span>}
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {loading && (
        <div className="empty-state" role="status" aria-live="polite">불러오는 중…</div>
      )}
      {!loading && items.length === 0 && (
        <div className="empty-state">필터 조건에 맞는 릴스가 없습니다</div>
      )}

      {!loading && items.length > 0 && totalPages > 1 && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          total={total}
          onChange={goPage}
        />
      )}
    </>
  )
}
