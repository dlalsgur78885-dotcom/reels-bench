import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authedFetch } from '../api'
import { fmtNum, engagementRate } from '../utils'

interface YtItem {
  shortcode: string
  url: string
  author: string
  author_handle: string
  play_count: number
  like_count: number
  comment_count: number
  video_duration: number
  thumbnail_url: string
  caption: string
  collected_at: string
  taken_at: string
  analyzed: boolean
}

interface YtStats {
  total_shorts: number
  total_views: number
  total_likes: number
  analyzed_count: number
}

export default function YtBench() {
  const navigate = useNavigate()
  const [items, setItems] = useState<YtItem[]>([])
  const [stats, setStats] = useState<YtStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<'recent' | 'plays' | 'likes' | 'er'>('recent')
  const [q, setQ] = useState('')

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    params.set('sort', sort)
    params.set('limit', '60')
    if (q) params.set('q', q)
    authedFetch(`/api/yt/bench?${params.toString()}`)
      .then(r => r.json())
      .then(d => {
        setItems(d.items || [])
        setStats(d.stats || null)
      })
      .catch(() => {
        setItems([])
        setStats(null)
      })
      .finally(() => setLoading(false))
  }, [sort, q])

  return (
    <>
      <div className="page-header">
        <h1>유튜브 숏폼 벤치마크</h1>
        <p>{loading ? '불러오는 중…' : `${stats?.total_shorts ?? 0}개 숏폼 / 분석 ${stats?.analyzed_count ?? 0}개`}</p>
      </div>

      {stats && (
        <div className="kpi-row">
          <div className="kpi-card">
            <div className="kpi-label">숏폼</div>
            <div className="kpi-value">{stats.total_shorts}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">총 조회수</div>
            <div className="kpi-value">{fmtNum(stats.total_views)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">총 좋아요</div>
            <div className="kpi-value">{fmtNum(stats.total_likes)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">분석완료</div>
            <div className="kpi-value">{stats.analyzed_count}</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0 16px', flexWrap: 'wrap' }}>
        <input
          type="text" value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="채널·캡션·shortcode 검색"
          style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, minWidth: 240 }}
        />
        <div className="segment-group" role="radiogroup">
          {([['recent', '최신순'], ['plays', '조회수'], ['likes', '좋아요'], ['er', 'ER']] as const).map(([k, l]) => (
            <button
              key={k}
              type="button"
              className={`btn-segment${sort === k ? ' active' : ''}`}
              onClick={() => setSort(k)}
            >{l}</button>
          ))}
        </div>
      </div>

      {!loading && items.length === 0 && (
        <div className="empty-state">분석된 유튜브 숏폼이 없습니다</div>
      )}

      <div className="reel-grid">
        {items.map(it => {
          const er = engagementRate(it.like_count, it.play_count)
          return (
            <div
              key={it.shortcode}
              className="reel-card"
              onClick={() => navigate(`/yt/bench/${it.shortcode}`)}
              style={{ cursor: 'pointer' }}
            >
              <img
                src={it.thumbnail_url}
                alt=""
                loading="lazy"
                style={{ width: '100%', aspectRatio: '4/5', objectFit: 'cover', display: 'block', background: 'var(--bg-elevated)' }}
              />
              <div className="card-info">
                <div className="card-author" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {it.author || '?'}
                  {it.analyzed && <span className="tag-pill tag-pill--small" style={{ fontSize: 9 }}>분석</span>}
                </div>
                <div className="card-stats">
                  <span className="stat-pill">{fmtNum(it.play_count)}</span>
                  <span className="stat-pill" style={{ color: 'var(--error)' }}>♥ {fmtNum(it.like_count)}</span>
                  {er > 0 && <span className="stat-pill" style={{ color: er >= 5 ? 'var(--success)' : 'var(--accent)' }}>{er}%</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
