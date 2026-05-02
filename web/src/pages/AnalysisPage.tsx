import { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, thumbUrl } from '../api'
import type { BenchItem } from '../api'
import { fmtNum, engagementRate } from '../utils'
import Thumb from '../components/Thumb'

const PAGE_SIZE = 30

export default function AnalysisPage() {
  const [items, setItems] = useState<BenchItem[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const pageRef = useRef(1)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const navigate = useNavigate()

  const load = useCallback(async (page: number, append: boolean) => {
    setLoading(true)
    try {
      const res = await api.bench({ page, limit: PAGE_SIZE, sort: 'recent', q: search })
      // analyzed only
      const analyzed = res.items.filter(r => r.analyzed)
      setItems(prev => append ? [...prev, ...analyzed] : analyzed)
      setTotal(res.stats.analyzed_count)
      setHasMore(res.has_more)
      pageRef.current = page
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [search])

  useEffect(() => { load(1, false) }, [load])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loading) {
        load(pageRef.current + 1, true)
      }
    }, { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loading, load])

  const onSearch = (v: string) => {
    setSearch(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => load(1, false), 300)
  }

  return (
    <>
      <div className="page-header">
        <h1>분석</h1>
        <p>{total}개 릴스 분석 완료</p>
      </div>

      <input
        className="search-input"
        placeholder="검색..."
        value={search}
        onChange={e => onSearch(e.target.value)}
        style={{ marginBottom: 16 }}
      />

      {items.length === 0 && !loading && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          분석된 릴스가 없습니다. 벤치마크에서 분석을 시작하세요.
        </div>
      )}

      {items.map(r => {
        const er = engagementRate(r.like_count, r.play_count)
        return (
          <div
            key={r.shortcode}
            className="analysis-card"
            onClick={() => navigate(`/bench/${r.shortcode}`)}
          >
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <Thumb
                src={thumbUrl(r.shortcode)}
                shortcode={r.shortcode}
                style={{ width: 60, height: 80, objectFit: 'cover', borderRadius: 'var(--radius-sm)', flexShrink: 0, background: 'var(--bg-elevated)' }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', marginBottom: 4 }}>
                  @{r.author || '?'}
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12, marginLeft: 8 }}>{r.shortcode}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  <span className="stat-pill">{fmtNum(r.play_count)}</span>
                  <span className="stat-pill" style={{ color: 'var(--error)' }}>&#9829; {fmtNum(r.like_count)}</span>
                  {er > 0 && <span className="stat-pill">{er}%</span>}
                </div>
              </div>
            </div>
          </div>
        )
      })}

      <div ref={sentinelRef} style={{ height: 1 }} />
      {loading && <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>불러오는 중...</div>}
    </>
  )
}
