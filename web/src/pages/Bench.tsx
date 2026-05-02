import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, thumbUrl } from '../api'
import type { BenchItem, BenchFilters } from '../api'
import { fmtNum, engagementRate } from '../utils'
import Thumb from '../components/Thumb'
import Pagination from '../components/Pagination'
import BenchFilterControls from '../components/BenchFilterControls'

const PAGE_SIZE = 50

export default function Bench() {
  const [items, setItems] = useState<BenchItem[]>([])
  const [stats, setStats] = useState<{ total_reels: number; total_plays: number; total_likes: number; analyzed_count: number } | null>(null)
  const [total, setTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [params, setParams] = useState<BenchFilters>({ sort: 'plays' })
  const [loading, setLoading] = useState(false)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const navigate = useNavigate()

  const load = useCallback(async (page: number, p: BenchFilters) => {
    setLoading(true)
    try {
      const res = await api.bench({ ...p, page, limit: PAGE_SIZE })
      setItems(res.items)
      setStats(res.stats)
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

      <BenchFilterControls onChange={setParams} />

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
