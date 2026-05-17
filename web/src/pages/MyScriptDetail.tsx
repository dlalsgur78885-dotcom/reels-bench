import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useMe } from '../auth'
import { buildTtsText } from '../ttsCopy'

const sourceLabel: Record<string, string> = {
  insta: 'Instagram', youtube: 'YouTube', fb_ads: 'FB Ads',
}

export default function MyScriptDetail() {
  const { pid: pidParam, sid } = useParams<{ pid: string; sid: string }>()
  const pid = Number(pidParam)
  const navigate = useNavigate()
  const me = useMe()

  const [data, setData] = useState<any | null>(null)
  const [productName, setProductName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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

  const [refSents, setRefSents] = useState<Array<{ start: number; end: number; text: string; section: string }>>([])
  const [showRef, setShowRef] = useState(true)
  type StageKey = 'base' | 'alt_a' | 'alt_b'
  const stageLabel = (k: StageKey) => k === 'base' ? '기본' : k === 'alt_a' ? 'A원고' : 'B원고'
  const [stageView, setStageView] = useState<StageKey | null>(null)
  const [deletingStage, setDeletingStage] = useState(false)

  const isMine = !!(data && me && data.created_by === me.id)

  useEffect(() => {
    if (!pid || !sid) return
    setLoading(true); setError('')
    api.getGenScript(pid, sid)
      .then(r => {
        setData(r)
        setCaption((r as any).meta?.caption || '')
        setPinned((r as any).meta?.pinned_comment || '')
        setPlanUrl((r as any).meta?.shooting_plan_url || '')
        setCaptionExpanded(false)
      })
      .catch(e => setError(e.message || '불러오기 실패'))
      .finally(() => setLoading(false))
    api.listColleagues().then(setColleagues).catch(() => {})
    api.listMyProducts().then(list => {
      const p = list.find(x => x.id === pid)
      if (p) setProductName(p.name)
    }).catch(() => {})
  }, [pid, sid])

  useEffect(() => {
    if (!data?.ref_shortcode) { setRefSents([]); return }
    const src: 'reels' | 'youtube' = data.source_type === 'youtube' ? 'youtube' : 'reels'
    api.getRefSentences(data.ref_shortcode, src)
      .then(r => setRefSents(r.sentences || []))
      .catch(() => setRefSents([]))
  }, [data?.ref_shortcode, data?.source_type])

  // stages 정규화 — key 기반 ({base, alt_a, alt_b}). 옛 데이터(stage 1/2/3)도 변환.
  const stages: Array<{ key: StageKey; sentences: any[] }> = useMemo(() => {
    const raw: any[] = data?.meta?.stages || []
    const map = new Map<StageKey, { key: StageKey; sentences: any[] }>()
    for (const s of raw) {
      let k: StageKey | null = null
      if (s.key === 'base' || s.key === 'alt_a' || s.key === 'alt_b') k = s.key
      else if (s.variant === 'original') k = 'base'
      else if (s.variant === 'default') k = 'alt_a'
      else if (s.variant === 'strong') k = 'alt_b'
      if (k && !map.has(k)) map.set(k, { key: k, sentences: s.sentences || [] })
    }
    // base가 없으면 row.sentences를 base로 가정
    if (!map.has('base') && data?.sentences) {
      map.set('base', { key: 'base', sentences: data.sentences })
    }
    const order: StageKey[] = ['base', 'alt_a', 'alt_b']
    return order.filter(k => map.has(k)).map(k => map.get(k)!)
  }, [data?.meta?.stages, data?.sentences])

  const hasKey = (k: StageKey) => stages.some(s => s.key === k)

  const displayedSents: any[] = useMemo(() => {
    if (editing) return draftSents
    const view = stageView || stages[0]?.key || 'base'
    const pick = stages.find(s => s.key === view)
    return pick?.sentences || data?.sentences || []
  }, [editing, draftSents, data?.sentences, stageView, stages])

  const deleteCurrentStage = async () => {
    if (!pid || !sid || deletingStage) return
    const view: StageKey = stageView || (stages[0]?.key || 'base')
    if (stages.length <= 1) {
      alert('마지막 단계는 삭제할 수 없습니다. 대본 전체를 삭제하려면 목록에서 삭제하세요.')
      return
    }
    if (!confirm(`${stageLabel(view)} 단계를 삭제할까요? (다른 단계는 유지)`)) return
    setDeletingStage(true)
    try {
      const newStages = stages.filter(s => s.key !== view)
      // sentences 컬럼은 새 base로 교체
      const baseSents = newStages.find(s => s.key === 'base')?.sentences
        || newStages[0]?.sentences
        || []
      // base가 삭제됐다면 첫 남은 stage를 base로 승격
      const finalStages = newStages.some(s => s.key === 'base')
        ? newStages
        : newStages.map((s, i) => i === 0 ? { ...s, key: 'base' as StageKey } : s)
      const resp = await api.updateGenScript(pid, sid, {
        sentences: baseSents,
        stages: finalStages,
      })
      const fresh = resp.row || {
        ...data,
        sentences: baseSents,
        meta: { ...(data.meta || {}), stages: finalStages },
      }
      setData(fresh)
      setStageView(finalStages[0]?.key || 'base')
    } catch (e: any) {
      alert('단계 삭제 실패: ' + (e.message || e))
    } finally {
      setDeletingStage(false)
    }
  }

  // gen sentence ↔ ref sentence 1:1 매칭 (start time 근접 우선 + index fallback)
  const pairs = useMemo(() => {
    const gens = displayedSents
    const refs = refSents
    const used = new Set<number>()
    return gens.map((g, gi) => {
      let bestI = -1
      let bestDiff = Infinity
      const gStart = Number(g.start ?? gi)
      refs.forEach((r, ri) => {
        if (used.has(ri)) return
        const d = Math.abs(Number(r.start ?? ri) - gStart)
        if (d < bestDiff) { bestDiff = d; bestI = ri }
      })
      // 차이가 너무 크면 index fallback
      if (bestI < 0 || bestDiff > 5) {
        bestI = refs[gi] && !used.has(gi) ? gi : bestI
      }
      if (bestI >= 0) used.add(bestI)
      return { gen: g, ref: bestI >= 0 ? refs[bestI] : null, gi }
    })
  }, [displayedSents, refSents])

  useEffect(() => {
    if (!data || !pid || !sid) return
    if (me && data.created_by === me.id) {
      api.listScriptShares(pid, sid).then(setShares).catch(() => setShares([]))
    } else {
      setShares([])
    }
  }, [data, me, pid, sid])

  const startEdit = () => {
    if (!data) return
    setDraftTitle(data.title || '')
    setDraftSents((data.sentences || []).map((s: any) => ({ ...s })))
    setEditing(true)
  }
  const cancelEdit = () => { setEditing(false); setDraftSents([]) }
  const saveEdit = async () => {
    if (!data || !pid || !sid) return
    setSavingEdit(true)
    try {
      const view: StageKey = stageView || (stages[0]?.key || 'base')
      // 현재 보는 stage 덮어쓰기 + 다른 stage 보존
      const newStages = stages.length > 0
        ? stages.map(s => s.key === view ? { ...s, sentences: draftSents } : s)
        : [{ key: 'base' as StageKey, sentences: draftSents }]
      // sentences 컬럼은 base만 반영 (A/B는 stages에만)
      const baseSents = newStages.find(s => s.key === 'base')?.sentences || draftSents
      const resp = await api.updateGenScript(pid, sid, {
        title: draftTitle,
        sentences: baseSents,
        stages: newStages,
      })
      const fresh = resp.row || {
        ...data, title: draftTitle, sentences: baseSents,
        meta: { ...(data.meta || {}), stages: newStages },
      }
      setData({ ...data, ...fresh })
      setEditing(false)
    } catch (e: any) {
      alert('저장 실패: ' + (e.message || e))
    } finally {
      setSavingEdit(false)
    }
  }

  const saveCaptionPinned = async () => {
    if (!data || !pid || !sid) return
    setSavingMeta(true)
    try {
      await api.updateGenScript(pid, sid, { caption, pinned_comment: pinned, shooting_plan_url: planUrl })
      setData({ ...data, meta: { ...(data.meta || {}), caption, pinned_comment: pinned, shooting_plan_url: planUrl } })
    } catch (e: any) {
      alert('저장 실패: ' + (e.message || e))
    } finally {
      setSavingMeta(false)
    }
  }

  const addShare = async () => {
    if (!pid || !sid || !shareTarget) return
    setShareBusy(true)
    try {
      await api.addScriptShare(pid, sid, { shared_with_id: shareTarget, permission: sharePerm })
      setShareTarget('')
      const list = await api.listScriptShares(pid, sid)
      setShares(list)
    } catch (e: any) {
      alert('공유 추가 실패: ' + (e.message || e))
    } finally {
      setShareBusy(false)
    }
  }
  const removeShare = async (share_id: string) => {
    if (!pid || !sid) return
    if (!confirm('이 공유를 제거할까요?')) return
    try {
      await api.deleteScriptShare(pid, sid, share_id)
      setShares(prev => prev.filter(s => s.id !== share_id))
    } catch (e: any) {
      alert('공유 제거 실패: ' + (e.message || e))
    }
  }

  const deleteScript = async () => {
    if (!pid || !sid) return
    if (!confirm('이 대본을 삭제하시겠습니까?')) return
    try {
      await api.deleteGenScript(pid, sid)
      navigate('/my-scripts')
    } catch (e: any) {
      alert('삭제 실패: ' + (e.message || e))
    }
  }

  const meta = useMemo(() => data?.meta || {}, [data])

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>불러오는 중…</div>
  if (error || !data) return (
    <div style={{ padding: 24 }}>
      <button onClick={() => navigate('/my-scripts')}
        style={{ marginBottom: 14, padding: '6px 12px', fontSize: 12,
          border: '1px solid var(--border)', borderRadius: 6, background: 'transparent',
          color: 'var(--text-body)', cursor: 'pointer' }}>← 대본 목록</button>
      <div style={{ color: 'var(--error)' }}>{error || '대본 없음'}</div>
    </div>
  )

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: 20 }}>
      <button onClick={() => navigate('/my-scripts')}
        style={{ marginBottom: 14, padding: '6px 12px', fontSize: 12,
          border: '1px solid var(--border)', borderRadius: 6, background: 'transparent',
          color: 'var(--text-body)', cursor: 'pointer' }}>← 대본 목록</button>

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: 16 }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          {editing ? (
            <input value={draftTitle} onChange={e => setDraftTitle(e.target.value)}
              style={{ flex: 1, padding: '6px 10px', fontSize: 16, fontWeight: 700,
                border: '1px solid var(--accent)', borderRadius: 4,
                background: 'var(--bg-base)', color: 'var(--text-primary)' }} />
          ) : (
            <h2 style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>{data.title}</h2>
          )}
          {editing ? (
            <>
              <button onClick={saveEdit} disabled={savingEdit}
                style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600,
                  background: 'var(--accent)', color: '#fff', border: 'none',
                  borderRadius: 4, cursor: savingEdit ? 'wait' : 'pointer' }}>
                {savingEdit ? '저장 중…' : '저장'}
              </button>
              <button onClick={cancelEdit}
                style={{ padding: '6px 12px', fontSize: 12, background: 'transparent',
                  color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>취소</button>
            </>
          ) : (
            <>
              <button onClick={startEdit}
                style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600,
                  background: 'transparent', color: 'var(--accent)',
                  border: '1px solid var(--accent)', borderRadius: 4, cursor: 'pointer' }}>수정</button>
              <button
                onClick={async () => {
                  const text = buildTtsText(displayedSents)
                  if (!text) return
                  await navigator.clipboard.writeText(text)
                }}
                style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600,
                  background: 'transparent', color: 'var(--text-body)',
                  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>TTS 복사</button>
              <button
                onClick={() => navigate('/tts', { state: {
                  sentences: displayedSents,
                  title: data?.title || '',
                  voice: data?.meta?.target_persona?.voice,
                  personaGender: data?.meta?.target_persona?.gender,
                  persona: data?.meta?.target_persona,  // 합성 시 인라인 cue
                  from: { path: `/my-scripts/${pid}/${sid}`, label: '저장된 대본' },
                } })}
                disabled={!displayedSents.length}
                style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600,
                  background: displayedSents.length ? 'var(--accent)' : 'var(--bg-elevated)',
                  color: displayedSents.length ? '#fff' : 'var(--text-muted)',
                  border: '1px solid var(--accent)', borderRadius: 4,
                  cursor: displayedSents.length ? 'pointer' : 'not-allowed' }}>TTS 생성</button>
              {isMine && (
                <button onClick={deleteScript}
                  style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600,
                    background: 'transparent', color: 'var(--error)',
                    border: '1px solid var(--error)', borderRadius: 4, cursor: 'pointer' }}>삭제</button>
              )}
            </>
          )}
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px',
            background: 'var(--bg-elevated)', borderRadius: 4, color: 'var(--text-secondary)', marginRight: 6 }}>
            {sourceLabel[data.source_type] || data.source_type}
          </span>
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{productName || `상품 #${pid}`}</span>
          {' · '}
          {(data._creator_name || data._creator_email) && (
            <span style={{ color: 'var(--accent)' }}>✍ 기획: {data._creator_name || data._creator_email} · </span>
          )}
          {data.persona_name && <span>{data.persona_name} · </span>}
          {data.ref_shortcode && <span>ref: {data.ref_shortcode} · </span>}
          {meta?.duration_target_sec && <span>{meta.duration_target_sec}초 · </span>}
          <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
            📺 ref {refSents.length}문장 / ✍ 우리 {displayedSents.length}문장
          </span>
          {' · '}
          {new Date(data.created_at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}
        </div>

        {!editing && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            {stages.length > 1 && (
              <>
                <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>단계:</label>
                <select value={stageView || stages[0]?.key || 'base'}
                  onChange={e => setStageView(e.target.value as StageKey)}
                  style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4,
                    border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-body)' }}>
                  {stages.map(s => (
                    <option key={s.key} value={s.key}>{stageLabel(s.key)}</option>
                  ))}
                </select>
              </>
            )}
            {isMine && stages.length > 1 && (
              <button onClick={deleteCurrentStage}
                disabled={deletingStage}
                title={`${stageLabel(stageView || stages[0]?.key || 'base')} 단계만 삭제`}
                style={{ padding: '5px 11px', fontSize: 11, fontWeight: 600,
                  background: 'transparent', color: 'var(--error)',
                  border: '1px solid var(--error)', borderRadius: 4,
                  cursor: deletingStage ? 'wait' : 'pointer',
                  opacity: deletingStage ? 0.6 : 1 }}>
                {deletingStage ? '삭제 중…' : `${stageLabel(stageView || stages[0]?.key || 'base')} 삭제`}
              </button>
            )}
          </div>
        )}

        {refSents.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={showRef} onChange={e => setShowRef(e.target.checked)} />
              ref 대본과 1:1 비교
            </label>
            {showRef && data.ref_shortcode && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                · ref: {data.ref_shortcode}
              </span>
            )}
          </div>
        )}

        {showRef && refSents.length > 0 ? (
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10,
              fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
              color: 'var(--text-muted)', marginBottom: 6, padding: '0 12px' }}>
              <div>📺 REF 원본</div>
              <div>✍ 우리 대본 (생성)</div>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {pairs.map(({ gen, ref, gi }) => (
                <div key={gi} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'stretch' }}>
                  <div style={{ fontSize: 12, lineHeight: 1.55, padding: '8px 12px',
                    background: 'var(--bg-elevated)', borderRadius: 4, color: 'var(--text-secondary)' }}>
                    {ref ? (
                      <>
                        {ref.section && (
                          <span style={{ fontSize: 9, fontWeight: 700, marginRight: 6, color: 'var(--accent)' }}>
                            [{ref.section}]
                          </span>
                        )}
                        {ref.text}
                      </>
                    ) : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>—</span>}
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.55, padding: '8px 12px',
                    background: 'var(--bg-base)', borderRadius: 4,
                    display: editing ? 'flex' : 'block', alignItems: 'flex-start', gap: 6 }}>
                    <div style={{ flex: 1 }}>
                      {gen.direction && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', marginRight: 6 }}>
                          ({gen.direction})
                        </span>
                      )}
                      {editing ? (
                        <textarea value={gen.text || ''}
                          onChange={e => setDraftSents(prev => prev.map((x, j) => j === gi ? { ...x, text: e.target.value } : x))}
                          rows={Math.max(1, Math.ceil((gen.text || '').length / 38))}
                          style={{ width: '100%', padding: '4px 8px', fontSize: 13, lineHeight: 1.5,
                            border: '1px solid var(--border)', borderRadius: 4,
                            background: 'transparent', color: 'var(--text-body)',
                            resize: 'vertical', fontFamily: 'inherit', marginTop: 4 }} />
                      ) : gen.text}
                    </div>
                    {editing && (
                      <button onClick={() => setDraftSents(prev => prev.filter((_, j) => j !== gi))}
                        title="이 문장 삭제"
                        style={{ flexShrink: 0, padding: '2px 8px', fontSize: 11, fontWeight: 600,
                          background: 'transparent', color: 'var(--error)',
                          border: '1px solid var(--error)', borderRadius: 4, cursor: 'pointer' }}>✕</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 6, marginBottom: 18 }}>
            {displayedSents.map((s: any, i: number) => (
              <div key={i} style={{ fontSize: 13, lineHeight: 1.6,
                padding: '8px 12px', background: 'var(--bg-base)', borderRadius: 4,
                display: editing ? 'flex' : 'block', alignItems: 'flex-start', gap: 6 }}>
                <div style={{ flex: 1 }}>
                  {s.direction && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', marginRight: 6 }}>
                      ({s.direction})
                    </span>
                  )}
                  {editing ? (
                    <textarea value={s.text || ''}
                      onChange={e => setDraftSents(prev => prev.map((x, j) => j === i ? { ...x, text: e.target.value } : x))}
                      rows={Math.max(1, Math.ceil((s.text || '').length / 38))}
                      style={{ width: '100%', padding: '4px 8px', fontSize: 13, lineHeight: 1.5,
                        border: '1px solid var(--border)', borderRadius: 4,
                        background: 'transparent', color: 'var(--text-body)',
                        resize: 'vertical', fontFamily: 'inherit', marginTop: 4 }} />
                  ) : s.text}
                </div>
                {editing && (
                  <button onClick={() => setDraftSents(prev => prev.filter((_, j) => j !== i))}
                    title="이 문장 삭제"
                    style={{ flexShrink: 0, padding: '2px 8px', fontSize: 11, fontWeight: 600,
                      background: 'transparent', color: 'var(--error)',
                      border: '1px solid var(--error)', borderRadius: 4, cursor: 'pointer' }}>✕</button>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>📝 캡션</label>
          <textarea value={caption} onChange={e => setCaption(e.target.value)}
            placeholder="영상 업로드 시 본문에 들어갈 캡션 (해시태그 포함)"
            rows={captionExpanded ? 20 : 4}
            style={{ width: '100%', padding: '8px 10px', fontSize: 12, lineHeight: 1.5,
              border: '1px solid var(--border)', borderRadius: 6,
              background: 'var(--bg-base)', color: 'var(--text-body)',
              resize: 'vertical', fontFamily: 'inherit', marginBottom: 4 }} />
          {caption.length > 180 && (
            <button onClick={() => setCaptionExpanded(v => !v)}
              style={{ display: 'block', marginLeft: 'auto', marginBottom: 10,
                padding: '2px 10px', fontSize: 11, fontWeight: 600,
                background: 'transparent', color: 'var(--accent)',
                border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>
              {captionExpanded ? '▲ 접기' : '▼ 더보기'}
            </button>
          )}
          {caption.length <= 180 && <div style={{ marginBottom: 8 }} />}

          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>📌 고정댓글</label>
          <textarea value={pinned} onChange={e => setPinned(e.target.value)}
            placeholder="댓글창 상단에 고정될 댓글 (CTA, 링크 등)"
            rows={3}
            style={{ width: '100%', padding: '8px 10px', fontSize: 12, lineHeight: 1.5,
              border: '1px solid var(--border)', borderRadius: 6,
              background: 'var(--bg-base)', color: 'var(--text-body)',
              resize: 'vertical', fontFamily: 'inherit', marginBottom: 12 }} />

          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>🎬 촬영기획안 링크</label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <input type="url" value={planUrl} onChange={e => setPlanUrl(e.target.value)}
              placeholder="https://… (Notion/Drive/문서 링크)"
              style={{ flex: 1, padding: '8px 10px', fontSize: 12,
                border: '1px solid var(--border)', borderRadius: 6,
                background: 'var(--bg-base)', color: 'var(--text-body)' }} />
            {planUrl && (
              <a href={planUrl} target="_blank" rel="noopener noreferrer"
                style={{ padding: '8px 12px', fontSize: 12, fontWeight: 600,
                  background: 'var(--bg-elevated)', color: 'var(--accent)',
                  border: '1px solid var(--border)', borderRadius: 6,
                  textDecoration: 'none', whiteSpace: 'nowrap' }}>↗ 열기</a>
            )}
          </div>

          <button onClick={saveCaptionPinned} disabled={savingMeta}
            style={{ padding: '8px 16px', fontSize: 12, fontWeight: 600,
              background: 'var(--accent)', color: '#fff', border: 'none',
              borderRadius: 6, cursor: savingMeta ? 'wait' : 'pointer',
              opacity: savingMeta ? 0.7 : 1 }}>
            {savingMeta ? '저장 중…' : '💾 캡션/고정댓글/촬영기획안 저장'}
          </button>
        </div>

        {isMine && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>
              🤝 공유 ({shares.length}명)
            </div>
            {shares.length > 0 && (
              <div style={{ display: 'grid', gap: 4, marginBottom: 10 }}>
                {shares.map(s => (
                  <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '6px 10px', background: 'var(--bg-base)', borderRadius: 4, fontSize: 11 }}>
                    <span style={{ flex: 1 }}>{s.shared_with_name || s.shared_with_email || s.shared_with_id}</span>
                    <span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                      background: s.permission === 'edit' ? 'var(--accent)' : 'var(--bg-elevated)',
                      color: s.permission === 'edit' ? '#fff' : 'var(--text-secondary)' }}>
                      {s.permission === 'edit' ? '편집' : '보기'}
                    </span>
                    <button onClick={() => removeShare(s.id)}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--error)', fontSize: 11 }}>제거</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={shareTarget} onChange={e => setShareTarget(e.target.value)}
                style={{ flex: 1, padding: '6px 10px', fontSize: 11,
                  border: '1px solid var(--border)', borderRadius: 4,
                  background: 'var(--bg-base)', color: 'var(--text-body)' }}>
                <option value="">공유받을 회원 선택</option>
                {colleagues
                  .filter(c => !shares.some(s => s.shared_with_id === c.id))
                  .map(c => <option key={c.id} value={c.id}>{c.display_name || c.email}</option>)}
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
                ➕ 공유
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
