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

// 작업 상태 4종 — 백엔드 _SCRIPT_STATUSES와 동일
type ScriptStatus = 'pending' | 'in_progress' | 'done' | 'hold'
const STATUSES: { value: ScriptStatus; label: string; bg: string }[] = [
  { value: 'pending', label: '대기', bg: '#9ca3af' },
  { value: 'in_progress', label: '진행', bg: '#3b82f6' },
  { value: 'done', label: '완료', bg: '#10b981' },
  { value: 'hold', label: '보류', bg: '#f59e0b' },
]
const STATUS_BG: Record<string, string> = Object.fromEntries(STATUSES.map(s => [s.value, s.bg]))
const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUSES.map(s => [s.value, s.label]))

// 제작 단계 6종 — 백엔드 _SCRIPT_STAGES와 동일 (대본→TTS→기획→소스→편집→업로드)
type WorkStage = 'script' | 'tts' | 'plan' | 'source' | 'edit' | 'upload'
const STAGES: { value: WorkStage; label: string }[] = [
  { value: 'script', label: '대본' },
  { value: 'tts', label: 'TTS' },
  { value: 'plan', label: '기획' },
  { value: 'source', label: '소스' },
  { value: 'edit', label: '편집' },
  { value: 'upload', label: '업로드' },
]
const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES.map(s => [s.value, s.label]))

