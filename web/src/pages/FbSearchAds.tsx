import { useEffect, useState } from 'react'
import { authedFetch } from '../api'

interface Ad {
  shortcode: string
  author_username: string
  caption_text: string
  thumbnail_url: string
  video_duration: number
  video_url: string
}

export default function FbSearchAds() {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<Ad[]>([])
  const [loading, setLoading] = useState(false)
  const [scraping, setScraping] = useState(false)

  const search = (query: string) => {
    setLoading(true)
    authedFetch(`/api/fb/search/ads?q=${encodeURIComponent(query)}`)
      .then(r => r.json())
      .then(d => setItems(d.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }
  useEffect(() => { search('') }, [])

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
                <div className="card-author" style={{ fontSize: 12 }}>{ad.author_username}</div>
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
