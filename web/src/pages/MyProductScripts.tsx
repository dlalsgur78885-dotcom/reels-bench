import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'

type Script = {
  id: string
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

const sourceLabel: Record<string, string> = {
  insta: 'Instagram',
  youtube: 'YouTube',
  fb_ads: 'FB Ads',
}

export default function MyProductScripts() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const pid = id ? Number(id) : NaN
  const [scripts, setScripts] = useState<Script[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<{ sid: string; data: any } | null>(null)
  const [caption, setCaption] = useState('')
  const [captionExpanded, setCaptionExpanded] = useState(false)
  const [pinned, setPinned] = useState('')
  const [planUrl, setPlanUrl] = useState('')
  const [savingMeta, setSavingMeta] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSents, setDraftSents] = useState<any[]>([])
  const [savingEdit, setSavingEdit] = useState(false)

  useEffect(() => {
    if (!pid) return
    setLoading(true)
    api.listGenScripts(pid)
      .then(setScripts)
      .catch(e => setError(e.message || '불러오기 실패'))
      .finally(() => setLoading(false))
  }, [pid])

  const openScript = async (sid: string) => {
    try {
      const r = await api.getGenScript(pid, sid)
      setSelected({ sid, data: r })
      setCaption((r as any).meta?.caption || '')
      setCaptionExpanded(false)
      setPinned((r as any).meta?.pinned_comment || '')
      setPlanUrl((r as any).meta?.shooting_plan_url || '')
      setEditing(false)
    } catch (e: any) {
      alert('불러오기 실패: ' + (e.message || e))
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
      const resp = await api.updateGenScript(pid, selected.sid, { title: draftTitle, sentences: draftSents })
      const fresh = resp.row || { ...selected.data, title: draftTitle, sentences: draftSents }
      setSelected({ ...selected, data: { ...selected.data, ...fresh } })
      setScripts(prev => prev.map(s => s.id === selected.sid ? { ...s, title: fresh.title || draftTitle } : s))
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
      await api.updateGenScript(pid, selected.sid, {
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

  const deleteScript = async (sid: string) => {
    if (!confirm('이 대본을 삭제하시겠습니까?')) return
    try {
      await api.deleteGenScript(pid, sid)
      setScripts(prev => prev.filter(s => s.id !== sid))
      if (selected?.sid === sid) setSelected(null)
    } catch (e: any) {
      alert('삭제 실패: ' + (e.message || e))
    }
  }

  if (!pid) return <div style={{ padding: 20 }}>잘못된 상품 ID</div>

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 20 }}>
      <button onClick={() => navigate('/my-products')}
        style={{ background: 'transparent', border: '1px solid var(--border)', padding: '6px 14px',
          borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-body)',
          fontSize: 12, marginBottom: 16 }}>
        ← 내 상품
      </button>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>🎬 저장된 대본</h2>

      {loading && <div style={{ color: 'var(--text-muted)' }}>불러오는 중…</div>}
      {error && <div style={{ color: 'var(--error)' }}>{error}</div>}
      {!loading && scripts.length === 0 && (
        <div style={{ color: 'var(--text-muted)', padding: 30, textAlign: 'center',
          background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border)' }}>
          저장된 대본이 없습니다. 대본 생성 후 결과 페이지에서 💾 저장 클릭.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: 16 }}>
        <div style={{ display: 'grid', gap: 8 }}>
          {scripts.map(s => (
            <div key={s.id}
              onClick={() => openScript(s.id)}
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
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{s.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {s.persona_name && <span>{s.persona_name} · </span>}
                  {s.ref_shortcode && <span>ref: {s.ref_shortcode} · </span>}
                  {s._shared && (s._creator_name || s._creator_email) && (
                    <span style={{ color: 'var(--accent)' }}>
                      ✍ {s._creator_name || s._creator_email} ·{' '}
                    </span>
                  )}
                  {new Date(s.created_at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}
                </div>
              </div>
              <button onClick={(e) => { e.stopPropagation(); deleteScript(s.id) }}
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
            borderRadius: 'var(--radius-md)', padding: 14, maxHeight: '70vh', overflowY: 'auto',
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
                    {savingEdit ? '저장 중…' : '✓ 저장'}
                  </button>
                  <button onClick={cancelEdit}
                    style={{ padding: '4px 10px', fontSize: 11,
                      background: 'transparent', color: 'var(--text-muted)',
                      border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>취소</button>
                </>
              ) : (
                <button onClick={startEdit}
                  style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600,
                    background: 'transparent', color: 'var(--accent)',
                    border: '1px solid var(--accent)', borderRadius: 4, cursor: 'pointer' }}>
                  ✏ 수정
                </button>
              )}
              <button onClick={() => setSelected(null)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>✕</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
              {(selected.data._creator_name || selected.data._creator_email) && (
                <span style={{ color: 'var(--accent)' }}>
                  ✍ 기획: {selected.data._creator_name || selected.data._creator_email} ·{' '}
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
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                📝 캡션
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
                📌 고정댓글
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
                🎬 촬영기획안 링크
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
                {savingMeta ? '저장 중…' : '💾 캡션/고정댓글/촬영기획안 저장'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
