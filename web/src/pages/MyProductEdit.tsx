import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import type { MyProduct } from '../api'

interface USPItem { usp: string; description?: string; reviews: string[] }
interface SocialProofItem { type: string; label: string; value: string; evidence?: string }

const SP_TYPES: { key: string; label: string; placeholder: string }[] = [
  { key: 'sales_volume', label: '매출/판매량', placeholder: '예: 누적 100억, 월 1억원' },
  { key: 'review_volume', label: '후기/재구매', placeholder: '예: 후기 5천 개, 재구매율 80%' },
  { key: 'rating', label: '평점', placeholder: '예: 별점 4.9, 만점' },
  { key: 'authority', label: '권위/추천', placeholder: '예: BTS 사용, 의사 추천' },
  { key: 'scarcity', label: '품절/랭킹', placeholder: '예: 베스트 1위, 5번째 리오더' },
  { key: 'award', label: '수상/인증', placeholder: '예: FDA 승인, 올해의 OO' },
  { key: 'personal', label: '본인 사용 (약함)', placeholder: '예: 5년째 사용 중' },
]

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
function invalidateCache() {
  try { sessionStorage.removeItem(CACHE_KEY) } catch {}
}

export default function MyProductEdit() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const isNew = !id || id === 'new'
  const productId = isNew ? null : Number(id)

  const [name, setName] = useState('')
  const [usps, setUsps] = useState<USPItem[]>([{ usp: '', reviews: [''] }])
  const [socialProof, setSocialProof] = useState<SocialProofItem[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(!isNew)
  const [original, setOriginal] = useState<MyProduct | null>(null)

  const [collectorText, setCollectorText] = useState('')
  const [collectorUspIndex, setCollectorUspIndex] = useState(0)
  const [replaceFrom, setReplaceFrom] = useState('트립쿠폰')
  const [replaceTo, setReplaceTo] = useState('')

  // USP 그룹
  type UspGroup = { id: string; name: string; color: string | null; order_idx: number; usp_indexes: number[]; capability_out?: string | null }
  const [groups, setGroups] = useState<UspGroup[]>([])
  const [newGroupName, setNewGroupName] = useState('')
  const [groupsExpanded, setGroupsExpanded] = useState(true)
  // 필터: null=전체, 'unclassified'=미분류, group.id=특정 그룹
  const [activeGroupFilter, setActiveGroupFilter] = useState<string | null>(null)
  // LLM 리뷰 생성 중인 USP idx (한 번에 하나만)
  const [genReviewsIdx, setGenReviewsIdx] = useState<number | null>(null)

  const reloadGroups = async () => {
    if (!productId) return
    try { setGroups(await api.listUspGroups(productId)) } catch {}
  }
  useEffect(() => { reloadGroups() }, [productId])

  // 1-based usp index → groupId map
  const groupByUspIdx = (() => {
    const m = new Map<number, UspGroup>()
    for (const g of groups) for (const i of (g.usp_indexes || [])) m.set(i, g)
    return m
  })()

  const setUspGroup = async (uspIdx: number, newGroupId: string | null) => {
    if (!productId) { alert('상품 저장 후 그룹 사용 가능'); return }
    const prevGroups = groups
    // Optimistic UI: 즉시 state 갱신
    const optimistic = groups.map(g => {
      const has = g.usp_indexes.includes(uspIdx)
      const shouldHave = g.id === newGroupId
      if (has === shouldHave) return g
      return {
        ...g,
        usp_indexes: shouldHave
          ? [...g.usp_indexes, uspIdx].sort((a, b) => a - b)
          : g.usp_indexes.filter(i => i !== uspIdx),
      }
    })
    setGroups(optimistic)
    // 백엔드는 변경된 그룹만 병렬 호출
    const calls = optimistic
      .filter(g => {
        const prev = prevGroups.find(p => p.id === g.id)
        return prev && JSON.stringify(prev.usp_indexes) !== JSON.stringify(g.usp_indexes)
      })
      .map(g => api.setUspGroupMembers(productId, g.id, g.usp_indexes))
    try {
      await Promise.all(calls)
    } catch (e: any) {
      // 실패 시 rollback
      setGroups(prevGroups)
      alert('그룹 설정 실패: ' + (e.message || e))
    }
  }

  const addGroup = async () => {
    if (!productId) { alert('상품 저장 후 그룹 추가 가능'); return }
    const n = newGroupName.trim()
    if (!n) return
    try {
      await api.createUspGroup(productId, { name: n, order_idx: groups.length })
      setNewGroupName('')
      await reloadGroups()
    } catch (e: any) { alert('그룹 추가 실패: ' + (e.message || e)) }
  }

  const renameGroup = async (gid: string, current: string) => {
    const v = prompt('그룹 이름', current)
    if (!v || !v.trim() || !productId) return
    try {
      await api.updateUspGroup(productId, gid, { name: v.trim() })
      await reloadGroups()
    } catch (e: any) { alert('이름 수정 실패: ' + (e.message || e)) }
  }

  const removeGroup = async (gid: string) => {
    if (!productId) return
    if (!confirm('이 그룹을 삭제할까요? (USP 자체는 안 지워짐, 멤버 매핑만 제거)')) return
    try {
      await api.deleteUspGroup(productId, gid)
      await reloadGroups()
    } catch (e: any) { alert('삭제 실패: ' + (e.message || e)) }
  }

  // 그룹 capability_out (안 하는 것) 인라인 편집
  const [editingCapGroupId, setEditingCapGroupId] = useState<string | null>(null)
  const [editingCapDraft, setEditingCapDraft] = useState<string>('')
  const saveCapabilityOut = async (gid: string, val: string) => {
    if (!productId) return
    try {
      await api.updateUspGroup(productId, gid, { capability_out: val })
      await reloadGroups()
      setEditingCapGroupId(null)
    } catch (e: any) { alert('저장 실패: ' + (e.message || e)) }
  }

  // 편집 시 데이터 로드 — 캐시 우선, 없으면 API
  useEffect(() => {
    if (isNew) return
    const cached = loadCache()
    const fromCache = cached?.find(p => p.id === productId)
    if (fromCache) {
      setOriginal(fromCache)
      setName(fromCache.name)
      setUsps(fromCache.usps?.length ? fromCache.usps : [{ usp: '', reviews: [''] }])
      setSocialProof((fromCache as any).social_proof || [])
      setReplaceTo(fromCache.name)
      setLoading(false)
      return
    }
    api.listMyProducts().then(list => {
      const p = list.find(x => x.id === productId)
      if (!p) {
        setErr('상품을 찾을 수 없습니다')
      } else {
        setOriginal(p)
        setName(p.name)
        setUsps(p.usps?.length ? p.usps : [{ usp: '', reviews: [''] }])
        setSocialProof((p as any).social_proof || [])
        setReplaceTo(p.name)
      }
      setLoading(false)
    }).catch(e => { setErr(e.message || '로딩 실패'); setLoading(false) })
  }, [isNew, productId])

  const cleanUsps = () => usps
    .map(u => ({
      usp: u.usp.trim(),
      description: (u.description || '').trim() || undefined,
      reviews: u.reviews.map(r => r.trim()).filter(Boolean),
    }))
    .filter(u => u.usp)

  const save = async () => {
    if (!name.trim()) { setErr('이름을 입력해주세요'); return }
    setBusy(true); setErr('')
    try {
      const cleanSp = socialProof
        .map(sp => ({
          type: sp.type, label: (sp.label || '').trim(),
          value: (sp.value || '').trim(),
          evidence: (sp.evidence || '').trim() || undefined,
        }))
        .filter(sp => sp.label && sp.value)
      const payload = { name: name.trim(), usps: cleanUsps(), social_proof: cleanSp }
      if (isNew) await api.createMyProduct(payload)
      else await api.updateMyProduct(productId!, payload)
      invalidateCache()
      navigate('/my-products')
    } catch (e: any) { setErr(e.message || '저장 실패') }
    setBusy(false)
  }

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

  if (loading) {
    return (
      <div style={{ padding: 40, color: 'var(--text-muted)' }}>불러오는 중…</div>
    )
  }

  return (
    <>
      <button onClick={() => navigate('/my-products')} className="detail-back" type="button">
        ← 내 상품
      </button>

      <div className="page-header" style={{ marginTop: 8 }}>
        <h1>{isNew ? '새 상품' : '상품 수정'}</h1>
        <p>{isNew ? '제품/서비스를 등록합니다.' : original?.name}</p>
      </div>

      <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <section>
          <label style={labelSt}>제품명 / 서비스명</label>
          <input style={inputSt} value={name} onChange={e => setName(e.target.value)} placeholder="예: C멤버십" autoFocus />
        </section>

        <section>
          <label style={labelSt}>리뷰 수집</label>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14 }}>
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
                type="button"
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
        </section>

        <section>
          <label style={labelSt}>USP & 연관 리뷰</label>

          {productId && (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)', padding: 10, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: groupsExpanded ? 10 : 0 }}>
                <strong style={{ fontSize: 12 }}>🏷 USP 그룹 ({groups.length})</strong>
                <button type="button" onClick={() => setGroupsExpanded(v => !v)}
                  style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 11,
                    background: 'transparent', border: '1px solid var(--border)',
                    borderRadius: 4, cursor: 'pointer', color: 'var(--text-secondary)' }}>
                  {groupsExpanded ? '▲ 접기' : '▼ 펼치기'}
                </button>
              </div>
              {groupsExpanded && (
                <>
                  {/* 필터 행: 전체 + 미분류 + 각 그룹 pill (클릭 = 필터 토글) */}
                  {/* 카운트는 현재 usps 기준 — 필터 적용 결과와 항상 일치 (g.usp_indexes.length 사용 X — 삭제된 인덱스 포함 가능) */}
                  {(() => {
                    const allCount = usps.length
                    const unclassifiedCount = usps.filter((_, i) => !groupByUspIdx.has(i + 1)).length
                    const groupCount = (gid: string) => usps.filter((_, i) => groupByUspIdx.get(i + 1)?.id === gid).length
                    return (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginRight: 4 }}>FILTER:</span>
                    {/* 전체 */}
                    <button type="button" onClick={() => setActiveGroupFilter(null)}
                      style={{
                        padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                        cursor: 'pointer',
                        background: activeGroupFilter === null ? 'var(--accent)' : 'var(--bg-elevated)',
                        color: activeGroupFilter === null ? '#fff' : 'var(--text-body)',
                        border: '1px solid var(--border)',
                      }}>
                      전체 ({allCount})
                    </button>
                    {/* 미분류 */}
                    <button type="button" onClick={() => setActiveGroupFilter('unclassified')}
                      style={{
                        padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                        cursor: 'pointer',
                        background: activeGroupFilter === 'unclassified' ? 'var(--accent)' : 'var(--bg-elevated)',
                        color: activeGroupFilter === 'unclassified' ? '#fff' : 'var(--text-body)',
                        border: '1px dashed var(--border)',
                      }}>
                      미분류 ({unclassifiedCount})
                    </button>
                    {groups.map(g => {
                      const isActive = activeGroupFilter === g.id
                      const cnt = groupCount(g.id)
                      return (
                        <div key={g.id} style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          padding: '4px 8px', borderRadius: 6,
                          background: isActive ? (g.color || 'var(--accent)') : 'var(--bg-elevated)',
                          color: isActive ? '#fff' : (g.color || 'var(--text-body)'),
                          border: `1px solid ${isActive ? (g.color || 'var(--accent)') : 'var(--border)'}`,
                          fontSize: 11,
                          boxShadow: isActive ? '0 0 0 2px rgba(99,102,241,0.2)' : 'none',
                        }}>
                          <button type="button"
                            onClick={() => setActiveGroupFilter(isActive ? null : g.id)}
                            title={isActive ? '필터 해제 (전체 보기)' : '이 그룹의 USP만 보기'}
                            style={{
                              background: 'transparent', border: 'none', cursor: 'pointer',
                              color: 'inherit', fontSize: 11, padding: 0, fontWeight: 700,
                              display: 'inline-flex', gap: 4, alignItems: 'baseline',
                            }}>
                            <span>{g.name}</span>
                            <span style={{ opacity: 0.7 }}>({cnt})</span>
                          </button>
                          <button type="button" onClick={() => renameGroup(g.id, g.name)}
                            title="이름 수정"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                              color: 'inherit', fontSize: 11, padding: 0 }}>편집</button>
                          <button type="button"
                            onClick={() => {
                              setEditingCapGroupId(editingCapGroupId === g.id ? null : g.id)
                              setEditingCapDraft(g.capability_out || '')
                            }}
                            title={g.capability_out ? `안 하는 것: ${g.capability_out}` : '이 그룹이 안 하는 것 명시'}
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                              color: g.capability_out ? '#f59e0b' : 'inherit', fontSize: 11, padding: 0 }}>경계</button>
                          <button type="button" onClick={() => removeGroup(g.id)}
                            title="삭제"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                              color: 'inherit', fontSize: 11, padding: 0 }}>삭제</button>
                        </div>
                      )
                    })}
                  </div>
                    )
                  })()}
                  {/* capability_out 편집 폼 (경계 클릭 시 펼쳐짐) */}
                  {editingCapGroupId && (() => {
                    const g = groups.find(x => x.id === editingCapGroupId)
                    if (!g) return null
                    return (
                      <div style={{
                        marginBottom: 10, padding: 10,
                        background: 'rgba(245,158,11,0.08)',
                        border: '1px solid rgba(245,158,11,0.4)',
                        borderRadius: 'var(--radius-sm)',
                      }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', marginBottom: 6 }}>
                          "{g.name}" 그룹이 안 하는 것 (writer의 false claim 방지)
                        </div>
                        <textarea value={editingCapDraft}
                          onChange={e => setEditingCapDraft(e.target.value)}
                          placeholder="예: 실제 예약 (제휴 사이트 이동), 결제 (외부 처리)"
                          rows={2}
                          style={{ width: '100%', padding: '6px 10px', fontSize: 12, marginBottom: 6,
                            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                            background: 'var(--bg-surface)', resize: 'vertical', fontFamily: 'inherit' }} />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button"
                            onClick={() => saveCapabilityOut(g.id, editingCapDraft)}
                            style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600,
                              background: '#f59e0b', color: '#fff', border: 'none',
                              borderRadius: 4, cursor: 'pointer' }}>저장</button>
                          <button type="button"
                            onClick={() => { setEditingCapGroupId(null); setEditingCapDraft('') }}
                            style={{ padding: '4px 12px', fontSize: 11,
                              background: 'transparent', border: '1px solid var(--border)',
                              borderRadius: 4, cursor: 'pointer', color: 'var(--text-body)' }}>취소</button>
                          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>
                            description의 어휘여도 이 항목은 functionality로 안 박힘
                          </span>
                        </div>
                      </div>
                    )
                  })()}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addGroup() } }}
                      placeholder="새 그룹 이름 (예: 디자인, 가격, 후기)"
                      style={{ ...inputSt, flex: 1, fontSize: 12 }} />
                    <button type="button" onClick={addGroup}
                      disabled={!newGroupName.trim()}
                      style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600,
                        background: 'var(--accent)', color: '#fff', border: 'none',
                        borderRadius: 4, cursor: newGroupName.trim() ? 'pointer' : 'not-allowed',
                        opacity: newGroupName.trim() ? 1 : 0.5 }}>
                      + 추가
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {usps.map((u, i) => {
            const uspIdx = i + 1
            const curGroup = groupByUspIdx.get(uspIdx)
            // 필터 적용: null=전체, 'unclassified'=그룹 없음만, groupId=해당 그룹만
            if (activeGroupFilter === 'unclassified' && curGroup) return null
            if (activeGroupFilter && activeGroupFilter !== 'unclassified' && curGroup?.id !== activeGroupFilter) return null
            return (
            <div key={i} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <input style={{ ...inputSt, flex: 1 }} value={u.usp}
                  onChange={e => setUsps(usps.map((x, idx) => idx === i ? { ...x, usp: e.target.value } : x))}
                  placeholder={`USP ${i + 1} (한 줄)`} />
                {productId && groups.length > 0 && (
                  <select
                    value={curGroup?.id || ''}
                    onChange={e => setUspGroup(uspIdx, e.target.value || null)}
                    style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4,
                      border: '1px solid var(--border)',
                      background: curGroup?.color || 'var(--bg-base)',
                      color: curGroup?.color ? '#fff' : 'var(--text-body)',
                      fontWeight: curGroup ? 700 : 400, minWidth: 110 }}>
                    <option value="">미분류</option>
                    {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                )}
                {usps.length > 1 && (
                  <button type="button" onClick={() => setUsps(usps.filter((_, idx) => idx !== i))} style={{ padding: '4px 10px', fontSize: 11, border: '1px solid var(--error)', borderRadius: 4, background: 'transparent', color: 'var(--error)', cursor: 'pointer' }}>USP 삭제</button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
                  USP 설명 (writer가 어휘 source로 사용) — ⚠️ <strong>1 USP = 1 feature</strong>. 여러 기능 묶지 말고 별도 USP로 분리.
                </span>
                <button
                  type="button"
                  disabled={!u.usp.trim()}
                  title={u.usp.trim() ? 'LLM이 USP 이름 + 리뷰로 description 자동 생성' : 'USP 이름 먼저 입력'}
                  onClick={async () => {
                    if (!u.usp.trim()) return
                    const idx = i
                    try {
                      const r = await api.suggestUspDescription({
                        product_name: name,
                        usp_name: u.usp,
                        reviews: u.reviews.filter(rv => rv.trim()),
                      })
                      setUsps(prev => prev.map((x, ix) => ix === idx ? { ...x, description: r.description } : x))
                    } catch (err: any) {
                      alert('LLM 추천 실패: ' + (err?.message || err))
                    }
                  }}
                  style={{
                    padding: '3px 10px', fontSize: 11, fontWeight: 600,
                    border: '1px solid var(--accent)', borderRadius: 4,
                    background: u.usp.trim() ? 'var(--accent-light)' : 'var(--bg-elevated)',
                    color: u.usp.trim() ? 'var(--accent)' : 'var(--text-muted)',
                    cursor: u.usp.trim() ? 'pointer' : 'not-allowed',
                  }}>
                  🪄 LLM 추천
                </button>
              </div>
              <textarea style={{ ...textareaSt, marginBottom: 8, minHeight: 60, fontSize: 12 }}
                value={u.description || ''}
                onChange={e => setUsps(usps.map((x, idx) => idx === i ? { ...x, description: e.target.value } : x))}
                placeholder={`기능 설명 — 권장 4 섹션:
문제: 사용자 일상 불편 (구체 scene)
해결: 우리 제품이 하는 것 (구체 동작)
혜택: 사용 후 변화 (감정·결과)
앱이 하는 것: 검색, 비교, 알림 (실제 capability)
앱이 안 하는 것: 실제 예약 (외부 사이트), 결제 (외부 처리)
핵심 명사:
- 문제 측: ...
- 해결 측: ...
- 혜택 측: ...

또는 위 🪄 LLM 추천 클릭 → 자동 생성`} />
              <div style={{ paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
                {u.reviews.map((r, j) => (
                  <div key={j} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                    <input style={{ ...inputSt, flex: 1, fontSize: 12 }} value={r}
                      onChange={e => setUsps(usps.map((x, idx) => idx === i ? { ...x, reviews: x.reviews.map((rr, k) => k === j ? e.target.value : rr) } : x))}
                      placeholder={`연관 리뷰 ${j + 1}`} />
                    {u.reviews.length > 1 && (
                      <button type="button" onClick={() => setUsps(usps.map((x, idx) => idx === i ? { ...x, reviews: x.reviews.filter((_, k) => k !== j) } : x))}
                        style={{ padding: '4px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-elevated)', cursor: 'pointer' }}>삭제</button>
                    )}
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => setUsps(usps.map((x, idx) => idx === i ? { ...x, reviews: [...x.reviews, ''] } : x))}
                    style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, border: '1px solid var(--accent)', borderRadius: 4, background: 'var(--accent-light)', color: 'var(--accent)', cursor: 'pointer' }}>+ 리뷰 추가</button>
                  <button type="button"
                    disabled={!u.usp.trim() || (genReviewsIdx === i)}
                    title={u.usp.trim() ? 'USP 이름 + description 기반 소비자 언어 리뷰 5개 LLM 생성' : 'USP 이름 먼저 입력'}
                    onClick={async () => {
                      if (!u.usp.trim() || genReviewsIdx !== null) return
                      setGenReviewsIdx(i)
                      try {
                        const existing = (u.reviews || []).filter(r => r.trim())
                        const r = await api.generateUspReviews({
                          product_name: name,
                          usp_name: u.usp,
                          usp_description: u.description || '',
                          existing_reviews: existing,
                          count: 5,
                        })
                        const newReviews = Array.isArray(r.reviews) ? r.reviews.filter((x: string) => (x || '').trim()) : []
                        if (newReviews.length === 0) {
                          alert('생성된 리뷰가 없습니다.')
                          return
                        }
                        // 기존 빈 리뷰 제거 + 새 리뷰 append
                        setUsps(usps.map((x, idx) => idx === i ? {
                          ...x,
                          reviews: [...x.reviews.filter(r => r.trim()), ...newReviews],
                        } : x))
                      } catch (e: any) {
                        alert('리뷰 생성 실패: ' + (e?.message || e))
                      } finally {
                        setGenReviewsIdx(null)
                      }
                    }}
                    style={{
                      padding: '4px 10px', fontSize: 11, fontWeight: 600,
                      border: '1px solid var(--accent)', borderRadius: 4,
                      background: (u.usp.trim() && genReviewsIdx === null) ? 'var(--accent)' : 'var(--bg-elevated)',
                      color: (u.usp.trim() && genReviewsIdx === null) ? '#fff' : 'var(--text-muted)',
                      cursor: (u.usp.trim() && genReviewsIdx === null) ? 'pointer' : 'not-allowed',
                      opacity: genReviewsIdx === i ? 0.6 : 1,
                    }}>
                    {genReviewsIdx === i ? '생성 중…' : 'LLM 리뷰 5개 생성'}
                  </button>
                </div>
              </div>
            </div>
            )
          })}
          {/* 필터링 후 결과 없을 때 빈 상태 */}
          {(() => {
            if (!activeGroupFilter) return null
            const visible = usps.filter((_, i) => {
              const cg = groupByUspIdx.get(i + 1)
              if (activeGroupFilter === 'unclassified') return !cg
              return cg?.id === activeGroupFilter
            }).length
            if (visible > 0) return null
            const label = activeGroupFilter === 'unclassified'
              ? '미분류'
              : groups.find(g => g.id === activeGroupFilter)?.name || '?'
            return (
              <div style={{
                padding: 20, textAlign: 'center', fontSize: 12,
                color: 'var(--text-muted)', background: 'var(--bg-elevated)',
                border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)',
                marginBottom: 10,
              }}>
                "{label}"에 속한 USP 없음 — <button type="button"
                  onClick={() => setActiveGroupFilter(null)}
                  style={{ background: 'transparent', border: 'none',
                    color: 'var(--accent)', cursor: 'pointer', fontSize: 12,
                    fontWeight: 600, textDecoration: 'underline' }}>전체 보기</button>
              </div>
            )
          })()}
          <button type="button" onClick={async () => {
            // 그룹 필터 활성 상태면 새 USP는 미분류라 필터에 의해 숨겨짐 → 필터 자동 해제
            const isSpecificGroupFilter = activeGroupFilter && activeGroupFilter !== 'unclassified'
            const targetGroupId = isSpecificGroupFilter ? activeGroupFilter : null
            const newUsps = [...usps, { usp: '', description: '', reviews: [''] }]
            const newUspIdx = newUsps.length  // 1-based
            setUsps(newUsps)
            // 특정 그룹 필터면 새 USP를 자동으로 그 그룹에 할당 (productId 있을 때만)
            if (targetGroupId && productId) {
              try {
                await setUspGroup(newUspIdx, targetGroupId)
              } catch {}
            } else if (activeGroupFilter) {
              // productId 없거나 'unclassified' 필터면 필터 해제로 새 USP 보이게
              setActiveGroupFilter(null)
            }
          }}
            style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'var(--accent-light)', color: 'var(--accent)', cursor: 'pointer' }}>+ USP 추가</button>
        </section>

        <section className="section-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={labelSt}>사회적 증명 (Social Proof)</label>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              매출·후기·평점·수상 등 신뢰 신호. body chunk에 USP와 함께 자연스럽게 결합되어 사용됨.
            </div>
          </div>
          {socialProof.map((sp, i) => {
            const meta = SP_TYPES.find(t => t.key === sp.type) || SP_TYPES[0]
            return (
              <div key={i} style={{ border: '1px solid var(--border-subtle)', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={sp.type}
                    onChange={e => setSocialProof(socialProof.map((x, idx) => idx === i ? { ...x, type: e.target.value } : x))}
                    style={{ ...inputSt, width: 140 }}
                  >
                    {SP_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                  <input
                    type="text" placeholder="라벨 (예: 32억 매출)"
                    value={sp.label}
                    onChange={e => setSocialProof(socialProof.map((x, idx) => idx === i ? { ...x, label: e.target.value } : x))}
                    style={{ ...inputSt, flex: 1, minWidth: 140 }}
                  />
                  <button type="button"
                    onClick={() => setSocialProof(socialProof.filter((_, idx) => idx !== i))}
                    style={{ padding: '4px 10px', fontSize: 11, border: '1px solid var(--error)', borderRadius: 4, background: 'transparent', color: 'var(--error)', cursor: 'pointer' }}>
                    삭제
                  </button>
                </div>
                <input
                  type="text" placeholder={meta.placeholder}
                  value={sp.value}
                  onChange={e => setSocialProof(socialProof.map((x, idx) => idx === i ? { ...x, value: e.target.value } : x))}
                  style={inputSt}
                />
                <input
                  type="text" placeholder="추가 컨텍스트 (선택, 예: '2024년 누적')"
                  value={sp.evidence || ''}
                  onChange={e => setSocialProof(socialProof.map((x, idx) => idx === i ? { ...x, evidence: e.target.value } : x))}
                  style={{ ...inputSt, fontSize: 12 }}
                />
              </div>
            )
          })}
          <button type="button"
            onClick={() => setSocialProof([...socialProof, { type: 'sales_volume', label: '', value: '' }])}
            style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', background: 'var(--accent-light)', color: 'var(--accent)', cursor: 'pointer', alignSelf: 'flex-start' }}>
            + 사회적 증명 추가
          </button>
        </section>

        {err && <div style={{ color: 'var(--error)', fontSize: 12 }}>{err}</div>}

        <div style={{
          display: 'flex', gap: 8, justifyContent: 'flex-end',
          paddingTop: 12, borderTop: '1px solid var(--border-subtle)',
          position: 'sticky', bottom: 0, background: 'var(--bg-base)',
        }}>
          <button type="button" onClick={() => navigate('/my-products')} disabled={busy} style={{ padding: '8px 16px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)', cursor: 'pointer' }}>취소</button>
          <button type="button" onClick={save} disabled={busy} style={{ padding: '8px 20px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', background: 'var(--accent)', color: '#fff', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? '저장 중…' : '저장'}</button>
        </div>
      </div>
    </>
  )
}
