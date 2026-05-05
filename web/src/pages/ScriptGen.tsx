import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, BASE } from '../api'
import type { MyProduct, PersonaCandidate, ReferenceInfo } from '../api'
import { getAccessToken } from '../supabase'

interface USPItem { usp: string; description?: string; reviews: string[] }

interface RefSuggest { shortcode: string; author: string; play_count: number; thumbnail_url: string }

interface GeneratedScript {
  duration_target_sec?: number
  structure?: {
    hook?: { seconds: string; text: string; type?: string; analysis?: string }
    intro?: { seconds: string; text: string; analysis?: string }
    body?: { seconds: string; text: string; key_points?: string[]; analysis?: string }
    cta?: { seconds: string; text: string; type?: string; analysis?: string }
    overall?: { flow?: string; strength?: string; why_it_works?: string }
  }
  sentences?: { start: number; end: number; text: string; direction?: string; emotion?: string; intensity?: number; delivery?: string }[]
  tts_script?: string
  _references_used?: string[]
}

const labelSt: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }
const inputSt: React.CSSProperties = {
  width: '100%', padding: '8px 12px', fontSize: 13,
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-base)', color: 'var(--text-primary)',
}
const textareaSt: React.CSSProperties = { ...inputSt, fontFamily: 'inherit', resize: 'vertical', minHeight: 60 }

