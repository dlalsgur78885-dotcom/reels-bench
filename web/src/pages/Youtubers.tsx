import { useEffect, useState, useMemo } from 'react'
import { authedFetch } from '../api'

interface Youtuber {
  youtube_handle: string
  channel_name: string
  category: string | null
  subscribers: number | null
  daily_views: number | null
  subscriber_growth_rate: number | null
  avatar_url: string | null
  description: string | null
  country_code: string | null
  is_verified: boolean | null
  engagement_rate: number | null
}

function fmtNum(n: number | null | undefined): string {
  if (!n) return '-'
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}만`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}천`
  return String(n)
}

export default function Youtubers() {
  const [items, setItems] = useState<Youtuber[]>([])
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<'subscribers' | 'daily_views' | 'growth'>('subscribers')
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<string>('')
  const [addInput, setAddInput] = useState('')
  const [adding, setAdding] = useState(false)
  const [msg, setMsg] = useState('')

  const load = () => {
    setLoading(true)
    const params = new URLSearchParams()
    params.set('sort', sort)
    if (q) params.set('q', q)
    if (category) params.set('category', category)
    authedFetch(`/api/youtubers?${params.toString()}`)
      .then(r => r.json())
      .then(d => setItems(d.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [sort, q, category])

  const onAdd = async () => {
    const handles = [...new Set(
      addInput.split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean)
    )]
    if (handles.length === 0) return
    setAdding(true)
    setMsg('')
    let added = 0, dup = 0, fail = 0
    for (const h of handles) {
      try {
        const r = await authedFetch('/api/youtubers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ handle: h }),
        })
        const d = await r.json()
        if (!r.ok) { fail++; continue }
        if (d.duplicate) dup++; else added++
      } catch {
        fail++
      }
    }
    const parts: string[] = []
    if (added) parts.push(`추가 ${added}`)
    if (dup) parts.push(`중복 ${dup}`)
    if (fail) parts.push(`실패 ${fail}`)
    setMsg(parts.join(' · ') || '결과 없음')
    setAddInput('')
    setAdding(false)
    load()
  }

  const onDelete = async (handle: string) => {
    if (!confirm(`${handle} 삭제할까요?`)) return
    try {
      const r = await authedFetch(`/api/youtubers/${encodeURIComponent(handle)}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`오류 ${r.status}`)
      load()
    } catch (e: any) {
      alert(`삭제 실패: ${e.message}`)
    }
  }

  const categories = useMemo(() => {
    const s = new Set<string>()
    items.forEach(it => { if (it.category) s.add(it.category) })
    return Array.from(s).sort()
  }, [items])

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, marginBottom: 12 }}>유튜버 ({items.length})</h1>

      <div className="section-card" style={{ padding: 14, marginBottom: 16 }}>
        <textarea
          value={addInput}
          onChange={e => setAddInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onAdd()
          }}
          placeholder={'@channel 또는 https://youtube.com/@channel\n여러 개를 줄바꿈/쉼표/공백으로 구분 (Ctrl+Enter 추가)'}
          disabled={adding}
          rows={3}
          style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button
            onClick={onAdd}
            disabled={adding || !addInput.trim()}
            className="btn-primary btn-primary--sm"
          >
            {adding ? '추가 중...' : '+ 채널 추가'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {(() => {
              const n = new Set(addInput.split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean)).size
              return n > 0 ? `${n}개 인식` : '비어있음'
            })()}
          </span>
          {msg && <span style={{ fontSize: 12, color: msg.includes('실패') && !msg.includes('실패 0') ? 'var(--error)' : 'var(--accent)' }}>{msg}</span>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="이름·핸들 검색"
          style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, minWidth: 240 }}
        />
        <select value={sort} onChange={e => setSort(e.target.value as any)} style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6 }}>
          <option value="subscribers">구독자순</option>
          <option value="daily_views">일일 조회순</option>
          <option value="growth">성장률순</option>
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)} style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6 }}>
          <option value="">전체 카테고리</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {loading ? (
        <div style={{ padding: 40, color: 'var(--text-muted)' }}>로딩...</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {items.map(it => (
            <div
              key={it.youtube_handle}
              className="section-card"
              style={{ padding: 14, display: 'flex', gap: 12, alignItems: 'flex-start', position: 'relative' }}
            >
              <button
                onClick={() => onDelete(it.youtube_handle)}
                style={{
                  position: 'absolute', top: 6, right: 6, fontSize: 11,
                  color: 'var(--error)', border: 'none', background: 'transparent',
                  cursor: 'pointer', padding: '2px 6px',
                }}
                title="삭제"
              >×</button>
              {it.avatar_url ? (
                <img src={it.avatar_url} alt="" style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} loading="lazy" />
              ) : (
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--bg-elevated)', flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <a
                    href={`https://www.youtube.com/${it.youtube_handle.startsWith('@') ? it.youtube_handle : '@' + it.youtube_handle}`}
                    target="_blank" rel="noopener noreferrer"
                    style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', textDecoration: 'none' }}
                  >
                    {it.channel_name || it.youtube_handle}
                  </a>
                  {it.is_verified && <span style={{ fontSize: 12, color: 'var(--accent)' }}>✓</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{it.youtube_handle}</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                  {it.category && <span className="tag-pill tag-pill--small">{it.category}</span>}
                  {it.country_code && <span className="tag-pill tag-pill--small" style={{ fontSize: 10 }}>{it.country_code}</span>}
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                  <span>👥 {fmtNum(it.subscribers)}</span>
                  <span>📈 일일 {fmtNum(it.daily_views)}</span>
                  {it.subscriber_growth_rate != null && (
                    <span style={{ color: it.subscriber_growth_rate > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                      {it.subscriber_growth_rate > 0 ? '+' : ''}{(it.subscriber_growth_rate * 100).toFixed(1)}%
                    </span>
                  )}
                </div>
                {it.description && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {it.description}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
