import { useEffect, useState } from 'react'
import { api, authedFetch } from '../api'

type Share = {
  id: string
  shared_with_id: string
  permission: 'view' | 'edit'
  created_at: string
  display_name?: string
  email?: string
}

type Colleague = { id: string; email?: string; display_name?: string | null }

export default function SeedanceGroupShareModal({
  groupName, videoCount, onClose,
}: {
  groupName: string
  videoCount: number
  onClose: () => void
}) {
  const [shares, setShares] = useState<Share[]>([])
  const [colleagues, setColleagues] = useState<Colleague[]>([])
  const [target, setTarget] = useState('')
  const [perm, setPerm] = useState<'view' | 'edit'>('view')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = async () => {
    const qs = `?group_name=${encodeURIComponent(groupName)}`
    const re = await authedFetch(`/api/seedance/group-shares${qs}`)
    setShares(re.ok ? await re.json() : [])
  }

  useEffect(() => {
    (async () => {
      setLoading(true); setError('')
      try {
        const qs = `?group_name=${encodeURIComponent(groupName)}`
        const [sList, cList] = await Promise.all([
          authedFetch(`/api/seedance/group-shares${qs}`).then(r => r.ok ? r.json() : []),
          api.listColleagues().catch(() => []),
        ])
        setShares(Array.isArray(sList) ? sList : [])
        setColleagues(Array.isArray(cList) ? cList : [])
      } catch (e: any) {
        setError(e?.message || String(e))
      } finally { setLoading(false) }
    })()
  }, [groupName])

  const add = async () => {
    if (!target || busy) return
    setBusy(true); setError('')
    try {
      const r = await authedFetch('/api/seedance/group-shares', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_name: groupName, shared_with_id: target, permission: perm }),
      })
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
      setTarget('')
      await refresh()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally { setBusy(false) }
  }

  const remove = async (share_id: string) => {
    if (!confirm('이 공유를 제거할까요? 받은 사용자가 해당 그룹 영상을 더 이상 볼 수 없습니다.')) return
    try {
      const r = await authedFetch(`/api/seedance/group-shares/${share_id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`${r.status}`)
      setShares(prev => prev.filter(s => s.id !== share_id))
    } catch (e: any) {
      alert('제거 실패: ' + (e?.message || e))
    }
  }

  const availableColleagues = colleagues.filter(c => !shares.some(s => s.shared_with_id === c.id))

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 18, width: '100%', maxWidth: 480 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
            그룹 공유 — {groupName}
          </h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: 18 }}>×</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
          이 그룹의 영상 {videoCount}개를 한 번에 공유합니다. 이후 그룹에 추가되는 영상도 자동으로 같이 공유돼요.
        </div>

        {loading && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>불러오는 중…</div>}
        {error && (
          <div style={{ padding: 8, marginBottom: 10, fontSize: 12,
            background: 'rgba(239,68,68,0.08)', color: 'var(--error)',
            border: '1px solid var(--error)', borderRadius: 4 }}>{error}</div>
        )}

        {!loading && (
          <>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
              공유 중 ({shares.length}명)
            </div>
            {shares.length > 0 ? (
              <div style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
                {shares.map(s => (
                  <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '6px 10px', background: 'var(--bg-base)', borderRadius: 4, fontSize: 11 }}>
                    <span style={{ flex: 1 }}>{s.display_name || s.email || s.shared_with_id}</span>
                    <span style={{
                      padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                      background: s.permission === 'edit' ? 'var(--accent)' : 'var(--bg-elevated)',
                      color: s.permission === 'edit' ? '#fff' : 'var(--text-secondary)',
                    }}>{s.permission === 'edit' ? '편집' : '보기'}</span>
                    <button onClick={() => remove(s.id)}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--error)', fontSize: 11 }}>제거</button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '6px 0', marginBottom: 10 }}>
                아직 공유된 사용자가 없습니다.
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                새 공유 추가
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={target} onChange={e => setTarget(e.target.value)}
                  style={{ flex: 1, padding: '6px 10px', fontSize: 11,
                    border: '1px solid var(--border)', borderRadius: 4,
                    background: 'var(--bg-base)', color: 'var(--text-body)' }}>
                  <option value="">공유받을 회원 선택</option>
                  {availableColleagues.map(c => (
                    <option key={c.id} value={c.id}>{c.display_name || c.email}</option>
                  ))}
                </select>
                <select value={perm} onChange={e => setPerm(e.target.value as any)}
                  style={{ padding: '6px 8px', fontSize: 11,
                    border: '1px solid var(--border)', borderRadius: 4,
                    background: 'var(--bg-base)', color: 'var(--text-body)' }}>
                  <option value="view">보기</option>
                  <option value="edit">편집</option>
                </select>
                <button onClick={add} disabled={busy || !target}
                  style={{ padding: '6px 14px', fontSize: 11, fontWeight: 700,
                    background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4,
                    cursor: (busy || !target) ? 'not-allowed' : 'pointer',
                    opacity: (busy || !target) ? 0.5 : 1 }}>
                  추가
                </button>
              </div>
              {availableColleagues.length === 0 && (
                <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>
                  공유 가능한 다른 회원이 없습니다.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
