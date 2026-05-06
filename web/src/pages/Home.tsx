import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, authedFetch, thumbUrl } from '../api'
import type { BenchItem } from '../api'
import { fmtNum, engagementRate } from '../utils'
import Thumb from '../components/Thumb'

type Platform = 'ig' | 'yt' | 'fb'

interface Props { platform: Platform }

export default function Home({ platform }: Props) {
  if (platform === 'yt') return <YtHome />
  if (platform === 'fb') return <FbHome />
  return <IgHome />
}

// ───────────────────── 인스타 ─────────────────────
function IgHome() {
  const [items, setItems] = useState<BenchItem[]>([])
  const [stats, setStats] = useState<{ total_reels: number; total_plays: number; total_likes: number; analyzed_count: number } | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.bench({ page: 1, limit: 40, sort: 'recent' }).then(res => {
      // fb_ads 제외 — 인스타 홈
      const ig = res.items.filter(r => !r.shortcode.startsWith('fb_'))
      setItems(ig.slice(0, 20))
      setStats(res.stats)
    }).catch(console.error)
  }, [])

  if (!stats) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>불러오는 중...</div>

  const avgER = stats.total_plays > 0
    ? Math.round((stats.total_likes / stats.total_plays) * 10000) / 100
    : 0

  return (
    <>
      <div className="page-header">
        <h1>인스타그램 대시보드</h1>
        <p>릴스 벤치마크 현황</p>
      </div>

      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-label">릴스</div>
          <div className="kpi-value">{stats.total_reels}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">총 조회수</div>
          <div className="kpi-value">{fmtNum(stats.total_plays)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">총 좋아요</div>
          <div className="kpi-value">{fmtNum(stats.total_likes)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">평균 ER</div>
          <div className="kpi-value">{avgER}%</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">분석완료</div>
          <div className="kpi-value">{stats.analyzed_count}</div>
        </div>
      </div>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>
        최근 릴스
      </h2>

      <div className="reel-grid">
        {items.map(r => {
          const er = engagementRate(r.like_count, r.play_count)
          return (
            <div key={r.shortcode} className="reel-card" onClick={() => navigate(`/bench/${r.shortcode}`)}>
              <Thumb
                src={thumbUrl(r.shortcode)}
                shortcode={r.shortcode}
                style={{ width: '100%', aspectRatio: '4/5', objectFit: 'cover', display: 'block', background: 'var(--bg-elevated)' }}
              />
              <div className="card-info">
                <div className="card-author">@{r.author || '?'}</div>
                <div className="card-stats">
                  <span className="stat-pill">{fmtNum(r.play_count)}</span>
                  <span className="stat-pill" style={{ color: 'var(--error)' }}>&#9829; {fmtNum(r.like_count)}</span>
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

// ───────────────────── 유튜브 ─────────────────────
interface Youtuber {
  youtube_handle: string
  channel_name: string
  category: string | null
  subscribers: number | null
  daily_views: number | null
  subscriber_growth_rate: number | null
  avatar_url: string | null
  description: string | null
  is_verified: boolean | null
}

function YtHome() {
  const [items, setItems] = useState<Youtuber[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    authedFetch('/api/youtubers?sort=subscribers')
      .then(r => r.json())
      .then(d => setItems(d.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>불러오는 중...</div>

  const totalSubs = items.reduce((s, it) => s + (it.subscribers || 0), 0)
  const totalDaily = items.reduce((s, it) => s + (it.daily_views || 0), 0)
  const verified = items.filter(it => it.is_verified).length
  const avgGrowth = items.length
    ? items.reduce((s, it) => s + (it.subscriber_growth_rate || 0), 0) / items.length
    : 0

  return (
    <>
      <div className="page-header">
        <h1>유튜브 대시보드</h1>
        <p>채널 벤치마크 현황</p>
      </div>

      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-label">채널</div>
          <div className="kpi-value">{items.length}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">총 구독자</div>
          <div className="kpi-value">{fmtNum(totalSubs)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">총 일일조회</div>
          <div className="kpi-value">{fmtNum(totalDaily)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">인증채널</div>
          <div className="kpi-value">{verified}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">평균 성장률</div>
          <div className="kpi-value" style={{ color: avgGrowth > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
            {avgGrowth > 0 ? '+' : ''}{(avgGrowth * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>
        구독자 TOP {Math.min(items.length, 12)}
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {items.slice(0, 12).map(it => (
          <div
            key={it.youtube_handle}
            className="section-card"
            style={{ padding: 14, display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer' }}
            onClick={() => navigate('/yt/channels')}
          >
            {it.avatar_url ? (
              <img src={it.avatar_url} alt="" style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} loading="lazy" />
            ) : (
              <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--bg-elevated)', flexShrink: 0 }} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.channel_name || it.youtube_handle}
                </span>
                {it.is_verified && <span style={{ fontSize: 12, color: 'var(--accent)' }}>&#10003;</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{it.youtube_handle}</div>
              <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                <span>구독 {fmtNum(it.subscribers || 0)}</span>
                <span>일일 {fmtNum(it.daily_views || 0)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// ───────────────────── 페북 라이브러리 ─────────────────────
interface FbAdvertiser {
  id: number | null
  page_name: string
  logo_url: string | null
  ad_count: number
  is_active: boolean | null
  registered: boolean
}

interface FbAd {
  shortcode: string
  page_name: string
  caption: string
  thumbnail_url: string
  collected_at: string
}

function FbHome() {
  const [advs, setAdvs] = useState<FbAdvertiser[]>([])
  const [ads, setAds] = useState<FbAd[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    Promise.all([
      authedFetch('/api/fb/advertisers?sort=ad_count').then(r => r.json()).catch(() => ({ items: [] })),
      authedFetch('/api/ads?limit=12&sort=recent').then(r => r.json()).catch(() => ({ items: [] })),
    ]).then(([a, b]) => {
      setAdvs(a.items || [])
      setAds(b.items || [])
    }).finally(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>불러오는 중...</div>

  const totalAds = advs.reduce((s, a) => s + (a.ad_count || 0), 0)
  const registered = advs.filter(a => a.registered).length
  const active = advs.filter(a => a.is_active).length

  return (
    <>
      <div className="page-header">
        <h1>페북 라이브러리 대시보드</h1>
        <p>광고주·광고 수집 현황</p>
      </div>

      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-label">광고주</div>
          <div className="kpi-value">{advs.length}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">등록 광고주</div>
          <div className="kpi-value">{registered}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">활성 광고주</div>
          <div className="kpi-value">{active}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">총 광고</div>
          <div className="kpi-value">{fmtNum(totalAds)}</div>
        </div>
      </div>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>
        광고 많은 광고주 TOP {Math.min(advs.length, 8)}
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 24 }}>
        {advs.slice(0, 8).map(a => (
          <div
            key={a.page_name}
            className="section-card"
            style={{ padding: 12, display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}
            onClick={() => navigate('/fb/advertisers')}
          >
            {a.logo_url ? (
              <img src={a.logo_url} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} loading="lazy" />
            ) : (
              <div style={{ width: 40, height: 40, borderRadius: 8, background: 'var(--bg-elevated)', flexShrink: 0 }} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.page_name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>광고 {a.ad_count}개</div>
            </div>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>
        최근 광고
      </h2>

      <div className="reel-grid">
        {ads.slice(0, 12).map(ad => (
          <div key={ad.shortcode} className="reel-card" onClick={() => navigate(`/bench/${ad.shortcode}`)}>
            {ad.thumbnail_url ? (
              <img src={ad.thumbnail_url} alt="" loading="lazy" style={{ width: '100%', aspectRatio: '4/5', objectFit: 'cover', display: 'block', background: 'var(--bg-elevated)' }} />
            ) : (
              <div style={{ width: '100%', aspectRatio: '4/5', background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 11 }}>썸네일 없음</div>
            )}
            <div className="card-info">
              <div className="card-author">{ad.page_name || '?'}</div>
              <div className="card-stats">
                <span className="stat-pill" style={{ fontSize: 10 }}>{(ad.collected_at || '').slice(0, 10)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
