import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useMe } from '../auth'

type Script = {
  id: string
  product_id: number
  ref_shortcode: string | null
  source_type: string
  persona_name: string | null
  title: string
  meta: any
  created_at: string
  created_by?: string
  _shared?: boolean
  _permission?: 'view' | 'edit'
  _creator_name?: string
  _creator_email?: string
}

type Product = { id: number; name: string }

const sourceLabel: Record<string, string> = {
  insta: 'Instagram',
  youtube: 'YouTube',
  fb_ads: 'FB Ads',
}

export default function MyScripts() {
  const navigate = useNavigate()
  const me = useMe()
  const [products, setProducts] = useState<Product[]>([])
  const [scripts, setScripts] = useState<Script[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [productFilter, setProductFilter] = useState<number | 'all'>('all')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  // 상태 필터: 전체 / 대기 / 완료
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'done'>('all')
  // 그룹 필터: null=전체, '__unclassified__'=미분류, 그 외 group_name
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  const [savingMetaId, setSavingMetaId] = useState<string | null>(null)
  // 그룹 picker: 클릭한 카드의 script id (열려있을 때만 set)
  const [groupPickerSid, setGroupPickerSid] = useState<string | null>(null)
  const [newGroupInput, setNewGroupInput] = useState('')
  const [selected, setSelected] = useState<{ pid: number; sid: string; data: any } | null>(null)
  const [caption, setCaption] = useState('')
  const [captionExpanded, setCaptionExpanded] = useState(false)
  const [pinned, setPinned] = useState('')
  const [planUrl, setPlanUrl] = useState('')
  const [savingMeta, setSavingMeta] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSents, setDraftSents] = useState<any[]>([])
  const [savingEdit, setSavingEdit] = useState(false)
  const [shares, setShares] = useState<Awaited<ReturnType<typeof api.listScriptShares>>>([])
  const [shareTarget, setShareTarget] = useState('')
  const [sharePerm, setSharePerm] = useState<'view' | 'edit'>('view')
  const [shareBusy, setShareBusy] = useState(false)
  const [colleagues, setColleagues] = useState<Awaited<ReturnType<typeof api.listColleagues>>>([])

  const isMine = !!(selected && me && selected.data.created_by === me.id)

  useEffect(() => {
    api.listColleagues().then(setColleagues).catch(() => {})
  }, [])

  useEffect(() => {
    if (!groupPickerSid) return
    // setTimeout으로 한 tick 미루기 — 그렇지 않으면 picker를 여는 click이 곧바로 document 핸들러를 trigger해서 닫힘
    const t = setTimeout(() => {
      const onDocClick = () => setGroupPickerSid(null)
      document.addEventListener('click', onDocClick)
      ;(window as any).__gp_off = () => document.removeEventListener('click', onDocClick)
    }, 0)
    return () => {
      clearTimeout(t)
      ;(window as any).__gp_off?.()
    }
  }, [groupPickerSid])

  useEffect(() => {
    setLoading(true)
    api.listAllMyScripts()
      .then(r => {
        setProducts(r.products || [])
        setScripts(r.scripts || [])
      })
      .catch(e => setError(e.message || '불러오기 실패'))
      .finally(() => setLoading(false))
  }, [])

  const productById = useMemo(() => {
    const m = new Map<number, string>()
    for (const p of products) m.set(p.id, p.name)
    return m
  }, [products])

  const getStatus = (s: Script): 'pending' | 'done' => {
    const v = (s.meta?.status || 'pending').toString()
    return v === 'done' ? 'done' : 'pending'
  }
  const getGroup = (s: Script): string => (s.meta?.group_name || '').toString().trim()

  const filtered = useMemo(() => {
    return scripts.filter(s => {
      if (productFilter !== 'all' && s.product_id !== productFilter) return false
      if (sourceFilter !== 'all' && s.source_type !== sourceFilter) return false
      if (statusFilter !== 'all' && getStatus(s) !== statusFilter) return false
      if (groupFilter !== null) {
        const g = getGroup(s)
        if (groupFilter === '__unclassified__' && g) return false
        if (groupFilter !== '__unclassified__' && g !== groupFilter) return false
      }
      return true
    })
  }, [scripts, productFilter, sourceFilter, statusFilter, groupFilter])

  // 카운트 계산
  const counts = useMemo(() => {
    const base = scripts.filter(s => {
      if (productFilter !== 'all' && s.product_id !== productFilter) return false
      if (sourceFilter !== 'all' && s.source_type !== sourceFilter) return false
      return true
    })
    const pending = base.filter(s => getStatus(s) === 'pending').length
    const done = base.filter(s => getStatus(s) === 'done').length
    return { all: base.length, pending, done }
  }, [scripts, productFilter, sourceFilter])

  // 사용자가 만든 그룹 (unique group_name)
  const userGroups = useMemo(() => {
    const set = new Set<string>()
    scripts.forEach(s => {
      const g = getGroup(s)
      if (g) set.add(g)
    })
    return Array.from(set).sort()
  }, [scripts])

  const unclassifiedCount = useMemo(() => scripts.filter(s => !getGroup(s)).length, [scripts])
  const groupCount = (gname: string) => scripts.filter(s => getGroup(s) === gname).length

  const updateScriptMeta = async (s: Script, patch: { status?: 'pending' | 'done'; group_name?: string }) => {
    setSavingMetaId(s.id)
    try {
      await api.updateGenScript(s.product_id, s.id, patch)
      const newMeta = { ...(s.meta || {}), ...patch }
      setScripts(prev => prev.map(x => x.id === s.id ? { ...x, meta: newMeta } : x))
    } catch (e: any) {
      alert('상태 저장 실패: ' + (e.message || e))
    } finally {
      setSavingMetaId(null)
    }
  }

  const openScript = async (s: Script) => {
    try {
      const r = await api.getGenScript(s.product_id, s.id)
      setSelected({ pid: s.product_id, sid: s.id, data: r })
      setCaption((r as any).meta?.caption || '')
      setCaptionExpanded(false)
      setPinned((r as any).meta?.pinned_comment || '')
      setPlanUrl((r as any).meta?.shooting_plan_url || '')
      setEditing(false)
      setShareTarget('')
      // 본인 대본이면 공유 리스트 자동 로드
      if (me && r.created_by === me.id) {
        try {
          const list = await api.listScriptShares(s.product_id, s.id)
          setShares(list)
        } catch { setShares([]) }
      } else {
        setShares([])
      }
    } catch (e: any) {
      alert('불러오기 실패: ' + (e.message || e))
    }
  }

  const addShare = async () => {
    if (!selected || !shareTarget) return
    setShareBusy(true)
    try {
      await api.addScriptShare(selected.pid, selected.sid, { shared_with_id: shareTarget, permission: sharePerm })
      setShareTarget('')
      const list = await api.listScriptShares(selected.pid, selected.sid)
      setShares(list)
    } catch (e: any) {
      alert('공유 추가 실패: ' + (e.message || e))
    } finally {
      setShareBusy(false)
    }
  }

  const removeShare = async (share_id: string) => {
    if (!selected) return
    if (!confirm('이 공유를 제거할까요?')) return
    try {
      await api.deleteScriptShare(selected.pid, selected.sid, share_id)
      setShares(prev => prev.filter(s => s.id !== share_id))
    } catch (e: any) {
      alert('공유 제거 실패: ' + (e.message || e))
    }
  }

  const startEdit = () => {
    if (!selected) return
    setDraftTitle(selected.data.title || '')
    setDraftSents((selected.data.sentences || []).map((s: any) => ({ ...s })))
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraftSents([])
  }

  const saveEdit = async () => {
    if (!selected) return
    setSavingEdit(true)
    try {
      const resp = await api.updateGenScript(selected.pid, selected.sid, {
        title: draftTitle, sentences: draftSents,
      })
      // 백엔드 진짜 상태로 동기화 (부분 반영 의심 차단)
      const fresh = resp.row || { ...selected.data, title: draftTitle, sentences: draftSents }
      setSelected({ ...selected, data: { ...selected.data, ...fresh } })
      setScripts(prev => prev.map(s =>
        s.id === selected.sid ? { ...s, title: fresh.title || draftTitle } : s,
      ))
      setEditing(false)
    } catch (e: any) {
      alert('저장 실패: ' + (e.message || e))
    } finally {
      setSavingEdit(false)
    }
  }

  const saveCaptionPinned = async () => {
    if (!selected) return
    setSavingMeta(true)
    try {
      await api.updateGenScript(selected.pid, selected.sid, {
        caption, pinned_comment: pinned, shooting_plan_url: planUrl,
      })
      setSelected({
        ...selected,
        data: {
          ...selected.data,
          meta: { ...(selected.data.meta || {}), caption, pinned_comment: pinned, shooting_plan_url: planUrl },
        },
      })
    } catch (e: any) {
      alert('저장 실패: ' + (e.message || e))
    } finally {
      setSavingMeta(false)
    }
  }

  const deleteScript = async (s: Script) => {
    if (!confirm('이 대본을 삭제하시겠습니까?')) return
    try {
      await api.deleteGenScript(s.product_id, s.id)
      setScripts(prev => prev.filter(x => x.id !== s.id))
      if (selected?.sid === s.id) setSelected(null)
    } catch (e: any) {
      alert('삭제 실패: ' + (e.message || e))
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: 20 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 14 }}>저장된 대본</h2>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <select value={productFilter === 'all' ? 'all' : String(productFilter)}
          onChange={e => setProductFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          style={{ padding: '6px 10px', fontSize: 12, borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-body)' }}>
          <option value="all">전체 상품</option>
          {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
          style={{ padding: '6px 10px', fontSize: 12, borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-body)' }}>
          <option value="all">전체 플랫폼</option>
          <option value="insta">Instagram</option>
          <option value="youtube">YouTube</option>
          <option value="fb_ads">FB Ads</option>
        </select>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
          {filtered.length}개 / 전체 {scripts.length}개
        </div>
      </div>

      {/* 상태 필터 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginRight: 4 }}>상태:</span>
        {([
          ['all', '전체', counts.all],
          ['pending', '대기', counts.pending],
          ['done', '완료', counts.done],
        ] as const).map(([k, label, n]) => (
          <button key={k} type="button" onClick={() => setStatusFilter(k as any)}
            style={{
              padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              borderRadius: 6, border: '1px solid var(--border)',
              background: statusFilter === k ? 'var(--accent)' : 'var(--bg-surface)',
              color: statusFilter === k ? '#fff' : 'var(--text-body)',
            }}>
            {label} ({n})
          </button>
        ))}
      </div>

      {/* 그룹 필터 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginRight: 4 }}>그룹:</span>
        <button type="button" onClick={() => setGroupFilter(null)}
          style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
            borderRadius: 6, border: '1px solid var(--border)',
            background: groupFilter === null ? 'var(--accent)' : 'var(--bg-surface)',
            color: groupFilter === null ? '#fff' : 'var(--text-body)',
          }}>
          전체 ({scripts.length})
        </button>
        <button type="button" onClick={() => setGroupFilter('__unclassified__')}
          style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
            borderRadius: 6, border: '1px dashed var(--border)',
            background: groupFilter === '__unclassified__' ? 'var(--accent)' : 'var(--bg-surface)',
            color: groupFilter === '__unclassified__' ? '#fff' : 'var(--text-body)',
          }}>
          미분류 ({unclassifiedCount})
        </button>
        {userGroups.map(g => {
          const active = groupFilter === g
          return (
            <button key={g} type="button" onClick={() => setGroupFilter(active ? null : g)}
              style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                borderRadius: 6, border: '1px solid var(--border)',
                background: active ? 'var(--accent)' : 'var(--bg-surface)',
                color: active ? '#fff' : 'var(--text-body)',
              }}>
              {g} ({groupCount(g)})
            </button>
          )
        })}
        <button type="button"
          onClick={() => {
            const name = prompt('새 그룹 이름:')?.trim()
            if (!name) return
            // 그룹은 script에 할당될 때 생성됨 — 빈 그룹은 만들 수 없음. 사용자가 카드 클릭 후 "그룹 지정"으로 적용.
            setGroupFilter(name)
            alert(`"${name}" 그룹 필터 활성화. 아래 대본 카드의 "그룹 지정" 버튼으로 할당하세요.`)
          }}
          style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
            borderRadius: 6, border: '1px dashed var(--accent)',
            background: 'transparent', color: 'var(--accent)',
          }}>
          + 그룹 만들기
        </button>
      </div>

      {loading && <div style={{ color: 'var(--text-muted)' }}>불러오는 중…</div>}
      {error && <div style={{ color: 'var(--error)' }}>{error}</div>}
      {!loading && filtered.length === 0 && (
        <div style={{ color: 'var(--text-muted)', padding: 30, textAlign: 'center',
          background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border)' }}>
          저장된 대본이 없습니다. 대본 생성 후 결과 페이지에서 저장 클릭.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: 16 }}>
        <div style={{ display: 'grid', gap: 8 }}>
          {filtered.map(s => (
            <div key={s.id}
              onClick={() => navigate(`/my-scripts/${s.product_id}/${s.id}`)}
              style={{
                background: selected?.sid === s.id ? 'var(--accent-light)' : 'var(--bg-surface)',
                border: `1px solid ${selected?.sid === s.id ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-md)', padding: 12,
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
              }}>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '2px 8px',
                background: 'var(--bg-elevated)', borderRadius: 4, color: 'var(--text-secondary)',
              }}>{sourceLabel[s.source_type] || s.source_type}</span>
              {/* 상태 토글 — 클릭 시 대기 ↔ 완료 */}
              {(() => {
                const st = getStatus(s)
                const isDone = st === 'done'
                return (
                  <button type="button"
                    disabled={savingMetaId === s.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      updateScriptMeta(s, { status: isDone ? 'pending' : 'done' })
                    }}
                    style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 8px',
                      background: isDone ? 'var(--success, #10b981)' : 'var(--warning, #f59e0b)',
                      color: '#fff', border: 'none', borderRadius: 4,
                      cursor: 'pointer', opacity: savingMetaId === s.id ? 0.5 : 1,
                    }}>
                    {isDone ? '완료' : '대기'}
                  </button>
                )
              })()}
              {/* 그룹 라벨 + picker */}
              {(() => {
                const g = getGroup(s)
                const isOpen = groupPickerSid === s.id
                return (
                  <div style={{ position: 'relative' }}>
                    <button type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setGroupPickerSid(isOpen ? null : s.id)
                        setNewGroupInput('')
                      }}
                      style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 8px',
                        background: g ? 'var(--accent-light)' : 'transparent',
                        color: g ? 'var(--accent)' : 'var(--text-muted)',
                        border: `1px ${g ? 'solid' : 'dashed'} var(--border)`,
                        borderRadius: 4, cursor: 'pointer',
                      }}>
                      {g || '+ 그룹'}
                    </button>
                    {isOpen && (
                      <div onClick={e => e.stopPropagation()}
                        style={{
                          position: 'absolute', top: '100%', left: 0, marginTop: 4,
                          minWidth: 200, zIndex: 100,
                          background: 'var(--bg-surface)', border: '1px solid var(--border)',
                          borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                          padding: 6,
                        }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
                          padding: '4px 8px' }}>그룹 선택</div>
                        <button type="button"
                          onClick={() => {
                            updateScriptMeta(s, { group_name: '' })
                            setGroupPickerSid(null)
                          }}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left',
                            padding: '6px 8px', fontSize: 11, fontWeight: g === '' ? 700 : 500,
                            background: !g ? 'var(--accent-light)' : 'transparent',
                            color: !g ? 'var(--accent)' : 'var(--text-body)',
                            border: 'none', borderRadius: 4, cursor: 'pointer',
                          }}>미분류</button>
                        {userGroups.map(gn => (
                          <button key={gn} type="button"
                            onClick={() => {
                              updateScriptMeta(s, { group_name: gn })
                              setGroupPickerSid(null)
                            }}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left',
                              padding: '6px 8px', fontSize: 11, fontWeight: g === gn ? 700 : 500,
                              background: g === gn ? 'var(--accent-light)' : 'transparent',
                              color: g === gn ? 'var(--accent)' : 'var(--text-body)',
                              border: 'none', borderRadius: 4, cursor: 'pointer',
                            }}>{gn}</button>
                        ))}
                        <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <input
                              type="text"
                              value={newGroupInput}
                              onChange={e => setNewGroupInput(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  const v = newGroupInput.trim()
                                  if (v) {
                                    updateScriptMeta(s, { group_name: v })
                                    setGroupPickerSid(null)
                                  }
                                }
                              }}
                              placeholder="새 그룹 이름"
                              style={{
                                flex: 1, padding: '4px 6px', fontSize: 11,
                                border: '1px solid var(--border)', borderRadius: 4,
                                background: 'var(--bg-base)', color: 'var(--text-body)',
                              }}
                            />
                            <button type="button"
                              onClick={() => {
                                const v = newGroupInput.trim()
                                if (v) {
                                  updateScriptMeta(s, { group_name: v })
                                  setGroupPickerSid(null)
                                }
                              }}
                              disabled={!newGroupInput.trim()}
                              style={{
                                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                                background: 'var(--accent)', color: '#fff', border: 'none',
                                borderRadius: 4, cursor: newGroupInput.trim() ? 'pointer' : 'not-allowed',
                                opacity: newGroupInput.trim() ? 1 : 0.5,
                              }}>+</button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })()}
              {s._shared && (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 8px',
                  background: 'var(--accent-light)', borderRadius: 4, color: 'var(--accent)',
                  border: '1px solid var(--accent)',
                }}>공유받음 ({s._permission === 'edit' ? '편집' : '보기'})</span>
              )}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{s.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                    {productById.get(s.product_id) || `상품 #${s.product_id}`}
                  </span>
                  {' · '}
                  {s.persona_name && <span>{s.persona_name} · </span>}
                  {s.ref_shortcode && <span>ref: {s.ref_shortcode} · </span>}
                  {s._shared && (s._creator_name || s._creator_email) && (
                    <span style={{ color: 'var(--accent)' }}>
                      {s._creator_name || s._creator_email} ·{' '}
                    </span>
                  )}
                  {new Date(s.created_at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}
                </div>
              </div>
              <button onClick={(e) => { e.stopPropagation(); navigate(`/my-products/${s.product_id}/edit`) }}
                style={{
                  padding: '4px 10px', fontSize: 11, fontWeight: 500,
                  border: '1px solid var(--border)', borderRadius: 4,
                  background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
                }}>상품</button>
              <button onClick={(e) => { e.stopPropagation(); deleteScript(s) }}
                style={{
                  padding: '4px 10px', fontSize: 11, fontWeight: 600,
                  border: '1px solid var(--error)', borderRadius: 4,
                  background: 'transparent', color: 'var(--error)', cursor: 'pointer',
                }}>삭제</button>
            </div>
          ))}
        </div>

        {selected && (
          <div style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 14, maxHeight: '75vh', overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              {editing ? (
                <input
                  value={draftTitle}
                  onChange={e => setDraftTitle(e.target.value)}
                  style={{ flex: 1, padding: '4px 8px', fontSize: 14, fontWeight: 700,
                    border: '1px solid var(--accent)', borderRadius: 4,
                    background: 'var(--bg-base)', color: 'var(--text-primary)' }}
                />
              ) : (
                <strong style={{ fontSize: 14, flex: 1 }}>{selected.data.title}</strong>
              )}
              {editing ? (
                <>
                  <button onClick={saveEdit} disabled={savingEdit}
                    style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600,
                      background: 'var(--accent)', color: '#fff', border: 'none',
                      borderRadius: 4, cursor: savingEdit ? 'wait' : 'pointer', opacity: savingEdit ? 0.7 : 1 }}>
                    {savingEdit ? '저장 중…' : '저장'}
                  </button>
                  <button onClick={cancelEdit}
                    style={{ padding: '4px 10px', fontSize: 11,
                      background: 'transparent', color: 'var(--text-muted)',
                      border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>취소</button>
                </>
              ) : (
                <>
                  <button onClick={startEdit}
                    style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600,
                      background: 'transparent', color: 'var(--accent)',
                      border: '1px solid var(--accent)', borderRadius: 4, cursor: 'pointer' }}>
                    수정
                  </button>
                </>
              )}
              <button onClick={() => setSelected(null)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>닫기</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                {productById.get(selected.pid) || `상품 #${selected.pid}`}
              </span>
              {' · '}
              {(selected.data._creator_name || selected.data._creator_email) && (
                <span style={{ color: 'var(--accent)' }}>
                  기획: {selected.data._creator_name || selected.data._creator_email} ·{' '}
                </span>
              )}
              {selected.data.persona_name && <span>{selected.data.persona_name} · </span>}
              {selected.data.ref_shortcode && <span>ref: {selected.data.ref_shortcode} · </span>}
              {selected.data.meta?.duration_target_sec && <span>{selected.data.meta.duration_target_sec}초 · </span>}
              {selected.data.meta?._cost?.total_cost_usd && <span>${selected.data.meta._cost.total_cost_usd}</span>}
            </div>
            <div style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
              {(editing ? draftSents : (selected.data.sentences || [])).map((s: any, i: number) => (
                <div key={i} style={{ fontSize: 12, lineHeight: 1.6,
                  padding: '6px 10px', background: 'var(--bg-base)', borderRadius: 4,
                  display: editing ? 'flex' : 'block', alignItems: 'flex-start', gap: 6,
                }}>
                  <div style={{ flex: 1 }}>
                    {s.direction && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', marginRight: 6 }}>
                        ({s.direction})
                      </span>
                    )}
                    {editing ? (
                      <textarea
                        value={s.text || ''}
                        onChange={e => setDraftSents(prev => prev.map((x, j) => j === i ? { ...x, text: e.target.value } : x))}
                        rows={Math.max(1, Math.ceil((s.text || '').length / 38))}
                        style={{ width: '100%', padding: '4px 8px', fontSize: 12, lineHeight: 1.5,
                          border: '1px solid var(--border)', borderRadius: 4,
                          background: 'transparent', color: 'var(--text-body)',
                          resize: 'vertical', fontFamily: 'inherit', marginTop: 4 }}
                      />
                    ) : s.text}
                  </div>
                  {editing && (
                    <button
                      onClick={() => setDraftSents(prev => prev.filter((_, j) => j !== i))}
                      title="이 문장 삭제"
                      style={{ flexShrink: 0, padding: '2px 8px', fontSize: 11, fontWeight: 600,
                        background: 'transparent', color: 'var(--error)',
                        border: '1px solid var(--error)', borderRadius: 4, cursor: 'pointer' }}>
                      삭제
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                캡션
              </label>
              <textarea
                value={caption}
                onChange={e => setCaption(e.target.value)}
                placeholder="영상 업로드 시 본문에 들어갈 캡션 (해시태그 포함)"
                rows={captionExpanded ? 20 : 4}
                style={{
                  width: '100%', padding: '8px 10px', fontSize: 12, lineHeight: 1.5,
                  border: '1px solid var(--border)', borderRadius: 6,
                  background: 'var(--bg-base)', color: 'var(--text-body)',
                  resize: 'vertical', fontFamily: 'inherit', marginBottom: 4,
                }}
              />
              {caption.length > 180 && (
                <button
                  onClick={() => setCaptionExpanded(v => !v)}
                  style={{
                    display: 'block', marginLeft: 'auto', marginBottom: 10,
                    padding: '2px 10px', fontSize: 11, fontWeight: 600,
                    background: 'transparent', color: 'var(--accent)',
                    border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
                  }}>
                  {captionExpanded ? '▲ 접기' : '▼ 더보기'}
                </button>
              )}
              {caption.length <= 180 && <div style={{ marginBottom: 8 }} />}

              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                고정댓글
              </label>
              <textarea
                value={pinned}
                onChange={e => setPinned(e.target.value)}
                placeholder="댓글창 상단에 고정될 댓글 (CTA, 링크 등)"
                rows={3}
                style={{
                  width: '100%', padding: '8px 10px', fontSize: 12, lineHeight: 1.5,
                  border: '1px solid var(--border)', borderRadius: 6,
                  background: 'var(--bg-base)', color: 'var(--text-body)',
                  resize: 'vertical', fontFamily: 'inherit', marginBottom: 12,
                }}
              />

              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                촬영기획안 링크
              </label>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                <input
                  type="url"
                  value={planUrl}
                  onChange={e => setPlanUrl(e.target.value)}
                  placeholder="https://… (Notion/Drive/문서 링크)"
                  style={{ flex: 1, padding: '8px 10px', fontSize: 12,
                    border: '1px solid var(--border)', borderRadius: 6,
                    background: 'var(--bg-base)', color: 'var(--text-body)' }}
                />
                {planUrl && (
                  <a href={planUrl} target="_blank" rel="noopener noreferrer"
                    style={{ padding: '8px 12px', fontSize: 12, fontWeight: 600,
                      background: 'var(--bg-elevated)', color: 'var(--accent)',
                      border: '1px solid var(--border)', borderRadius: 6,
                      textDecoration: 'none', whiteSpace: 'nowrap' }}>↗ 열기</a>
                )}
              </div>

              <button
                onClick={saveCaptionPinned}
                disabled={savingMeta}
                style={{
                  padding: '8px 16px', fontSize: 12, fontWeight: 600,
                  background: 'var(--accent)', color: '#fff', border: 'none',
                  borderRadius: 6, cursor: savingMeta ? 'wait' : 'pointer',
                  opacity: savingMeta ? 0.7 : 1,
                }}>
                {savingMeta ? '저장 중…' : '캡션/고정댓글/촬영기획안 저장'}
              </button>
            </div>

            {isMine && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  공유 ({shares.length}명)
                </div>
                {shares.length > 0 && (
                  <div style={{ display: 'grid', gap: 4, marginBottom: 10 }}>
                    {shares.map(s => (
                      <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center',
                        padding: '6px 10px', background: 'var(--bg-base)', borderRadius: 4, fontSize: 11 }}>
                        <span style={{ flex: 1 }}>{s.shared_with_name || s.shared_with_email || s.shared_with_id}</span>
                        <span style={{
                          padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                          background: s.permission === 'edit' ? 'var(--accent)' : 'var(--bg-elevated)',
                          color: s.permission === 'edit' ? '#fff' : 'var(--text-secondary)',
                        }}>{s.permission === 'edit' ? '편집' : '보기'}</span>
                        <button onClick={() => removeShare(s.id)}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                            color: 'var(--error)', fontSize: 11 }}>제거</button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <select
                    value={shareTarget}
                    onChange={e => setShareTarget(e.target.value)}
                    style={{ flex: 1, padding: '6px 10px', fontSize: 11,
                      border: '1px solid var(--border)', borderRadius: 4,
                      background: 'var(--bg-base)', color: 'var(--text-body)' }}>
                    <option value="">공유받을 회원 선택</option>
                    {colleagues
                      .filter(c => !shares.some(s => s.shared_with_id === c.id))
                      .map(c => (
                        <option key={c.id} value={c.id}>
                          {c.display_name || c.email}
                        </option>
                      ))}
                  </select>
                  <select value={sharePerm} onChange={e => setSharePerm(e.target.value as 'view' | 'edit')}
                    style={{ padding: '6px 8px', fontSize: 11,
                      border: '1px solid var(--border)', borderRadius: 4,
                      background: 'var(--bg-base)', color: 'var(--text-body)' }}>
                    <option value="view">보기</option>
                    <option value="edit">편집</option>
                  </select>
                  <button onClick={addShare} disabled={shareBusy || !shareTarget}
                    style={{ padding: '6px 12px', fontSize: 11, fontWeight: 600,
                      background: 'var(--accent)', color: '#fff', border: 'none',
                      borderRadius: 4, cursor: shareBusy ? 'wait' : 'pointer',
                      opacity: shareBusy || !shareTarget ? 0.5 : 1 }}>
                    공유 추가
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
