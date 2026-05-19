import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authedFetch } from '../api'

type Prompt = {
  id: string
  name: string | null
  content: string
  mode: string | null
  use_count: number
  created_at: string
  updated_at: string
}

const MODES = [
  { v: null, label: '전체' },
  { v: 'transition', label: '전환' },
  { v: 'reference', label: '합성' },
] as const

export default function SeedancePrompts() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Prompt[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterMode, setFilterMode] = useState<string | null>(null)
  const [editing, setEditing] = useState<Prompt | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [draftMode, setDraftMode] = useState<'transition' | 'reference' | ''>('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true); setError('')
    try {
      const r = await authedFetch('/api/seedance/prompts')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setItems(await r.json())
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally { setLoading(false) }
  }

  const openNew = () => {
    setEditing({ id: '', name: '', content: '', mode: null, use_count: 0, created_at: '', updated_at: '' })
    setDraftName(''); setDraftContent(''); setDraftMode('')
  }
  const openEdit = (p: Prompt) => {
    setEditing(p)
    setDraftName(p.name || '')
    setDraftContent(p.content)
    setDraftMode((p.mode as any) || '')
  }
  const close = () => setEditing(null)

  const save = async () => {
    if (!editing || saving) return
    if (!draftContent.trim()) { alert('프롬프트 내용을 입력하세요'); return }
    setSaving(true)
    try {
      const body = {
        name: draftName.trim() || null,
        content: draftContent.trim(),
        mode: draftMode || null,
      }
      const isNew = !editing.id
      const r = await authedFetch(isNew ? '/api/seedance/prompts' : `/api/seedance/prompts/${editing.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const result = await r.json()
      const row: Prompt = isNew ? result : (result.row || { ...editing, ...body })
      setItems(prev => isNew ? [row, ...prev] : prev.map(p => p.id === row.id ? row : p))
      setEditing(null)
    } catch (e: any) {
      alert('저장 실패: ' + (e?.message || e))
    } finally { setSaving(false) }
  }

  const remove = async (p: Prompt) => {
    if (!confirm(`"${p.name || p.content.slice(0, 30)}" 삭제할까요?`)) return
    try {
      const r = await authedFetch(`/api/seedance/prompts/${p.id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setItems(prev => prev.filter(x => x.id !== p.id))
    } catch (e: any) {
      alert('삭제 실패: ' + (e?.message || e))
    }
  }

  const useInGen = (p: Prompt) => {
    // 사용 카운트 +1 + /seedance 로 prompt 들고 이동
    authedFetch(`/api/seedance/prompts/${p.id}/used`, { method: 'POST' }).catch(() => {})
    sessionStorage.setItem('seedance_pending_prompt', p.content)
    if (p.mode) sessionStorage.setItem('seedance_pending_mode', p.mode)
    navigate('/seedance')
  }

  const filtered = filterMode === null ? items : items.filter(p => p.mode === filterMode)

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>프롬프트 라이브러리</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            자주 쓰는 영상 생성 프롬프트 저장 · 재사용. {items.length}개 보유.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={openNew}
            style={{ padding: '8px 14px', fontSize: 12, fontWeight: 700,
              background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6,
              cursor: 'pointer' }}>+ 새 프롬프트</button>
          <button onClick={() => navigate('/seedance')}
            style={{ padding: '8px 14px', fontSize: 12, fontWeight: 600,
              background: 'transparent', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}>
            영상 생성으로
          </button>
        </div>
      </div>

      {/* 필터 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', alignSelf: 'center', marginRight: 4 }}>모드:</span>
        {MODES.map(m => (
          <button key={m.label} type="button" onClick={() => setFilterMode(m.v as any)}
            style={{
              padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              borderRadius: 6, border: '1px solid var(--border)',
              background: filterMode === m.v ? 'var(--accent)' : 'var(--bg-surface)',
              color: filterMode === m.v ? '#fff' : 'var(--text-body)',
            }}>{m.label}</button>
        ))}
      </div>

      {loading && <div style={{ color: 'var(--text-muted)' }}>불러오는 중…</div>}
      {error && <div style={{ color: 'var(--error)' }}>{error}</div>}
      {!loading && filtered.length === 0 && !error && (
        <div style={{ padding: 40, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)',
          background: 'var(--bg-surface)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          저장된 프롬프트가 없습니다. + 새 프롬프트 로 추가.
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {filtered.map(p => (
          <div key={p.id} style={cardSt}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {p.name || <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(이름 없음)</span>}
                  {p.mode && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                      background: p.mode === 'reference' ? 'rgba(99,102,241,0.15)' : 'rgba(34,197,94,0.15)',
                      color: p.mode === 'reference' ? 'var(--accent)' : 'var(--success, #10b981)' }}>
                      {p.mode === 'reference' ? '합성' : '전환'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  사용 {p.use_count}회 · {new Date(p.updated_at || p.created_at).toLocaleString('ko-KR')}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => useInGen(p)} style={smBtn}>사용 →</button>
                <button onClick={() => openEdit(p)} style={smBtnGhost}>수정</button>
                <button onClick={() => navigator.clipboard.writeText(p.content)} style={smBtnGhost}>복사</button>
                <button onClick={() => remove(p)}
                  style={{ ...smBtnGhost, color: 'var(--error)', borderColor: 'var(--error)' }}>삭제</button>
              </div>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-body)',
              padding: '8px 10px', background: 'var(--bg-base)', borderRadius: 4,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {p.content}
            </div>
          </div>
        ))}
      </div>

      {/* 편집 모달 */}
      {editing && (
        <div onClick={close}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 8, padding: 18, width: '100%', maxWidth: 600 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>
              {editing.id ? '프롬프트 수정' : '새 프롬프트'}
            </h3>
            <Label>이름 (선택)</Label>
            <input value={draftName} onChange={e => setDraftName(e.target.value)}
              placeholder="예: 카페 분위기 컷"
              style={inputSt} />

            <div style={{ height: 10 }} />
            <Label>모드 (선택)</Label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {[
                { v: '', label: '범용' },
                { v: 'transition', label: '전환' },
                { v: 'reference', label: '합성' },
              ].map(m => (
                <button key={m.label} type="button" onClick={() => setDraftMode(m.v as any)}
                  style={{
                    padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                    borderRadius: 6, border: '1px solid var(--border)',
                    background: draftMode === m.v ? 'var(--accent)' : 'var(--bg-base)',
                    color: draftMode === m.v ? '#fff' : 'var(--text-body)',
                  }}>{m.label}</button>
              ))}
            </div>

            <Label>내용 *</Label>
            <textarea value={draftContent} onChange={e => setDraftContent(e.target.value)}
              rows={8} placeholder="@Image1 인물이 @Image2 배경 안에서 ..."
              style={{ ...inputSt, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />

            <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={close} disabled={saving} style={smBtnGhost}>취소</button>
              <button onClick={save} disabled={saving}
                style={{ ...smBtn, padding: '8px 18px',
                  cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1 }}>
                {saving ? '저장 중…' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const cardSt: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 8, padding: 12,
}
const smBtn: React.CSSProperties = {
  padding: '5px 12px', fontSize: 11, fontWeight: 700,
  background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4,
  cursor: 'pointer',
}
const smBtnGhost: React.CSSProperties = {
  padding: '5px 12px', fontSize: 11, fontWeight: 600,
  background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
}
const inputSt: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: 12,
  border: '1px solid var(--border)', borderRadius: 4,
  background: 'var(--bg-base)', color: 'var(--text-body)',
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)',
      marginBottom: 4, letterSpacing: '0.02em' }}>{children}</div>
  )
}
