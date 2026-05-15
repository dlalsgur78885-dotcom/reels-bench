import { useEffect, useState } from 'react'
import { authedFetch } from '../api'

interface Item {
  page_name: string
  ad_count: number
  thumbnails: string[]
  sample_caption: string
  registered: boolean
  advertiser_id: number | null
  logo_url: string | null
}

const CACHE_PREFIX = 'fb_search_advertisers:'
function readCache(query: string): Item[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + query)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function writeCache(query: string, items: Item[]) {
  try { sessionStorage.setItem(CACHE_PREFIX + query, JSON.stringify(items)) } catch {}
}

export default function FbSearchAdvertisers() {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(false)
  const [scraping, setScraping] = useState(false)
  const [error, setError] = useState('')

  const search = (query: string) => {
    const key = query.trim()
    const cached = readCache(key)
    setError('')
    if (cached) setItems(cached)
    setLoading(!cached)
    authedFetch(`/api/fb/search/advertisers?q=${encodeURIComponent(query)}`)
      .then(r => r.json())
      .then(d => {
        const next = d.items || []
        setItems(next)
        writeCache(key, next)
      })
      .catch(() => {
        if (!cached) setItems([])
        setError('광고주 검색 결과를 불러오지 못했습니다.')
      })
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

  const onSave = async (page_name: string) => {
    try {
      const r = await authedFetch('/api/fb/advertisers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_url: `https://www.facebook.com/${encodeURIComponent(page_name)}` }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.detail || `오류 ${r.status}`)
      }
      search(q)
    } catch (e: any) {
      alert(`저장 실패: ${e.message}`)
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, marginBottom: 12 }}>광고주 검색</h1>
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

      {error && <div className="error-banner">{error}</div>}

      {loading && items.length === 0 ? (
        <div className="section-card section-card--block" style={{ padding: 14 }}>
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 80px 90px 1.8fr 60px', gap: 14, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="skeleton-line" style={{ width: 32, height: 32, borderRadius: 999 }} />
              <div className="skeleton-line" />
              <div className="skeleton-line" />
              <div className="skeleton-line" />
              <div className="skeleton-line" />
              <div className="skeleton-line" />
            </div>
          ))}
        </div>
      ) : (
        <div className="section-card section-card--block" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '10px 14px', textAlign: 'left', width: 56 }}></th>
                <th style={{ padding: '10px 14px', textAlign: 'left' }}>광고주</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', width: 100 }}>광고 수</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', width: 90 }}>등록</th>
                <th style={{ padding: '10px 14px', textAlign: 'left' }}>샘플 캡션</th>
                <th style={{ padding: '10px 14px', textAlign: 'right', width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.page_name} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '8px 14px' }}>
                    {it.logo_url ? (
                      <img src={it.logo_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} loading="lazy" />
                    ) : (
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>
                        {it.page_name.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>{it.page_name}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <span className="tag-pill tag-pill--small">{it.ad_count}개</span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {it.registered ? (
                      <span className="tag-pill tag-pill--small" style={{ background: '#10b981', color: '#fff', borderColor: '#10b981' }}>등록됨</span>
                    ) : (
                      <span className="tag-pill tag-pill--small" style={{ borderStyle: 'dashed' }}>미등록</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-secondary)', fontSize: 12, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.sample_caption || '-'}
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                    {!it.registered && (
                      <button
                        className="btn-ghost btn-ghost--inline"
                        onClick={() => onSave(it.page_name)}
                        style={{ fontSize: 11 }}
                      >저장</button>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>결과 없음</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
