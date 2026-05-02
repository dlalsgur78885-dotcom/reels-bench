import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { MyProduct, ShareInfo, ShareableUser } from '../api'

interface USPItem { usp: string; reviews: string[] }

const labelSt: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }
const inputSt: React.CSSProperties = {
  width: '100%', padding: '8px 12px', fontSize: 13,
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-base)', color: 'var(--text-primary)',
}
const textareaSt: React.CSSProperties = { ...inputSt, fontFamily: 'inherit', resize: 'vertical', minHeight: 96, lineHeight: 1.5 }

function cleanReviews(raw: string, replaceFrom: string, replaceTo: string): string[] {
  const from = replaceFrom.trim()
  const to = replaceTo.trim()

  const normalize = (value: unknown) => {
    if (typeof value !== 'string') return ''
    let text = value
      .replace(/\r/g, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^[\s"'\-[\]({})*•·]+/, '')
      .replace(/[\s"'\-[\]({})]+$/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (from && to) text = text.split(from).join(to)
    return text
  }

  const fromJson = (() => {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.map(item => typeof item === 'string' ? item : item?.text || item?.review || item?.content)
      }
      if (Array.isArray(parsed?.reviews)) return parsed.reviews
      if (Array.isArray(parsed?.usps)) return parsed.usps.flatMap((u: any) => u?.reviews || [])
    } catch {
      return null
    }
    return null
  })()

  const source = fromJson ?? raw.split('\n')
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const item of source) {
    const text = normalize(item)
    if (text.length < 2 || seen.has(text)) continue
    seen.add(text)
    cleaned.push(text)
  }
  return cleaned
}

const CACHE_KEY = 'my_products_cache'
function loadCache(): MyProduct[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function saveCache(v: MyProduct[]) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(v)) } catch {}
}

