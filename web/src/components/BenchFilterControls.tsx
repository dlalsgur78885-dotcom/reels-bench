import { useEffect, useRef, useState } from 'react'
import { fmtNum } from '../utils'
import type { BenchFilters } from '../api'

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

interface Props {
  /** 부모에 변경된 BenchFilters 전달 (검색은 300ms 디바운스 적용된 값으로). */
  onChange: (params: BenchFilters) => void
}

export default function BenchFilterControls({ onChange }: Props) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [sort, setSort] = useState<'plays' | 'likes' | 'er' | 'recent'>('plays')
  const [showFilters, setShowFilters] = useState(false)
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

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // search debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search])

  // emit params upward whenever any filter changes
  useEffect(() => {
    onChange({
      sort,
      q: debouncedSearch || undefined,
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
    })
  }, [debouncedSearch, sort, playsMin, playsMax, erMin, erMax, dateFrom, dateTo,
      adSuit, uspCount, bodyStruct, hookT, ctaT, onChange])

  const toggle = (s: Set<string>, v: string, setter: (n: Set<string>) => void) => {
    const next = new Set(s)
    if (next.has(v)) next.delete(v); else next.add(v)
    setter(next)
  }

  const activeFilterCount = [playsMin, playsMax, erMin, erMax, dateFrom, dateTo].filter(Boolean).length
    + adSuit.size + uspCount.size + bodyStruct.size + hookT.size + ctaT.size

  const clearFilters = () => {
    setPlaysMin(''); setPlaysMax(''); setErMin(''); setErMax(''); setDateFrom(''); setDateTo('')
    setAdSuit(new Set()); setUspCount(new Set()); setBodyStruct(new Set()); setHookT(new Set()); setCtaT(new Set())
  }

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

  return (
    <>
      <div className={`bench-toolbar${showFilters ? ' with-filters' : ''}`}>
        <div className="bench-search-wrap">
          <svg className="bench-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3.5 3.5" />
          </svg>
          <input
            className="search-input bench-search"
            placeholder="작성자, shortcode, 키워드로 검색"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="작성자, shortcode, 키워드로 검색"
          />
        </div>
        <div className="bench-toolbar-spacer" />
        <div className="segment-group" role="radiogroup" aria-label="정렬 기준">
          {([['plays', '조회수'], ['likes', '좋아요'], ['er', 'ER'], ['recent', '최신순']] as const).map(([k, l]) => (
            <button
              key={k}
              type="button"
              className={`btn-segment${sort === k ? ' active' : ''}`}
              role="radio"
              aria-checked={sort === k}
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
          <section>
            <div className="filter-section-title">
              범위
              <span className="filter-section-title-helper">조회수·참여율·기간</span>
            </div>
            <div className="filter-section-grid">
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
            </div>
          </section>

          <section className="filter-section-divider">
            <div className="filter-section-title">
              분류
              <span className="filter-section-title-helper">광고 적합성·USP·구조·Hook·CTA</span>
            </div>
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
          </section>

          {activeFilterCount > 0 && (
            <div className="filter-actions">
              <button type="button" className="btn-reset" onClick={clearFilters}>초기화</button>
            </div>
          )}
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
    </>
  )
}
