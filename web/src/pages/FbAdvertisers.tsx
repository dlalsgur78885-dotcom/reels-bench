import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authedFetch } from '../api'

interface Advertiser {
  id: number | null
  page_name: string
  page_url: string | null
  logo_url: string | null
  description: string | null
  is_active: boolean | null
  ad_count: number
  sample_caption: string
  registered: boolean
}

const CACHE_KEY = 'fb_advertisers_cache:'

function readCache(key: string): Advertiser[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY + key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function writeCache(key: string, items: Advertiser[]) {
  try { sessionStorage.setItem(CACHE_KEY + key, JSON.stringify(items)) } catch {}
}

export default function FbAdvertisers() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Advertiser[]>([])
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<'ad_count' | 'name'>('ad_count')
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addMode, setAddMode] = useState<'search' | 'url'>('search')
  const [pageUrl, setPageUrl] = useState('')
  const [saving, setSaving] = useState(false)
  // 검색 모드용
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ page_name: string; ad_count: number; logo_url: string | null; sample_caption: string; registered: boolean }>>([])
  const [searching, setSearching] = useState(false)

  const load = () => {
    const params = new URLSearchParams()
    params.set('sort', sort)
    if (debouncedQ) params.set('q', debouncedQ)
    const key = params.toString()
    const cached = readCache(key)
    if (cached) {
      setItems(cached)
      setLoading(false)
    } else {
      setLoading(true)
    }
    authedFetch(`/api/fb/advertisers?${key}`)
      .then(r => r.json())
      .then(d => {
        const next = d.items || []
        setItems(next)
        writeCache(key, next)
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q), 250)
    return () => window.clearTimeout(timer)
  }, [q])
  useEffect(load, [sort, debouncedQ])

  const onAdd = async () => {
    if (!pageUrl.trim().startsWith('http')) { alert('유효한 페이스북 페이지 URL 입력'); return }
    setSaving(true)
    try {
      const r = await authedFetch('/api/fb/advertisers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_url: pageUrl.trim() }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.detail || d.error || `오류 ${r.status}`)
      }
      setShowAdd(false)
      setPageUrl('')
      load()
    } catch (e: any) {
      alert(`추가 실패: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const runSearch = (query: string) => {
    setSearching(true)
    authedFetch(`/api/fb/search/advertisers?q=${encodeURIComponent(query)}&limit=30`)
      .then(r => r.json())
      .then(d => setSearchResults(d.items || []))
      .catch(() => setSearchResults([]))
      .finally(() => setSearching(false))
  }

  // Live 수집 + polling — 검색 시 큐에 추가하고 결과 자동 갱신
  const [livePolling, setLivePolling] = useState(false)
  const [pollSecondsLeft, setPollSecondsLeft] = useState(0)

  const searchAndCollect = async (query: string) => {
    if (!query.trim()) { alert('키워드 입력'); return }
    // 1. 즉시 캐시 검색
    runSearch(query)
    // 2. Live 수집 큐 추가
    try {
      await authedFetch(`/api/fb/scrape?keyword=${encodeURIComponent(query)}`, { method: 'POST' })
    } catch {}
    // 3. polling 시작 (10초 간격, 최대 120초)
    setLivePolling(true)
    setPollSecondsLeft(120)
    let elapsed = 0
    const iv = setInterval(() => {
      elapsed += 10
      setPollSecondsLeft(120 - elapsed)
      runSearch(query)
      if (elapsed >= 120) {
        clearInterval(iv)
        setLivePolling(false)
        setPollSecondsLeft(0)
      }
    }, 10000)
  }

  const saveFromSearch = async (page_name: string) => {
    try {
      const r = await authedFetch('/api/fb/advertisers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_url: `https://www.facebook.com/${encodeURIComponent(page_name)}` }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.detail || `오류 ${r.status}`)
      }
      runSearch(searchQ)
      load()
    } catch (e: any) {
      alert(`저장 실패: ${e.message}`)
    }
  }

  const onDelete = async (id: number, name: string) => {
    if (!confirm(`"${name}" 광고주를 삭제할까요?`)) return
    try {
      const r = await authedFetch(`/api/fb/advertisers/${id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`오류 ${r.status}`)
      load()
    } catch (e: any) {
      alert(`삭제 실패: ${e.message}`)
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>페북 라이브러리 광고주 ({items.length})</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="btn-primary btn-primary--sm"
          style={{ marginLeft: 'auto' }}
        >+ 광고주 추가</button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="text" value={q} onChange={e => setQ(e.target.value)}
          placeholder="광고주 검색"
          style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, minWidth: 240 }}
        />
        <select value={sort} onChange={e => setSort(e.target.value as any)} style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6 }}>
          <option value="ad_count">광고 개수순</option>
          <option value="name">이름순</option>
        </select>
      </div>

      {loading ? (
        <div style={{ padding: 40, color: 'var(--text-muted)' }}>로딩...</div>
      ) : items.length === 0 ? (
        <div style={{ padding: 40, color: 'var(--text-muted)', textAlign: 'center' }}>광고주 없음</div>
      ) : (
        <div className="section-card section-card--block" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700, width: 56 }}></th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>광고주</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700, width: 100 }}>광고 개수</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700, width: 100 }}>등록</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>샘플 캡션</th>
                <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr
                  key={it.page_name}
                  style={{ borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer' }}
                  onClick={(e) => {
                    const t = e.target as HTMLElement
                    if (t.closest('a') || t.closest('button')) return
                    navigate(`/ads?q=${encodeURIComponent(it.page_name)}`)
                  }}
                >
                  <td style={{ padding: '8px 14px' }}>
                    {it.logo_url ? (
                      <img src={it.logo_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', display: 'block' }} loading="lazy" />
                    ) : (
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>
                        {it.page_name.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>
                    {it.page_url ? (
                      <a href={it.page_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-primary)', textDecoration: 'none' }}>
                        {it.page_name}
                      </a>
                    ) : (
                      <a href={`/ads?q=${encodeURIComponent(it.page_name)}`} style={{ color: 'var(--text-primary)', textDecoration: 'none' }}>
                        {it.page_name}
                      </a>
                    )}
                    {it.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginTop: 2 }}>{it.description}</div>}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span className="tag-pill tag-pill--small">{it.ad_count}개</span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {it.registered ? (
                      <span className="tag-pill tag-pill--small" style={{ background: '#10b981', color: '#fff', borderColor: '#10b981' }}>등록됨</span>
                    ) : (
                      <span className="tag-pill tag-pill--small" style={{ background: 'transparent', color: 'var(--text-muted)', borderStyle: 'dashed' }}>자동감지</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-secondary)', fontSize: 12, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.sample_caption || '-'}
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                    {it.id != null && (
                      <button
                        onClick={() => onDelete(it.id!, it.page_name)}
                        style={{ fontSize: 11, color: 'var(--error)', border: 'none', background: 'transparent', cursor: 'pointer' }}
                      >삭제</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 광고주 추가 모달 — 검색 + URL 직접 추가 탭 */}
      {showAdd && (
        <div className="modal-backdrop" onClick={() => !saving && setShowAdd(false)}>
          <div className="modal-panel" style={{ width: 640, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header"><h3 style={{ margin: 0 }}>광고주 추가</h3></div>
            {/* 탭 */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', padding: '0 20px' }}>
              <button
                onClick={() => setAddMode('search')}
                style={{
                  padding: '10px 16px', fontSize: 13, fontWeight: addMode === 'search' ? 700 : 500,
                  borderTop: 'none', borderLeft: 'none', borderRight: 'none',
                  borderBottom: addMode === 'search' ? '2px solid var(--accent)' : '2px solid transparent',
                  background: 'transparent', color: addMode === 'search' ? 'var(--accent)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >키워드 검색</button>
              <button
                onClick={() => setAddMode('url')}
                style={{
                  padding: '10px 16px', fontSize: 13, fontWeight: addMode === 'url' ? 700 : 500,
                  borderTop: 'none', borderLeft: 'none', borderRight: 'none',
                  borderBottom: addMode === 'url' ? '2px solid var(--accent)' : '2px solid transparent',
                  background: 'transparent', color: addMode === 'url' ? 'var(--accent)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >URL 직접 입력</button>
            </div>

            <div className="modal-body" style={{ flex: 1, overflow: 'auto' }}>
              {addMode === 'url' ? (
                <>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>페이스북 페이지 URL *</label>
                  <input
                    type="url" value={pageUrl}
                    onChange={e => setPageUrl(e.target.value)}
                    placeholder="https://www.facebook.com/JCBKorea"
                    autoFocus
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, marginTop: 4 }}
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
                    URL만 입력하면 페이지 이름 + 로고를 자동으로 가져옵니다.
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                    <input
                      type="text" value={searchQ}
                      onChange={e => setSearchQ(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && searchAndCollect(searchQ)}
                      placeholder="키워드 입력 (예: 다이어트, 화장품)"
                      autoFocus
                      disabled={livePolling}
                      style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6 }}
                    />
                    <button
                      className="btn-primary btn-primary--sm"
                      onClick={() => searchAndCollect(searchQ)}
                      disabled={livePolling}
                    >{livePolling ? `수집 중 (${pollSecondsLeft}s)` : '검색 + Live 수집'}</button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
                    💡 검색 시 <b>FB Ads Library 라이브 스크래핑</b>이 자동 trigger됩니다 (60-120초).<br />
                    캐시된 결과 즉시 표시 + 새로 수집된 광고주는 자동으로 추가됩니다.
                  </div>
                  {livePolling && (
                    <div style={{ padding: 10, marginBottom: 10, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 12, color: '#1e40af' }}>
                      🔄 fb_ads_worker가 "{searchQ}" 스크래핑 중... ({pollSecondsLeft}초 남음)
                    </div>
                  )}
                  {searching ? (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>검색 중...</div>
                  ) : searchResults.length === 0 ? (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>결과 없음 (키워드 입력 후 검색)</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {searchResults.map(r => (
                        <div key={r.page_name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg-elevated)', borderRadius: 6 }}>
                          {r.logo_url ? (
                            <img src={r.logo_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} loading="lazy" />
                          ) : (
                            <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--bg-base)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>
                              {r.page_name.charAt(0).toUpperCase()}
                            </div>
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{r.page_name}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>광고 {r.ad_count}개</div>
                          </div>
                          {r.registered ? (
                            <span className="tag-pill tag-pill--small" style={{ background: '#10b981', color: '#fff', borderColor: '#10b981' }}>등록됨</span>
                          ) : (
                            <button className="btn-primary btn-primary--sm" onClick={() => saveFromSearch(r.page_name)} style={{ fontSize: 11 }}>저장</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn-ghost" onClick={() => setShowAdd(false)} disabled={saving}>취소</button>
              {addMode === 'url' && (
                <button className="btn-primary btn-primary--sm" onClick={onAdd} disabled={saving}>
                  {saving ? '가져오는 중...' : '추가'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
