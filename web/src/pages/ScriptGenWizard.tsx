import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { buildTtsText } from '../ttsCopy'
import { api, authedFetch, BASE } from '../api'
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

// sessionStorage 영속화 — 위저드 state 유지 (새로고침/뒤로가기/탭 이동 후에도 결과 단계 유지)
const WIZARD_TTL_MS = 60 * 60 * 1000  // 1시간
function wizKey(sc: string | undefined): string { return `rb_wizard:${sc || ''}` }
function loadWiz(sc: string | undefined): any | null {
  if (!sc) return null
  try {
    const raw = sessionStorage.getItem(wizKey(sc))
    if (!raw) return null
    const s = JSON.parse(raw)
    if (!s || (Date.now() - (s._t || 0)) > WIZARD_TTL_MS) {
      sessionStorage.removeItem(wizKey(sc))
      return null
    }
    return s
  } catch { return null }
}
function clearWiz(sc: string | undefined) {
  if (!sc) return
  try { sessionStorage.removeItem(wizKey(sc)) } catch {}
}

export default function ScriptGenWizard() {
  const { shortcode } = useParams<{ shortcode: string }>()
  const location = useLocation()
  const source: 'reels' | 'youtube' = location.pathname.includes('/script/new/yt/') ? 'youtube' : 'reels'
  const navigate = useNavigate()
  // 위저드 영속화 — 마운트 시 1회 load (lazy init)
  const saved = (() => loadWiz(shortcode))()
  const [step, setStep] = useState<Step>((saved?.step as Step) || 'product')

  // 1. 상품
  const [products, setProducts] = useState<MyProduct[]>([])
  const [productId, setProductId] = useState<number | null>(saved?.productId ?? null)
  // USP 그룹
  type UspGroupLite = { id: string; name: string; color: string | null; order_idx: number; usp_indexes: number[]; capability_out?: string | null }
  const [uspGroups, setUspGroups] = useState<UspGroupLite[]>([])
  useEffect(() => {
    if (!productId) { setUspGroups([]); return }
    api.listUspGroups(productId).then(setUspGroups).catch(() => setUspGroups([]))
  }, [productId])

  // 2. 매핑
  const [mapping, setMapping] = useState<MappingPreview | null>(saved?.mapping || null)
  const [mappingLoading, setMappingLoading] = useState(false)
  const [mappingError, setMappingError] = useState('')
  const [chunkOverrides, setChunkOverrides] = useState<Record<string, number[]>>(saved?.chunkOverrides || {})
  const [chunkEdits, setChunkEdits] = useState<Record<string, { topic: string; role: string; section?: string }>>(saved?.chunkEdits || {})
  const [editingChunk, setEditingChunk] = useState<Record<string, boolean>>({})
  const [skippedChunks, setSkippedChunks] = useState<Set<string>>(new Set(saved?.skippedChunks || []))
  const [skippedSentenceStarts, setSkippedSentenceStarts] = useState<Set<number>>(new Set(saved?.skippedSentenceStarts || []))
  // CTA override — 다른 ref의 CTA로 교체 (null이면 원본 사용)
  type OverrideData = { shortcode: string; author: string; section_text: string; section_chunk: any; topic?: string }
  const [sectionOverrides, setSectionOverrides] = useState<Record<string, OverrideData>>(saved?.sectionOverrides || {})
  const [hookArchetypeOverride, setHookArchetypeOverride] = useState<{ archetype: string; pattern?: string; core_word?: string } | null>(saved?.hookArchetypeOverride || null)

  // 3. 페르소나
  const [allPersonas, setAllPersonas] = useState<Array<PersonaCandidate & { _uspIndex: number; _uspName: string; _unified?: boolean; _coversUsps?: number[] }>>(saved?.allPersonas || [])
  const [selectedPersonaIdx, setSelectedPersonaIdx] = useState<Set<number>>(new Set(saved?.selectedPersonaIdx || []))
  // ref-derived desire 후보 (참고 대본 emotional arc 기반)
  const [selectedRefDesireIdx, setSelectedRefDesireIdx] = useState<Set<number>>(new Set())
  // 통합 페르소나 생성 진행 + 분석 결과
  const [unifiedLoading, setUnifiedLoading] = useState(false)
  const [unifiedMeta, setUnifiedMeta] = useState<{ common_pain: string; common_context: string; shared_keywords: string[] } | null>(null)

  // 4. 생성
  const [genError, setGenError] = useState('')
  const [genResult, setGenResult] = useState<Record<string, GeneratedScript>>(saved?.genResult || {})
  // 진행률 polling state — 페르소나별 (sessionId → progress)
  const [genProgress, setGenProgress] = useState<Record<string, { step?: string; percent?: number; message?: string; label: string }>>({})

  useEffect(() => {
    api.listMyProducts().then(setProducts).catch(() => {})
  }, [])

  // 위저드 영속화 — state 변경 시마다 sessionStorage에 저장 (debounce 없음, 한 키 통째)
  useEffect(() => {
    if (!shortcode) return
    if (step === 'product' && !productId && !mapping && !Object.keys(genResult).length) {
      // 깨끗한 초기 상태 — 저장 불필요
      return
    }
    try {
      sessionStorage.setItem(wizKey(shortcode), JSON.stringify({
        _t: Date.now(),
        step, productId, mapping, chunkOverrides, chunkEdits,
        skippedChunks: Array.from(skippedChunks),
        skippedSentenceStarts: Array.from(skippedSentenceStarts),
        sectionOverrides, hookArchetypeOverride,
        allPersonas, selectedPersonaIdx: Array.from(selectedPersonaIdx),
        genResult,
      }))
    } catch {}
  }, [shortcode, step, productId, mapping, chunkOverrides, chunkEdits,
      skippedChunks, skippedSentenceStarts, sectionOverrides, hookArchetypeOverride,
      allPersonas, selectedPersonaIdx, genResult])

  const goToMapping = async (pid: number) => {
    if (!shortcode) return
    setProductId(pid)
    setStep('mapping')
    setMappingLoading(true)
    setMappingError('')
    setChunkOverrides({})
    setSkippedChunks(new Set())
    setSkippedSentenceStarts(new Set())
    setHookArchetypeOverride(null)
    try {
      const r = await api.previewMapping(shortcode, pid, source)
      setMapping(r)
    } catch (e: any) {
      setMappingError(e.message || String(e))
    } finally {
      setMappingLoading(false)
    }
  }

  // (deleteChunkSentence 제거 — 매핑 단계는 DB 영구 삭제 X. 대신 skippedSentenceStarts wizard 상태)

  // ref 대본 한 문장 수정 (오타 수정) — chunks DB + transcripts.segments 동기화
  // 주의: chunk skip/restore와는 완전 별개 동작. text만 수정.
  const updateChunkSentenceText = async (
    chunkSection: string,
    sentIdx: number,
    newText: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!mapping || !shortcode) return { ok: false, error: '매핑/shortcode 미로드' }
    const trimmed = newText.trim()
    if (!trimmed) return { ok: false, error: '문장이 비어있음' }
    // 새 chunks 배열 만들기 — 해당 chunk의 sent text만 교체 (skip 상태 무관, DB는 항상 전체 chunks)
    const newChunks = mapping.section_chunks.map((c: any) => {
      if (c.section !== chunkSection) return c
      const newSents = (c.sentences || []).map((s: any, i: number) =>
        i === sentIdx ? { ...s, text: trimmed } : s,
      )
      return { ...c, sentences: newSents }
    })
    try {
      await api.updateSectionChunks(shortcode, newChunks, source)
    } catch (e: any) {
      return { ok: false, error: e?.message || 'DB 저장 실패' }
    }
    setMapping({ ...mapping, section_chunks: newChunks })
    return { ok: true }
  }

  // 기존 USP 수정 — 매핑 단계에서 인라인 편집
  const updateUsp = async (
    userUspId: number,  // 1-based
    name: string,
    description: string,
    reviews: string[],
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!mapping || !productId) return { ok: false, error: '매핑/상품 미로드' }
    if (!name.trim()) return { ok: false, error: 'USP 이름 필수' }
    const idx = userUspId - 1
    if (idx < 0 || idx >= mapping.product.usps.length) return { ok: false, error: 'USP id 범위 밖' }
    const cleanReviews = reviews.map(r => r.trim()).filter(Boolean)
    const newUsps = mapping.product.usps.map((u: any, i: number) =>
      i === idx
        ? { ...u, usp: name.trim(), description: description.trim() || undefined, reviews: cleanReviews }
        : u,
    )
    try {
      await api.updateMyProduct(productId, {
        name: mapping.product.name,
        usps: newUsps,
      })
    } catch (e: any) {
      return { ok: false, error: e.message || 'DB 저장 실패' }
    }
    setMapping({ ...mapping, product: { ...mapping.product, usps: newUsps } })
    return { ok: true }
  }

  // 새 USP를 즉석 생성 + my_products DB에 저장 + chunk 매핑 자동 적용
  const createUspForChunk = async (
    chunkSection: string,
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
    const newUserUspId = newUsps.length  // 1-based id
    setMapping({ ...mapping, product: { ...mapping.product, usps: newUsps } })
    setChunkOverrides({ ...chunkOverrides, [chunkSection]: [newUserUspId] })
    return { ok: true }
  }

  // chunk별 effective user_usp_ids (precedence: chunkOverride > LLM 자동 매핑) — multi
  // override는 빈 배열도 명시적 "미매핑"으로 인정 (key 존재 여부로 판단)
  const effectiveChunkUspIds = (chunk: MappingPreview['section_chunks'][number]): number[] => {
    const sec = chunk.section || ''
    if (sec in chunkOverrides) return chunkOverrides[sec]
    const m = mapping?.chunk_mapping.find(x => x.chunk_section === sec)
    return m?.user_usp_ids || []
  }

  // override 적용 후 unused user USPs 재계산 — chunk effective USPs만 기준 (multi)
  const effectiveUnusedUsps = (() => {
    if (!mapping) return []
    const used = new Set<number>()
    mapping.section_chunks.forEach(c => {
      effectiveChunkUspIds(c).forEach(uid => used.add(uid))
    })
    return mapping.product.usps
      .map((u: any, i: number) => ({ user_usp_id: i + 1, user_usp_name: u.usp }))
      .filter(u => !used.has(u.user_usp_id))
  })()

  const [personaRefreshing, setPersonaRefreshing] = useState(false)
  const [refreshingUspIdx, setRefreshingUspIdx] = useState<number | null>(null)

  // 통합 페르소나 생성 — 매핑된 USP들을 모두 한 번에 분석해서 교집합 페르소나 도출
  const generateUnifiedPersonas = async () => {
    if (!mapping) return
    // 매핑된(chunk에서 사용 중인) USP만 모으기
    const matched = new Set<number>()
    mapping.section_chunks.forEach(c => {
      effectiveChunkUspIds(c).forEach(uid => matched.add(uid))
    })
    const usps = mapping.product.usps
      .map((u: any, i: number) => matched.has(i + 1) ? { ...u, _idx: i + 1 } : null)
      .filter(Boolean) as Array<{ usp: string; description?: string; reviews?: string[]; _idx: number }>
    if (usps.length === 0) {
      alert('매핑된 USP가 없습니다. 매핑 단계에서 USP를 chunk에 할당해주세요.')
      return
    }
    setUnifiedLoading(true)
    try {
      const r = await api.extractUnifiedPersonas(
        usps.map(u => ({ usp: u.usp, description: u.description, reviews: u.reviews || [] })),
        mapping.product.name || '',
      )
      const newPs: Array<PersonaCandidate & { _uspIndex: number; _uspName: string; _unified: true; _coversUsps?: number[] }> =
        (r.personas || []).map(p => ({
          ...p,
          _uspIndex: 0,  // 0 = unified (specific USP에 속하지 않음)
          _uspName: '통합',
          _unified: true,
          _coversUsps: (p as any).covers_usps as number[] | undefined,
        }))
      // 기존 allPersonas 뒤에 append
      setAllPersonas(prev => [...prev.filter(p => !p._unified), ...newPs])
      setUnifiedMeta({
        common_pain: r.common_pain,
        common_context: r.common_context,
        shared_keywords: r.shared_keywords || [],
      })
    } catch (e: any) {
      alert('통합 페르소나 생성 실패: ' + (e?.message || e))
    } finally {
      setUnifiedLoading(false)
    }
  }

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
      // allPersonas 갱신 — chunk effective USPs만 기준 (multi)
      const matched = new Set<number>()
      mapping.section_chunks.forEach(c => {
        effectiveChunkUspIds(c).forEach(uid => matched.add(uid))
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
      effectiveChunkUspIds(c).forEach(uid => matched.add(uid))
    })
    const all = mapping.product.usps.map((u: any, i: number) => ({
      idx: i,
      name: u.usp || '',
      personaCount: (u.personas || []).length,
      reviewCount: (u.reviews || []).filter(Boolean).length,
      match: matched.has(i + 1),
    }))
    // matched가 0개면 fallback — 모든 USP 노출 (사용자가 페르소나 직접 선택 가능)
    const filtered = matched.size > 0 ? all.filter(x => x.match) : all
    return filtered.map(({ match: _m, ...rest }) => rest)
  })()

  const goToPersona = async () => {
    if (!mapping) return
    setStep('persona')

    // override 반영한 매칭된 user USP 인덱스 — chunk effective USPs만 기준 (multi)
    const matchedRaw = new Set<number>()
    mapping.section_chunks.forEach(c => {
      effectiveChunkUspIds(c).forEach(uid => matchedRaw.add(uid))
    })
    // matched가 0개면 fallback — 모든 USP 사용 (사용자가 페르소나 직접 선택 가능)
    const matched: Set<number> = matchedRaw.size > 0
      ? matchedRaw
      : new Set(mapping.product.usps.map((_: any, i: number) => i + 1))

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

    // per-USP 페르소나 수집 X — 대시보드에 통합 페르소나만 표시
    setAllPersonas([])
    setSelectedPersonaIdx(new Set())
    setUnifiedMeta(null)

    // ⭐ 통합 페르소나 자동 추출 — 매핑된 USP들의 교집합 분석 (백그라운드, await X — UI 블록 X)
    setTimeout(() => { generateUnifiedPersonas() }, 0)
  }

  const generate = async () => {
    if (!mapping || !shortcode) return
    setStep('generating')
    setGenError('')
    setGenResult({})
    // USP 1-based index → group capability_out 매핑 (그룹별 boundary)
    const uspIdxToCapOut = new Map<number, string>()
    for (const g of uspGroups) {
      const capOut = (g as any).capability_out
      if (capOut && (g.usp_indexes || []).length) {
        for (const idx of g.usp_indexes) uspIdxToCapOut.set(idx, capOut)
      }
    }
    const cleanUsps = mapping.product.usps.map((u: any, i: number) => ({
      usp: (u.usp || '').trim(),
      description: (u.description || '').trim() || undefined,
      reviews: (u.reviews || []).map((r: string) => r.trim()).filter(Boolean),
      group_capability_out: uspIdxToCapOut.get(i + 1) || undefined,
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

    // 페르소나별 session_id 생성
    const sessionIds = personas.map((_, idx) => `gen-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`)
    const initialProgress: Record<string, { step?: string; percent?: number; message?: string; label: string }> = {}
    personas.forEach((p, idx) => {
      const baseName = p ? p.name : '기본'
      const label = personas.length > 1 ? `${baseName} #${idx + 1}` : baseName
      initialProgress[sessionIds[idx]] = { label, step: 'start', percent: 0, message: '시작' }
    })
    setGenProgress(initialProgress)

    // 진행률 polling (3초마다 모든 session 갱신)
    const pollInterval = setInterval(async () => {
      try {
        const updates = await Promise.all(sessionIds.map(sid => api.scriptProgress(sid).catch(() => null)))
        setGenProgress(prev => {
          const next = { ...prev }
          updates.forEach((u, idx) => {
            if (u?.found && next[sessionIds[idx]]) {
              next[sessionIds[idx]] = {
                ...next[sessionIds[idx]],
                step: u.step, percent: u.percent, message: u.message,
              }
            }
          })
          return next
        })
      } catch { /* noop */ }
    }, 3000)

    try {
      const token = await getAccessToken()
      const calls = personas.map(async (persona, idx): Promise<[string, GeneratedScript]> => {
        const r = await fetch(`${BASE}/api/script/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
          body: JSON.stringify({
            product_name: mapping.product.name,
            pain: '', desire: '',
            usps: cleanUsps,
            reference_shortcodes: [shortcode],
            reference_source: source,
            refine: false,
            session_id: sessionIds[idx],
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
            chunk_usp_override: Object.keys(chunkOverrides).length
              ? chunkOverrides
              : undefined,
            chunk_meta_override: Object.keys(chunkEdits).length
              ? chunkEdits
              : undefined,
            skip_chunk_sections: skippedChunks.size > 0
              ? Array.from(skippedChunks)
              : undefined,
            skip_sentence_starts: skippedSentenceStarts.size > 0
              ? Array.from(skippedSentenceStarts)
              : undefined,
            section_overrides: Object.keys(sectionOverrides).length
              ? Object.fromEntries(Object.entries(sectionOverrides).map(([sec, ov]) => [
                  sec, { shortcode: ov.shortcode, section_chunk: ov.section_chunk }
                ]))
              : undefined,
            hook_archetype_override: hookArchetypeOverride || undefined,
          }),
        })
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
        const baseName = persona ? persona.name : '기본'
        // 동일 이름 충돌 방지: idx로 unique 보장
        const key = personas.length > 1 ? `${baseName} #${idx + 1}` : baseName
        return [key, await r.json()]
      })
      const settled = await Promise.allSettled(calls)
      clearInterval(pollInterval)
      console.log('[script/gen] personas count:', personas.length, 'settled:', settled.length)
      const out: Record<string, GeneratedScript> = {}
      const errors: string[] = []
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') {
          const [name, draft] = s.value
          console.log(`[script/gen] persona ${i + 1} OK, key="${name}"`)
          out[name] = draft
        } else {
          const msg = s.reason?.message || String(s.reason)
          console.error(`[script/gen] persona ${i + 1} FAILED:`, msg)
          errors.push(`P${i + 1}: ${msg}`)
        }
      })
      if (Object.keys(out).length === 0) {
        throw new Error(`모든 호출 실패: ${errors.join(' | ')}`)
      }
      // 일부 실패도 사용자에게 알림
      if (errors.length > 0) {
        setGenError(`${errors.length}/${personas.length} 페르소나 실패: ${errors.join(' | ')}`)
      }
      setGenResult(out)
      setStep('done')

      // 1차 끝나면 자동 2차 refine — vocab 중복 자동 검출 + pinpoint 교체
      // 사용자가 chunk 안 어휘 중복 안 보고 싶음. 백그라운드 silent 실행.
      // skip 정보 전달 — 삭제된 chunk/sentence가 ref에서 복원되지 않도록
      const skipOpts = {
        skip_chunk_sections: skippedChunks.size > 0 ? Array.from(skippedChunks) : undefined,
        skip_sentence_starts: skippedSentenceStarts.size > 0 ? Array.from(skippedSentenceStarts) : undefined,
      }
      ;(async () => {
        const refinedOut: Record<string, GeneratedScript> = { ...out }
        await Promise.all(Object.entries(out).map(async ([name, draft]) => {
          try {
            const refined = await api.refineScript(draft, cleanUsps, shortcode, skipOpts)
            if (refined && refined.sentences) {
              refinedOut[name] = {
                ...draft,
                sentences: refined.sentences,
                tts_script: refined.tts_script || draft.tts_script,
              }
            }
          } catch (e) {
            console.warn(`[auto-refine] ${name} skipped:`, e)
          }
        }))
        setGenResult(refinedOut)
      })()
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

      <Stepper step={step} onJump={(target) => {
        // 가능한 곳만 점프 (mapping 미로드면 mapping/persona/done 잠금)
        if (target === 'product') {
          setStep('product')
          return
        }
        if (target === 'mapping' && mapping) {
          setStep('mapping')
          return
        }
        if (target === 'persona' && allPersonas.length > 0) {
          setStep('persona')
          return
        }
        if (target === 'done' && Object.keys(genResult).length > 0) {
          setStep('done')
          return
        }
      }} />

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
          chunkOverrides={chunkOverrides}
          unusedUsps={effectiveUnusedUsps}
          onChunkOverride={(section, userIds) => {
            const next = { ...chunkOverrides }
            if (userIds === null) delete next[section]   // null → override 해제 (LLM 자동 매핑 복원)
            else next[section] = userIds                  // [] → 명시적 미매핑 / [1,2] → 수동 매핑
            setChunkOverrides(next)
          }}
          getEffectiveChunkUspIds={effectiveChunkUspIds}
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
          onCreateUsp={createUspForChunk}
          onUpdateUsp={updateUsp}
          onUpdateChunkSentenceText={updateChunkSentenceText}
          skippedSentenceStarts={skippedSentenceStarts}
          onToggleSkipSentence={(start) => {
            setSkippedSentenceStarts(prev => {
              const next = new Set(prev)
              const key = Math.round(start * 100) / 100
              if (next.has(key)) next.delete(key)
              else next.add(key)
              return next
            })
          }}
          skippedChunks={skippedChunks}
          onToggleSkipChunk={(section) => {
            setSkippedChunks(prev => {
              const next = new Set(prev)
              if (next.has(section)) next.delete(section)
              else next.add(section)
              return next
            })
          }}
          sectionOverrides={sectionOverrides}
          setSectionOverrides={setSectionOverrides}
          hookArchetypeOverride={hookArchetypeOverride}
          setHookArchetypeOverride={setHookArchetypeOverride}
          currentShortcode={shortcode || ''}
          onBack={() => setStep('product')}
          onNext={goToPersona}
          uspGroups={uspGroups}
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
          onGenerateUnified={generateUnifiedPersonas}
          unifiedLoading={unifiedLoading}
          unifiedMeta={unifiedMeta}
        />
      )}

      {step === 'generating' && (
        <div style={cardSt}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
              대본 생성 중… (페르소나 {Object.keys(genProgress).length || 1}개 동시)
            </div>
            <button
              onClick={() => {
                setGenError('')
                setGenProgress({})
                setStep('persona')
              }}
              style={{
                padding: '6px 14px', fontSize: 12,
                background: 'transparent', color: 'var(--text-body)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}>
              ← 페르소나로 돌아가기
            </button>
          </div>
          <div style={{ display: 'grid', gap: 14 }}>
            {Object.entries(genProgress).map(([sid, p]) => {
              const pct = Math.max(0, Math.min(100, p.percent || 0))
              const isDone = pct >= 100
              return (
                <div key={sid} style={{
                  padding: 12, background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{p.label}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: isDone ? 'var(--success)' : 'var(--accent)' }}>
                      {pct}%
                    </div>
                  </div>
                  <div style={{
                    height: 6, background: 'var(--bg-base)', borderRadius: 3,
                    overflow: 'hidden', marginBottom: 6,
                  }}>
                    <div style={{
                      height: '100%', width: `${pct}%`,
                      background: isDone ? 'var(--success)' : 'var(--accent)',
                      transition: 'width 300ms ease',
                    }} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {p.step ? `[${p.step}]` : ''} {p.message || '대기 중…'}
                  </div>
                </div>
              )
            })}
          </div>
          {genError && (
            <div style={{
              marginTop: 12, padding: 10, background: 'rgba(239,68,68,0.1)',
              border: '1px solid var(--error)', color: 'var(--error)', fontSize: 12,
              borderRadius: 'var(--radius-sm)',
            }}>{genError}</div>
          )}
        </div>
      )}

      {step === 'done' && (
        <StepDone
          result={genResult}
          refChunks={(() => {
            // 1) skipped chunks 제외 (gen에 없으니 ref에서도 빼서 1:1 페어링 유지)
            // 2) skipped sentences 제외 (각 chunk 안 sentences에서 필터)
            // 3) section_overrides가 있으면 해당 섹션 chunk를 차용본으로 교체해서 ref 비교에 반영
            const baseAll = mapping?.section_chunks || []
            const skipSentSet = skippedSentenceStarts
            const filterSents = (sents: any[]) => sents.filter((s: any) =>
              !skipSentSet.has(Math.round((s.start || 0) * 100) / 100),
            )
            const base = baseAll
              .filter(c => !skippedChunks.has(c.section))
              .map((c: any) => ({ ...c, sentences: filterSents(c.sentences || []) }))
              .filter((c: any) => (c.sentences || []).length > 0)
            if (!Object.keys(sectionOverrides).length) return base
            return base.map(c => {
              const sec = (c.section || '').toLowerCase()
              const ov = sectionOverrides[sec]
              if (!ov || !ov.section_chunk) return c
              const ovChunk = ov.section_chunk
              return {
                ...c,
                sentences: (ovChunk.sentences || c.sentences || []),
                topic: ovChunk.topic || c.topic,
                role: ovChunk.role || c.role,
                _borrowed_from: ov.shortcode,
              } as any
            })
          })()}
          chunkUspMapping={(() => {
            // section → { ids, names } — wizard에서 사용자가 선택한 effective mapping
            const out: Record<string, { ids: number[]; names: string[] }> = {}
            if (!mapping) return out
            const usps = mapping.product.usps || []
            for (const c of mapping.section_chunks || []) {
              const sec = c.section || ''
              const ids = effectiveChunkUspIds(c)
              const names = ids.map(uid => (usps[uid - 1] as any)?.usp || '').filter(Boolean)
              out[sec.toLowerCase()] = { ids, names }
            }
            return out
          })()}
          onRestart={() => {
            setStep('product')
            setProductId(null)
            setMapping(null)
            setAllPersonas([])
            setSelectedPersonaIdx(new Set())
            setGenResult({})
            setChunkOverrides({})
            setChunkEdits({})
            setSkippedChunks(new Set())
            setSkippedSentenceStarts(new Set())
            setSectionOverrides({})
            setHookArchetypeOverride(null)
            clearWiz(shortcode)
            try { sessionStorage.removeItem(`rb_wizard_stepdone:${shortcode || ''}`) } catch {}
          }}
          onBackToPersona={() => {
            setGenError('')
            setStep('persona')
          }}
          onBackToMapping={() => {
            setGenError('')
            setStep('mapping')
          }}
          onSkipChunkSection={(section) => {
            setSkippedChunks(prev => {
              const next = new Set(prev)
              next.add(section)
              return next
            })
          }}
          productId={productId}
          shortcode={shortcode || ''}
          source={source}
          usps={(mapping?.product?.usps || []).map((u: any) => ({
            usp: u.usp || '', description: u.description, reviews: u.reviews || [],
          }))}
          onRefined={(tabName, refined) => {
            setGenResult(prev => ({ ...prev, [tabName]: refined }))
          }}
          skipOpts={{
            skip_chunk_sections: skippedChunks.size > 0 ? Array.from(skippedChunks) : undefined,
            skip_sentence_starts: skippedSentenceStarts.size > 0 ? Array.from(skippedSentenceStarts) : undefined,
          }}
        />
      )}
    </div>
  )
}

function Stepper({ step, onJump }: { step: Step; onJump?: (target: Step) => void }) {
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
        const clickable = !!onJump && (done || active)
        const handle = clickable ? () => onJump!(s as Step) : undefined
        return (
          <div key={s} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            <div
              onClick={handle}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', borderRadius: 'var(--radius-pill)',
                background: active ? 'var(--accent-light)' : 'transparent',
                fontWeight: active ? 700 : 500,
                color: active ? 'var(--accent)' : (done ? 'var(--text-secondary)' : 'var(--text-muted)'),
                fontSize: 12,
                cursor: clickable ? 'pointer' : 'default',
                userSelect: 'none',
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
  mapping, loading, error, chunkOverrides, unusedUsps, onChunkOverride,
  getEffectiveChunkUspIds, chunkEdits, editingChunk, setChunkEdits, toggleChunkEdit,
  onCreateUsp, onUpdateUsp, onUpdateChunkSentenceText, skippedSentenceStarts, onToggleSkipSentence, skippedChunks, onToggleSkipChunk, sectionOverrides, setSectionOverrides,
  hookArchetypeOverride, setHookArchetypeOverride,
  currentShortcode, onBack, onNext,
  uspGroups,
}: {
  mapping: MappingPreview | null
  loading: boolean
  error: string
  chunkOverrides: Record<string, number[]>
  unusedUsps: { user_usp_id: number; user_usp_name: string }[]
  onChunkOverride: (section: string, userIds: number[] | null) => void
  getEffectiveChunkUspIds: (chunk: MappingPreview['section_chunks'][number]) => number[]
  chunkEdits: Record<string, { topic: string; role: string; section?: string }>
  editingChunk: Record<string, boolean>
  setChunkEdits: React.Dispatch<React.SetStateAction<Record<string, { topic: string; role: string; section?: string }>>>
  toggleChunkEdit: (section: string, currentTopic: string, currentRole: string) => void
  onCreateUsp: (chunkSection: string, name: string, description: string, reviews: string[]) => Promise<{ ok: boolean; error?: string }>
  onUpdateUsp: (userUspId: number, name: string, description: string, reviews: string[]) => Promise<{ ok: boolean; error?: string }>
  onUpdateChunkSentenceText: (chunkSection: string, sentIdx: number, newText: string) => Promise<{ ok: boolean; error?: string }>
  skippedSentenceStarts: Set<number>
  onToggleSkipSentence: (start: number) => void
  skippedChunks: Set<string>
  onToggleSkipChunk: (section: string) => void
  sectionOverrides: Record<string, { shortcode: string; author: string; section_text: string; section_chunk: any; topic?: string }>
  setSectionOverrides: React.Dispatch<React.SetStateAction<Record<string, { shortcode: string; author: string; section_text: string; section_chunk: any; topic?: string }>>>
  hookArchetypeOverride: { archetype: string; pattern?: string; core_word?: string } | null
  setHookArchetypeOverride: React.Dispatch<React.SetStateAction<{ archetype: string; pattern?: string; core_word?: string } | null>>
  currentShortcode: string
  onBack: () => void
  onNext: () => void
  uspGroups: Array<{ id: string; name: string; color: string | null; order_idx: number; usp_indexes: number[] }>
}) {
  // CTA pool picker
  type SectionItem = { shortcode: string; author: string; section_text: string; section_chunk: any; topic?: string }
  const [pickerSection, setPickerSection] = useState<'hook' | 'intro' | 'cta' | null>(null)
  const [sectionPools, setSectionPools] = useState<Record<string, SectionItem[]>>({})
  const [poolLoading, setPoolLoading] = useState(false)
  const [sectionSearch, setSectionSearch] = useState('')

  const openSectionPicker = async (sec: 'hook' | 'intro' | 'cta') => {
    setPickerSection(sec)
    setSectionSearch('')
    if ((sectionPools[sec] || []).length > 0) return
    setPoolLoading(true)
    try {
      const r = await authedFetch(`/api/script/section-pool?section=${sec}&exclude=${encodeURIComponent(currentShortcode)}&limit=200`)
      if (r.ok) {
        const d = await r.json()
        setSectionPools(prev => ({ ...prev, [sec]: d.items || [] }))
      }
    } finally {
      setPoolLoading(false)
    }
  }
  const lookupBySc = async (sc: string) => {
    if (!sc || !pickerSection) return
    const pool = sectionPools[pickerSection] || []
    if (pool.some(c => c.shortcode === sc)) return
    try {
      const r = await authedFetch(`/api/script/section-pool?section=${pickerSection}&shortcode=${encodeURIComponent(sc)}`)
      if (r.ok) {
        const d = await r.json()
        if (d.items && d.items.length > 0) {
          setSectionPools(prev => ({ ...prev, [pickerSection]: [...d.items, ...(prev[pickerSection] || [])] }))
        }
      }
    } catch {}
  }
  const _extractShortcode = (raw: string): string => {
    const s = raw.trim()
    if (!s) return ''
    let m = s.match(/instagram\.com\/(?:reels?|p)\/([A-Za-z0-9_-]{6,})/i)
    if (m) return m[1]
    m = s.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i)
    if (m) return m[1]
    m = s.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/i)
    if (m) return m[1]
    if (/^[A-Za-z0-9_-]{6,}$/.test(s)) return s
    return ''
  }
  const currentPool = pickerSection ? (sectionPools[pickerSection] || []) : []
  const filteredPool = currentPool.filter(c => {
    if (!sectionSearch.trim()) return true
    const q = sectionSearch.toLowerCase().trim()
    const sc = _extractShortcode(sectionSearch)
    if (sc && (c.shortcode || '').toLowerCase() === sc.toLowerCase()) return true
    return (c.section_text || '').toLowerCase().includes(q)
      || (c.author || '').toLowerCase().includes(q)
      || (c.shortcode || '').toLowerCase().includes(q)
  })
  const [creatingFor, setCreatingFor] = useState<string | null>(null)  // chunk.section
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newReviews, setNewReviews] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState('')
  // USP 그룹 필터: null=전체, 'unclassified'=미분류만, group.id=특정 그룹만
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  // USP 수정 인라인 편집 상태 — 한 번에 1개만. editingChunkSection이 있으면 그 chunk 안에서만 폼 렌더
  const [editingUspId, setEditingUspId] = useState<number | null>(null)
  const [editingChunkSection, setEditingChunkSection] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editReviews, setEditReviews] = useState('')
  const [savingUsp, setSavingUsp] = useState(false)
  const [editErr, setEditErr] = useState('')
  // ref 대본 문장 텍스트 수정 (오타) — 한 번에 1개만
  const [editingSent, setEditingSent] = useState<{ chunkSection: string; sentIdx: number } | null>(null)
  const [sentDraft, setSentDraft] = useState('')
  const [savingSent, setSavingSent] = useState(false)
  const [sentEditErr, setSentEditErr] = useState('')

  const startEditSent = (chunkSection: string, sentIdx: number, text: string) => {
    setEditingSent({ chunkSection, sentIdx })
    setSentDraft(text || '')
    setSentEditErr('')
  }
  const cancelEditSent = () => {
    setEditingSent(null)
    setSentEditErr('')
  }
  const submitEditSent = async () => {
    if (!editingSent) return
    setSavingSent(true)
    setSentEditErr('')
    const r = await onUpdateChunkSentenceText(editingSent.chunkSection, editingSent.sentIdx, sentDraft)
    setSavingSent(false)
    if (r.ok) setEditingSent(null)
    else setSentEditErr(r.error || '실패')
  }

  const startCreate = (chunkSection: string, chunkSummary: string) => {
    setCreatingFor(chunkSection)
    setNewName('')
    setNewDesc(chunkSummary)  // chunk summary를 default로 채워서 사용자 시작점 제공
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

  // chunk.section → mapping record
  const mappingByChunkSection = new Map<string, MappingPreview['chunk_mapping'][number]>()
  mapping.chunk_mapping.forEach(m => mappingByChunkSection.set(m.chunk_section, m))

  const startEditUsp = (uspId: number, fromChunkSection: string) => {
    const u: any = mapping?.product.usps[uspId - 1]
    if (!u) return
    setEditingUspId(uspId)
    setEditingChunkSection(fromChunkSection)
    setEditName(u.usp || '')
    setEditDesc(u.description || '')
    setEditReviews((u.reviews || []).join('\n'))
    setEditErr('')
  }
  const cancelEditUsp = () => {
    setEditingUspId(null)
    setEditingChunkSection(null)
    setEditErr('')
  }
  const submitEditUsp = async () => {
    if (editingUspId == null) return
    setSavingUsp(true)
    setEditErr('')
    const reviews = editReviews.split('\n').map(s => s.trim()).filter(Boolean)
    const r = await onUpdateUsp(editingUspId, editName, editDesc, reviews)
    setSavingUsp(false)
    if (r.ok) {
      setEditingUspId(null)
      setEditingChunkSection(null)
    } else {
      setEditErr(r.error || '실패')
    }
  }

  return (
    <>
      <div style={cardSt}>
        <div style={labelSt}>2단계 — 매핑 리뷰</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          참고 릴스의 각 섹션 chunk와 그에 매핑된 우리 USP. USP pill 옆 편집 버튼으로 인라인 수정 가능.
        </div>

        {/* USP 그룹 필터 — 그룹 있을 때만 표시
            카운트는 실제 mapping.product.usps와 교차 (g.usp_indexes에 deleted index 있을 수 있음) */}
        {uspGroups.length > 0 && (() => {
          const allUsps = mapping.product.usps as any[]
          const idxToGroup = new Map<number, typeof uspGroups[number]>()
          for (const g of uspGroups) for (const i of g.usp_indexes) idxToGroup.set(i, g)
          const unclassifiedCount = allUsps.filter((_: any, i: number) => !idxToGroup.has(i + 1)).length
          const groupCount = (gid: string) => allUsps.filter((_: any, i: number) => idxToGroup.get(i + 1)?.id === gid).length
          return (
            <div style={{
              display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
              marginBottom: 14, padding: 10,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginRight: 4 }}>
                USP 그룹 필터:
              </span>
              <button type="button" onClick={() => setGroupFilter(null)}
                style={{
                  padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                  cursor: 'pointer',
                  background: groupFilter === null ? 'var(--accent)' : 'var(--bg-surface)',
                  color: groupFilter === null ? '#fff' : 'var(--text-body)',
                  border: '1px solid var(--border)',
                }}>
                전체 ({allUsps.length})
              </button>
              <button type="button" onClick={() => setGroupFilter('unclassified')}
                style={{
                  padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                  cursor: 'pointer',
                  background: groupFilter === 'unclassified' ? 'var(--accent)' : 'var(--bg-surface)',
                  color: groupFilter === 'unclassified' ? '#fff' : 'var(--text-body)',
                  border: '1px dashed var(--border)',
                }}>
                미분류 ({unclassifiedCount})
              </button>
              {uspGroups.map(g => {
                const isActive = groupFilter === g.id
                return (
                  <button key={g.id} type="button"
                    onClick={() => setGroupFilter(isActive ? null : g.id)}
                    style={{
                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                      cursor: 'pointer',
                      background: isActive ? (g.color || 'var(--accent)') : 'var(--bg-surface)',
                      color: isActive ? '#fff' : (g.color || 'var(--text-body)'),
                      border: `1px solid ${isActive ? (g.color || 'var(--accent)') : 'var(--border)'}`,
                      boxShadow: isActive ? '0 0 0 2px rgba(99,102,241,0.2)' : 'none',
                    }}>
                    {g.name} ({groupCount(g.id)})
                  </button>
                )
              })}
              {groupFilter !== null && (
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                  ※ 필터된 USP만 chunk별로 표시됩니다
                </span>
              )}
            </div>
          )
        })()}

        <div style={{ display: 'grid', gap: 10 }}>
          {mapping.section_chunks.map((chunk, ci) => {
            const mappingRec = mappingByChunkSection.get(chunk.section) || null
            const mappedIds = mappingRec?.user_usp_ids || []
            const sec = (chunk.section || '').toLowerCase()
            const isOverridable = sec === 'hook' || sec === 'intro' || sec === 'cta'
            const sectionOv = sectionOverrides[sec] || null
            // hook/intro/cta/body 모두 USP 직접 선택 허용. 페르소나 슬롯은 명시적 "매핑 없음" 선택 시에만.
            const isPersonaSlot = false
            const isSkipped = skippedChunks.has(chunk.section)

            return (
              <div key={ci} style={{
                background: isSkipped ? 'var(--bg-elevated)' : 'var(--bg-surface)',
                border: `1px ${isSkipped ? 'dashed' : 'solid'} var(--border)`,
                borderRadius: 'var(--radius-md)', padding: 14,
                opacity: isSkipped ? 0.45 : 1,
                position: 'relative',
              }}>
                {/* 헤더: 섹션 라벨 + 토픽 + 역할 + 약한매칭 경고 */}
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                    color: 'var(--text-secondary)',
                    padding: '3px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                  }}>
                    {chunkEdits[chunk.section]?.section || chunk.section}
                    {chunkEdits[chunk.section]?.section && chunkEdits[chunk.section]?.section !== chunk.section && (
                      <span style={{ marginLeft: 4, color: 'var(--accent)', fontWeight: 600 }}>(수정됨)</span>
                    )}
                  </span>
                  {(chunkEdits[chunk.section]?.role || chunk.role) && !editingChunk[chunk.section] && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {chunkEdits[chunk.section]?.role || chunk.role}
                    </span>
                  )}
                  {(chunkEdits[chunk.section]?.topic || chunk.topic) && !editingChunk[chunk.section] && (
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {chunkEdits[chunk.section]?.topic || chunk.topic}
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
                  {!isPersonaSlot && !isSkipped && (
                    <button
                      onClick={() => toggleChunkEdit(chunk.section, chunk.topic || '', chunk.role || '')}
                      style={{
                        marginLeft: 'auto', padding: '2px 8px', fontSize: 11,
                        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                        background: 'var(--bg-surface)', color: 'var(--text-body)',
                        cursor: 'pointer',
                      }}>
                      {editingChunk[chunk.section] ? '저장' : '분석 수정'}
                    </button>
                  )}
                  <button
                    onClick={() => onToggleSkipChunk(chunk.section)}
                    title={isSkipped ? '복원' : '이 chunk를 이번 생성에서 제외'}
                    style={{
                      marginLeft: (isPersonaSlot || isSkipped) ? 'auto' : 0,
                      padding: '2px 8px', fontSize: 11, fontWeight: 600,
                      border: `1px solid ${isSkipped ? 'var(--accent)' : 'var(--error)'}`,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-surface)',
                      color: isSkipped ? 'var(--accent)' : 'var(--error)',
                      cursor: 'pointer', opacity: 1, pointerEvents: 'auto',
                    }}>
                    {isSkipped ? '복원' : '삭제'}
                  </button>
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

                {/* hook chunk — archetype primary 선택 (top-2 candidates) */}
                {sec === 'hook' && mapping?.hook_archetype && (
                  <HookArchetypePicker
                    classified={mapping.hook_archetype}
                    override={hookArchetypeOverride}
                    setOverride={setHookArchetypeOverride}
                  />
                )}

                {/* hook/intro/cta — 다른 ref에서 가져오기 배너 */}
                {isOverridable && (
                  <div style={{
                    background: sectionOv ? 'rgba(99,102,241,0.08)' : 'var(--bg-elevated)',
                    border: `1px ${sectionOv ? 'solid' : 'dashed'} ${sectionOv ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius-sm)', padding: '10px 12px', marginBottom: 10,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      {sectionOv ? (
                        <>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>다른 ref {sec.toUpperCase()} 사용 중</span>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>@{sectionOv.author || sectionOv.shortcode}</span>
                          <button onClick={() => setSectionOverrides(prev => {
                            const next = { ...prev }; delete next[sec]; return next
                          })} style={{
                            marginLeft: 'auto', padding: '3px 10px', fontSize: 11, background: 'transparent',
                            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text-muted)',
                          }}>원본으로</button>
                        </>
                      ) : (
                        <>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>현재 ref의 {sec.toUpperCase()} 사용 중. 다른 ref로 교체 가능.</span>
                          <button onClick={() => openSectionPicker(sec)} style={{
                            marginLeft: 'auto', padding: '4px 12px', fontSize: 11, fontWeight: 600,
                            background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer',
                          }}>📚 다른 {sec.toUpperCase()} 가져오기</button>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* override 시 차용 sentences 우선 표시 */}
                {isOverridable && sectionOv && (sectionOv.section_chunk?.sentences?.length || 0) > 0 && (
                  <div style={{
                    background: 'rgba(99,102,241,0.05)', borderRadius: 'var(--radius-sm)',
                    padding: '10px 12px', marginBottom: 10,
                    border: '1px solid var(--accent)',
                  }}>
                    {(sectionOv.section_chunk.sentences as any[]).map((s, si) => (
                      <div key={si} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-body)' }}>
                        {s.text}
                      </div>
                    ))}
                  </div>
                )}

                {/* ref 대본 (override 없을 때) — 오타 수정 인라인 편집 */}
                {!(isOverridable && sectionOv) && chunk.sentences && chunk.sentences.length > 0 && (
                  <div style={{
                    background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)',
                    padding: '10px 12px', marginBottom: 10,
                  }}>
                    {chunk.sentences.map((s, si) => {
                      const isEditing = editingSent?.chunkSection === chunk.section && editingSent?.sentIdx === si
                      if (isEditing) {
                        return (
                          <div key={si} style={{ marginBottom: 6, padding: 8, background: 'var(--bg-base)', border: '1px solid var(--accent)', borderRadius: 6 }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                              {s.start.toFixed(1)}–{s.end.toFixed(1)}s · 오타 수정 (저장하면 분석 DB에 반영)
                            </div>
                            <textarea
                              value={sentDraft}
                              onChange={(e) => setSentDraft(e.target.value)}
                              rows={2}
                              autoFocus
                              style={{
                                width: '100%', padding: '6px 8px', fontSize: 13,
                                border: '1px solid var(--border)', borderRadius: 4,
                                background: 'var(--bg-surface)', resize: 'vertical', fontFamily: 'inherit',
                              }}
                            />
                            {sentEditErr && (
                              <div style={{ fontSize: 11, color: 'var(--error)', marginTop: 4 }}>{sentEditErr}</div>
                            )}
                            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                              <button onClick={submitEditSent} disabled={savingSent || !sentDraft.trim()} style={{
                                padding: '4px 12px', fontSize: 11, fontWeight: 600,
                                background: 'var(--accent)', color: '#fff', border: 'none',
                                borderRadius: 4,
                                opacity: (savingSent || !sentDraft.trim()) ? 0.5 : 1,
                                cursor: (savingSent || !sentDraft.trim()) ? 'not-allowed' : 'pointer',
                              }}>{savingSent ? '저장 중…' : '저장'}</button>
                              <button onClick={cancelEditSent} disabled={savingSent} style={{
                                padding: '4px 12px', fontSize: 11,
                                background: 'transparent', color: 'var(--text-body)',
                                border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
                              }}>취소</button>
                            </div>
                          </div>
                        )
                      }
                      const isSentSkipped = skippedSentenceStarts.has(Math.round((s.start || 0) * 100) / 100)
                      return (
                        <div key={si} style={{
                          fontSize: 13, lineHeight: 1.6,
                          color: isSentSkipped ? 'var(--text-muted)' : 'var(--text-body)',
                          textDecoration: isSentSkipped ? 'line-through' : 'none',
                          opacity: isSentSkipped ? 0.55 : 1,
                          display: 'flex', alignItems: 'flex-start', gap: 6,
                        }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0, marginTop: 2 }}>
                            {s.start.toFixed(1)}–{s.end.toFixed(1)}s
                          </span>
                          <span style={{ flex: 1 }}>{s.text}</span>
                          <button
                            onClick={() => startEditSent(chunk.section, si, s.text || '')}
                            title="이 문장의 오타 수정"
                            disabled={!!editingSent}
                            style={{
                              padding: '2px 6px', fontSize: 10, fontWeight: 500,
                              background: 'transparent', color: 'var(--text-muted)',
                              border: '1px solid var(--border)', borderRadius: 3,
                              cursor: editingSent ? 'not-allowed' : 'pointer',
                              opacity: editingSent ? 0.4 : 1,
                              flexShrink: 0,
                            }}>편집</button>
                          {(() => {
                            const isSkippedSent = skippedSentenceStarts.has(Math.round((s.start || 0) * 100) / 100)
                            return (
                          <button
                            onClick={() => onToggleSkipSentence(s.start || 0)}
                            title={isSkippedSent ? '복원' : '이 문장 이번 generation에서 skip (DB 영구 X)'}
                            disabled={!!editingSent}
                            style={{
                              padding: '2px 6px', fontSize: 10, fontWeight: 600,
                              background: isSkippedSent ? 'rgba(245,158,11,0.10)' : 'transparent',
                              color: isSkippedSent ? 'var(--accent)' : 'var(--error)',
                              border: `1px solid ${isSkippedSent ? 'var(--accent)' : 'var(--error)'}`, borderRadius: 3,
                              cursor: editingSent ? 'not-allowed' : 'pointer',
                              opacity: editingSent ? 0.4 : 1,
                              flexShrink: 0,
                            }}>{isSkippedSent ? '↺' : '🗑'}</button>
                            )
                          })()}
                        </div>
                      )
                    })}
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
                ) : (() => {
                  const chunkUserIds = getEffectiveChunkUspIds(chunk)
                  const isChunkOverride = chunkOverrides[chunk.section] !== undefined
                  const isMulti = chunkUserIds.length >= 2
                  // 모든 user USP 옵션 (chunk별로 자유롭게 다 선택 가능 — unused 제한 X)
                  const allUserUsps = mapping.product.usps.map((u: any, i: number) => ({
                    user_usp_id: i + 1, user_usp_name: u.usp,
                  }))
                  // 그룹별 버킷 정리 (있는 그룹만, 마지막에 미분류)
                  type _G = (typeof uspGroups)[number]
                  const idxToGroup = new Map<number, _G>()
                  for (const g of uspGroups) for (const i of g.usp_indexes) idxToGroup.set(i, g)
                  let buckets: Array<{ group: _G | null; usps: typeof allUserUsps }> = []
                  for (const g of uspGroups) {
                    const inG = allUserUsps.filter(u => g.usp_indexes.includes(u.user_usp_id))
                    if (inG.length) buckets.push({ group: g, usps: inG })
                  }
                  const unclassified = allUserUsps.filter(u => !idxToGroup.has(u.user_usp_id))
                  if (unclassified.length) buckets.push({ group: null, usps: unclassified })
                  // 그룹 필터 적용
                  if (groupFilter === 'unclassified') {
                    buckets = buckets.filter(b => b.group === null)
                  } else if (groupFilter) {
                    buckets = buckets.filter(b => b.group?.id === groupFilter)
                  }
                  const toggleUsp = (uid: number) => {
                    const next = chunkUserIds.includes(uid)
                      ? chunkUserIds.filter(x => x !== uid)
                      : [...chunkUserIds, uid].sort((a, b) => a - b)
                    // 빈 배열도 명시적 "미매핑"으로 저장 (LLM 자동 매핑 복원 X)
                    onChunkOverride(chunk.section, next)
                  }
                  return (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(180px, 1fr) 16px minmax(260px, 1.3fr)',
                    gap: 10, alignItems: 'start', fontSize: 13,
                    padding: '8px 0',
                  }}>
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        chunk [{chunk.section}] · {chunk.topic}
                      </div>
                      {chunk.role && (
                        <div style={{ marginTop: 4, display: 'inline-block', padding: '2px 8px',
                          background: 'rgba(99,102,241,0.12)', color: 'var(--accent)',
                          borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 600,
                        }}>
                          역할: {chunk.role}
                        </div>
                      )}
                      {chunk.summary && (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                          {chunk.summary}
                        </div>
                      )}
                    </div>
                    <div style={{ color: 'var(--text-muted)', paddingTop: 2 }}>→</div>
                    <div>
                      <div style={{
                        fontWeight: 600,
                        color: chunkUserIds.length ? 'var(--text-primary)' : 'var(--warning)',
                        marginBottom: 6, fontSize: 12,
                      }}>
                        {chunkUserIds.length
                          ? (() => {
                            const labels = chunkUserIds.map(uid => {
                              const u = allUserUsps.find(x => x.user_usp_id === uid)
                              return `USP${uid} · ${u?.user_usp_name || ''}`
                            }).join(' / ')
                            const tag = isChunkOverride ? ' (수동)' : ''
                            const multiTag = isMulti ? ' · 통합 호소' : ''
                            return `${labels}${tag}${multiTag}`
                          })()
                          : '매칭 없음 — 페르소나로 풀기'}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>
                        {buckets.map((bucket, bi) => (
                          <div key={bucket.group?.id || `unclassified-${bi}`}
                            style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                            <span style={{
                              padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                              background: bucket.group?.color || 'var(--bg-elevated)',
                              color: bucket.group?.color ? '#fff' : 'var(--text-muted)',
                              border: bucket.group ? 'none' : '1px dashed var(--border)',
                              whiteSpace: 'nowrap', minWidth: 56, textAlign: 'center',
                            }}>
                              {bucket.group ? bucket.group.name : '미분류'}
                            </span>
                            {bucket.usps.map(u => {
                              const checked = chunkUserIds.includes(u.user_usp_id)
                              return (
                                <span key={u.user_usp_id} style={{ display: 'inline-flex', alignItems: 'stretch' }}>
                                  <button
                                    type="button"
                                    onClick={() => toggleUsp(u.user_usp_id)}
                                    style={{
                                      padding: '4px 8px 4px 10px', fontSize: 11, fontWeight: checked ? 700 : 500,
                                      border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                                      borderRight: 'none',
                                      borderTopLeftRadius: 'var(--radius-pill)',
                                      borderBottomLeftRadius: 'var(--radius-pill)',
                                      background: checked ? 'var(--accent-light)' : 'var(--bg-base)',
                                      color: checked ? 'var(--accent)' : 'var(--text-body)',
                                      cursor: 'pointer',
                                    }}>
                                    {checked ? '✓ ' : ''}USP{u.user_usp_id} · {u.user_usp_name}
                                  </button>
                                  <button
                                    type="button"
                                    title={`USP${u.user_usp_id} 수정`}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      startEditUsp(u.user_usp_id, chunk.section)
                                    }}
                                    style={{
                                      padding: '4px 8px', fontSize: 11,
                                      border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                                      borderTopRightRadius: 'var(--radius-pill)',
                                      borderBottomRightRadius: 'var(--radius-pill)',
                                      background: checked ? 'var(--accent-light)' : 'var(--bg-base)',
                                      color: 'var(--text-muted)',
                                      cursor: 'pointer',
                                    }}>
                                    편집
                                  </button>
                                </span>
                              )
                            })}
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => onChunkOverride(chunk.section, [])}
                          title="모든 USP 매핑 해제 — 이 chunk는 페르소나 톤 + ref 구조로만 작성됨"
                          style={{
                            padding: '4px 10px', fontSize: 11,
                            fontWeight: chunkUserIds.length === 0 ? 700 : 500,
                            border: `1px dashed ${chunkUserIds.length === 0 ? 'var(--warning)' : 'var(--border)'}`,
                            borderRadius: 'var(--radius-pill)',
                            background: chunkUserIds.length === 0 ? 'rgba(245,158,11,0.10)' : 'transparent',
                            color: chunkUserIds.length === 0 ? 'var(--warning)' : 'var(--text-muted)',
                            cursor: 'pointer',
                          }}>
                          {chunkUserIds.length === 0 ? '· ' : ''}매핑 없음 (페르소나로 풀기)
                        </button>
                      </div>
                      {/* 인라인 USP 편집 폼 — 이 chunk에서 ✏ 클릭한 경우만 렌더 */}
                      {editingUspId != null && editingChunkSection === chunk.section && (
                        <div style={{
                          padding: 10, marginBottom: 8,
                          background: 'var(--bg-base)',
                          border: '1px solid var(--accent)',
                          borderRadius: 'var(--radius-sm)',
                        }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', marginBottom: 6 }}>
                            USP{editingUspId} 수정 (저장하면 내 상품 DB 갱신)
                          </div>
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            placeholder="USP 이름"
                            style={{
                              width: '100%', padding: '7px 10px', fontSize: 12, marginBottom: 6,
                              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                              background: 'var(--bg-surface)',
                            }}
                          />
                          <div style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>설명 (writer 어휘 source)</span>
                            <button
                              type="button"
                              disabled={!editName.trim()}
                              title={editName.trim() ? 'LLM이 USP 이름 + 리뷰로 description 자동 생성' : 'USP 이름 먼저'}
                              onClick={async () => {
                                if (!editName.trim()) return
                                try {
                                  const reviews = editReviews.split('\n').map(r => r.trim()).filter(Boolean)
                                  const r = await api.suggestUspDescription({
                                    product_name: mapping?.product?.name || '',
                                    usp_name: editName,
                                    reviews,
                                  })
                                  setEditDesc(r.description)
                                } catch (err: any) {
                                  alert('LLM 추천 실패: ' + (err?.message || err))
                                }
                              }}
                              style={{
                                padding: '3px 10px', fontSize: 11, fontWeight: 600,
                                border: '1px solid var(--accent)', borderRadius: 4,
                                background: editName.trim() ? 'var(--accent-light)' : 'var(--bg-elevated)',
                                color: editName.trim() ? 'var(--accent)' : 'var(--text-muted)',
                                cursor: editName.trim() ? 'pointer' : 'not-allowed',
                              }}>
                              🪄 LLM 추천
                            </button>
                          </div>
                          <textarea
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            placeholder="설명 (예: 문제: ... / 해결: ... / 혜택: ...) — 또는 위 🪄 LLM 추천 클릭"
                            rows={4}
                            style={{
                              width: '100%', padding: '7px 10px', fontSize: 12, marginBottom: 6,
                              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                              background: 'var(--bg-surface)', resize: 'vertical', fontFamily: 'inherit',
                            }}
                          />
                          <textarea
                            value={editReviews}
                            onChange={(e) => setEditReviews(e.target.value)}
                            placeholder={'리뷰 (한 줄에 하나씩)'}
                            rows={4}
                            style={{
                              width: '100%', padding: '7px 10px', fontSize: 12, marginBottom: 6,
                              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                              background: 'var(--bg-surface)', resize: 'vertical', fontFamily: 'inherit',
                            }}
                          />
                          {editErr && (
                            <div style={{ fontSize: 11, color: 'var(--error)', marginBottom: 6 }}>{editErr}</div>
                          )}
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={submitEditUsp} disabled={savingUsp || !editName.trim()} style={{
                              ...primaryBtnSt, padding: '6px 14px', fontSize: 12,
                              opacity: (savingUsp || !editName.trim()) ? 0.5 : 1,
                              cursor: (savingUsp || !editName.trim()) ? 'not-allowed' : 'pointer',
                            }}>
                              {savingUsp ? '저장 중…' : '저장'}
                            </button>
                            <button onClick={cancelEditUsp} disabled={savingUsp} style={{
                              ...ghostBtnSt, padding: '6px 14px', fontSize: 12,
                            }}>취소</button>
                          </div>
                        </div>
                      )}
                      {chunkUserIds.length === 0 && (
                        <div style={{
                          fontSize: 11, color: 'var(--warning)', lineHeight: 1.5,
                          padding: '6px 10px', background: 'rgba(245,158,11,0.08)',
                          borderRadius: 'var(--radius-sm)', border: '1px dashed var(--warning)',
                          marginBottom: 6,
                        }}>
                          이 chunk는 우리 USP에 매핑되지 않음 — <b>페르소나 톤 + ref 구조</b>로 작성됩니다.
                        </div>
                      )}
                      {mappingRec?.reason && (
                        <div style={{
                          fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5,
                          padding: '6px 10px', background: 'var(--bg-base)',
                          borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
                          marginBottom: 6,
                        }}>
                          <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>매핑 근거: </span>
                          {mappingRec.reason}
                        </div>
                      )}
                      {creatingFor === chunk.section ? (
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
                          onClick={() => startCreate(chunk.section, chunk.summary || chunk.topic)}
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
                    {mappingRec?.reason && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {mappingRec.reason}
                      </div>
                    )}
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

      {/* Section picker modal — hook/intro/cta 공용 */}
      {pickerSection && (
        <div onClick={() => setPickerSection(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: 'var(--bg-base)', borderRadius: 'var(--radius-lg)',
            width: 'min(720px, 92vw)', maxHeight: '80vh', overflow: 'hidden',
            display: 'flex', flexDirection: 'column', border: '1px solid var(--border)',
          }}>
            <div style={{
              padding: '14px 18px', borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>📚 다른 ref {pickerSection.toUpperCase()} 가져오기</div>
              <input
                value={sectionSearch}
                onChange={(e) => {
                  const v = e.target.value
                  setSectionSearch(v)
                  const sc = _extractShortcode(v)
                  if (sc) lookupBySc(sc)
                }}
                onPaste={(e) => {
                  const txt = e.clipboardData.getData('text')
                  const sc = _extractShortcode(txt)
                  if (sc) lookupBySc(sc)
                }}
                placeholder="검색 (텍스트, 작성자, shortcode, 또는 URL 붙여넣기)"
                style={{
                  flex: 1, padding: '6px 10px', fontSize: 12,
                  border: '1px solid var(--border)', borderRadius: 6,
                  background: 'var(--bg-surface)',
                }}
              />
              <button onClick={() => setPickerSection(null)} style={{
                padding: '4px 10px', fontSize: 12, background: 'transparent',
                border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
              }}>닫기</button>
            </div>
            <div style={{ overflowY: 'auto', padding: '8px 0' }}>
              {poolLoading ? (
                <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  로딩 중…
                </div>
              ) : filteredPool.length === 0 ? (
                <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  결과 없음
                </div>
              ) : (
                filteredPool.map((c) => (
                  <div key={c.shortcode} style={{
                    padding: '10px 18px', borderBottom: '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                  }} onClick={() => {
                    if (!pickerSection) return
                    setSectionOverrides(prev => ({
                      ...prev,
                      [pickerSection]: {
                        shortcode: c.shortcode, author: c.author,
                        section_text: c.section_text, section_chunk: c.section_chunk, topic: c.topic,
                      },
                    }))
                    setPickerSection(null)
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-elevated)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                      @{c.author || '익명'} · <code>{c.shortcode}</code>
                      {c.topic && <span style={{ marginLeft: 6 }}>· {c.topic}</span>}
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-body)' }}>
                      {c.section_text}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function StepPersona({
  mapping, personas, matchedUserUsps, selected, onToggle, onRefreshUspPersonas, refreshingUspIdx,
  selectedRefDesireIdx, onToggleRefDesire,
  error, onBack, onGenerate,
  onGenerateUnified, unifiedLoading, unifiedMeta,
}: {
  mapping: MappingPreview | null
  personas: Array<PersonaCandidate & { _uspIndex: number; _uspName: string; _unified?: boolean; _coversUsps?: number[] }>
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
  onGenerateUnified: () => Promise<void>
  unifiedLoading: boolean
  unifiedMeta: { common_pain: string; common_context: string; shared_keywords: string[] } | null
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
          <div style={labelSt}>참고 대본 기반 desire/pain 후보 (선택사항)</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
            참고 릴스의 emotional thrust를 product 도메인으로 transform한 페르소나. 기본 미선택 — 위 USP 페르소나가 우선 권장.
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <div style={labelSt}>3단계 — 페르소나 선택 (총 0~2개)</div>
          <button
            type="button"
            onClick={onGenerateUnified}
            disabled={unifiedLoading}
            title="선택된 USP들의 공통점을 분석해서 모든 USP에 자연 fit하는 통합 페르소나 생성"
            style={{
              marginLeft: 'auto',
              padding: '6px 12px', fontSize: 12, fontWeight: 700,
              border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)',
              background: unifiedLoading ? 'var(--bg-elevated)' : 'var(--accent)',
              color: unifiedLoading ? 'var(--text-muted)' : '#fff',
              cursor: unifiedLoading ? 'not-allowed' : 'pointer',
            }}>
            {unifiedLoading ? '분석 중…' : '통합 페르소나 생성'}
          </button>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          위 desire 후보 + 아래 USP 페르소나 합쳐 0~2개. 0개 = 자동 추론.
        </div>
        {unifiedMeta && (
          <div style={{
            padding: 10, marginBottom: 12,
            background: 'var(--accent-light)', border: '1px solid var(--accent)',
            borderRadius: 'var(--radius-sm)', fontSize: 12, lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 700, color: 'var(--accent)', marginBottom: 4 }}>🔗 USP 교집합 분석</div>
            {unifiedMeta.common_pain && (
              <div><span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>공통 pain:</span> {unifiedMeta.common_pain}</div>
            )}
            {unifiedMeta.common_context && (
              <div><span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>공통 context:</span> {unifiedMeta.common_context}</div>
            )}
            {unifiedMeta.shared_keywords?.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>공통 키워드:</span>{' '}
                {unifiedMeta.shared_keywords.map((k, i) => (
                  <span key={i} style={{
                    display: 'inline-block', marginRight: 4, marginTop: 2,
                    padding: '1px 7px', fontSize: 11,
                    background: 'var(--bg-surface)', color: 'var(--text-body)',
                    borderRadius: 4, border: '1px solid var(--border)',
                  }}>{k}</span>
                ))}
              </div>
            )}
          </div>
        )}
        {personas.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {unifiedLoading
              ? '통합 페르소나 분석 중… (USP 교집합 + 5개 페르소나 도출)'
              : '통합 페르소나 미생성. 위 버튼으로 생성하거나, 0개 = 자동 추론으로 진행하세요.'}
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
                      {p._unified && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 7px',
                          background: 'var(--accent)', color: '#fff',
                          borderRadius: 'var(--radius-sm)', letterSpacing: '0.03em',
                        }}>🔗 통합 {p._coversUsps?.length ? `(USP ${p._coversUsps.join(',')})` : ''}</span>
                      )}
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
  result, refChunks, chunkUspMapping, onRestart, onBackToPersona, onBackToMapping, onSkipChunkSection,
  productId, shortcode, source, usps, onRefined, skipOpts,
}: {
  result: Record<string, GeneratedScript>
  refChunks: MappingPreview['section_chunks']
  chunkUspMapping: Record<string, { ids: number[]; names: string[] }>
  onRestart: () => void
  onBackToPersona: () => void
  onBackToMapping: () => void
  onSkipChunkSection: (section: string) => void
  productId: number | null
  shortcode: string
  source: 'reels' | 'youtube'
  usps: Array<{ usp: string; description?: string; reviews?: string[] }>
  onRefined: (tabName: string, refined: GeneratedScript) => void
  skipOpts: { skip_chunk_sections?: string[]; skip_sentence_starts?: number[] }
}) {
  // ref 문장 평탄화 (start 시간순 정렬, 빈 문장 제외) — _borrowed_from 메타 전파
  const refSentences = refChunks
    .flatMap((c: any) => (c.sentences || []).map((s: any) => ({
      ...s, section: c.section || '', _borrowed_from: c._borrowed_from || '',
    })))
    .filter((s: any) => (s.text || '').trim())
    .sort((a: any, b: any) => (a.start || 0) - (b.start || 0))
  const navigate = useNavigate()
  const tabs = Object.keys(result)
  // StepDone 영속화 — shortcode별 별도 키, TTL 1시간
  const stepDoneKey = `rb_wizard_stepdone:${shortcode || ''}`
  const stepDoneSaved = (() => {
    if (!shortcode) return null
    try {
      const raw = sessionStorage.getItem(stepDoneKey)
      if (!raw) return null
      const s = JSON.parse(raw)
      if (!s || (Date.now() - (s._t || 0)) > 60 * 60 * 1000) {
        sessionStorage.removeItem(stepDoneKey)
        return null
      }
      return s
    } catch { return null }
  })()
  const [active, setActive] = useState(stepDoneSaved?.active || tabs[0] || '')
  const [editingTab, setEditingTab] = useState<string | null>(null)
  const [refiningTab, setRefiningTab] = useState<string | null>(null)
  const [editedResult, setEditedResult] = useState<Record<string, GeneratedScript>>(stepDoneSaved?.editedResult || {})
  const [draftSentences, setDraftSentences] = useState<{ start: number; end: number; text: string }[] | null>(null)
  type StageKey = 'base' | 'alt_a' | 'alt_b'
  type RefineStage = { key: StageKey; sentences: any[]; created_at: string }
  const [stagesByTab, setStagesByTab] = useState<Record<string, RefineStage[]>>(stepDoneSaved?.stagesByTab || {})
  const [stageViewByTab, setStageViewByTab] = useState<Record<string, StageKey | null>>(stepDoneSaved?.stageViewByTab || {})
  const stageLabel = (k: StageKey) => k === 'base' ? '기본' : k === 'alt_a' ? 'A원고' : 'B원고'

  // StepDone 자동 영속화
  useEffect(() => {
    if (!shortcode) return
    try {
      sessionStorage.setItem(stepDoneKey, JSON.stringify({
        _t: Date.now(), active, editedResult, stagesByTab, stageViewByTab,
      }))
    } catch {}
  }, [stepDoneKey, shortcode, active, editedResult, stagesByTab, stageViewByTab])

  // 새 result 들어올 때 (생성 재시작 — 탭 자체 변경) 편집/단계 상태 리셋.
  // 첫 mount 에선 sessionStorage 복원본 보존해야 하므로 prev ref 가드 — 실제 변경 시만 reset.
  const tabsKey = tabs.join('|')
  const prevTabsKey = useRef(tabsKey)
  useEffect(() => {
    if (prevTabsKey.current === tabsKey) return
    prevTabsKey.current = tabsKey
    setEditedResult({})
    setEditingTab(null)
    setDraftSentences(null)
    setStagesByTab({})
    setStageViewByTab({})
  }, [tabsKey])

  const display = (tab: string): GeneratedScript | null => {
    if (!tab) return null
    return editedResult[tab] || result[tab] || null
  }
  const cur = display(active)

  const startEdit = () => {
    if (!cur) return
    setDraftSentences((cur.sentences || []).map(s => ({ start: s.start, end: s.end, text: s.text })))
    setEditingTab(active)
  }
  const cancelEdit = () => {
    setEditingTab(null)
    setDraftSentences(null)
  }
  const saveEdit = () => {
    if (!cur || !draftSentences) return
    const merged = (cur.sentences || []).map((orig, i) => {
      const draft = draftSentences[i]
      if (!draft) return orig
      return { ...orig, text: draft.text }
    })
    const ttsLines = merged.map(s => s.text).join('\n')
    const updated: GeneratedScript = { ...cur, sentences: merged, tts_script: ttsLines }
    setEditedResult(prev => ({ ...prev, [active]: updated }))
    // 편집 결과를 stagesByTab에도 반영 — 다듬기 A/B의 입력이 항상 "현재 보고 있는 base"가 되도록 보장
    // stages 비어있으면 base 자동 생성 (편집된 sentences로)
    const view: StageKey = stageViewByTab[active] || 'base'
    const now = new Date().toISOString()
    setStagesByTab(prev => {
      const cur_stages = prev[active] || []
      const idx = cur_stages.findIndex(s => s.key === view)
      if (idx >= 0) {
        return {
          ...prev,
          [active]: cur_stages.map(s => s.key === view ? { ...s, sentences: merged } : s),
        }
      }
      // 해당 key 없으면 추가 (base가 보통)
      return { ...prev, [active]: [...cur_stages, { key: view, sentences: merged, created_at: now }] }
    })
    setEditingTab(null)
    setDraftSentences(null)
  }
  const updateDraft = (idx: number, text: string) => {
    setDraftSentences(prev => prev ? prev.map((s, i) => i === idx ? { ...s, text } : s) : prev)
  }

  // chunk 단위 삭제 — 결과에서 특정 section의 모든 generated sentences 제거
  // + skippedChunks(부모)에도 추가해서 재생성 시 section-planner/writer 단계에서도 제외
  const deleteChunkRows = (rowIndices: number[], section?: string) => {
    const c = display(active)
    if (!c) return
    const indexSet = new Set(rowIndices)
    const newSentences = (c.sentences || []).filter((_, i) => !indexSet.has(i))
    const ttsLines = newSentences.map(s => s.text).join('\n')
    const updated: GeneratedScript = { ...c, sentences: newSentences, tts_script: ttsLines }
    setEditedResult(prev => ({ ...prev, [active]: updated }))
    if (section) onSkipChunkSection(section)
  }

  const isEditingActive = editingTab === active && draftSentences !== null
  const dirty = !!editedResult[active]

  const [saving, setSaving] = useState(false)
  const saveCurrent = async () => {
    if (!productId || saving || !active) return
    const draft = editedResult[active] || result[active]
    if (!draft) {
      alert('현재 페르소나 대본이 없습니다.')
      return
    }
    setSaving(true)
    try {
      await api.saveGenScript(productId, {
        ref_shortcode: shortcode || undefined,
        source_type: source === 'youtube' ? 'youtube' : 'insta',
        persona_name: active,
        title: active,
        sentences: (draft.sentences || []) as any[],
        meta: {
          duration_target_sec: draft.duration_target_sec,
          _cost: (draft as any)._cost,
          _usp_mapping: draft._usp_mapping,
          stages: stagesByTab[active] || [],
        },
      })
      if (confirm(`"${active}" 대본 저장 완료! 저장된 대본 목록으로 이동할까요?`)) {
        navigate(`/my-products/${productId}/scripts`)
      }
    } catch (e: any) {
      alert('저장 실패: ' + (e.message || e))
    } finally {
      setSaving(false)
    }
  }

  // 원본 문장 (편집 전) — start time → text 매핑. 색상 강조용.
  const originalTextByStart = (() => {
    const m = new Map<number, string>()
    const orig = result[active]
    if (orig?.sentences) {
      for (const s of orig.sentences) m.set(Math.round(s.start * 100), s.text || '')
    }
    return m
  })()
  const isSentenceEdited = (s: { start: number; text: string }): boolean => {
    const orig = originalTextByStart.get(Math.round(s.start * 100))
    if (orig === undefined) return false  // 원본에 없으면 비교 불가 (정상 X — 그냥 false)
    return (orig || '').trim() !== (s.text || '').trim()
  }

  return (
    <>
      {productId && active && (
        <button
          onClick={saveCurrent}
          disabled={saving}
          style={{
            ...primaryBtnSt, width: '100%', marginBottom: 12,
            opacity: saving ? 0.7 : 1, cursor: saving ? 'wait' : 'pointer',
          }}>
          {saving ? '저장 중…' : `💾 "${active}" 대본 저장`}
        </button>
      )}

      {tabs.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          {tabs.map(t => (
            <button key={t} onClick={() => { if (isEditingActive) return; setActive(t) }}
              disabled={isEditingActive && t !== active}
              style={{
                padding: '8px 14px', fontSize: 12,
                border: 'none', borderBottom: `2px solid ${active === t ? 'var(--accent)' : 'transparent'}`,
                background: 'transparent',
                color: active === t ? 'var(--text-primary)' : 'var(--text-muted)',
                fontWeight: active === t ? 600 : 500,
                cursor: isEditingActive && t !== active ? 'not-allowed' : 'pointer',
                opacity: isEditingActive && t !== active ? 0.5 : 1,
              }}>{t}{editedResult[t] ? ' ·' : ''}</button>
          ))}
        </div>
      )}

      {cur && (
        <div style={cardSt}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                생성된 대본 ({cur.duration_target_sec}초)
              </div>
              {(stagesByTab[active] || []).length > 0 && !isEditingActive && (
                <>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>단계:</label>
                  <select
                    value={stageViewByTab[active] || (stagesByTab[active][0]?.key || 'base')}
                    onChange={e => {
                      const v = e.target.value as StageKey
                      setStageViewByTab(prev => ({ ...prev, [active]: v }))
                      const stages = stagesByTab[active] || []
                      const pick = stages.find(s => s.key === v)
                      if (pick) {
                        const merged: GeneratedScript = { ...cur, sentences: pick.sentences }
                        onRefined(active, merged)
                      }
                    }}
                    style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4,
                      border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-body)' }}>
                    {(stagesByTab[active] || []).map(s => (
                      <option key={s.key} value={s.key}>{stageLabel(s.key)}</option>
                    ))}
                  </select>
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {!isEditingActive ? (
                <>
                  <button onClick={startEdit} style={ghostBtnSt}>대본 수정</button>
                  {(['default', 'strong'] as const).map(v => {
                    const targetKey: StageKey = v === 'default' ? 'alt_a' : 'alt_b'
                    const stages = stagesByTab[active] || []
                    const already = stages.find(s => s.key === targetKey)
                    return (
                    <button key={v}
                      onClick={async () => {
                        if (refiningTab || already) return
                        setRefiningTab(`${active}:${v}`)
                        try {
                          // 입력은 항상 base (있으면) 또는 현재 cur.sentences
                          const baseSents = stages.find(s => s.key === 'base')?.sentences || cur.sentences || []
                          const refined = await api.refineScript({ ...cur, sentences: baseSents }, usps, shortcode || undefined, skipOpts, v)
                          if (refined && refined.sentences) {
                            // direction/emotion/delivery 같은 TTS 메타를 base에서 1:1 merge (LLM 응답에 빠지면 base 유지)
                            // — rs.direction이 빈 문자열("")일 때도 base로 fallback (??는 null/undefined만 fallback)
                            refined.sentences = refined.sentences.map((rs: any, i: number) => {
                              const base: any = baseSents[i] || {}
                              const pickStr = (a: any, b: any) => (typeof a === 'string' && a.trim()) ? a : b
                              return {
                                ...base,
                                text: rs.text || base.text,
                                direction: pickStr(rs.direction, base.direction),
                                emotion: pickStr(rs.emotion, base.emotion),
                                intensity: (rs.intensity ?? base.intensity),
                                delivery: pickStr(rs.delivery, base.delivery),
                              }
                            })
                            const now = new Date().toISOString()
                            setStagesByTab(prev => {
                              const cur_stages = prev[active] || []
                              const map = new Map<StageKey, RefineStage>()
                              // base 보장
                              const existingBase = cur_stages.find(s => s.key === 'base')
                              map.set('base', existingBase || { key: 'base', sentences: baseSents, created_at: now })
                              for (const s of cur_stages) {
                                if (s.key !== 'base') map.set(s.key, s)
                              }
                              map.set(targetKey, { key: targetKey, sentences: refined.sentences, created_at: now })
                              const order: StageKey[] = ['base', 'alt_a', 'alt_b']
                              return { ...prev, [active]: order.filter(k => map.has(k)).map(k => map.get(k)!) }
                            })
                            setStageViewByTab(prev => ({ ...prev, [active]: targetKey }))
                            const merged: GeneratedScript = { ...cur, sentences: refined.sentences, tts_script: refined.tts_script || cur.tts_script }
                            onRefined(active, merged)
                          }
                        } catch (e: any) {
                          alert('다듬기 실패: ' + (e?.message || e))
                        } finally {
                          setRefiningTab(null)
                        }
                      }}
                      disabled={refiningTab !== null || !!already}
                      title={already ? `${stageLabel(targetKey)}는 이미 만들어졌습니다. dropdown으로 확인.`
                        : v === 'default'
                        ? '기본 원고 → A원고 (어색 문장 + 어휘 중복 교정)'
                        : '기본 원고 → B원고 (humanize — AI 티 제거)'}
                      style={{
                        ...ghostBtnSt,
                        background: already ? 'var(--bg-elevated)'
                          : refiningTab === `${active}:${v}` ? 'var(--bg-elevated)'
                          : v === 'default' ? '#f59e0b' : '#8b5cf6',
                        color: already ? 'var(--text-muted)'
                          : refiningTab === `${active}:${v}` ? 'var(--text-muted)' : '#fff',
                        borderColor: already ? 'var(--border)'
                          : v === 'default' ? '#f59e0b' : '#8b5cf6',
                        cursor: (refiningTab !== null || already) ? 'not-allowed' : 'pointer',
                      }}>
                      {refiningTab === `${active}:${v}` ? '다듬는 중…'
                        : already ? (v === 'default' ? 'A원고 ✓' : 'B원고 ✓')
                        : v === 'default' ? '다듬기 A (→ A원고)' : '다듬기 B (→ B원고 사람 톤)'}
                    </button>
                  )})}
                  <button onClick={async () => {
                    const text = buildTtsText(cur.sentences || [], cur.tts_script)
                    await navigator.clipboard.writeText(text)
                  }} style={ghostBtnSt}>TTS 복사</button>
                  <button
                    onClick={() => navigate('/tts', { state: {
                      sentences: cur.sentences,
                      title: active,
                      from: { path: '__back__', label: '대본 생성 결과' },
                    } })}
                    disabled={!cur.sentences?.length}
                    style={{
                      ...ghostBtnSt,
                      background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)',
                      cursor: cur.sentences?.length ? 'pointer' : 'not-allowed',
                      opacity: cur.sentences?.length ? 1 : 0.5,
                    }}
                  >🎙 음성 생성</button>
                </>
              ) : (
                <>
                  <button onClick={cancelEdit} style={ghostBtnSt}>취소</button>
                  <button onClick={saveEdit} style={{
                    ...ghostBtnSt,
                    background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)',
                  }}>💾 저장하기</button>
                </>
              )}
            </div>
          </div>
          {/* 컬럼 헤더 */}
          {refSentences.length > 0 && (
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
              padding: '6px 0', marginBottom: 4,
              fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: 'var(--text-muted)',
              borderBottom: '1px solid var(--border-subtle)',
            }}>
              <div>📋 참고 (REF)</div>
              <div>생성된 대본</div>
            </div>
          )}
          {/* 행별 비교 — section별 그룹 헤더 + chunk 삭제 버튼 */}
          {(() => {
            const genList = isEditingActive && draftSentences ? draftSentences : (cur.sentences || [])
            const rows = Math.max(refSentences.length, genList.length)
            // section별 row 인덱스 그룹화 (chunk 삭제 시 해당 그룹의 모든 row 인덱스 제거)
            const sectionRows = new Map<string, number[]>()
            for (let i = 0; i < rows; i++) {
              const sec = (refSentences[i]?.section || '').toLowerCase()
              if (!sec) continue
              if (!sectionRows.has(sec)) sectionRows.set(sec, [])
              sectionRows.get(sec)!.push(i)
            }
            const elements: React.ReactNode[] = []
            let prevSection = ''
            for (let i = 0; i < rows; i++) {
              const ref = refSentences[i]
              const gen = genList[i]
              const curSection = (ref?.section || '').toLowerCase()
              if (curSection && curSection !== prevSection) {
                const groupIndices = sectionRows.get(curSection) || []
                const mappedUsps = chunkUspMapping[curSection] || { ids: [], names: [] }
                elements.push(
                  <div key={`hdr-${curSection}-${i}`} style={{
                    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                    padding: '10px 0 6px', borderTop: i > 0 ? '1px dashed var(--border)' : 'none',
                  }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                      padding: '3px 8px', borderRadius: 4,
                      background: 'var(--bg-elevated)', color: 'var(--text-muted)',
                    }}>{curSection}</span>
                    {/* 매핑된 USP 뱃지 */}
                    {mappedUsps.ids.length > 0 ? (
                      mappedUsps.ids.map((uid, k) => (
                        <span key={uid} style={{
                          fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                          background: 'rgba(99,102,241,0.12)', color: 'var(--accent)',
                          border: '1px solid var(--accent)',
                        }}>
                          USP{uid} · {mappedUsps.names[k] || ''}
                        </span>
                      ))
                    ) : (
                      <span style={{
                        fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 4,
                        background: 'transparent', color: 'var(--text-muted)',
                        border: '1px dashed var(--border)',
                      }}>매핑 없음 (페르소나)</span>
                    )}
                    {mappedUsps.ids.length >= 2 && (
                      <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600 }}>통합 호소</span>
                    )}
                    {!isEditingActive && (
                      <button
                        onClick={() => {
                          if (!confirm(`이 chunk(${curSection})의 ${groupIndices.length}문장을 결과에서 삭제하고\n재생성 시에도 자동 제외할까요?`)) return
                          deleteChunkRows(groupIndices, curSection)
                        }}
                        title="이 chunk를 결과에서 삭제 + 재생성 시 section-planner/writer에서도 제외"
                        style={{
                          marginLeft: 'auto',
                          padding: '2px 8px', fontSize: 10, fontWeight: 600,
                          border: '1px solid var(--error)', borderRadius: 4,
                          background: 'transparent', color: 'var(--error)', cursor: 'pointer',
                        }}>
                        이 chunk 삭제
                      </button>
                    )}
                  </div>
                )
                prevSection = curSection
              }
              elements.push(
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: refSentences.length > 0 ? '1fr 1fr' : '1fr',
                  gap: 12, padding: '8px 0', alignItems: 'start',
                  borderTop: i > 0 && curSection === prevSection ? '1px solid var(--border-subtle)' : 'none',
                }}>
                  {refSentences.length > 0 && (
                    <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                      {ref ? (
                        <>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2, fontFamily: 'monospace' }}>
                            [{(ref.start || 0).toFixed(1)}–{(ref.end || 0).toFixed(1)}s]
                            {ref.section && (
                              <span style={{
                                marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px',
                                borderRadius: 3, background: 'var(--bg-elevated)', textTransform: 'uppercase',
                              }}>{ref.section}</span>
                            )}
                            {(ref as any)._borrowed_from && (
                              <span style={{
                                marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 6px',
                                borderRadius: 3, background: 'rgba(99,102,241,0.15)', color: 'var(--accent)',
                                border: '1px solid var(--accent)', textTransform: 'none',
                              }}>↗ from {(ref as any)._borrowed_from}</span>
                            )}
                          </div>
                          <div>{ref.text}</div>
                        </>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>—</span>
                      )}
                    </div>
                  )}
                  <div>
                    {gen ? (() => {
                      const edited = !isEditingActive && isSentenceEdited(gen)
                      return (
                      <>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2, fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span>[{gen.start.toFixed(1)}–{gen.end.toFixed(1)}s]</span>
                          {edited && (
                            <span style={{
                              fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                              background: 'rgba(34,197,94,0.15)', color: 'var(--success)',
                              border: '1px solid var(--success)', letterSpacing: '0.05em',
                            }}>편집됨</span>
                          )}
                        </div>
                        {isEditingActive && draftSentences ? (
                          <textarea
                            value={gen.text}
                            onChange={e => updateDraft(i, e.target.value)}
                            rows={Math.max(1, Math.ceil(gen.text.length / 40))}
                            style={{
                              width: '100%', padding: '6px 10px', fontSize: 13, lineHeight: 1.5,
                              border: '1px solid var(--border)', borderRadius: 6,
                              background: 'var(--bg-base)', color: 'var(--text-body)',
                              resize: 'vertical', fontFamily: 'inherit',
                            }}
                          />
                        ) : (
                          <div style={{
                            fontSize: 13, lineHeight: 1.5, fontWeight: 500,
                            color: edited ? 'var(--success)' : 'var(--text-primary)',
                            background: edited ? 'rgba(34,197,94,0.08)' : 'transparent',
                            padding: edited ? '4px 8px' : 0,
                            borderRadius: edited ? 4 : 0,
                            borderLeft: edited ? '3px solid var(--success)' : 'none',
                          }}>
                            {gen.text}
                          </div>
                        )}
                      </>
                      )
                    })() : (
                      <span style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 }}>—</span>
                    )}
                  </div>
                </div>,
              )
            }
            return elements
          })()}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={onBackToMapping} style={{ ...ghostBtnSt, flex: 1 }}>← 매핑으로</button>
        <button onClick={onBackToPersona} style={{ ...ghostBtnSt, flex: 1 }}>← 페르소나로</button>
        <button onClick={onRestart} style={{ ...ghostBtnSt, flex: 1 }}>↺ 처음부터</button>
      </div>
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

function HookArchetypePicker({
  classified, override, setOverride,
}: {
  classified: NonNullable<MappingPreview['hook_archetype']>
  override: { archetype: string; pattern?: string; core_word?: string } | null
  setOverride: React.Dispatch<React.SetStateAction<{ archetype: string; pattern?: string; core_word?: string } | null>>
}) {
  const candidates = classified.candidates && classified.candidates.length > 0
    ? classified.candidates
    : [{ archetype: classified.archetype, pattern: classified.pattern || '', core_word: classified.core_word || '', score: 1 }]
  const activeArch = override?.archetype || classified.archetype
  if (candidates.length < 2) {
    return (
      <div style={{
        background: 'rgba(99,102,241,0.08)', border: '1px solid var(--accent)',
        borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 10,
        fontSize: 11, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <span style={{ fontWeight: 700, color: 'var(--accent)' }}>🎯 Hook archetype</span>
        <span style={{ fontWeight: 600 }}>{classified.archetype}</span>
        {classified.core_word && <span style={{ color: 'var(--text-secondary)' }}>· core: <b>{classified.core_word}</b></span>}
        {classified.pattern && <span style={{ color: 'var(--text-muted)' }}>· pattern: <code>{classified.pattern}</code></span>}
      </div>
    )
  }
  return (
    <div style={{
      background: 'rgba(99,102,241,0.06)', border: '1px solid var(--accent)',
      borderRadius: 'var(--radius-sm)', padding: '10px 12px', marginBottom: 10,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', marginBottom: 6 }}>
        🎯 Hook archetype 후보 ({candidates.length}개) — primary 선택
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {candidates.map((c, i) => {
          const checked = c.archetype === activeArch
          return (
            <label key={`${c.archetype}-${i}`} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
              fontSize: 11, lineHeight: 1.4,
              background: checked ? 'var(--bg-surface)' : 'transparent',
              border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 4, cursor: 'pointer',
            }}>
              <input
                type="radio" name="hook-archetype" checked={checked}
                onChange={() => {
                  if (c.archetype === classified.archetype) {
                    // 분석 default로 복귀 → override 해제
                    setOverride(null)
                  } else {
                    setOverride({ archetype: c.archetype, pattern: c.pattern, core_word: c.core_word })
                  }
                }}
                style={{ flexShrink: 0 }}
              />
              <span style={{ fontWeight: 600 }}>{c.archetype}</span>
              {c.score != null && (
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>score {(c.score * 100).toFixed(0)}%</span>
              )}
              {c.core_word && <span style={{ color: 'var(--text-secondary)' }}>· core: <b>{c.core_word}</b></span>}
              {c.pattern && <span style={{ color: 'var(--text-muted)' }}>· {c.pattern}</span>}
              {c.archetype === classified.archetype && (
                <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-muted)' }}>(분석 default)</span>
              )}
            </label>
          )
        })}
      </div>
    </div>
  )
}