export default function ScriptGen() {
  const [productName, setProductName] = useState('')
  // pain/desire UI 제거 — 페르소나에서 자동 추론. API 호환을 위해 빈 문자열만 유지.
  const pain = ''
  const desire = ''
  const [usps, setUsps] = useState<USPItem[]>([{ usp: '', description: '', reviews: [''] }])
  // 메인 USP (라디오) + 서브 USP (체크박스 + 순서)
  const [mainUspIndex, setMainUspIndex] = useState<number | null>(null)
  const [subUspOrder, setSubUspOrder] = useState<number[]>([])  // 순서 있는 sub USP 인덱스
  // 호환용 — Set 인터페이스 유지
  const subUspIndices = new Set(subUspOrder)
  // 메인 USP에서 추출한 페르소나 후보들
  const [personaCandidates, setPersonaCandidates] = useState<PersonaCandidate[]>([])
  const [personasLoading, setPersonasLoading] = useState(false)
  const [personasError, setPersonasError] = useState('')
  // 사용자가 체크한 페르소나 (최대 2개)
  const [selectedPersonas, setSelectedPersonas] = useState<PersonaCandidate[]>([])
  // 페르소나 편집 모달 (index = -1 → 새 추가)
  const [personaEdit, setPersonaEdit] = useState<{ index: number; data: PersonaCandidate } | null>(null)
  const [personaSaving, setPersonaSaving] = useState(false)

  const [refInfo, setRefInfo] = useState<ReferenceInfo | null>(null)
  const [refMode, setRefMode] = useState<'single' | 'multi'>('single')
  const [refQuery, setRefQuery] = useState('')
  const [refSuggest, setRefSuggest] = useState<RefSuggest[]>([])
  const [refSelected, setRefSelected] = useState<RefSuggest[]>([])
  const [showSuggest, setShowSuggest] = useState(false)
  const [myProducts, setMyProducts] = useState<MyProduct[]>([])
  const [selectedProductId, setSelectedProductId] = useState<number | ''>('')
  const [generating, setGenerating] = useState(false)
  const [refining, setRefining] = useState<string | null>(null)  // refining 중인 페르소나 name
  const [err, setErr] = useState('')
  // 페르소나별 결과 (key = persona.name 또는 '_default')
  const [drafts, setDrafts] = useState<Record<string, GeneratedScript>>({})
  const [results, setResults] = useState<Record<string, GeneratedScript>>({})
  const [activeTab, setActiveTab] = useState<string>('')  // 결과 탭에 표시할 페르소나 name
  const [copied, setCopied] = useState(false)

  // 참고 릴스 대본 (생성 후 비교용)
  interface RefScript { author: string; sentences: Array<{ start: number; end: number; text: string; section?: string }> }
  const [refScripts, setRefScripts] = useState<Record<string, RefScript>>({})

  const [searchParams] = useSearchParams()

  // drafts 생성되면 참고 릴스 sentences 로드
  useEffect(() => {
    if (!Object.keys(drafts).length) return
    refSelected.forEach(r => {
      if (refScripts[r.shortcode]) return
      Promise.all([api.metadata(r.shortcode), api.extra(r.shortcode)])
        .then(([meta, extra]) => {
          setRefScripts(prev => ({
            ...prev,
            [r.shortcode]: {
              author: meta?.author_username || r.author || r.shortcode,
              sentences: (extra?.sentences as RefScript['sentences']) || [],
            },
          }))
        })
        .catch(() => {})
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, refSelected])

  // 내 상품 목록 로드
  useEffect(() => { api.listMyProducts().then(setMyProducts).catch(() => {}) }, [])

  // ?ref=<shortcode> URL 파라미터로 진입 시 자동 추가
  useEffect(() => {
    const refParam = searchParams.get('ref')
    if (!refParam) return
    if (refSelected.some(r => r.shortcode === refParam)) return
    api.bench({ q: refParam, limit: 5 }).then(r => {
      const found = r.items.find(i => i.shortcode === refParam)
      if (found) {
        setRefSelected([{
          shortcode: found.shortcode,
          author: found.author,
          play_count: found.play_count,
          thumbnail_url: found.thumbnail_url,
        }])
      }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const loadProduct = (id: number) => {
    const p = myProducts.find(x => x.id === id)
    if (!p) return
    setProductName(p.name)
    const loaded = p.usps?.length ? p.usps.map((u: any) => ({ usp: u.usp, description: u.description || '', reviews: u.reviews?.length ? u.reviews : [''] })) : [{ usp: '', description: '', reviews: [''] }]
    setUsps(loaded)
    setMainUspIndex(loaded.length ? 0 : null)
    setSubUspOrder([])
    setPersonaCandidates([])
    setSelectedPersonas([])
    setSelectedProductId(id)
  }

  const toggleSubUsp = (i: number) => {
    if (i === mainUspIndex) return  // 메인은 서브에 동시 선택 불가
    setSubUspOrder(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i])
  }
  const moveSubUsp = (i: number, dir: -1 | 1) => {
    setSubUspOrder(prev => {
      const idx = prev.indexOf(i)
      if (idx < 0) return prev
      const newIdx = idx + dir
      if (newIdx < 0 || newIdx >= prev.length) return prev
      const next = [...prev]
      ;[next[idx], next[newIdx]] = [next[newIdx], next[idx]]
      return next
    })
  }
  const setMain = (i: number) => {
    setMainUspIndex(i)
    setSubUspOrder(prev => prev.filter(x => x !== i))
    setPersonaCandidates([])
    setSelectedPersonas([])
  }

  // 메인 USP 변경 또는 USP 텍스트 변경 시 페르소나 자동 추출
  // mainUspText를 deps에 포함 — product 변경 시 같은 index여도 USP 내용이 다르면 재추출
  const mainUspText = mainUspIndex !== null ? (usps[mainUspIndex]?.usp || '') : ''
  const mainUspReviewsKey = mainUspIndex !== null
    ? (usps[mainUspIndex]?.reviews || []).filter(r => r.trim()).slice(0, 3).join('|').slice(0, 200)
    : ''
  useEffect(() => {
    if (mainUspIndex === null) { setPersonaCandidates([]); setSelectedPersonas([]); return }
    const u = usps[mainUspIndex]
    if (!u) return
    const reviews = (u.reviews || []).map(r => r.trim()).filter(Boolean)
    if (!u.usp.trim() || reviews.length === 0) {
      setPersonaCandidates([]); setSelectedPersonas([])
      return
    }
    setPersonasLoading(true); setPersonasError('')
    setPersonaCandidates([]); setSelectedPersonas([])  // 호출 전 비우기
    const productId = typeof selectedProductId === 'number' ? selectedProductId : undefined
    api.extractPersonas(u.usp, reviews, '', productId, mainUspIndex).then(r => {
      setPersonaCandidates(r.personas || [])
      setPersonasLoading(false)
      // 자동 선택 X — 사용자가 직접 고르도록
    }).catch(e => {
      setPersonasError(e.message || '페르소나 추출 실패')
      setPersonaCandidates([])
      setPersonasLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainUspIndex, mainUspText, mainUspReviewsKey, selectedProductId])

  const togglePersona = (p: PersonaCandidate) => {
    setSelectedPersonas(prev => {
      const idx = prev.findIndex(x => x.name === p.name)
      if (idx >= 0) return prev.filter((_, i) => i !== idx)
      if (prev.length >= 2) return [prev[1], p]  // 최대 2개, 가장 오래된 것 빼기
      return [...prev, p]
    })
  }

  // 페르소나 DB 저장 (현재 personaCandidates 전체를 DB에 PATCH)
  const savePersonasToDB = async (next: PersonaCandidate[]) => {
    if (typeof selectedProductId !== 'number' || mainUspIndex === null) return
    try {
      await api.updateUspPersonas(selectedProductId, mainUspIndex, next)
    } catch (e: any) {
      console.warn('persona save failed:', e?.message)
    }
  }

  const startNewPersona = () => {
    setPersonaEdit({
      index: -1,
      data: {
        name: '', scenario: '', signals: [], review_count: 0,
        sample_reviews: [], tone_hint: '',
      },
    })
  }
  const startEditPersona = (i: number) => {
    const p = personaCandidates[i]
    if (!p) return
    setPersonaEdit({ index: i, data: { ...p, signals: [...(p.signals || [])], sample_reviews: [...(p.sample_reviews || [])] } })
  }
  const deletePersona = async (i: number) => {
    if (!confirm('이 페르소나 삭제?')) return
    const removed = personaCandidates[i]
    const next = personaCandidates.filter((_, idx) => idx !== i)
    setPersonaCandidates(next)
    setSelectedPersonas(prev => prev.filter(x => x.name !== removed?.name))
    await savePersonasToDB(next)
  }
  const savePersonaEdit = async () => {
    if (!personaEdit) return
    if (!personaEdit.data.name.trim()) { alert('이름 필수'); return }
    setPersonaSaving(true)
    try {
      const cleaned: PersonaCandidate = {
        name: personaEdit.data.name.trim(),
        scenario: personaEdit.data.scenario.trim(),
        signals: personaEdit.data.signals.map(s => s.trim()).filter(Boolean),
        destinations: (personaEdit.data.destinations || []).map(s => s.trim()).filter(Boolean),
        review_count: personaEdit.data.review_count || 0,
        sample_reviews: personaEdit.data.sample_reviews || [],
        tone_hint: personaEdit.data.tone_hint.trim(),
      }
      let next: PersonaCandidate[]
      if (personaEdit.index < 0) {
        next = [...personaCandidates, cleaned]
      } else {
        next = personaCandidates.map((p, i) => i === personaEdit.index ? cleaned : p)
        // 선택 목록도 동기화 (이름이 바뀌었어도 인덱스로 매칭)
        const oldName = personaCandidates[personaEdit.index]?.name
        if (oldName) {
          setSelectedPersonas(prev => prev.map(x => x.name === oldName ? cleaned : x))
        }
      }
      setPersonaCandidates(next)
      await savePersonasToDB(next)
      setPersonaEdit(null)
    } finally {
      setPersonaSaving(false)
    }
  }

  // 참고 릴스가 1개 선택될 때 그 구조 정보 fetch
  useEffect(() => {
    if (refSelected.length !== 1) { setRefInfo(null); return }
    api.referenceInfo(refSelected[0].shortcode).then(setRefInfo).catch(() => setRefInfo(null))
  }, [refSelected])

  // 참고 릴스 검색 (벤치 API 활용)
  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await api.bench({ q: refQuery || undefined, limit: 12 })
      setRefSuggest(r.items)
    }, 250)
    return () => clearTimeout(t)
  }, [refQuery])

  const addUsp = () => {
    setUsps([...usps, { usp: '', description: '', reviews: [''] }])
  }
  const removeUsp = (i: number) => {
    setUsps(usps.filter((_, idx) => idx !== i))
    if (mainUspIndex === i) {
      setMainUspIndex(null); setPersonaCandidates([]); setSelectedPersonas([])
    } else if (mainUspIndex !== null && mainUspIndex > i) {
      setMainUspIndex(mainUspIndex - 1)
    }
    setSubUspOrder(prev => prev.filter(x => x !== i).map(x => x > i ? x - 1 : x))
  }
  const updateUsp = (i: number, val: string) => setUsps(usps.map((u, idx) => idx === i ? { ...u, usp: val } : u))

  const pickRef = (it: RefSuggest) => {
    if (refSelected.some(s => s.shortcode === it.shortcode)) return
    if (refMode === 'single') setRefSelected([it])
    else setRefSelected([...refSelected, it])
    setRefQuery('')
    setShowSuggest(false)
  }
  const removeRef = (sc: string) => setRefSelected(refSelected.filter(r => r.shortcode !== sc))

  // 메인 USP 첫 항목 + 서브 USP 순서대로
  const buildCleanUsps = () => {
    if (mainUspIndex === null) return []
    const order: number[] = [mainUspIndex, ...subUspOrder.filter(i => i !== mainUspIndex)]
    return order
      .map(i => usps[i])
      .filter(Boolean)
      .map(u => ({
        usp: u.usp.trim(),
        description: (u.description || '').trim() || undefined,
        reviews: u.reviews.map(r => r.trim()).filter(Boolean),
      }))
      .filter(u => u.usp)
  }

  // 1차: 선택된 페르소나마다 병렬 호출
  const generateDrafts = async () => {
    setErr(''); setDrafts({}); setResults({}); setGenerating(true)
    try {
      const cleanUsps = buildCleanUsps()
      if (!cleanUsps.length) throw new Error('메인 USP 1개 이상 필요')
      const token = await getAccessToken()
      const personas = selectedPersonas.length ? selectedPersonas : [null as unknown as PersonaCandidate]
      const calls = personas.map(async (persona): Promise<[string, GeneratedScript]> => {
        const r = await fetch(`${BASE}/api/script/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
          body: JSON.stringify({
            product_name: productName,
            pain,
            desire,
            usps: cleanUsps,
            reference_shortcodes: refSelected.map(r => r.shortcode),
            refine: false,
            target_persona: persona ? {
              name: persona.name,
              scenario: persona.scenario,
              signals: persona.signals,
              destinations: persona.destinations || [],
              tone_hint: persona.tone_hint,
            } : null,
          }),
        })
        if (!r.ok) {
          const d = await r.json().catch(() => ({}))
          throw new Error(d.detail || `${r.status}`)
        }
        const data = await r.json()
        return [persona ? persona.name : '_default', data]
      })
      const settled = await Promise.allSettled(calls)
      const newDrafts: Record<string, GeneratedScript> = {}
      const errors: string[] = []
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          newDrafts[s.value[0]] = s.value[1]
        } else {
          errors.push(s.reason?.message || String(s.reason))
        }
      }
      setDrafts(newDrafts)
      const firstKey = Object.keys(newDrafts)[0] || ''
      setActiveTab(firstKey)
      if (errors.length && !Object.keys(newDrafts).length) {
        setErr(errors.join(' / '))
      } else if (errors.length) {
        setErr(`일부 실패: ${errors.join(' / ')}`)
      }
    } catch (e: any) {
      setErr(e.message || '실패')
    }
    setGenerating(false)
  }

  // 2차: 활성 탭 페르소나의 draft → refined
  const refineActive = async () => {
    const draft = drafts[activeTab]
    if (!draft) return
    setErr(''); setRefining(activeTab)
    try {
      const cleanUsps = buildCleanUsps()
      const refSc = refSelected[0]?.shortcode
      const refined = await api.refineScript(draft, cleanUsps, refSc)
      setResults(prev => ({ ...prev, [activeTab]: refined }))
    } catch (e: any) {
      setErr(e.message || '다듬기 실패')
    }
    setRefining(null)
  }

  const resetAll = () => { setDrafts({}); setResults({}); setActiveTab(''); setErr('') }

  return (
    <>
      <div className="page-header">
        <h1>대본 생성</h1>
        <p>경쟁사 분석 데이터 기반 새 대본 작성</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: Object.keys(drafts).length ? '1fr 1fr' : '1fr', gap: 20 }}>
        {/* INPUT */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 20 }}>
          {myProducts.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <label style={labelSt}>저장된 상품 불러오기</label>
              <select value={selectedProductId} onChange={e => e.target.value ? loadProduct(Number(e.target.value)) : setSelectedProductId('')} style={inputSt}>
                <option value="">— 직접 입력 —</option>
                {myProducts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <label style={labelSt}>제품명 / 서비스명</label>
            <input style={inputSt} value={productName} onChange={e => setProductName(e.target.value)}
              placeholder="제품·서비스 이름 (예: 캔디팝 잠옷)" />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={labelSt}>
              USP & 연관 리뷰
              <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
                (메인 USP는 라디오 ◉ — 페르소나 결정 / 서브 USP는 체크 ☑ — Body 보조)
              </span>
            </label>

            {refInfo && (
              <div style={{
                marginBottom: 10, padding: '8px 12px',
                background: '#fff7ed', border: '1px solid #fdba74',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12, color: 'var(--text-primary)',
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              }}>
                <span style={{ fontWeight: 700, color: '#9a3412' }}>
                  ⚡ 이 참고 릴스에는 USP <b>{refInfo.recommended_usps}개</b> 권장
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  (메인 1개 {refInfo.recommended_usps > 1 ? `+ 서브 ${refInfo.recommended_usps - 1}개` : ''})
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  · Body 분절 {refInfo.body_slot_count}개 · {refInfo.body_class.type}
                </span>
              </div>
            )}

            {/* USP 순서 미리보기 (Main + Sub #1, #2... → Body slot 흐름) */}
            {(mainUspIndex !== null || subUspOrder.length > 0) && (
              <div style={{
                background: 'var(--bg-base)', border: '1px dashed var(--accent)', borderRadius: 'var(--radius-sm)',
                padding: 10, marginBottom: 8, fontSize: 12,
              }}>
                <div style={{ fontWeight: 700, color: 'var(--accent)', marginBottom: 6, fontSize: 11 }}>
                  📋 USP 순서 (Hook+Intro → Body slot 1 → 2 → 3...)
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {mainUspIndex !== null && (
                    <>
                      <span style={{ padding: '4px 10px', background: '#fff7ed', border: '2px solid #f97316', borderRadius: 4, fontWeight: 700, color: '#f97316' }}>
                        MAIN: {usps[mainUspIndex]?.usp || '(빈 USP)'}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>→</span>
                    </>
                  )}
                  {subUspOrder.map((idx, k) => (
                    <span key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ padding: '4px 10px', background: 'var(--accent-light)', border: '1px solid var(--accent)', borderRadius: 4, fontWeight: 700, color: 'var(--accent)' }}>
                        SUB #{k + 1}: {usps[idx]?.usp || '(빈 USP)'}
                      </span>
                      {k < subUspOrder.length - 1 && <span style={{ color: 'var(--text-muted)' }}>→</span>}
                    </span>
                  ))}
                </div>
                {mainUspIndex !== null && subUspOrder.length === 0 && (
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                    아래 USP 카드 체크박스로 서브 USP 선택 + ↑↓로 순서 조정
                  </div>
                )}
              </div>
            )}

            {usps.map((u, i) => {
              const isMain = mainUspIndex === i
              const isSub = subUspIndices.has(i)
              const enabled = isMain || isSub
              return (
              <div key={i} style={{
                background: isMain ? '#fff7ed' : (enabled ? 'var(--bg-base)' : 'var(--bg-elevated)'),
                border: `${isMain ? '2px' : '1px'} solid ${isMain ? '#f97316' : (enabled ? 'var(--border)' : 'var(--border-subtle)')}`,
                borderRadius: 'var(--radius-sm)',
                padding: 12, marginBottom: 8,
                opacity: enabled ? 1 : 0.55,
              }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                  <input type="radio" name="mainUsp" checked={isMain} onChange={() => setMain(i)}
                    title="메인 USP — 페르소나 결정"
                    style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0, accentColor: '#f97316' }} />
                  <input type="checkbox" checked={isSub} onChange={() => toggleSubUsp(i)}
                    disabled={isMain}
                    title={isMain ? '메인은 서브로 동시 선택 불가' : '서브 USP — Body 보조'}
                    style={{ width: 16, height: 16, cursor: isMain ? 'not-allowed' : 'pointer', flexShrink: 0 }} />
                  {isMain && <span style={{ fontSize: 10, fontWeight: 700, color: '#f97316', padding: '1px 5px', border: '1px solid #f97316', borderRadius: 3 }}>MAIN</span>}
                  {isSub && (
                    <>
                      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', padding: '1px 5px', border: '1px solid var(--accent)', borderRadius: 3 }}>
                        SUB #{subUspOrder.indexOf(i) + 1}
                      </span>
                      <button onClick={() => moveSubUsp(i, -1)}
                        disabled={subUspOrder.indexOf(i) <= 0}
                        title="순서 위로"
                        style={{ padding: '2px 6px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-elevated)', cursor: subUspOrder.indexOf(i) <= 0 ? 'not-allowed' : 'pointer', opacity: subUspOrder.indexOf(i) <= 0 ? 0.4 : 1 }}>↑</button>
                      <button onClick={() => moveSubUsp(i, 1)}
                        disabled={subUspOrder.indexOf(i) >= subUspOrder.length - 1}
                        title="순서 아래로"
                        style={{ padding: '2px 6px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-elevated)', cursor: subUspOrder.indexOf(i) >= subUspOrder.length - 1 ? 'not-allowed' : 'pointer', opacity: subUspOrder.indexOf(i) >= subUspOrder.length - 1 ? 0.4 : 1 }}>↓</button>
                    </>
                  )}
                  <input style={{ ...inputSt, flex: 1 }} value={u.usp}
                    onChange={e => updateUsp(i, e.target.value)}
                    placeholder={`USP ${i+1} 슬로건 (15자 이내)`} />
                  {usps.length > 1 && (
                    <button onClick={() => removeUsp(i)} style={smallBtn('error')}>삭제</button>
                  )}
                </div>
                <textarea
                  style={{ ...inputSt, fontFamily: 'inherit', resize: 'vertical', minHeight: 50, fontSize: 12, marginBottom: 6 }}
                  value={u.description || ''}
                  onChange={e => setUsps(usps.map((x, idx) => idx === i ? { ...x, description: e.target.value } : x))}
                  placeholder="기능 설명 (선택, 앱·서비스 추천) — 예: '설정한 가격에 도달하면 푸시 알림. 평소 모니터링 안 해도 자동 절약'"
                />
                <div style={{ paddingLeft: 10, borderLeft: '2px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
                  연관 리뷰 {u.reviews.filter(r => r.trim()).length}개 (대본 생성 시 자동 사용)
                </div>
              </div>
            )})}
            <button onClick={addUsp} style={smallBtn('accent')}>+ USP 추가</button>
          </div>

          {/* 페르소나 후보 */}
          {mainUspIndex !== null && (
            <div style={{ marginBottom: 16 }}>
              <label style={labelSt}>
                페르소나 후보
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
                  (메인 USP 리뷰에서 자동 추출 — 1~2개 선택 시 각각 광고 1개 생성)
                </span>
              </label>
              {personasLoading && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>페르소나 추출 중… (~10초)</div>}
              {personasError && <div style={{ fontSize: 12, color: 'var(--error)', padding: '6px 0' }}>{personasError}</div>}
              {!personasLoading && !personaCandidates.length && !personasError && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>리뷰가 부족하거나 메인 USP가 비어 있습니다.</div>
              )}
              {personaCandidates.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {personaCandidates.map((p, i) => {
                    const checked = selectedPersonas.some(x => x.name === p.name)
                    return (
                      <div key={i} style={{
                        background: checked ? '#eff6ff' : 'var(--bg-base)',
                        border: `${checked ? '2px' : '1px'} solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius-sm)', padding: 10,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <input type="checkbox" checked={checked} onChange={() => togglePersona(p)}
                            style={{ width: 16, height: 16, cursor: 'pointer' }} />
                          <span style={{ fontSize: 13, fontWeight: 700, flex: 1, cursor: 'pointer' }} onClick={() => togglePersona(p)}>
                            {p.name || '(이름 없음)'}
                          </span>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>매칭 {p.review_count}건</span>
                          <button onClick={() => startEditPersona(i)} title="편집" style={{
                            padding: '2px 8px', fontSize: 10, fontWeight: 600,
                            border: '1px solid var(--border)', borderRadius: 4,
                            background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer',
                          }}>편집</button>
                          <button onClick={() => deletePersona(i)} title="삭제" style={{
                            padding: '2px 8px', fontSize: 10, fontWeight: 600,
                            border: '1px solid var(--error)', borderRadius: 4,
                            background: 'transparent', color: 'var(--error)', cursor: 'pointer',
                          }}>×</button>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, cursor: 'pointer' }} onClick={() => togglePersona(p)}>
                          {p.scenario || '(시나리오 없음)'}
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                          {(p.signals || []).map(s => (
                            <span key={s} style={{
                              fontSize: 10, padding: '1px 6px', borderRadius: 999,
                              background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                            }}>#{s}</span>
                          ))}
                          {p.tone_hint && (
                            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }}>
                              톤: {p.tone_hint}
                            </span>
                          )}
                        </div>
                        {p.sample_reviews?.[0] && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 2 }}>
                            "{p.sample_reviews[0].slice(0, 100)}{p.sample_reviews[0].length > 100 ? '…' : ''}"
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <button onClick={startNewPersona} style={{
                  padding: '5px 10px', fontSize: 11, fontWeight: 600,
                  border: '1px dashed var(--accent)', borderRadius: 4,
                  background: 'var(--accent-light)', color: 'var(--accent)', cursor: 'pointer',
                }}>+ 페르소나 추가</button>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  선택: {selectedPersonas.length}/2 — 0개면 자동 추론 모드
                </span>
              </div>
            </div>
          )}

          {/* 페르소나 편집 모달 */}
          {personaEdit && (
            <div style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }} onClick={() => setPersonaEdit(null)}>
              <div onClick={e => e.stopPropagation()} style={{
                background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)',
                padding: 20, width: 540, maxHeight: '85vh', overflowY: 'auto',
                boxShadow: 'var(--shadow-md)',
              }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>
                  {personaEdit.index < 0 ? '페르소나 추가' : '페르소나 편집'}
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={labelSt}>이름 (한 줄 정의)</label>
                  <input style={inputSt} value={personaEdit.data.name}
                    onChange={e => setPersonaEdit({ ...personaEdit, data: { ...personaEdit.data, name: e.target.value } })}
                    placeholder="예: 고양이 키우는 20-30대 여성/커플 (집사)" />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={labelSt}>시나리오 (USP를 쓰는 구체 상황)</label>
                  <textarea style={textareaSt} rows={3} value={personaEdit.data.scenario}
                    onChange={e => setPersonaEdit({ ...personaEdit, data: { ...personaEdit.data, scenario: e.target.value } })}
                    placeholder="예: 집에서 고양이 안고 자거나 뒹구는 상황" />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={labelSt}>시그널 어휘 (쉼표로 구분)</label>
                  <input style={inputSt}
                    value={(personaEdit.data.signals || []).join(', ')}
                    onChange={e => setPersonaEdit({ ...personaEdit, data: { ...personaEdit.data, signals: e.target.value.split(',').map(s => s.trim()) } })}
                    placeholder="냥이, 집사, 고양이털" />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={labelSt}>여행지 / 구체 장소 (쉼표로 구분, 선택)</label>
                  <input style={inputSt}
                    value={(personaEdit.data.destinations || []).join(', ')}
                    onChange={e => setPersonaEdit({ ...personaEdit, data: { ...personaEdit.data, destinations: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })}
                    placeholder="푸꾸옥, 나트랑, 보라카이, 다낭 (대본에서 vivid 시나리오로 활용)" />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={labelSt}>톤 힌트</label>
                  <input style={inputSt} value={personaEdit.data.tone_hint}
                    onChange={e => setPersonaEdit({ ...personaEdit, data: { ...personaEdit.data, tone_hint: e.target.value } })}
                    placeholder="친근·일상 / 실용·간결 / 따뜻 등" />
                </div>
                {personaEdit.data.sample_reviews?.length > 0 && (
                  <div style={{ marginBottom: 10, padding: 8, background: 'var(--bg-base)', borderRadius: 4 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>참고 샘플 리뷰 (읽기 전용)</div>
                    {personaEdit.data.sample_reviews.slice(0, 3).map((r, i) => (
                      <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2 }}>· {r.slice(0, 120)}</div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                  <button onClick={() => setPersonaEdit(null)} style={{
                    padding: '8px 16px', fontSize: 12, fontWeight: 600,
                    border: '1px solid var(--border)', borderRadius: 4,
                    background: 'var(--bg-surface)', cursor: 'pointer',
                  }}>취소</button>
                  <button onClick={savePersonaEdit} disabled={personaSaving} style={{
                    padding: '8px 16px', fontSize: 12, fontWeight: 600,
                    border: 'none', borderRadius: 4,
                    background: personaSaving ? 'var(--text-muted)' : 'var(--accent)', color: '#fff',
                    cursor: personaSaving ? 'not-allowed' : 'pointer',
                  }}>{personaSaving ? '저장 중…' : '저장'}</button>
                </div>
              </div>
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <label style={labelSt}>참고 릴스</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, fontSize: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="radio" checked={refMode === 'single'} onChange={() => { setRefMode('single'); if (refSelected.length > 1) setRefSelected(refSelected.slice(0, 1)) }} />
                1개
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="radio" checked={refMode === 'multi'} onChange={() => setRefMode('multi')} />
                여러 개 mix
              </label>
            </div>

            {/* 선택된 릴스 */}
            {refSelected.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {refSelected.map(r => (
                  <div key={r.shortcode} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '4px 10px', background: 'var(--accent-light)',
                    border: '1px solid var(--accent)', borderRadius: 999, fontSize: 12,
                  }}>
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>@{r.author}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{r.shortcode}</span>
                    <button onClick={() => removeRef(r.shortcode)} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 14, padding: 0 }}>×</button>
                  </div>
                ))}
              </div>
            )}

            {/* 참고 구조 분석 카드 */}
            {refInfo && (() => {
              const subSelected = subUspIndices.size
              const bodyCount = refInfo.body_slot_count
              // 새 룰: main USP만 있으면 OK. sub은 선택사항 (body 다양화용).
              const ready = mainUspIndex !== null
              const optimalSubs = Math.max(0, bodyCount - 1)  // body마다 다른 USP 쓰려면 main + (body-1)개 sub
              return (
                <div style={{
                  background: ready ? '#ecfdf5' : '#eff6ff',
                  border: `1px solid ${ready ? '#34d399' : '#bfdbfe'}`,
                  borderRadius: 'var(--radius-sm)', padding: 10, marginBottom: 8,
                  fontSize: 11,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12 }}>
                    📊 참고 릴스 구조: <span style={{ color: '#1e40af' }}>{refInfo.body_class.type}</span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    • {refInfo.duration_sec.toFixed(0)}초 / {refInfo.total_sentences}문장 / Body 분절 <b>{bodyCount}개</b><br/>
                    • {refInfo.body_class.guide}
                  </div>

                  <div style={{ marginTop: 8, padding: 8, background: '#fff', borderRadius: 4, fontSize: 11 }}>
                    <b>필수</b>: <span style={{ color: '#f97316', fontWeight: 700 }}>메인 USP 1개</span> {mainUspIndex !== null ? '✓' : '✗'}
                    {bodyCount >= 2 && (
                      <>
                        <br/>
                        <b>선택</b>: <span style={{ color: 'var(--accent)' }}>서브 USP {optimalSubs}개</span>까지 추가하면 body 섹션마다 다른 USP 사용 가능 (현재 <b>{subSelected}개</b> 선택)
                        <br/>
                        <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                          • main 1개만 선택 = 모든 body가 main USP를 다양한 각도로 어필<br/>
                          • main + sub 추가 = body_1/2/3에 main·sub 적응형 매칭
                        </span>
                      </>
                    )}
                    {ready && <div style={{ color: '#065f46', marginTop: 4, fontWeight: 700 }}>✓ 준비 완료</div>}
                  </div>
                </div>
              )
            })()}

            {/* 검색 */}
            {(refMode === 'multi' || refSelected.length === 0) && (
              <div style={{ position: 'relative' }}>
                <input style={inputSt} value={refQuery}
                  onFocus={() => setShowSuggest(true)}
                  onChange={e => { setRefQuery(e.target.value); setShowSuggest(true) }}
                  placeholder="작성자나 코드로 검색..." />
                {showSuggest && refSuggest.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
                    background: 'var(--bg-surface)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)', maxHeight: 240, overflowY: 'auto', zIndex: 10,
                    boxShadow: 'var(--shadow-md)',
                  }}>
                    {refSuggest.map(r => (
                      <div key={r.shortcode} onClick={() => pickRef(r)} style={{
                        padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)',
                        display: 'flex', gap: 8, alignItems: 'center', fontSize: 12,
                      }}>
                        <span style={{ fontWeight: 600 }}>@{r.author}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{r.shortcode}</span>
                        <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>{r.play_count.toLocaleString()}회</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {err && <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>{err}</div>}

          {/* 생성 액션 */}
          {!Object.keys(drafts).length ? (
            <button onClick={generateDrafts}
              disabled={generating || !productName.trim() || refSelected.length === 0 || mainUspIndex === null}
              style={{
                width: '100%', padding: '12px 16px', fontSize: 14, fontWeight: 600,
                border: 'none', borderRadius: 'var(--radius-sm)',
                background: generating ? 'var(--text-muted)' : 'var(--accent)', color: '#fff',
                cursor: generating ? 'not-allowed' : 'pointer',
              }}>
              {generating
                ? `1차 생성 중… (페르소나 ${selectedPersonas.length || 1}개 동시)`
                : `🪄 1차 대본 생성 (페르소나 ${selectedPersonas.length || 1}개)`}
            </button>
          ) : (
            <button onClick={resetAll}
              style={{
                width: '100%', padding: '12px 16px', fontSize: 14, fontWeight: 600,
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer',
              }}>↺ 새 대본 작성</button>
          )}
        </div>

        {/* OUTPUT */}
        {(() => {
          const tabs = Object.keys(drafts)
          if (!tabs.length) return null
          const active = activeTab && drafts[activeTab] ? activeTab : tabs[0]
          const displayed = results[active] || drafts[active]
          if (!displayed) return null
          const isDraft = !results[active]
          return (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 20 }}>
            {/* 페르소나 탭 */}
            {tabs.length > 1 && (
              <div style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: '2px solid var(--border)' }}>
                {tabs.map(name => (
                  <button key={name} onClick={() => setActiveTab(name)} style={{
                    padding: '8px 14px', fontSize: 12, fontWeight: 700,
                    background: name === active ? 'var(--bg-surface)' : 'transparent',
                    color: name === active ? 'var(--accent)' : 'var(--text-muted)',
                    border: 'none',
                    borderBottom: name === active ? '2px solid var(--accent)' : '2px solid transparent',
                    marginBottom: -2, cursor: 'pointer',
                  }}>
                    {name === '_default' ? '자동 추론' : name}
                    {results[name] && <span style={{ marginLeft: 4, color: 'var(--success, #16a34a)' }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
            {isDraft && (
              <div style={{
                background: '#fff3cd', color: '#856404', padding: '6px 10px', borderRadius: 'var(--radius-sm)',
                fontSize: 11, fontWeight: 600, marginBottom: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              }}>
                <span>📝 1차 초안 — 다듬기로 완성</span>
                <button onClick={refineActive} disabled={!!refining}
                  style={{
                    padding: '5px 12px', fontSize: 11, fontWeight: 700,
                    border: 'none', borderRadius: 4,
                    background: refining ? 'var(--text-muted)' : 'var(--accent)', color: '#fff',
                    cursor: refining ? 'not-allowed' : 'pointer',
                  }}>
                  {refining === active ? '다듬는 중…' : '✨ 2차 다듬기'}
                </button>
              </div>
            )}
            {!isDraft && (
              <div style={{
                background: '#d4edda', color: '#155724', padding: '6px 10px', borderRadius: 'var(--radius-sm)',
                fontSize: 11, fontWeight: 600, marginBottom: 10,
              }}>✓ 2차 다듬기 완료 — 최종본</div>
            )}
            {(displayed as any)._target_persona && (
              <div style={{
                background: '#eff6ff', color: '#1e40af', padding: '6px 10px', borderRadius: 'var(--radius-sm)',
                fontSize: 11, marginBottom: 10,
              }}>
                🎯 페르소나: <b>{(displayed as any)._target_persona.name}</b>
                {(displayed as any)._target_persona.scenario && <> — {(displayed as any)._target_persona.scenario}</>}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>{isDraft ? '1차 초안' : '생성된 대본'} ({displayed.duration_target_sec}초)</h2>
              <button onClick={async () => {
                const text = displayed.tts_script || (displayed.sentences || []).map(s => s.text).join('\n')
                await navigator.clipboard.writeText(text)
                setCopied(true); setTimeout(() => setCopied(false), 1500)
              }} style={{ ...smallBtn('accent'), fontSize: 12 }}>
                {copied ? '✓ 복사됨' : '📋 TTS 스크립트 복사'}
              </button>
            </div>

            {/* 구조 (Hook/Intro/Body/CTA) */}
            {displayed.structure && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 16 }}>
                {([
                  ['Hook', 'hook', '#EF4444'],
                  ['Intro', 'intro', '#8B5CF6'],
                  ['Body', 'body', '#307df0'],
                  ['CTA', 'cta', '#F59E0B'],
                ] as const).map(([title, k, color]) => {
                  const sec = (displayed.structure as any)?.[k]
                  if (!sec) return null
                  return (
                    <div key={k} style={{
                      background: 'var(--bg-base)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)', padding: 10, borderTop: `3px solid ${color}`,
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 2 }}>{title}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>{sec.seconds}</div>
                      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-body)' }}>"{sec.text}"</div>
                      {sec.analysis && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{sec.analysis}</div>}
                    </div>
                  )
                })}
              </div>
            )}

            {/* 문장 타임라인 — 참고 릴스의 섹션 라벨을 시간 매칭으로 부여 */}
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>문장 타임라인</div>
            <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10, marginBottom: 12 }}>
              {(() => {
                const refSents = refScripts[refSelected[0]?.shortcode]?.sentences || []
                const findSection = (st: number, en: number): string => {
                  let bestOverlap = 0
                  let bestSection = ''
                  for (const r of refSents) {
                    const ov = Math.max(0, Math.min(en, r.end) - Math.max(st, r.start))
                    if (ov > bestOverlap) {
                      bestOverlap = ov
                      bestSection = (r.section || '').toLowerCase()
                    }
                  }
                  return bestSection
                }
                const sectionLabel = (sec: string) => sec === 'hook' ? 'Hook'
                  : sec === 'intro' ? 'Intro'
                  : sec === 'cta' ? 'CTA'
                  : sec.startsWith('body') ? sec.replace('_', ' ').toUpperCase()
                  : ''
                const sectionColor = (sec: string) => sec === 'hook' ? '#EF4444'
                  : sec === 'intro' ? '#8B5CF6'
                  : sec.startsWith('body') ? '#307df0'
                  : sec === 'cta' ? '#F59E0B'
                  : 'var(--text-muted)'
                return (displayed.sentences || []).map((s, i) => {
                  const sec = findSection(s.start, s.end)
                  const label = sectionLabel(sec)
                  const color = sectionColor(sec)
                  return (
                    <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 12, lineHeight: 1.7 }}>
                      <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 11, marginRight: 6 }}>
                        [{s.start.toFixed(1)}~{s.end.toFixed(1)}s]
                      </span>
                      {label && <span style={{
                        fontSize: 9, fontWeight: 700, color, padding: '1px 6px',
                        border: `1px solid ${color}`, borderRadius: 3, marginRight: 4,
                        textTransform: 'uppercase', letterSpacing: '.04em',
                      }}>{label}</span>}
                      {s.direction && <span style={{ background: '#ede9fe', color: '#7c3aed', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, marginRight: 4 }}>🎙 {s.direction}</span>}
                      {s.emotion && <span style={{ background: '#fce7f3', color: '#be185d', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, marginRight: 4 }}>{s.emotion}{s.intensity ? ` ${Math.round(s.intensity*100)}%` : ''}</span>}
                      {s.delivery && s.delivery !== 'normal' && <span style={{ background: '#FEF3C7', color: '#B45309', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, marginRight: 4 }}>{s.delivery}</span>}
                      <span>{s.text}</span>
                    </div>
                  )
                })
              })()}
            </div>

            {/* TTS Script */}
            {displayed.tts_script && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>TTS 스크립트</div>
                <textarea readOnly value={displayed.tts_script} style={{
                  ...textareaSt, minHeight: 140, fontSize: 12, lineHeight: 1.7, fontFamily: 'inherit',
                }} />
              </>
            )}

            {/* 전체 분석 */}
            {displayed.structure?.overall && (
              <div style={{
                marginTop: 12, padding: 12, fontSize: 12, lineHeight: 1.7,
                background: 'linear-gradient(135deg, #EFF6FF, #F5F3FF)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              }}>
                <strong>Flow:</strong> {displayed.structure.overall.flow}<br />
                <strong style={{ color: 'var(--success)' }}>Strength:</strong> {displayed.structure.overall.strength}<br />
                {displayed.structure.overall.why_it_works && <><strong>왜 작동할까:</strong> {displayed.structure.overall.why_it_works}</>}
              </div>
            )}

            {/* 참고 대본 */}
            {refSelected.length > 0 && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 }}>
                  📚 참고 대본 ({refSelected.length}개)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {refSelected.map(r => {
                    const rs = refScripts[r.shortcode]
                    return (
                      <div key={r.shortcode} style={{
                        background: 'var(--bg-base)', border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)', padding: 12,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 700 }}>
                            @{rs?.author || r.author || '—'}
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
                              {r.shortcode}
                            </span>
                          </div>
                          <a href={`/bench/${r.shortcode}`} target="_blank" rel="noopener noreferrer"
                            style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}>
                            상세 →
                          </a>
                        </div>
                        {!rs ? (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>대본 불러오는 중…</div>
                        ) : rs.sentences.length === 0 ? (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>대본 데이터 없음</div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {rs.sentences.map((s, i) => {
                              const sec = (s.section || '').toLowerCase()
                              const label = sec === 'hook' ? 'Hook'
                                : sec === 'intro' ? 'Intro'
                                : sec === 'cta' ? 'CTA'
                                : sec.startsWith('body') ? sec.replace('_', ' ').toUpperCase()
                                : ''
                              const color = sec === 'hook' ? '#EF4444'
                                : sec === 'intro' ? '#8B5CF6'
                                : sec.startsWith('body') ? '#307df0'
                                : sec === 'cta' ? '#F59E0B' : 'var(--text-muted)'
                              return (
                                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, lineHeight: 1.55 }}>
                                  <span style={{
                                    fontFamily: 'monospace', fontSize: 10,
                                    color: 'var(--text-muted)', flexShrink: 0, minWidth: 56,
                                  }}>
                                    {s.start.toFixed(1)}-{s.end.toFixed(1)}s
                                  </span>
                                  {label && (
                                    <span style={{
                                      fontSize: 9, fontWeight: 700, color, padding: '1px 6px',
                                      border: `1px solid ${color}`, borderRadius: 3,
                                      flexShrink: 0, textTransform: 'uppercase', letterSpacing: '.04em',
                                    }}>{label}</span>
                                  )}
                                  <span style={{ color: 'var(--text-primary)' }}>{s.text}</span>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
          )
        })()}
      </div>
    </>
  )
}

function smallBtn(variant: 'accent' | 'error' | 'muted'): React.CSSProperties {
  const colors = {
    accent: { bg: 'var(--accent-light)', color: 'var(--accent)', border: 'var(--accent)' },
    error: { bg: 'transparent', color: 'var(--error)', border: 'var(--error)' },
    muted: { bg: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: 'var(--border)' },
  }[variant]
  return {
    padding: '6px 12px', fontSize: 12, fontWeight: 600,
    border: `1px solid ${colors.border}`, borderRadius: 'var(--radius-sm)',
    background: colors.bg, color: colors.color, cursor: 'pointer',
  }
}
