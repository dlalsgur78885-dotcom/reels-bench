import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, BASE } from '../api'
import type { MyProduct, PersonaCandidate } from '../api'
import { getAccessToken } from '../supabase'

type Step = 'product' | 'mapping' | 'persona' | 'generating' | 'done'

type MappingPreview = Awaited<ReturnType<typeof api.previewMapping>>

interface GeneratedScript {
  duration_target_sec?: number
  sentences?: { start: number; end: number; text: string; direction?: string; emotion?: string; intensity?: number }[]
  tts_script?: string
  _usp_mapping?: any[]
}

const labelSt: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-muted)', marginBottom: 8,
}

const cardSt: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)', padding: 18, marginBottom: 14,
}

export default function ScriptGenWizard() {
  const { shortcode } = useParams<{ shortcode: string }>()
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('product')

  // 1. 상품
  const [products, setProducts] = useState<MyProduct[]>([])
  const [productId, setProductId] = useState<number | null>(null)

  // 2. 매핑
  const [mapping, setMapping] = useState<MappingPreview | null>(null)
  const [mappingLoading, setMappingLoading] = useState(false)
  const [mappingError, setMappingError] = useState('')
  // 사용자 수동 override (ref_usp_id → user_usp_id) — null 매칭 자리 채우기
  const [overrides, setOverrides] = useState<Record<number, number>>({})
  // chunk별 override (chunk.section → user_usp_id) — body 분석 결과 직접 변경
  const [chunkOverrides, setChunkOverrides] = useState<Record<string, number>>({})
  // chunk metadata 수정 (topic/role/section) — 이번 generation에만 적용
  const [chunkEdits, setChunkEdits] = useState<Record<string, { topic: string; role: string; section?: string }>>({})
  const [editingChunk, setEditingChunk] = useState<Record<string, boolean>>({})

  // 3. 페르소나
  const [allPersonas, setAllPersonas] = useState<Array<PersonaCandidate & { _uspIndex: number; _uspName: string }>>([])
  const [selectedPersonaIdx, setSelectedPersonaIdx] = useState<Set<number>>(new Set())
  // ref-derived desire 후보 (참고 대본 emotional arc 기반)
  const [selectedRefDesireIdx, setSelectedRefDesireIdx] = useState<Set<number>>(new Set())

  // 4. 생성
  const [genError, setGenError] = useState('')
  const [genResult, setGenResult] = useState<Record<string, GeneratedScript>>({})

  useEffect(() => {
    api.listMyProducts().then(setProducts).catch(() => {})
  }, [])

  const goToMapping = async (pid: number) => {
    if (!shortcode) return
    setProductId(pid)
    setStep('mapping')
    setMappingLoading(true)
    setMappingError('')
    setOverrides({})
    setChunkOverrides({})
    try {
      const r = await api.previewMapping(shortcode, pid)
      setMapping(r)
    } catch (e: any) {
      setMappingError(e.message || String(e))
    } finally {
      setMappingLoading(false)
    }
  }

  // 새 USP를 즉석 생성 + my_products DB에 저장 + 매핑 자동 적용
  const createUspForRef = async (
    refUspId: number,
    name: string,
    description: string,
    reviews: string[],
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!mapping || !productId) return { ok: false, error: '매핑/상품 미로드' }
    if (!name.trim()) return { ok: false, error: 'USP 이름 필수' }
    const cleanReviews = reviews.map(r => r.trim()).filter(Boolean)
    const newUsp: any = {
      usp: name.trim(),
      description: description.trim() || undefined,
      reviews: cleanReviews,
    }
    const newUsps = [...mapping.product.usps, newUsp]
    try {
      await api.updateMyProduct(productId, {
        name: mapping.product.name,
        usps: newUsps,
      })
    } catch (e: any) {
      return { ok: false, error: e.message || 'DB 저장 실패' }
    }
    // 로컬 매핑 갱신 + override 자동 적용
    const newUserUspId = newUsps.length  // 1-based id
    setMapping({ ...mapping, product: { ...mapping.product, usps: newUsps } })
    setOverrides({ ...overrides, [refUspId]: newUserUspId })
    return { ok: true }
  }

  // 자동 매핑 + override를 합친 effective 매핑
  const effectiveUserUspId = (m: MappingPreview['usp_mapping'][number]): number | null => {
    if (overrides[m.ref_usp_id]) return overrides[m.ref_usp_id]
    return m.user_usp_id
  }

  // chunk별 effective user_usp_id (precedence: chunkOverride > refUspOverride > auto)
  const effectiveChunkUspId = (chunk: MappingPreview['section_chunks'][number]): number | null => {
    const sec = chunk.section || ''
    if (chunkOverrides[sec]) return chunkOverrides[sec]
    const refId = chunk.primary_usp_id
    if (!refId) return null
    if (overrides[refId]) return overrides[refId]
    const m = mapping?.usp_mapping.find(x => x.ref_usp_id === refId)
    return m ? m.user_usp_id : null
  }

  // override 적용 후 unused user USPs 재계산 (chunk-level 사용 우선)
  const effectiveUnusedUsps = (() => {
    if (!mapping) return []
    const used = new Set<number>()
    mapping.section_chunks.forEach(c => {
      const eff = effectiveChunkUspId(c)
      if (eff) used.add(eff)
    })
    // chunk가 ref USP 없는 (hook/intro/cta) 경우는 ref USP override도 고려
    mapping.usp_mapping.forEach(m => {
      const eff = effectiveUserUspId(m)
      if (eff) used.add(eff)
    })
    return mapping.product.usps
      .map((u: any, i: number) => ({ user_usp_id: i + 1, user_usp_name: u.usp }))
      .filter(u => !used.has(u.user_usp_id))
  })()

  const [personaRefreshing, setPersonaRefreshing] = useState(false)
  const [refreshingUspIdx, setRefreshingUspIdx] = useState<number | null>(null)

  const refreshSingleUspPersonas = async (uspIdx: number) => {
    if (!mapping || !productId) return
    const u: any = mapping.product.usps[uspIdx]
    if (!u || !u.usp) return
    setRefreshingUspIdx(uspIdx)
    try {
      const r = await api.extractPersonas(u.usp || '', u.reviews || [], '', productId, uspIdx)
      const personas = r.personas || []
      const newUsps = mapping.product.usps.map((x: any, i: number) =>
        i === uspIdx ? { ...x, personas } : x,
      )
      const newMapping = { ...mapping, product: { ...mapping.product, usps: newUsps } }
      setMapping(newMapping)
      // allPersonas 갱신 — matched USP 인덱스에 한해
      const matched = new Set<number>()
      mapping.usp_mapping.forEach(m => {
        const eff = effectiveUserUspId(m)
        if (eff) matched.add(eff)
      })
      const collected: typeof allPersonas = []
      newUsps.forEach((x: any, i: number) => {
        if (!matched.has(i + 1)) return
        const ps: PersonaCandidate[] = (x.personas as PersonaCandidate[]) || []
        ps.forEach(p => {
          collected.push({ ...p, _uspIndex: i + 1, _uspName: x.usp })
        })
      })
      setAllPersonas(collected)
    } catch {
      // ignore
    } finally {
      setRefreshingUspIdx(null)
    }
  }

  const matchedUserUspsInfo = (() => {
    if (!mapping) return [] as Array<{ idx: number; name: string; personaCount: number; reviewCount: number }>
    const matched = new Set<number>()
    mapping.section_chunks.forEach(c => {
      const eff = effectiveChunkUspId(c)
      if (eff) matched.add(eff)
    })
    mapping.usp_mapping.forEach(m => {
      const eff = effectiveUserUspId(m)
      if (eff) matched.add(eff)
    })
    return mapping.product.usps
      .map((u: any, i: number) => ({
        idx: i,
        name: u.usp || '',
        personaCount: (u.personas || []).length,
        reviewCount: (u.reviews || []).filter(Boolean).length,
        match: matched.has(i + 1),
      }))
      .filter(x => x.match)
      .map(({ match: _m, ...rest }) => rest)
  })()

  const goToPersona = async () => {
    if (!mapping) return
    setStep('persona')

    // override 반영한 매칭된 user USP 인덱스 (chunk-level + ref-level)
    const matched = new Set<number>()
    mapping.section_chunks.forEach(c => {
      const eff = effectiveChunkUspId(c)
      if (eff) matched.add(eff)
    })
    mapping.usp_mapping.forEach(m => {
      const eff = effectiveUserUspId(m)
      if (eff) matched.add(eff)
    })

    // pain/desire 없는 USP를 식별하고 재추출 (병렬)
    const stale: { idx: number; usp: any }[] = []
    mapping.product.usps.forEach((u: any, i: number) => {
      if (!matched.has(i + 1)) return
      const personas: PersonaCandidate[] = (u.personas as PersonaCandidate[]) || []
      const missing = personas.length === 0 || personas.some(p => !p.pain || !p.desire)
      if (missing && (u.reviews?.length || 0) > 0) {
        stale.push({ idx: i, usp: u })
      }
    })

    let refreshedUsps = mapping.product.usps
    if (stale.length > 0) {
      setPersonaRefreshing(true)
      try {
        const results = await Promise.all(
          stale.map(({ idx, usp }) =>
            api.extractPersonas(
              usp.usp || '',
              usp.reviews || [],
              '',
              productId || undefined,
              idx,
            ).then(r => ({ idx, personas: r.personas })).catch(() => ({ idx, personas: [] as PersonaCandidate[] })),
          ),
        )
        refreshedUsps = mapping.product.usps.map((u: any, i: number) => {
          const found = results.find(r => r.idx === i)
          if (found && found.personas.length > 0) {
            return { ...u, personas: found.personas }
          }
          return u
        })
        setMapping({ ...mapping, product: { ...mapping.product, usps: refreshedUsps } })
      } catch (e) {
        // ignore — 기존 데이터로 진행
      } finally {
        setPersonaRefreshing(false)
      }
    }

    // 페르소나 모으기
    const collected: typeof allPersonas = []
    refreshedUsps.forEach((u: any, i: number) => {
      if (!matched.has(i + 1)) return
      const personas: PersonaCandidate[] = (u.personas as PersonaCandidate[]) || []
      personas.forEach(p => {
        collected.push({ ...p, _uspIndex: i + 1, _uspName: u.usp })
      })
    })
    setAllPersonas(collected)
    setSelectedPersonaIdx(new Set())
  }

  const generate = async () => {
    if (!mapping || !shortcode) return
    setStep('generating')
    setGenError('')
    setGenResult({})
    const cleanUsps = mapping.product.usps.map((u: any) => ({
      usp: (u.usp || '').trim(),
      description: (u.description || '').trim() || undefined,
      reviews: (u.reviews || []).map((r: string) => r.trim()).filter(Boolean),
    })).filter((u: any) => u.usp)

    // 1) USP 페르소나 + 2) ref-derived desire 후보를 합쳐 사용
    type PersonaLike = (PersonaCandidate & { _label?: string }) | null
    const productPersonas: PersonaLike[] = Array.from(selectedPersonaIdx).map(i => allPersonas[i])
    const refDesires = mapping?.ref_desires || []
    const refPersonas: PersonaLike[] = Array.from(selectedRefDesireIdx).map(i => {
      const r = refDesires[i]
      if (!r) return null
      return {
        name: `[참고 대본] ${r.name}`,
        scenario: r.scenario,
        signals: [],
        destinations: [],
        tone_hint: '',
        pain: r.pain,
        desire: r.desire,
        job_statement: r.job_statement,
        lf8: r.lf8,
        lf8_label: r.lf8_label,
        pain_scene: r.pain_scene,
        desire_scene: r.desire_scene,
        identity: r.identity,
        review_count: 0,
        sample_reviews: [],
      } as PersonaCandidate
    }).filter((p): p is PersonaCandidate => !!p)
    const personas: PersonaLike[] = [...productPersonas, ...refPersonas]
    if (personas.length === 0) personas.push(null)

    try {
      const token = await getAccessToken()
      const calls = personas.map(async (persona): Promise<[string, GeneratedScript]> => {
        const r = await fetch(`${BASE}/api/script/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
          body: JSON.stringify({
            product_name: mapping.product.name,
            pain: '', desire: '',
            usps: cleanUsps,
            reference_shortcodes: [shortcode],
            refine: false,
            target_persona: persona ? {
              name: persona.name, scenario: persona.scenario, signals: persona.signals,
              destinations: persona.destinations || [], tone_hint: persona.tone_hint,
              pain: persona.pain || '', desire: persona.desire || '',
              job_statement: persona.job_statement || '',
              lf8: persona.lf8 || null, lf8_label: persona.lf8_label || '',
              pain_scene: persona.pain_scene || '',
              desire_scene: persona.desire_scene || '',
              identity: persona.identity || '',
            } : null,
            usp_mapping_override: Object.keys(overrides).length
              ? Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, v]))
              : undefined,
            chunk_usp_override: Object.keys(chunkOverrides).length
              ? chunkOverrides
              : undefined,
            chunk_meta_override: Object.keys(chunkEdits).length
              ? chunkEdits
              : undefined,
          }),
        })
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
        return [persona ? persona.name : '기본', await r.json()]
      })
      const settled = await Promise.allSettled(calls)
      const out: Record<string, GeneratedScript> = {}
      settled.forEach(s => {
        if (s.status === 'fulfilled') {
          const [name, draft] = s.value
          out[name] = draft
        }
      })
      if (Object.keys(out).length === 0) throw new Error('모든 호출 실패')
      setGenResult(out)
      setStep('done')
    } catch (e: any) {
      setGenError(e.message || String(e))
      setStep('persona')
    }
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: 20 }}>
      <button onClick={() => navigate(`/bench/${shortcode}`)}
        style={{
          background: 'transparent', border: '1px solid var(--border)', padding: '6px 14px',
          borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-body)',
          fontSize: 12, marginBottom: 16,
        }}>
        ← 분석 페이지
      </button>

      <Stepper step={step} />

      {step === 'product' && (
        <StepProduct
          products={products}
          productId={productId}
          onSelect={goToMapping}
        />
      )}

      {step === 'mapping' && (
        <StepMapping
          mapping={mapping}
          loading={mappingLoading}
          error={mappingError}
          overrides={overrides}
          chunkOverrides={chunkOverrides}
          unusedUsps={effectiveUnusedUsps}
          onChunkOverride={(section, userId) => {
            const next = { ...chunkOverrides }
            if (userId === null) delete next[section]
            else next[section] = userId
            setChunkOverrides(next)
          }}
          getEffectiveChunkUspId={effectiveChunkUspId}
          chunkEdits={chunkEdits}
          editingChunk={editingChunk}
          setChunkEdits={setChunkEdits}
          toggleChunkEdit={(section, currentTopic, currentRole) => {
            setEditingChunk(prev => {
              const next = { ...prev }
              if (next[section]) delete next[section]
              else {
                next[section] = true
                // 편집 시작 시 현재 값을 default로 채워줌
                setChunkEdits(p => ({
                  ...p,
                  [section]: p[section] || { topic: currentTopic, role: currentRole },
                }))
              }
              return next
            })
          }}
          onCreateUsp={createUspForRef}
          onBack={() => setStep('product')}
          onNext={goToPersona}
        />
      )}

      {step === 'persona' && personaRefreshing && (
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: 18, marginBottom: 14,
          textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13,
        }}>
          페르소나 pain/desire 재추출 중…
        </div>
      )}

      {step === 'persona' && !personaRefreshing && (
        <StepPersona
          mapping={mapping}
          personas={allPersonas}
          matchedUserUsps={matchedUserUspsInfo}
          onRefreshUspPersonas={refreshSingleUspPersonas}
          refreshingUspIdx={refreshingUspIdx}
          selected={selectedPersonaIdx}
          selectedRefDesireIdx={selectedRefDesireIdx}
          onToggleRefDesire={(i) => {
            const next = new Set(selectedRefDesireIdx)
            if (next.has(i)) next.delete(i)
            else if (selectedPersonaIdx.size + next.size < 2) next.add(i)
            setSelectedRefDesireIdx(next)
          }}
          onToggle={(i) => {
            const next = new Set(selectedPersonaIdx)
            if (next.has(i)) next.delete(i)
            else if (next.size + selectedRefDesireIdx.size < 2) next.add(i)
            setSelectedPersonaIdx(next)
          }}
          error={genError}
          onBack={() => setStep('mapping')}
          onGenerate={generate}
        />
      )}

      {step === 'generating' && (
        <div style={{ ...cardSt, textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            대본 생성 중… (페르소나 {selectedPersonaIdx.size || 1}개 동시)
          </div>
        </div>
      )}

      {step === 'done' && (
        <StepDone
          result={genResult}
          onRestart={() => {
            setStep('product')
            setProductId(null)
            setMapping(null)
            setAllPersonas([])
            setSelectedPersonaIdx(new Set())
            setGenResult({})
          }}
        />
      )}
    </div>
  )
}

function Stepper({ step }: { step: Step }) {
  const items: [Step | 'all', string][] = [
    ['product', '상품'],
    ['mapping', '매핑 리뷰'],
    ['persona', '페르소나'],
    ['done', '결과'],
  ]
  const order: Step[] = ['product', 'mapping', 'persona', 'done']
  const stepIdx = order.indexOf(step === 'generating' ? 'persona' : step)
  return (
    <div style={{ display: 'flex', gap: 0, marginBottom: 20, alignItems: 'center' }}>
      {items.map(([s, label], i) => {
        const idx = order.indexOf(s as Step)
        const active = idx === stepIdx
        const done = idx < stepIdx
        return (
          <div key={s} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 14px', borderRadius: 'var(--radius-pill)',
              background: active ? 'var(--accent-light)' : 'transparent',
              fontWeight: active ? 700 : 500,
              color: active ? 'var(--accent)' : (done ? 'var(--text-secondary)' : 'var(--text-muted)'),
              fontSize: 12,
            }}>
              <span style={{
                width: 18, height: 18, borderRadius: '50%',
                background: active ? 'var(--accent)' : (done ? 'var(--text-secondary)' : 'var(--bg-elevated)'),
                color: active || done ? '#fff' : 'var(--text-muted)',
                fontSize: 11, fontWeight: 700,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>{i + 1}</span>
              {label}
            </div>
            {i < items.length - 1 && (
              <div style={{
                flex: 1, height: 1, background: 'var(--border)', margin: '0 4px',
              }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function StepProduct({
  products, productId, onSelect,
}: {
  products: MyProduct[]
  productId: number | null
  onSelect: (id: number) => void
}) {
  return (
    <div style={cardSt}>
      <div style={labelSt}>1단계 — 상품 선택</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
        이 참고 릴스로 어떤 상품의 대본을 만들지 선택하세요.
      </div>
      {products.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          등록된 상품이 없습니다. /my-products 에서 추가하세요.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {products.map(p => {
            const active = p.id === productId
            return (
              <button key={p.id} onClick={() => onSelect(p.id)}
                style={{
                  textAlign: 'left', padding: '12px 14px',
                  background: active ? 'var(--accent-light)' : 'var(--bg-surface)',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-md)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                }}>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    USP {p.usps?.length || 0}개
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--accent)' }}>선택 →</div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StepMapping({
  mapping, loading, error, overrides, chunkOverrides, unusedUsps, onChunkOverride,
  getEffectiveChunkUspId, chunkEdits, editingChunk, setChunkEdits, toggleChunkEdit,
  onCreateUsp, onBack, onNext,
}: {
  mapping: MappingPreview | null
  loading: boolean
  error: string
  overrides: Record<number, number>
  chunkOverrides: Record<string, number>
  unusedUsps: { user_usp_id: number; user_usp_name: string }[]
  onChunkOverride: (section: string, userId: number | null) => void
  getEffectiveChunkUspId: (chunk: MappingPreview['section_chunks'][number]) => number | null
  chunkEdits: Record<string, { topic: string; role: string }>
  editingChunk: Record<string, boolean>
  setChunkEdits: React.Dispatch<React.SetStateAction<Record<string, { topic: string; role: string; section?: string }>>>
  toggleChunkEdit: (section: string, currentTopic: string, currentRole: string) => void
  onCreateUsp: (refUspId: number, name: string, description: string, reviews: string[]) => Promise<{ ok: boolean; error?: string }>
  onBack: () => void
  onNext: () => void
}) {
  const [creatingFor, setCreatingFor] = useState<number | null>(null)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newReviews, setNewReviews] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState('')

  const startCreate = (refUspId: number, refDesc: string) => {
    setCreatingFor(refUspId)
    setNewName('')
    setNewDesc(refDesc)  // ref USP 설명을 default로 채워서 사용자 시작점 제공
    setNewReviews('')
    setCreateErr('')
  }
  const cancelCreate = () => {
    setCreatingFor(null)
    setCreateErr('')
  }
  const submitCreate = async () => {
    if (!creatingFor) return
    setCreating(true)
    setCreateErr('')
    const reviews = newReviews.split('\n').map(s => s.trim()).filter(Boolean)
    const r = await onCreateUsp(creatingFor, newName, newDesc, reviews)
    setCreating(false)
    if (r.ok) {
      setCreatingFor(null)
    } else {
      setCreateErr(r.error || '실패')
    }
  }

  if (loading) {
    return (
      <div style={{ ...cardSt, textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>매핑 분석 중…</div>
      </div>
    )
  }
  if (error) {
    return (
      <div style={cardSt}>
        <div style={{ color: 'var(--error)', fontSize: 13 }}>{error}</div>
        <button onClick={onBack} style={ghostBtnSt}>← 다시</button>
      </div>
    )
  }
  if (!mapping) return null

  // ref USP id → mapping record (override 반영한 effective)
  const mappingByRefId = new Map<number, MappingPreview['usp_mapping'][number]>()
  mapping.usp_mapping.forEach(m => mappingByRefId.set(m.ref_usp_id, m))

  return (
    <>
      <div style={cardSt}>
        <div style={labelSt}>2단계 — 매핑 리뷰</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          참고 릴스의 각 섹션 chunk와 그에 매핑된 우리 USP. 자동 매칭이 안 된 자리는 드롭다운으로 직접 채우거나 페르소나로 풀 수 있습니다.
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          {mapping.section_chunks.map((chunk, ci) => {
            const refUspId = chunk.primary_usp_id
            const mappingRec = refUspId ? mappingByRefId.get(refUspId) : null
            const isPersonaSlot = !refUspId  // hook/intro/cta 일부 — 특정 USP 없음

            return (
              <div key={ci} style={{
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)', padding: 14,
              }}>
                {/* 헤더: 섹션 라벨 + 토픽 + 역할 + 약한매칭 경고 */}
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                    color: 'var(--text-secondary)',
                    padding: '3px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                  }}>
                    {chunk.section}
                  </span>
                  {chunk.role && !editingChunk[chunk.section] && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {chunk.role}
                    </span>
                  )}
                  {chunk.topic && !editingChunk[chunk.section] && (
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {chunk.topic}
                    </span>
                  )}
                  {mappingRec?.confidence === 'loose' && (
                    <span title="ref USP와 우리 USP의 도메인·메커니즘 차이가 있어 writer가 풀기 어려울 수 있습니다" style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 7px',
                      background: 'rgba(245,158,11,0.15)', color: 'var(--warning)',
                      borderRadius: 'var(--radius-sm)', letterSpacing: '0.03em',
                      border: '1px solid var(--warning)',
                    }}>
                      ⚠ 약한 매칭
                    </span>
                  )}
                  {!isPersonaSlot && (
                    <button
                      onClick={() => toggleChunkEdit(chunk.section, chunk.topic || '', chunk.role || '')}
                      style={{
                        marginLeft: 'auto', padding: '2px 8px', fontSize: 11,
                        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                        background: 'var(--bg-surface)', color: 'var(--text-body)',
                        cursor: 'pointer',
                      }}>
                      {editingChunk[chunk.section] ? '저장' : '✏ 분석 수정'}
                    </button>
                  )}
                </div>
                {editingChunk[chunk.section] && (
                  <div style={{ marginBottom: 10, padding: 10, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                      <input
                        value={chunkEdits[chunk.section]?.section ?? chunk.section ?? ''}
                        onChange={(e) => setChunkEdits(prev => ({
                          ...prev, [chunk.section]: {
                            topic: prev[chunk.section]?.topic ?? chunk.topic ?? '',
                            role: prev[chunk.section]?.role ?? chunk.role ?? '',
                            section: e.target.value,
                          },
                        }))}
                        placeholder="섹션 (예: body_2)"
                        style={{ flex: 1, padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)' }}
                      />
                      <input
                        value={chunkEdits[chunk.section]?.topic ?? chunk.topic ?? ''}
                        onChange={(e) => setChunkEdits(prev => ({
                          ...prev, [chunk.section]: {
                            topic: e.target.value,
                            role: prev[chunk.section]?.role ?? chunk.role ?? '',
                            section: prev[chunk.section]?.section,
                          },
                        }))}
                        placeholder="토픽 (예: 셔링 가슴 보정)"
                        style={{ flex: 2, padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)' }}
                      />
                      <input
                        value={chunkEdits[chunk.section]?.role ?? chunk.role ?? ''}
                        onChange={(e) => setChunkEdits(prev => ({
                          ...prev, [chunk.section]: {
                            topic: prev[chunk.section]?.topic ?? chunk.topic ?? '',
                            role: e.target.value,
                            section: prev[chunk.section]?.section,
                          },
                        }))}
                        placeholder="역할 (디테일/시연/proof)"
                        style={{ flex: 1, padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)' }}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      변경한 값은 이번 대본 생성에만 적용됩니다. 섹션 변경 (예: body_2 → body_3)은 writer 호출 그룹을 바꿉니다.
                    </div>
                  </div>
                )}

                {/* ref 대본 */}
                {chunk.sentences && chunk.sentences.length > 0 && (
                  <div style={{
                    background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)',
                    padding: '10px 12px', marginBottom: 10,
                  }}>
                    {chunk.sentences.map((s, si) => (
                      <div key={si} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-body)' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: 11, marginRight: 8 }}>
                          {s.start.toFixed(1)}–{s.end.toFixed(1)}s
                        </span>
                        {s.text}
                      </div>
                    ))}
                  </div>
                )}

                {/* USP 매핑 영역 */}
                {isPersonaSlot ? (
                  <div style={{
                    fontSize: 12, color: 'var(--text-secondary)',
                    padding: '8px 12px', background: 'var(--bg-base)',
                    borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border)',
                  }}>
                    이 chunk는 특정 USP에 묶이지 않습니다 — <b>페르소나 톤 + ref 구조</b>로 작성됩니다.
                  </div>
                ) : mappingRec && (() => {
                  const chunkUserId = getEffectiveChunkUspId(chunk)
                  const isChunkOverride = chunkOverrides[chunk.section] !== undefined
                  // 모든 user USP 옵션 (chunk별로 자유롭게 다 선택 가능 — unused 제한 X)
                  const allUserUsps = mapping.product.usps.map((u: any, i: number) => ({
                    user_usp_id: i + 1, user_usp_name: u.usp,
                  }))
                  return (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(180px, 1fr) 16px minmax(220px, 1fr) 1.3fr',
                    gap: 10, alignItems: 'start', fontSize: 13,
                    padding: '8px 0',
                  }}>
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        ref USP{mappingRec.ref_usp_id}{mappingRec.ref_label ? ` · ${mappingRec.ref_label}` : ''}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {mappingRec.ref_description}
                      </div>
                    </div>
                    <div style={{ color: 'var(--text-muted)', paddingTop: 2 }}>→</div>
                    <div>
                      <div style={{
                        fontWeight: 600,
                        color: chunkUserId ? 'var(--text-primary)' : 'var(--warning)',
                        marginBottom: 6, fontSize: 12,
                      }}>
                        {chunkUserId
                          ? (() => {
                            const u = allUserUsps.find(x => x.user_usp_id === chunkUserId)
                            const tag = isChunkOverride ? ' (chunk 수동)' : (overrides[mappingRec.ref_usp_id] ? ' (ref 수동)' : '')
                            return `USP${chunkUserId} · ${u?.user_usp_name || ''}${tag}`
                          })()
                          : '매칭 없음'}
                      </div>
                      <select
                        value={chunkUserId || ''}
                        onChange={(e) => {
                          const v = e.target.value
                          onChunkOverride(chunk.section, v ? Number(v) : null)
                        }}
                        style={{
                          width: '100%', padding: '6px 10px', fontSize: 12,
                          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                          background: 'var(--bg-base)', color: 'var(--text-primary)',
                        }}>
                        <option value="">— 매핑 없음 (페르소나로 풀기) —</option>
                        {allUserUsps.map(u => (
                          <option key={u.user_usp_id} value={u.user_usp_id}>
                            USP{u.user_usp_id} · {u.user_usp_name}
                          </option>
                        ))}
                      </select>
                      {creatingFor === mappingRec.ref_usp_id ? (
                        <div style={{
                          marginTop: 8, padding: 10,
                          background: 'var(--bg-base)', border: '1px solid var(--accent)',
                          borderRadius: 'var(--radius-sm)',
                        }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', marginBottom: 6 }}>
                            새 USP 만들기 (저장하면 내 상품 DB에 추가됨)
                          </div>
                          <input
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            placeholder="USP 이름 (예: 노카라잠옷)"
                            style={{
                              width: '100%', padding: '7px 10px', fontSize: 12, marginBottom: 6,
                              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                              background: 'var(--bg-surface)',
                            }}
                          />
                          <textarea
                            value={newDesc}
                            onChange={(e) => setNewDesc(e.target.value)}
                            placeholder="설명 (선택, 한 줄. 형식 예: 문제: ... / 해결: ... / 혜택: ...)"
                            rows={2}
                            style={{
                              width: '100%', padding: '7px 10px', fontSize: 12, marginBottom: 6,
                              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                              background: 'var(--bg-surface)', resize: 'vertical', fontFamily: 'inherit',
                            }}
                          />
                          <textarea
                            value={newReviews}
                            onChange={(e) => setNewReviews(e.target.value)}
                            placeholder={'리뷰 (한 줄에 하나씩)\n예: 부드러운 촉감이 정말 좋아요\n예: 잘 때 편해서 매일 입어요'}
                            rows={4}
                            style={{
                              width: '100%', padding: '7px 10px', fontSize: 12, marginBottom: 6,
                              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                              background: 'var(--bg-surface)', resize: 'vertical', fontFamily: 'inherit',
                            }}
                          />
                          {createErr && (
                            <div style={{ fontSize: 11, color: 'var(--error)', marginBottom: 6 }}>{createErr}</div>
                          )}
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={submitCreate} disabled={creating || !newName.trim()} style={{
                              ...primaryBtnSt, padding: '6px 14px', fontSize: 12,
                              opacity: (creating || !newName.trim()) ? 0.5 : 1,
                              cursor: (creating || !newName.trim()) ? 'not-allowed' : 'pointer',
                            }}>
                              {creating ? '저장 중…' : '저장 + 매핑'}
                            </button>
                            <button onClick={cancelCreate} disabled={creating} style={{
                              ...ghostBtnSt, padding: '6px 14px', fontSize: 12,
                            }}>취소</button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => startCreate(mappingRec.ref_usp_id, mappingRec.ref_description)}
                          style={{
                            marginTop: 6, padding: '6px 12px', fontSize: 11, fontWeight: 500,
                            background: 'transparent', color: 'var(--accent)',
                            border: '1px dashed var(--accent)', borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                          }}>
                          + 새 USP 만들기 (이 자리용)
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {mappingRec.reason}
                    </div>
                  </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      </div>

      {unusedUsps.length > 0 && (
        <div style={cardSt}>
          <div style={labelSt}>사용 안 된 우리 USP</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
            이번 대본에서 다음 USP는 등장하지 않습니다. 위 chunk 중 미매칭 자리에 직접 매핑할 수 있어요.
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {unusedUsps.map(u => (
              <li key={u.user_usp_id} style={{ fontSize: 13, marginBottom: 4 }}>
                <b>USP{u.user_usp_id}</b> — {u.user_usp_name}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
        <button onClick={onBack} style={ghostBtnSt}>← 상품 다시</button>
        <button onClick={onNext} style={primaryBtnSt}>페르소나 선택 →</button>
      </div>
    </>
  )
}

function StepPersona({
  mapping, personas, matchedUserUsps, selected, onToggle, onRefreshUspPersonas, refreshingUspIdx,
  selectedRefDesireIdx, onToggleRefDesire,
  error, onBack, onGenerate,
}: {
  mapping: MappingPreview | null
  personas: Array<PersonaCandidate & { _uspIndex: number; _uspName: string }>
  matchedUserUsps: Array<{ idx: number; name: string; personaCount: number; reviewCount: number }>
  selected: Set<number>
  onToggle: (i: number) => void
  onRefreshUspPersonas: (uspIdx: number) => Promise<void>
  refreshingUspIdx: number | null
  selectedRefDesireIdx: Set<number>
  onToggleRefDesire: (i: number) => void
  error: string
  onBack: () => void
  onGenerate: () => void
}) {
  if (!mapping) return null
  return (
    <>
      <div style={cardSt}>
        <div style={labelSt}>매칭된 USP — 페르소나 보유 현황</div>
        <div style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
          {matchedUserUsps.map(u => (
            <div key={u.idx} style={{
              display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
              padding: '8px 12px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)',
            }}>
              <span style={{ fontWeight: 600 }}>USP{u.idx + 1} · {u.name}</span>
              <span style={{ color: u.personaCount > 0 ? 'var(--success)' : 'var(--warning)', fontSize: 12 }}>
                페르소나 {u.personaCount}개
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>리뷰 {u.reviewCount}개</span>
              <button
                onClick={() => onRefreshUspPersonas(u.idx)}
                disabled={refreshingUspIdx === u.idx || u.reviewCount === 0}
                style={{
                  marginLeft: 'auto', padding: '4px 10px', fontSize: 11,
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-surface)', color: 'var(--text-body)',
                  cursor: refreshingUspIdx === u.idx ? 'not-allowed' : (u.reviewCount === 0 ? 'not-allowed' : 'pointer'),
                  opacity: refreshingUspIdx === u.idx || u.reviewCount === 0 ? 0.5 : 1,
                }}>
                {refreshingUspIdx === u.idx ? '추출 중…' : '페르소나 재추출'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {(mapping.ref_desires || []).length > 0 && (
        <div style={cardSt}>
          <div style={labelSt}>참고 대본 기반 desire/pain 후보</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
            참고 릴스의 hook/intro/페르소나성 chunk가 어필하는 emotional thrust. 우리 대본에 같은 desire를 녹이고 싶다면 선택.
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {(mapping.ref_desires || []).map((d, i) => {
              const checked = selectedRefDesireIdx.has(i)
              const disabled = !checked && (selected.size + selectedRefDesireIdx.size >= 2)
              return (
                <label key={i} style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start',
                  padding: '10px 12px',
                  background: checked ? 'var(--accent-light)' : 'var(--bg-surface)',
                  border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-md)',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.5 : 1,
                }}>
                  <input type="checkbox" checked={checked} disabled={disabled}
                    onChange={() => onToggleRefDesire(i)}
                    style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 7px',
                        background: 'var(--accent)', color: '#fff', borderRadius: 'var(--radius-sm)',
                        letterSpacing: '0.05em',
                      }}>REF</span>
                      <span>{d.name}</span>
                      {d.lf8 && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 7px',
                          background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                          borderRadius: 'var(--radius-sm)', letterSpacing: '0.03em',
                        }}>LF8 #{d.lf8} {d.lf8_label || ''}</span>
                      )}
                    </div>
                    {d.scenario && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{d.scenario}</div>
                    )}
                    {d.job_statement && (
                      <div style={{ fontSize: 12, color: 'var(--text-body)', marginTop: 6, fontStyle: 'italic' }}>
                        {d.job_statement}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
                      {(d.pain_scene || d.pain) && (
                        <div>
                          <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginRight: 6 }}>pain</span>
                          <span style={{ color: 'var(--text-body)' }}>{d.pain_scene || d.pain}</span>
                        </div>
                      )}
                      {(d.desire_scene || d.desire) && (
                        <div>
                          <span style={{ color: 'var(--accent)', fontWeight: 600, marginRight: 6 }}>desire</span>
                          <span style={{ color: 'var(--text-body)' }}>{d.desire_scene || d.desire}</span>
                        </div>
                      )}
                      {d.identity && (
                        <div>
                          <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginRight: 6 }}>identity</span>
                          <span style={{ color: 'var(--text-body)' }}>{d.identity}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
        </div>
      )}

      <div style={cardSt}>
        <div style={labelSt}>3단계 — 페르소나 선택 (총 0~2개)</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          위 desire 후보 + 아래 USP 페르소나 합쳐 0~2개. 0개 = 자동 추론.
        </div>
        {personas.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            매칭된 USP에 등록된 페르소나가 없습니다. 위에서 재추출하거나, 자동 추론으로 진행하세요.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {personas.map((p, i) => {
              const checked = selected.has(i)
              const disabled = !checked && selected.size >= 2
              return (
                <label key={i} style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start',
                  padding: '10px 12px',
                  background: checked ? 'var(--accent-light)' : 'var(--bg-surface)',
                  border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-md)',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.5 : 1,
                }}>
                  <input type="checkbox" checked={checked} disabled={disabled}
                    onChange={() => onToggle(i)}
                    style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span>{p.name}</span>
                      {p.lf8 && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 7px',
                          background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                          borderRadius: 'var(--radius-sm)', letterSpacing: '0.03em',
                        }}>LF8 #{p.lf8} {p.lf8_label || ''}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{p.scenario}</div>
                    {p.job_statement && (
                      <div style={{ fontSize: 12, color: 'var(--text-body)', marginTop: 6, fontStyle: 'italic' }}>
                        {p.job_statement}
                      </div>
                    )}
                    {(p.pain_scene || p.desire_scene || p.pain || p.desire) && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
                        {(p.pain_scene || p.pain) && (
                          <div>
                            <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginRight: 6 }}>pain</span>
                            <span style={{ color: 'var(--text-body)' }}>{p.pain_scene || p.pain}</span>
                          </div>
                        )}
                        {(p.desire_scene || p.desire) && (
                          <div>
                            <span style={{ color: 'var(--accent)', fontWeight: 600, marginRight: 6 }}>desire</span>
                            <span style={{ color: 'var(--text-body)' }}>{p.desire_scene || p.desire}</span>
                          </div>
                        )}
                        {p.identity && (
                          <div>
                            <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginRight: 6 }}>identity</span>
                            <span style={{ color: 'var(--text-body)' }}>{p.identity}</span>
                          </div>
                        )}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                      USP{p._uspIndex} · {p._uspName}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {error && (
        <div style={{ ...cardSt, color: 'var(--error)' }}>{error}</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
        <button onClick={onBack} style={ghostBtnSt}>← 매핑 다시</button>
        <button onClick={onGenerate} style={primaryBtnSt}>
          대본 생성 ({selected.size || 1}개)
        </button>
      </div>
    </>
  )
}

function StepDone({
  result, onRestart,
}: {
  result: Record<string, GeneratedScript>
  onRestart: () => void
}) {
  const tabs = Object.keys(result)
  const [active, setActive] = useState(tabs[0] || '')
  const cur = active && result[active] ? result[active] : null

  return (
    <>
      {tabs.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          {tabs.map(t => (
            <button key={t} onClick={() => setActive(t)} style={{
              padding: '8px 14px', fontSize: 12,
              border: 'none', borderBottom: `2px solid ${active === t ? 'var(--accent)' : 'transparent'}`,
              background: 'transparent', color: active === t ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: active === t ? 600 : 500, cursor: 'pointer',
            }}>{t}</button>
          ))}
        </div>
      )}

      {cur && (
        <div style={cardSt}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              생성된 대본 ({cur.duration_target_sec}초)
            </div>
            <button onClick={async () => {
              const text = cur.tts_script || (cur.sentences || []).map(s => s.text).join('\n')
              await navigator.clipboard.writeText(text)
            }} style={ghostBtnSt}>TTS 복사</button>
          </div>
          {(cur.sentences || []).map((s, i) => (
            <div key={i} style={{
              fontSize: 13, padding: '8px 0',
              borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none',
            }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8 }}>
                [{s.start.toFixed(1)}–{s.end.toFixed(1)}s]
              </span>
              {s.text}
            </div>
          ))}
        </div>
      )}

      <button onClick={onRestart} style={{ ...ghostBtnSt, width: '100%' }}>↺ 다시 처음부터</button>
    </>
  )
}

const primaryBtnSt: React.CSSProperties = {
  padding: '10px 22px', fontSize: 13, fontWeight: 600,
  background: 'var(--accent)', color: '#fff', border: 'none',
  borderRadius: 'var(--radius-md)', cursor: 'pointer',
}

const ghostBtnSt: React.CSSProperties = {
  padding: '8px 16px', fontSize: 12, fontWeight: 500,
  background: 'var(--bg-surface)', color: 'var(--text-body)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', cursor: 'pointer',
}
