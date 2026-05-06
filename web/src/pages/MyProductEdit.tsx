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
          {usps.map((u, i) => (
            <div key={i} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <input style={{ ...inputSt, flex: 1 }} value={u.usp}
                  onChange={e => setUsps(usps.map((x, idx) => idx === i ? { ...x, usp: e.target.value } : x))}
                  placeholder={`USP ${i + 1} (한 줄)`} />
                {usps.length > 1 && (
                  <button type="button" onClick={() => setUsps(usps.filter((_, idx) => idx !== i))} style={{ padding: '4px 10px', fontSize: 11, border: '1px solid var(--error)', borderRadius: 4, background: 'transparent', color: 'var(--error)', cursor: 'pointer' }}>USP 삭제</button>
                )}
              </div>
              <textarea style={{ ...textareaSt, marginBottom: 8, minHeight: 60, fontSize: 12 }}
                value={u.description || ''}
                onChange={e => setUsps(usps.map((x, idx) => idx === i ? { ...x, description: e.target.value } : x))}
                placeholder="기능 설명 + 어디서 좋은지 (선택, 앱·서비스 추천) — 예: '사용자가 설정한 가격대로 떨어지면 푸시로 즉시 알려줘서, 평소 가격 모니터링 안 해도 자동 절약 가능'" />
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
                <button type="button" onClick={() => setUsps(usps.map((x, idx) => idx === i ? { ...x, reviews: [...x.reviews, ''] } : x))}
                  style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, border: '1px solid var(--accent)', borderRadius: 4, background: 'var(--accent-light)', color: 'var(--accent)', cursor: 'pointer' }}>+ 리뷰 추가</button>
              </div>
            </div>
          ))}
          <button type="button" onClick={() => setUsps([...usps, { usp: '', description: '', reviews: [''] }])}
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
