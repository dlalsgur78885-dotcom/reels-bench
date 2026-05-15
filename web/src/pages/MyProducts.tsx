import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { MyProduct, ShareInfo, ShareableUser } from '../api'

const labelSt: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }

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
  const navigate = useNavigate()
  const cached = loadCache()
  const [items, setItems] = useState<MyProduct[]>(cached || [])
  const [loading, setLoading] = useState(!cached)
  const [err, setErr] = useState('')

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

  return (
    <>
      <div className="page-header">
        <h1>내 상품</h1>
        <p>{loading && items.length === 0 ? '불러오는 중…' : `${items.length}개`}</p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <button onClick={() => navigate('/my-products/new')} style={{
          padding: '8px 16px', fontSize: 13, fontWeight: 600,
          border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)',
          background: 'var(--accent-light)', color: 'var(--accent)', cursor: 'pointer',
        }}>+ 새 상품</button>
      </div>

      {err && <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>{err}</div>}

      {!loading && items.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)' }}>
          등록된 상품이 없습니다. 새 상품으로 시작하세요.
        </div>
      )}

      {loading && items.length === 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 16 }}>
          {[0, 1, 2].map(i => (
            <div key={i} className="skeleton-card" style={{ padding: 14 }}>
              <div className="skeleton-line" style={{ width: '62%', marginBottom: 14 }} />
              <div className="skeleton-line" style={{ width: '88%', marginBottom: 8 }} />
              <div className="skeleton-line" style={{ width: '40%' }} />
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && (
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
                    <button onClick={() => navigate(`/my-products/${p.id}/scripts`)} title="저장된 대본" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-base)', cursor: 'pointer' }}>🎬 대본</button>
                    {canEdit && (
                      <button onClick={() => navigate(`/my-products/${p.id}/edit`)} style={{ padding: '3px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-base)', cursor: 'pointer' }}>수정</button>
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