export default function MyScripts() {
  const navigate = useNavigate()
  const me = useMe()
  const [products, setProducts] = useState<Product[]>([])
  const [scripts, setScripts] = useState<Script[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [productFilter, setProductFilter] = useState<number | 'all'>('all')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  // 상태 필터: 전체 / 대기 / 진행 / 완료 / 보류
  const [statusFilter, setStatusFilter] = useState<'all' | ScriptStatus>('all')
  // 단계 필터: null=전체, 그 외 WorkStage
  const [stageFilter, setStageFilter] = useState<WorkStage | null>(null)
  // 그룹 필터: null=전체, '__unclassified__'=미분류, 그 외 group_name
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  // 새로 생성했지만 아직 어떤 대본에도 할당되지 않은 그룹 (만들자마자 칩으로 보이도록 임시 유지)
  const [pendingGroups, setPendingGroups] = useState<string[]>([])
  const [savingMetaId, setSavingMetaId] = useState<string | null>(null)
  // 인라인 제목 수정 — 편집 중인 카드의 script id (열려있을 때만 set)
  const [titleEditSid, setTitleEditSid] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [savingTitleId, setSavingTitleId] = useState<string | null>(null)
  // 그룹/상태/단계 picker: 클릭한 카드의 script id (열려있을 때만 set)
  const [groupPickerSid, setGroupPickerSid] = useState<string | null>(null)
  const [statusPickerSid, setStatusPickerSid] = useState<string | null>(null)
  const [stagePickerSid, setStagePickerSid] = useState<string | null>(null)
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

  const getStatus = (s: Script): ScriptStatus => {
    const v = (s.meta?.status || 'pending').toString()
    return (STATUS_LABEL[v] ? v : 'pending') as ScriptStatus
  }
  const getStage = (s: Script): WorkStage | '' => {
    const v = (s.meta?.work_stage || '').toString()
    return (STAGE_LABEL[v] ? v : '') as WorkStage | ''
  }
  const getGroup = (s: Script): string => (s.meta?.group_name || '').toString().trim()

  const filtered = useMemo(() => {
    return scripts.filter(s => {
      if (productFilter !== 'all' && s.product_id !== productFilter) return false
      if (sourceFilter !== 'all' && s.source_type !== sourceFilter) return false
      if (statusFilter !== 'all' && getStatus(s) !== statusFilter) return false
      if (stageFilter !== null && getStage(s) !== stageFilter) return false
      if (groupFilter !== null) {
        const g = getGroup(s)
        if (groupFilter === '__unclassified__' && g) return false
        if (groupFilter !== '__unclassified__' && g !== groupFilter) return false
      }
      return true
    }).sort((a, b) => {
      const ta = new Date(a.created_at).getTime()
      const tb = new Date(b.created_at).getTime()
      return tb - ta
    })
  }, [scripts, productFilter, sourceFilter, statusFilter, stageFilter, groupFilter])

  // 상태별 카운트
  const counts = useMemo(() => {
    const base = scripts.filter(s => {
      if (productFilter !== 'all' && s.product_id !== productFilter) return false
      if (sourceFilter !== 'all' && s.source_type !== sourceFilter) return false
      return true
    })
    const byStatus: Record<string, number> = { all: base.length }
    for (const st of STATUSES) byStatus[st.value] = base.filter(s => getStatus(s) === st.value).length
    return byStatus
  }, [scripts, productFilter, sourceFilter])

  // 단계별 카운트
  const stageCounts = useMemo(() => {
    const base = scripts.filter(s => {
      if (productFilter !== 'all' && s.product_id !== productFilter) return false
      if (sourceFilter !== 'all' && s.source_type !== sourceFilter) return false
      return true
    })
    const m: Record<string, number> = {}
    for (const st of STAGES) m[st.value] = base.filter(s => getStage(s) === st.value).length
    return m
  }, [scripts, productFilter, sourceFilter])

  // 사용자가 만든 그룹 (unique group_name) — 실제 할당된 + pending
  const userGroups = useMemo(() => {
    const set = new Set<string>()
    scripts.forEach(s => {
      const g = getGroup(s)
      if (g) set.add(g)
    })
    pendingGroups.forEach(g => set.add(g))
    return Array.from(set).sort()
  }, [scripts, pendingGroups])

  const unclassifiedCount = useMemo(() => scripts.filter(s => !getGroup(s)).length, [scripts])
  const groupCount = (gname: string) => scripts.filter(s => getGroup(s) === gname).length

  // 그룹 일괄 이름 변경 — 해당 그룹의 모든 대본을 새 이름으로 update
  const renameGroup = async (oldName: string, newName: string) => {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName) return
    const targets = scripts.filter(s => getGroup(s) === oldName)
    try {
      // 미할당(pending) 그룹이면 API 호출 없이 이름만 교체
      if (targets.length === 0) {
        setPendingGroups(prev => {
          const filtered = prev.filter(g => g !== oldName)
          return filtered.includes(trimmed) ? filtered : [...filtered, trimmed]
        })
      } else {
        await Promise.all(targets.map(s =>
          api.updateGenScript(s.product_id, s.id, { group_name: trimmed }),
        ))
        setScripts(prev => prev.map(s =>
          getGroup(s) === oldName
            ? { ...s, meta: { ...(s.meta || {}), group_name: trimmed } }
            : s,
        ))
        setPendingGroups(prev => prev.filter(g => g !== oldName && g !== trimmed))
      }
      if (groupFilter === oldName) setGroupFilter(trimmed)
    } catch (e: any) {
      alert('그룹 이름 변경 실패: ' + (e.message || e))
    }
  }

  // 그룹 삭제 — 그룹에 속한 모든 대본을 미분류로 만들고 chip 제거 (대본 자체는 유지)
  const deleteGroup = async (name: string) => {
    const targets = scripts.filter(s => getGroup(s) === name)
    if (!confirm(`"${name}" 그룹을 삭제할까요? (대본 ${targets.length}개는 미분류로 이동)`)) return
    try {
      if (targets.length > 0) {
        await Promise.all(targets.map(s =>
          api.updateGenScript(s.product_id, s.id, { group_name: '' }),
        ))
        setScripts(prev => prev.map(s => {
          if (getGroup(s) !== name) return s
          const m = { ...(s.meta || {}) }
          delete m.group_name
          return { ...s, meta: m }
        }))
      }
      setPendingGroups(prev => prev.filter(g => g !== name))
      if (groupFilter === name) setGroupFilter(null)
    } catch (e: any) {
      alert('그룹 삭제 실패: ' + (e.message || e))
    }
  }

  const saveTitle = async (s: Script) => {
    const newTitle = titleDraft.trim()
    if (!newTitle || newTitle === s.title) {
      setTitleEditSid(null)
      return
    }
    setSavingTitleId(s.id)
    try {
      await api.updateGenScript(s.product_id, s.id, { title: newTitle })
      setScripts(prev => prev.map(x => x.id === s.id ? { ...x, title: newTitle } : x))
      setTitleEditSid(null)
    } catch (e: any) {
      alert('제목 저장 실패: ' + (e.message || e))
    } finally {
      setSavingTitleId(null)
    }
  }

  const updateScriptMeta = async (s: Script, patch: { status?: ScriptStatus; work_stage?: string; group_name?: string }) => {
    setSavingMetaId(s.id)
    try {
      await api.updateGenScript(s.product_id, s.id, patch)
      const newMeta = { ...(s.meta || {}), ...patch }
      setScripts(prev => prev.map(x => x.id === s.id ? { ...x, meta: newMeta } : x))
      // 할당된 그룹은 이제 실제 데이터로 존재하므로 pending에서 제거
      if (patch.group_name) {
        const gn = patch.group_name
        setPendingGroups(prev => prev.filter(g => g !== gn))
      }
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

      {/* 상태 필터 — 대기/진행/완료/보류 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginRight: 4 }}>상태:</span>
        {[{ k: 'all' as const, label: '전체' }, ...STATUSES.map(st => ({ k: st.value, label: st.label }))].map(({ k, label }) => (
          <button key={k} type="button" onClick={() => setStatusFilter(k)}
            style={{
              padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              borderRadius: 6, border: '1px solid var(--border)',
              background: statusFilter === k
                ? (k === 'all' ? 'var(--accent)' : STATUS_BG[k])
                : 'var(--bg-surface)',
              color: statusFilter === k ? '#fff' : 'var(--text-body)',
            }}>
            {label} ({k === 'all' ? counts.all : (counts[k] || 0)})
          </button>
        ))}
      </div>

      {/* 단계 필터 — 대본→TTS→기획→소스→편집→업로드 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginRight: 4 }}>단계:</span>
        <button type="button" onClick={() => setStageFilter(null)}
          style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
            borderRadius: 6, border: '1px solid var(--border)',
            background: stageFilter === null ? 'var(--accent)' : 'var(--bg-surface)',
            color: stageFilter === null ? '#fff' : 'var(--text-body)',
          }}>
          전체
        </button>
        {STAGES.map(st => (
          <button key={st.value} type="button"
            onClick={() => setStageFilter(stageFilter === st.value ? null : st.value)}
            style={{
              padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              borderRadius: 6, border: '1px solid var(--border)',
              background: stageFilter === st.value ? 'var(--accent)' : 'var(--bg-surface)',
              color: stageFilter === st.value ? '#fff' : 'var(--text-body)',
            }}>
            {st.label} ({stageCounts[st.value] || 0})
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
            <div key={g} style={{
              display: 'inline-flex', alignItems: 'stretch',
              borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden',
              background: active ? 'var(--accent)' : 'var(--bg-surface)',
            }}>
              <button type="button" onClick={() => setGroupFilter(active ? null : g)}
                style={{
                  padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  border: 'none', background: 'transparent',
                  color: active ? '#fff' : 'var(--text-body)',
                }}>
                {g} ({groupCount(g)})
              </button>
              <button type="button"
                title="그룹 이름 변경"
                onClick={() => {
                  const next = prompt(`"${g}" 그룹의 새 이름:`, g)
                  if (next != null) renameGroup(g, next)
                }}
                style={{
                  padding: '4px 6px', fontSize: 10, cursor: 'pointer',
                  border: 'none', borderLeft: '1px solid var(--border)',
                  background: 'transparent',
                  color: active ? '#fff' : 'var(--text-muted)',
                }}>✎</button>
              <button type="button"
                title="그룹 삭제"
                onClick={() => deleteGroup(g)}
                style={{
                  padding: '4px 6px', fontSize: 10, cursor: 'pointer',
                  border: 'none', borderLeft: '1px solid var(--border)',
                  background: 'transparent',
                  color: active ? '#fff' : 'var(--text-muted)',
                }}>✕</button>
            </div>
          )
        })}
        <button type="button"
          onClick={() => {
            const name = prompt('새 그룹 이름:')?.trim()
            if (!name) return
            // 즉시 칩으로 노출하고, 필터는 켜지 않음 (할당 전이라 비어 있으면 혼란스러움).
            // 어느 대본에든 실제 할당되면 pendingGroups에서 자동 제거됨.
            setPendingGroups(prev => prev.includes(name) ? prev : [...prev, name])
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
              onClick={() => {
                if (titleEditSid === s.id) return
                navigate(`/my-scripts/${s.product_id}/${s.id}`)
              }}
              style={{
                background: selected?.sid === s.id ? 'var(--accent-light)' : 'var(--bg-surface)',
                border: `1px solid ${selected?.sid === s.id ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-md)', padding: 12,
                cursor: titleEditSid === s.id ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '2px 8px',
                background: 'var(--bg-elevated)', borderRadius: 4, color: 'var(--text-secondary)',
              }}>{sourceLabel[s.source_type] || s.source_type}</span>
              {/* 상태 picker — 대기/진행/완료/보류 */}
              {(() => {
                const st = getStatus(s)
                const isOpen = statusPickerSid === s.id
                return (
                  <div style={{ position: 'relative' }}>
                    <button type="button"
                      disabled={savingMetaId === s.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        setStatusPickerSid(isOpen ? null : s.id)
                        setGroupPickerSid(null); setStagePickerSid(null)
                      }}
                      style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 8px',
                        background: STATUS_BG[st], color: '#fff', border: 'none', borderRadius: 4,
                        cursor: 'pointer', opacity: savingMetaId === s.id ? 0.5 : 1,
                      }}>
                      {STATUS_LABEL[st]} ▾
                    </button>
                    {isOpen && (
                      <div onClick={e => e.stopPropagation()}
                        style={{
                          position: 'absolute', top: '100%', left: 0, marginTop: 4,
                          minWidth: 130, zIndex: 100,
                          background: 'var(--bg-surface)', border: '1px solid var(--border)',
                          borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 6,
                        }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', padding: '4px 8px' }}>
                          작업 상태
                        </div>
                        {STATUSES.map(opt => (
                          <button key={opt.value} type="button"
                            onClick={() => { updateScriptMeta(s, { status: opt.value }); setStatusPickerSid(null) }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                              padding: '6px 8px', fontSize: 11, fontWeight: opt.value === st ? 700 : 500,
                              background: opt.value === st ? 'var(--bg-elevated)' : 'transparent',
                              color: 'var(--text-body)', border: 'none', borderRadius: 4, cursor: 'pointer',
                            }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: opt.bg, flexShrink: 0 }} />
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })()}
              {/* 단계 picker — 대본/TTS/기획/소스/편집/업로드 */}
              {(() => {
                const stg = getStage(s)
                const isOpen = stagePickerSid === s.id
                return (
                  <div style={{ position: 'relative' }}>
                    <button type="button"
                      disabled={savingMetaId === s.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        setStagePickerSid(isOpen ? null : s.id)
                        setGroupPickerSid(null); setStatusPickerSid(null)
                      }}
                      style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 8px',
                        background: stg ? 'rgba(124,58,237,0.12)' : 'transparent',
                        color: stg ? '#7c3aed' : 'var(--text-muted)',
                        border: `1px ${stg ? 'solid' : 'dashed'} var(--border)`,
                        borderRadius: 4, cursor: 'pointer', opacity: savingMetaId === s.id ? 0.5 : 1,
                      }}>
                      {stg ? STAGE_LABEL[stg] : '+ 단계'}
                    </button>
                    {isOpen && (
                      <div onClick={e => e.stopPropagation()}
                        style={{
                          position: 'absolute', top: '100%', left: 0, marginTop: 4,
                          minWidth: 130, zIndex: 100,
                          background: 'var(--bg-surface)', border: '1px solid var(--border)',
                          borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 6,
                        }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', padding: '4px 8px' }}>
                          제작 단계
                        </div>
                        <button type="button"
                          onClick={() => { updateScriptMeta(s, { work_stage: '' }); setStagePickerSid(null) }}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left',
                            padding: '6px 8px', fontSize: 11, fontWeight: !stg ? 700 : 500,
                            background: !stg ? 'var(--bg-elevated)' : 'transparent',
                            color: 'var(--text-body)', border: 'none', borderRadius: 4, cursor: 'pointer',
                          }}>미지정</button>
                        {STAGES.map((opt, i) => (
                          <button key={opt.value} type="button"
                            onClick={() => { updateScriptMeta(s, { work_stage: opt.value }); setStagePickerSid(null) }}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left',
                              padding: '6px 8px', fontSize: 11, fontWeight: opt.value === stg ? 700 : 500,
                              background: opt.value === stg ? 'var(--bg-elevated)' : 'transparent',
                              color: 'var(--text-body)', border: 'none', borderRadius: 4, cursor: 'pointer',
                            }}>
                            {i + 1}. {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
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
                        setStatusPickerSid(null); setStagePickerSid(null)
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
              <div style={{ flex: 1, minWidth: 0 }}>
                {titleEditSid === s.id ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                    <input
                      autoFocus
                      type="text"
                      value={titleDraft}
                      onChange={e => setTitleDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); saveTitle(s) }
                        else if (e.key === 'Escape') { e.preventDefault(); setTitleEditSid(null) }
                      }}
                      disabled={savingTitleId === s.id}
                      style={{
                        flex: 1, padding: '4px 8px', fontSize: 13, fontWeight: 600,
                        border: '1px solid var(--accent)', borderRadius: 4,
                        background: 'var(--bg-base)', color: 'var(--text-primary)',
                      }}
                    />
                    <button type="button"
                      onClick={e => { e.stopPropagation(); saveTitle(s) }}
                      disabled={savingTitleId === s.id}
                      style={{
                        padding: '4px 10px', fontSize: 11, fontWeight: 600,
                        background: 'var(--accent)', color: '#fff', border: 'none',
                        borderRadius: 4, cursor: savingTitleId === s.id ? 'wait' : 'pointer',
                        opacity: savingTitleId === s.id ? 0.7 : 1,
                      }}>{savingTitleId === s.id ? '저장중…' : '저장'}</button>
                    <button type="button"
                      onClick={e => { e.stopPropagation(); setTitleEditSid(null) }}
                      style={{
                        padding: '4px 10px', fontSize: 11,
                        background: 'transparent', color: 'var(--text-muted)',
                        border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
                      }}>취소</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title}
                    </div>
                    <button type="button"
                      title="제목 수정"
                      onClick={e => {
                        e.stopPropagation()
                        setTitleEditSid(s.id)
                        setTitleDraft(s.title || '')
                      }}
                      style={{
                        padding: '2px 6px', fontSize: 10, fontWeight: 600,
                        background: 'transparent', color: 'var(--text-muted)',
                        border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
                        flexShrink: 0,
                      }}>✎</button>
                  </div>
                )}
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
