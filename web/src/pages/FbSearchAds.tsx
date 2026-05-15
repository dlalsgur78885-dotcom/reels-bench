import { useEffect, useState } from 'react'
import { authedFetch } from '../api'

interface Ad {
  shortcode: string
  author_username: string
  caption_text: string
  thumbnail_url: string
  video_duration: number
  video_url: string
  taken_at?: string  // 광고 시작일 (FB ad library 'started running')
}

const CACHE_KEY = 'fb_search_ads_cache_v2:'

function readCache(query: string): Ad[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY + query)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function writeCache(query: string, items: Ad[]) {
  try { sessionStorage.setItem(CACHE_KEY + query, JSON.stringify(items)) } catch {}
}

type SortKey = 'recent' | 'started' | 'duration_short' | 'duration_long'

export default function FbSearchAds() {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<Ad[]>(readCache('') || [])
  const [loading, setLoading] = useState(false)
  const [scraping, setScraping] = useState(false)
  // 필터
  // minAgeDays = N일 이상 운영된 광고만 (= taken_at <= now - N일). 0=전체
  const [minAgeDays, setMinAgeDays] = useState(7)
  const [durBucket, setDurBucket] = useState<'all' | '0-15' | '15-30' | '30-60' | '60+'>('all')
  const [sort, setSort] = useState<SortKey>('recent')

  const buildQs = (query: string) => {
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    // 항상 전송 (기본 7) — 0이면 백엔드에서 필터 해제
    params.set('min_age_days', String(minAgeDays))
    if (durBucket === '0-15') params.set('duration_max', '15')
    else if (durBucket === '15-30') { params.set('duration_min', '15'); params.set('duration_max', '30') }
    else if (durBucket === '30-60') { params.set('duration_min', '30'); params.set('duration_max', '60') }
    else if (durBucket === '60+') params.set('duration_min', '60')
    if (sort !== 'recent') params.set('sort', sort)
    return params.toString()
  }

  const search = (query: string) => {
    const qs = buildQs(query)
    const cacheK = `${query}|${qs}`
    const cached = readCache(cacheK)
    if (cached) {
      setItems(cached)
      setLoading(false)
    } else {
      setLoading(true)
    }
    authedFetch(`/api/fb/search/ads?${qs}`)
      .then(r => r.json())
      .then(d => {
        const next = d.items || []
        setItems(next)
        writeCache(cacheK, next)
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    const timer = window.setTimeout(() => search(q), 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minAgeDays, durBucket, sort])

  const onLiveScrape = async () => {
    if (!q.trim()) { alert('키워드 입력'); return }
    setScraping(true)
    try {
      const r = await authedFetch(`/api/fb/scrape?keyword=${encodeURIComponent(q)}`, { method: 'POST' })
      if (!r.ok) throw new Error(`오류 ${r.status}`)
      alert(`"${q}" 스크래핑 큐 추가됨. fb_ads_worker가 처리 중...`)
    } catch (e: any) {
      alert(`실패: ${e.message}`)
    } finally {
      setScraping(false)
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, marginBottom: 12 }}>광고 검색</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          type="text" value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search(q)}
          placeholder="키워드 (캡션·광고주명 매칭)"
          style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6 }}
        />
        <button className="btn-primary btn-primary--sm" onClick={() => search(q)}>검색</button>
        <button className="btn-ghost btn-ghost--inline" onClick={onLiveScrape} disabled={scraping}>
          {scraping ? '큐 추가 중...' : 'Live 수집'}
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
        💡 캐시된 광고에서 검색 / "Live 수집"은 fb_ads_worker로 새 키워드 스크래핑 트리거
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 4 }}>최소 운영기간:</span>
          {[
            { v: 0, label: '전체' }, { v: 3, label: '3일+' }, { v: 7, label: '7일+' },
            { v: 14, label: '14일+' }, { v: 30, label: '30일+' }, { v: 90, label: '90일+' },
          ].map(o => (
            <button key={o.v} onClick={() => setMinAgeDays(o.v)} style={{
              padding: '3px 10px', fontSize: 11, fontWeight: minAgeDays === o.v ? 700 : 500,
              border: `1px solid ${minAgeDays === o.v ? 'var(--accent)' : 'var(--border)'}`,
              background: minAgeDays === o.v ? 'var(--accent-light)' : 'var(--bg-surface)',
              color: minAgeDays === o.v ? 'var(--accent)' : 'var(--text-body)',
              borderRadius: 'var(--radius-pill)', cursor: 'pointer',
            }} title="광고 게재 시작일 기준 N일 이상 운영 중인 광고만">{o.label}</button>
          ))}
          <input
            type="number" min={0} max={365} value={minAgeDays}
            onChange={e => {
              const v = Math.max(0, Math.min(365, Number(e.target.value) || 0))
              setMinAgeDays(v)
            }}
            title="커스텀 (일 단위)"
            style={{ width: 56, padding: '3px 6px', fontSize: 11, marginLeft: 4,
              border: '1px solid var(--border)', borderRadius: 4,
              background: 'var(--bg-surface)', color: 'var(--text-body)' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 4 }}>길이:</span>
          {([
            ['all', '전체'], ['0-15', '≤15s'], ['15-30', '15-30s'],
            ['30-60', '30-60s'], ['60+', '60s+'],
          ] as const).map(([v, label]) => (
            <button key={v} onClick={() => setDurBucket(v)} style={{
              padding: '3px 10px', fontSize: 11, fontWeight: durBucket === v ? 700 : 500,
              border: `1px solid ${durBucket === v ? 'var(--accent)' : 'var(--border)'}`,
              background: durBucket === v ? 'var(--accent-light)' : 'var(--bg-surface)',
              color: durBucket === v ? 'var(--accent)' : 'var(--text-body)',
              borderRadius: 'var(--radius-pill)', cursor: 'pointer',
            }}>{label}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 4 }}>정렬:</span>
          <select value={sort} onChange={e => setSort(e.target.value as SortKey)} style={{
            padding: '3px 8px', fontSize: 11, border: '1px solid var(--border)',
            borderRadius: 4, background: 'var(--bg-surface)', cursor: 'pointer',
          }}>
            <option value="recent">최신 수집순</option>
            <option value="started">광고 시작일순</option>
            <option value="duration_short">짧은 영상순</option>
            <option value="duration_long">긴 영상순</option>
          </select>
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
          {items.length}개
        </span>
      </div>

      {loading ? <div style={{ padding: 40, color: 'var(--text-muted)' }}>로딩...</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
          {items.map(ad => (
            <a
              key={ad.shortcode}
              href={`/bench/${ad.shortcode}`}
              className="reel-card"
              style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
            >
              <div style={{ position: 'relative' }}>
                {ad.thumbnail_url ? (
                  <img src={ad.thumbnail_url} alt="" style={{ width: '100%', aspectRatio: '4/5', objectFit: 'cover', display: 'block', background: 'var(--bg-elevated)' }} loading="lazy" />
                ) : (
                  <div style={{ width: '100%', aspectRatio: '4/5', background: 'var(--bg-elevated)' }} />
                )}
                <span style={{ position: 'absolute', top: 6, left: 6, fontSize: 10, padding: '2px 6px', background: '#3b82f6', color: '#fff', borderRadius: 3, fontWeight: 700 }}>FB</span>
                {ad.video_duration && (
                  <span style={{ position: 'absolute', bottom: 6, right: 6, fontSize: 10, padding: '2px 5px', background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: 3 }}>
                    {Math.round(ad.video_duration)}s
                  </span>
                )}
              </div>
              <div className="card-info" style={{ padding: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                  <div className="card-author" style={{ fontSize: 12 }}>{ad.author_username}</div>
                  {ad.taken_at && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                      📅 {new Date(ad.taken_at).toLocaleDateString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric' })}
                    </span>
                  )}
                </div>
                {ad.caption_text && (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4, marginTop: 4, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {ad.caption_text}
                  </div>
                )}
              </div>
            </a>
          ))}
          {items.length === 0 && (
            <div style={{ gridColumn: '1 / -1', padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>결과 없음</div>
          )}
        </div>
      )}
    </div>
  )
}
