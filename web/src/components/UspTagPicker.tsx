import { useEffect, useState } from 'react'
import { api } from '../api'
import type { MyProduct } from '../api'

export type UspLink = { product_id: number; usp_index: number }
type UspGroup = { id: string; name: string; color: string | null; usp_indexes: number[] }

// 영상에 USP를 연결하는 모달 picker.
// USP는 my_products.usps[]의 1-based index로 식별. USP 그룹 클릭 = 멤버 일괄 토글.
export default function UspTagPicker({
  links, products, onSave, disabled, label,
}: {
  links: UspLink[]
  products: MyProduct[]
  onSave: (links: UspLink[]) => Promise<void>
  disabled?: boolean
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<UspLink[]>(links)
  const [pid, setPid] = useState<number | null>(products[0]?.id ?? null)
  const [groups, setGroups] = useState<UspGroup[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setDraft(links)
      if (pid == null && products.length) setPid(products[0].id)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || pid == null) { setGroups([]); return }
    api.listUspGroups(pid).then(setGroups).catch(() => setGroups([]))
  }, [open, pid])

  const product = products.find(p => p.id === pid) || null
  const usps = product?.usps || []

  const has = (p: number, ui: number) => draft.some(l => l.product_id === p && l.usp_index === ui)
  const toggle = (p: number, ui: number) => {
    setDraft(prev => has(p, ui)
      ? prev.filter(l => !(l.product_id === p && l.usp_index === ui))
      : [...prev, { product_id: p, usp_index: ui }])
  }
  const applyGroup = (g: UspGroup) => {
    if (pid == null || g.usp_indexes.length === 0) return
    const allOn = g.usp_indexes.every(ui => has(pid, ui))
    setDraft(prev => {
      const others = prev.filter(l => !(l.product_id === pid && g.usp_indexes.includes(l.usp_index)))
      return allOn ? others
        : [...others, ...g.usp_indexes.map(ui => ({ product_id: pid as number, usp_index: ui }))]
    })
  }

  const linkLabel = (l: UspLink) => {
    const p = products.find(x => x.id === l.product_id)
    const u = p?.usps?.[l.usp_index - 1]
    return u?.usp || `USP#${l.usp_index}`
  }

  const save = async () => {
    setSaving(true)
    try { await onSave(draft); setOpen(false) }
    catch (e: any) { alert('USP 저장 실패: ' + (e?.message || e)) }
    finally { setSaving(false) }
  }

  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}
        style={{
          padding: '4px 10px', fontSize: 11, fontWeight: 600,
          background: 'transparent', color: 'var(--accent)',
          border: '1px solid var(--accent)', borderRadius: 4,
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        }}>
        {label || 'USP 연결'}{links.length > 0 ? ` (${links.length})` : ''}
      </button>

      {open && (
        <div onClick={() => !saving && setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 2000,
            background: 'rgba(0,0,0,0.45)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
          <div onClick={e => e.stopPropagation()}
            style={{
              width: 460, maxHeight: '80vh', overflowY: 'auto',
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 8, padding: 16, boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
            }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <strong style={{ fontSize: 14 }}>USP 연결</strong>
              <button onClick={() => !saving && setOpen(false)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--text-muted)', fontSize: 18 }}>×</button>
            </div>

            {products.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 16, textAlign: 'center' }}>
                상품이 없습니다. 먼저 내 상품을 등록하세요.
              </div>
            ) : (
              <>
                <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>상품</label>
                <select value={pid ?? ''} onChange={e => setPid(Number(e.target.value))}
                  style={{ width: '100%', marginTop: 4, marginBottom: 12, padding: '6px 8px',
                    fontSize: 12, border: '1px solid var(--border)', borderRadius: 6,
                    background: 'var(--bg-base)', color: 'var(--text-body)' }}>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>

                {groups.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>
                      USP 그룹 (클릭 시 멤버 일괄 선택)
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {groups.map(g => {
                        const allOn = g.usp_indexes.length > 0
                          && g.usp_indexes.every(ui => has(pid as number, ui))
                        return (
                          <button key={g.id} type="button" onClick={() => applyGroup(g)}
                            style={{
                              padding: '3px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                              borderRadius: 12, border: '1px solid var(--border)',
                              background: allOn ? (g.color || 'var(--accent)') : 'var(--bg-base)',
                              color: allOn ? '#fff' : 'var(--text-body)',
                            }}>
                            {g.name} ({g.usp_indexes.length})
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  USP 목록
                </div>
                {usps.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>
                    이 상품에 등록된 USP가 없습니다.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 4 }}>
                    {usps.map((u, i) => {
                      const ui = i + 1
                      const on = has(pid as number, ui)
                      return (
                        <label key={ui}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                            padding: '6px 8px', borderRadius: 6,
                            background: on ? 'var(--accent-light)' : 'var(--bg-base)',
                            border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                          }}>
                          <input type="checkbox" checked={on}
                            onChange={() => toggle(pid as number, ui)} />
                          <span style={{ fontSize: 12, color: 'var(--text-body)' }}>{u.usp}</span>
                        </label>
                      )
                    })}
                  </div>
                )}

                {draft.length > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>
                      선택됨 ({draft.length})
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {draft.map((l, i) => (
                        <span key={i}
                          style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                            background: 'var(--accent-light)', color: 'var(--accent)' }}>
                          {linkLabel(l)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={() => !saving && setOpen(false)}
                style={{ padding: '6px 14px', fontSize: 12, background: 'transparent',
                  color: 'var(--text-muted)', border: '1px solid var(--border)',
                  borderRadius: 6, cursor: 'pointer' }}>취소</button>
              <button onClick={save} disabled={saving}
                style={{ padding: '6px 14px', fontSize: 12, fontWeight: 700,
                  background: 'var(--accent)', color: '#fff', border: 'none',
                  borderRadius: 6, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 }}>
                {saving ? '저장 중…' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