export default function MyProducts() {
  const cached = loadCache()
  const [items, setItems] = useState<MyProduct[]>(cached || [])
  const [loading, setLoading] = useState(!cached)
  const [editing, setEditing] = useState<MyProduct | 'new' | null>(null)
  const [name, setName] = useState('')
  const [usps, setUsps] = useState<USPItem[]>([{ usp: '', reviews: [''] }])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const [collectorText, setCollectorText] = useState('')
  const [collectorUspIndex, setCollectorUspIndex] = useState(0)
  const [replaceFrom, setReplaceFrom] = useState('트립쿠폰')
  const [replaceTo, setReplaceTo] = useState('')

  // 공유
  const [sharing, setSharing] = useState<MyProduct | null>(null)
  const [sharePerm, setSharePerm] = useState<'view' | 'edit'>('view')
  const [shareableUsers, setShareableUsers] = useState<ShareableUser[]>([])
  const [shares, setShares] = useState<ShareInfo[]>([])
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set())
  const [shareBusy, setShareBusy] = useState(false)
  const [shareErr, setShareErr] = useState('')

  const load = async () => {
    if (items.length === 0) setLoading(true)
    try {
      const fresh = await api.listMyProducts()
      setItems(fresh)
      saveCache(fresh)
    } catch (e: any) { setErr(e.message) }
    setLoading(false)
  }
  useEffect(() => { load() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [])

  const resetCollector = (productName = '') => {
    setCollectorText('')
    setCollectorUspIndex(0)
    setReplaceFrom('트립쿠폰')
    setReplaceTo(productName)
  }

  const startNew = () => {
    setEditing('new'); setName('')
    setUsps([{ usp: '', reviews: [''] }]); setErr('')
    resetCollector('')
  }
  const startEdit = (p: MyProduct) => {
    setEditing(p); setName(p.name)
    setUsps(p.usps?.length ? p.usps : [{ usp: '', reviews: [''] }]); setErr('')
    resetCollector(p.name)
  }

  const cleanUsps = () => usps
    .map(u => ({ usp: u.usp.trim(), reviews: u.reviews.map(r => r.trim()).filter(Boolean) }))
    .filter(u => u.usp)

  const save = async () => {
    if (!name.trim()) { setErr('이름을 입력해주세요'); return }
    setBusy(true); setErr('')
    try {
      const payload = { name: name.trim(), usps: cleanUsps() }
      if (editing === 'new') await api.createMyProduct(payload)
      else if (editing) await api.updateMyProduct(editing.id, payload)
      setEditing(null); load()
    } catch (e: any) { setErr(e.message || '저장 실패') }
    setBusy(false)
  }

  const remove = async (p: MyProduct) => {
    if (!confirm(`"${p.name}" 상품을 삭제할까요?`)) return
    try { await api.deleteMyProduct(p.id); load() } catch (e: any) { alert(e.message) }
  }

  const startShare = async (p: MyProduct) => {
    setSharing(p); setSharePerm('view'); setPickedIds(new Set()); setShareErr('')
    try {
      const [users, existing] = await Promise.all([api.shareableUsers(), api.listProductShares(p.id)])
      setShareableUsers(users)
      setShares(existing)
    } catch (e: any) { setShareErr(e.message || '로딩 실패') }
  }

  const togglePicked = (id: string) => {
    setPickedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const submitShare = async () => {
    if (!sharing || pickedIds.size === 0) return
    setShareBusy(true); setShareErr('')
    try {
      await api.shareProduct(sharing.id, [...pickedIds], sharePerm)
      const existing = await api.listProductShares(sharing.id)
      setShares(existing)
      setPickedIds(new Set())
    } catch (e: any) { setShareErr(e.message || '공유 실패') }
    setShareBusy(false)
  }

  const revokeShare = async (userId: string) => {
    if (!sharing) return
    if (!confirm('공유를 해제할까요?')) return
    try {
      await api.unshareProduct(sharing.id, userId)
      setShares(prev => prev.filter(s => s.shared_with_id !== userId))
    } catch (e: any) { alert(e.message || '실패') }
  }

  const sharedIdSet = useMemo(() => new Set(shares.map(s => s.shared_with_id)), [shares])
  const candidates = useMemo(
    () => shareableUsers.filter(u => !sharedIdSet.has(u.id)),
    [shareableUsers, sharedIdSet],
  )

  const collectedReviews = useMemo(
    () => cleanReviews(collectorText, replaceFrom, replaceTo || name),
    [collectorText, replaceFrom, replaceTo, name],
  )

  const newCollectedCount = useMemo(() => {
    const existing = new Set((usps[collectorUspIndex]?.reviews || []).map(r => r.trim()).filter(Boolean))
    return collectedReviews.filter(r => !existing.has(r)).length
  }, [collectedReviews, collectorUspIndex, usps])

  const applyCollectedReviews = () => {
    const target = usps[collectorUspIndex]
    if (!target) { setErr('리뷰를 넣을 USP를 선택해주세요'); return }
    const existing = new Set(target.reviews.map(r => r.trim()).filter(Boolean))
    const nextReviews = [
      ...target.reviews.map(r => r.trim()).filter(Boolean),
      ...collectedReviews.filter(r => !existing.has(r)),
    ]
    setUsps(usps.map((u, idx) => idx === collectorUspIndex ? { ...u, reviews: nextReviews.length ? nextReviews : [''] } : u))
    setCollectorText('')
  }

  return (
    <>
      <div className="page-header">
        <h1>내 상품</h1>
        <p>{loading && items.length === 0 ? '불러오는 중…' : `${items.length}개`}</p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <button onClick={startNew} style={{
          padding: '8px 16px', fontSize: 13, fontWeight: 600,
          border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)',
          background: 'var(--accent-light)', color: 'var(--accent)', cursor: 'pointer',
        }}>+ 새 상품</button>
      </div>

      {loading && <div style={{ color: 'var(--text-muted)' }}>로딩...</div>}

      {!loading && items.length === 0 && !editing && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)' }}>
          등록된 상품이 없습니다. 새 상품으로 시작하세요.
        </div>
      )}

      {!loading && items.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 16 }}>
          {items.map(p => {
            const isOwner = !p.is_shared
            const canEdit = isOwner || p.permission === 'edit'
            return (
              <div key={p.id} style={{
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)', padding: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    {isOwner && (
                      <button onClick={() => startShare(p)} title="다른 직원에게 공유" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid var(--accent)', borderRadius: 4, background: 'var(--accent-light)', color: 'var(--accent)', cursor: 'pointer' }}>공유</button>
                    )}
                    {canEdit && (
                      <button onClick={() => startEdit(p)} style={{ padding: '3px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-base)', cursor: 'pointer' }}>수정</button>
                    )}
                    {isOwner && (
                      <button onClick={() => remove(p)} style={{ padding: '3px 8px', fontSize: 11, border: '1px solid var(--error)', borderRadius: 4, background: 'transparent', color: 'var(--error)', cursor: 'pointer' }}>삭제</button>
                    )}
                  </div>
                </div>
                {p.is_shared && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', marginBottom: 6, fontSize: 10, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 999, background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
                    <span>공유받음</span>
                    <span style={{ color: 'var(--text-muted)' }}>· @{p.owner_name}</span>
                    <span style={{ color: p.permission === 'edit' ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {p.permission === 'edit' ? '수정 가능' : '보기 전용'}
                    </span>
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  USP {p.usps?.length || 0}개 · 리뷰 {p.usps?.reduce((s, u) => s + (u.reviews?.length || 0), 0) || 0}개
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }} onClick={() => !busy && setEditing(null)}>
          <div style={{
            background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)',
            padding: 24, width: 760, maxHeight: '90vh', overflowY: 'auto',
          }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
              {editing === 'new' ? '새 상품 등록' : `상품 수정: ${(editing as MyProduct).name}`}
            </h2>

            <div style={{ marginBottom: 14 }}>
              <label style={labelSt}>제품명 / 서비스명</label>
              <input style={inputSt} value={name} onChange={e => setName(e.target.value)} placeholder="예: C멤버십" />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelSt}>리뷰 수집</label>
              <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr', gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={labelSt}>바꿀 이름</label>
                    <input style={inputSt} value={replaceFrom} onChange={e => setReplaceFrom(e.target.value)} placeholder="트립쿠폰" />
                  </div>
                  <div>
                    <label style={labelSt}>대체 이름</label>
                    <input style={inputSt} value={replaceTo} onChange={e => setReplaceTo(e.target.value)} placeholder={name || 'C멤버십'} />
                  </div>
                  <div>
                    <label style={labelSt}>넣을 USP</label>
                    <select style={inputSt} value={collectorUspIndex} onChange={e => setCollectorUspIndex(Number(e.target.value))}>
                      {usps.map((u, i) => <option key={i} value={i}>{u.usp || `USP ${i + 1}`}</option>)}
                    </select>
                  </div>
                </div>
                <textarea
                  style={textareaSt}
                  value={collectorText}
                  onChange={e => setCollectorText(e.target.value)}
                  placeholder={'리뷰를 한 줄에 하나씩 붙여넣기\n또는 {"reviews":["리뷰1","리뷰2"]} JSON 붙여넣기'}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    정제 {collectedReviews.length}개 · 새로 추가 {newCollectedCount}개
                  </div>
                  <button
                    onClick={applyCollectedReviews}
                    disabled={newCollectedCount === 0}
                    style={{
                      padding: '6px 12px', fontSize: 12, fontWeight: 600,
                      border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)',
                      background: newCollectedCount ? 'var(--accent-light)' : 'var(--bg-elevated)',
                      color: newCollectedCount ? 'var(--accent)' : 'var(--text-muted)',
                      cursor: newCollectedCount ? 'pointer' : 'not-allowed',
                    }}
                  >선택 USP에 추가</button>
                </div>
                {collectedReviews.length > 0 && (
                  <div style={{ marginTop: 8, maxHeight: 92, overflowY: 'auto', borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
                    {collectedReviews.slice(0, 5).map((r, i) => (
                      <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {i + 1}. {r}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelSt}>USP & 연관 리뷰</label>
              {usps.map((u, i) => (
                <div key={i} style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10, marginBottom: 8 }}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    <input style={{ ...inputSt, flex: 1 }} value={u.usp}
                      onChange={e => setUsps(usps.map((x, idx) => idx === i ? { ...x, usp: e.target.value } : x))}
                      placeholder={`USP ${i + 1}`} />
                    {usps.length > 1 && (
                      <button onClick={() => setUsps(usps.filter((_, idx) => idx !== i))} style={{ padding: '4px 8px', fontSize: 11, border: '1px solid var(--error)', borderRadius: 4, background: 'transparent', color: 'var(--error)', cursor: 'pointer' }}>삭제</button>
                    )}
                  </div>
                  <div style={{ paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
                    {u.reviews.map((r, j) => (
                      <div key={j} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                        <input style={{ ...inputSt, flex: 1, fontSize: 12 }} value={r}
                          onChange={e => setUsps(usps.map((x, idx) => idx === i ? { ...x, reviews: x.reviews.map((rr, k) => k === j ? e.target.value : rr) } : x))}
                          placeholder={`연관 리뷰 ${j + 1}`} />
                        {u.reviews.length > 1 && (
                          <button onClick={() => setUsps(usps.map((x, idx) => idx === i ? { ...x, reviews: x.reviews.filter((_, k) => k !== j) } : x))}
                            style={{ padding: '4px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-elevated)', cursor: 'pointer' }}>삭제</button>
                        )}
                      </div>
                    ))}
                    <button onClick={() => setUsps(usps.map((x, idx) => idx === i ? { ...x, reviews: [...x.reviews, ''] } : x))}
                      style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, border: '1px solid var(--accent)', borderRadius: 4, background: 'var(--accent-light)', color: 'var(--accent)', cursor: 'pointer' }}>+ 리뷰 추가</button>
                  </div>
                </div>
              ))}
              <button onClick={() => setUsps([...usps, { usp: '', reviews: [''] }])}
                style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'var(--accent-light)', color: 'var(--accent)', cursor: 'pointer' }}>+ USP 추가</button>
            </div>

            {err && <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 8 }}>{err}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditing(null)} disabled={busy} style={{ padding: '8px 16px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)', cursor: 'pointer' }}>취소</button>
              <button onClick={save} disabled={busy} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>{busy ? '저장 중...' : '저장'}</button>
            </div>
          </div>
        </div>
      )}

      {sharing && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }} onClick={() => !shareBusy && setSharing(null)}>
          <div style={{
            background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)',
            padding: 24, width: 520, maxHeight: '85vh', overflowY: 'auto',
          }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>"{sharing.name}" 공유</h2>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
              선택한 직원에게 이 상품을 보여줍니다.
            </p>

            <div style={{ marginBottom: 14 }}>
              <label style={labelSt}>권한</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['view', 'edit'] as const).map(opt => (
                  <button key={opt} onClick={() => setSharePerm(opt)} style={{
                    flex: 1, padding: '8px 12px', fontSize: 12, fontWeight: 600,
                    border: '1px solid', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    borderColor: sharePerm === opt ? 'var(--accent)' : 'var(--border)',
                    background: sharePerm === opt ? 'var(--accent-light)' : 'var(--bg-base)',
                    color: sharePerm === opt ? 'var(--accent)' : 'var(--text-secondary)',
                  }}>
                    <div>{opt === 'view' ? '보기 전용' : '수정 가능'}</div>
                    <div style={{ fontSize: 10, fontWeight: 400, marginTop: 2, color: 'var(--text-muted)' }}>
                      {opt === 'view' ? '참고용 — 변경 불가' : '동시 편집 — 마지막 저장이 덮어씀'}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelSt}>공유 대상 ({pickedIds.size}명 선택)</label>
              {candidates.length === 0 ? (
                <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  공유 가능한 직원이 없습니다.
                </div>
              ) : (
                <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  {candidates.map(u => {
                    const checked = pickedIds.has(u.id)
                    return (
                      <label key={u.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                        cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)',
                        background: checked ? 'var(--accent-light)' : 'transparent',
                      }}>
                        <input type="checkbox" checked={checked} onChange={() => togglePicked(u.id)} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.display_name || u.email.split('@')[0]}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            {u.email.replace('@reels-bench.local', '')}
                          </div>
                        </div>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            {shares.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelSt}>이미 공유 중 ({shares.length}명)</label>
                <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  {shares.map(s => (
                    <div key={s.shared_with_id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.display_name}
                        </div>
                        <div style={{ fontSize: 10, color: s.permission === 'edit' ? 'var(--accent)' : 'var(--text-muted)' }}>
                          {s.permission === 'edit' ? '수정 가능' : '보기 전용'}
                        </div>
                      </div>
                      <button onClick={() => revokeShare(s.shared_with_id)} style={{
                        padding: '3px 8px', fontSize: 11, border: '1px solid var(--error)',
                        borderRadius: 4, background: 'transparent', color: 'var(--error)', cursor: 'pointer',
                      }}>해제</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {shareErr && <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 8 }}>{shareErr}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setSharing(null)} disabled={shareBusy} style={{ padding: '8px 16px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)', cursor: 'pointer' }}>닫기</button>
              <button onClick={submitShare} disabled={shareBusy || pickedIds.size === 0} style={{
                padding: '8px 16px', fontSize: 13, fontWeight: 600, border: 'none',
                borderRadius: 'var(--radius-sm)', cursor: pickedIds.size ? 'pointer' : 'not-allowed',
                background: pickedIds.size ? 'var(--accent)' : 'var(--bg-elevated)',
                color: pickedIds.size ? '#fff' : 'var(--text-muted)',
              }}>{shareBusy ? '공유 중...' : `${pickedIds.size}명에게 공유`}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
