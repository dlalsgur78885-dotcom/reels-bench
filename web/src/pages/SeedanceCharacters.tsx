import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authedFetch } from '../api'

type Character = {
  id: string
  name: string | null
  description: string | null
  image_url: string
  use_count: number
  created_at: string
  meta: any
}

export default function SeedanceCharacters() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Character | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [descDraft, setDescDraft] = useState('')

  // 업로드 폼
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadPreview, setUploadPreview] = useState('')
  const [uploadName, setUploadName] = useState('')
  const [uploadDesc, setUploadDesc] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { load() }, [])
  useEffect(() => () => { if (uploadPreview) URL.revokeObjectURL(uploadPreview) }, [])

  const load = async () => {
    setLoading(true); setError('')
    try {
      const r = await authedFetch('/api/seedance/characters')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setItems(await r.json())
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally { setLoading(false) }
  }

  const pickFile = (f: File | null) => {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview)
    setUploadFile(f)
    setUploadPreview(f ? URL.createObjectURL(f) : '')
  }

  const upload = async () => {
    if (!uploadFile || uploading) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      if (uploadName.trim()) fd.append('name', uploadName.trim())
      if (uploadDesc.trim()) fd.append('description', uploadDesc.trim())
      const r = await authedFetch('/api/seedance/characters', { method: 'POST', body: fd })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const row: Character = await r.json()
      setItems(prev => [row, ...prev])
      // reset form
      if (uploadPreview) URL.revokeObjectURL(uploadPreview)
      setUploadFile(null); setUploadPreview(''); setUploadName(''); setUploadDesc('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (e: any) {
      alert('등록 실패: ' + (e?.message || e))
    } finally { setUploading(false) }
  }

  const saveMeta = async (c: Character) => {
    try {
      const r = await authedFetch(`/api/seedance/characters/${c.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameDraft, description: descDraft }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const updated = { ...c, name: nameDraft.trim() || null, description: descDraft.trim() || null }
      setItems(prev => prev.map(x => x.id === c.id ? updated : x))
      setSelected(updated)
      setEditingName(false)
    } catch (e: any) {
      alert('수정 실패: ' + (e?.message || e))
    }
  }

  const remove = async (c: Character) => {
    if (!confirm(`"${c.name || '이 인물'}" 삭제할까요?`)) return
    try {
      const r = await authedFetch(`/api/seedance/characters/${c.id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setItems(prev => prev.filter(x => x.id !== c.id))
      if (selected?.id === c.id) setSelected(null)
    } catch (e: any) {
      alert('삭제 실패: ' + (e?.message || e))
    }
  }

  const useInGen = (c: Character) => {
    sessionStorage.setItem('seedance_pending_character', JSON.stringify({
      id: c.id, image_url: c.image_url, name: c.name,
    }))
    sessionStorage.setItem('seedance_pending_mode', 'reference')
    navigate('/seedance')
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>인물 라이브러리</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            합성 모드에서 재사용할 인물 사진 보관. {items.length}명 보유.
          </p>
        </div>
        <button onClick={() => navigate('/seedance')}
          style={{ padding: '8px 14px', fontSize: 12, fontWeight: 600,
            background: 'transparent', color: 'var(--text-secondary)',
            border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}>
          영상 생성으로
        </button>
      </div>

      {/* 업로드 폼 */}
      <div style={{ ...cardSt, marginBottom: 16, padding: 14 }}>
        <Label>새 인물 등록</Label>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12, marginTop: 6 }}>
          <div>
            {uploadPreview ? (
              <div style={{ position: 'relative' }}>
                <img src={uploadPreview} alt="preview"
                  style={{ width: '100%', aspectRatio: '1', objectFit: 'cover',
                    borderRadius: 6, border: '1px solid var(--border)', background: '#000' }} />
                <button onClick={() => pickFile(null)} disabled={uploading}
                  style={{ position: 'absolute', top: 4, right: 4, padding: '3px 8px',
                    fontSize: 10, fontWeight: 600, border: 'none', borderRadius: 4,
                    background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer' }}>교체</button>
              </div>
            ) : (
              <label htmlFor="char-file"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                  aspectRatio: '1', cursor: 'pointer',
                  border: '1.5px dashed var(--border)', borderRadius: 6,
                  background: 'var(--bg-base)', color: 'var(--text-muted)', fontSize: 12 }}>
                + 사진 선택
              </label>
            )}
            <input id="char-file" ref={fileInputRef} type="file" accept="image/*"
              onChange={e => pickFile(e.target.files?.[0] || null)} disabled={uploading}
              style={{ display: 'none' }} />
          </div>
          <div>
            <input value={uploadName} onChange={e => setUploadName(e.target.value)}
              placeholder="이름 (예: 20대 여성 모델 A) — 선택"
              disabled={uploading} style={inputSt} />
            <div style={{ height: 8 }} />
            <textarea value={uploadDesc} onChange={e => setUploadDesc(e.target.value)}
              placeholder="메모 (인물 특성, 사용 톤 등) — 선택"
              rows={3}
              disabled={uploading}
              style={{ ...inputSt, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
            <div style={{ height: 8 }} />
            <button onClick={upload} disabled={!uploadFile || uploading}
              style={{ padding: '8px 16px', fontSize: 12, fontWeight: 700,
                background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4,
                cursor: uploading ? 'wait' : 'pointer',
                opacity: (!uploadFile || uploading) ? 0.5 : 1 }}>
              {uploading ? '등록 중…' : '+ 등록'}
            </button>
          </div>
        </div>
      </div>

      {loading && <div style={{ color: 'var(--text-muted)' }}>불러오는 중…</div>}
      {error && <div style={{ color: 'var(--error)' }}>{error}</div>}
      {!loading && items.length === 0 && !error && (
        <div style={{ padding: 40, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)',
          background: 'var(--bg-surface)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          등록된 인물이 없습니다. 위에서 사진을 추가하세요.
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: selected ? '1fr 1.4fr' : '1fr', gap: 16,
      }}>
        {items.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: selected ? 'repeat(auto-fill, minmax(140px, 1fr))' : 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 10,
          }}>
            {items.map(c => (
              <div key={c.id}
                style={{
                  background: 'var(--bg-surface)',
                  border: `1.5px solid ${selected?.id === c.id ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 8, overflow: 'hidden', cursor: 'pointer',
                }}
                onClick={() => {
                  setSelected(c)
                  setNameDraft(c.name || '')
                  setDescDraft(c.description || '')
                  setEditingName(false)
                }}>
                <img src={c.image_url} alt={c.name || ''}
                  style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', background: '#000', display: 'block' }} />
                <div style={{ padding: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.3,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.name || <span style={{ color: 'var(--text-muted)' }}>(이름 없음)</span>}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    사용 {c.use_count}회
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {selected && (
          <div style={{ ...cardSt, padding: 14, alignSelf: 'start', position: 'sticky', top: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              {editingName ? (
                <div style={{ flex: 1, marginRight: 8 }}>
                  <input value={nameDraft} onChange={e => setNameDraft(e.target.value)} autoFocus
                    style={{ ...inputSt, fontSize: 14, fontWeight: 700 }} />
                </div>
              ) : (
                <strong style={{ fontSize: 14, flex: 1 }}>
                  {selected.name || <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(이름 없음)</span>}
                  <button onClick={() => setEditingName(true)}
                    style={{ marginLeft: 8, fontSize: 10, color: 'var(--accent)', background: 'none',
                      border: 'none', cursor: 'pointer' }}>✎</button>
                </strong>
              )}
              <button onClick={() => setSelected(null)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--text-muted)', fontSize: 18 }}>×</button>
            </div>

            <img src={selected.image_url} alt={selected.name || ''}
              style={{ width: '100%', borderRadius: 8, background: '#000', marginBottom: 10 }} />

            <Label>메모</Label>
            {editingName ? (
              <textarea value={descDraft} onChange={e => setDescDraft(e.target.value)}
                rows={3} style={{ ...inputSt, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
            ) : (
              <div style={{ ...inputSt, minHeight: 38, whiteSpace: 'pre-wrap', color: selected.description ? 'var(--text-body)' : 'var(--text-muted)' }}>
                {selected.description || '(없음)'}
              </div>
            )}

            <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {editingName ? (
                <>
                  <button onClick={() => saveMeta(selected)} style={smBtn}>저장</button>
                  <button onClick={() => { setEditingName(false); setNameDraft(selected.name || ''); setDescDraft(selected.description || '') }}
                    style={smBtnGhost}>취소</button>
                </>
              ) : (
                <>
                  <button onClick={() => useInGen(selected)} style={smBtn}>🧑 인물로 사용 →</button>
                  <button onClick={() => { navigator.clipboard.writeText(selected.image_url); alert('URL 복사됨') }}
                    style={smBtnGhost}>URL 복사</button>
                  <button onClick={() => remove(selected)}
                    style={{ ...smBtnGhost, color: 'var(--error)', borderColor: 'var(--error)' }}>삭제</button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const cardSt: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 8, padding: 12,
}
const smBtn: React.CSSProperties = {
  padding: '6px 14px', fontSize: 11, fontWeight: 700,
  background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4,
  cursor: 'pointer',
}
const smBtnGhost: React.CSSProperties = {
  padding: '6px 14px', fontSize: 11, fontWeight: 600,
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
