import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authedFetch } from '../api'
import { useMe } from '../auth'
import SeedanceShareModal from '../components/SeedanceShareModal'

type Character = {
  id: string
  name: string | null
  description: string | null
  image_url: string             // primary/cover
  image_urls: string[]          // 전체 사진 리스트
  use_count: number
  created_at: string
  created_by?: string
  meta: any
  _shared?: boolean
  _permission?: 'view' | 'edit'
  _creator_name?: string
  _creator_email?: string
}

function imageList(c: Character): string[] {
  const arr = (c.image_urls && c.image_urls.length > 0) ? c.image_urls : [c.image_url]
  return arr.filter(Boolean)
}

// 인물 사진 각도 — 백엔드 _CHAR_ANGLES와 동일 (front/side/three_quarter/back)
type Angle = 'front' | 'side' | 'three_quarter' | 'back'
const ANGLES: { value: Angle; label: string }[] = [
  { value: 'front', label: '정면' },
  { value: 'side', label: '측면' },
  { value: 'three_quarter', label: '반측' },
  { value: 'back', label: '뒷모습' },
]
const ANGLE_LABEL: Record<string, string> = Object.fromEntries(ANGLES.map(a => [a.value, a.label]))

function getAngle(c: Character, url: string): Angle | '' {
  const a = c.meta?.angles?.[url]
  return (a && ANGLE_LABEL[a]) ? (a as Angle) : ''
}

function canEdit(c: Character): boolean {
  return !c._shared || c._permission === 'edit'
}

export default function SeedanceCharacters() {
  const navigate = useNavigate()
  const me = useMe()
  const [items, setItems] = useState<Character[]>([])
  const [shareModalFor, setShareModalFor] = useState<Character | null>(null)
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
  const [uploadAngle, setUploadAngle] = useState<Angle>('front')
  const [uploading, setUploading] = useState(false)
  const [addingImage, setAddingImage] = useState(false)
  // 상세 패널 "사진 추가" 시 적용할 각도
  const [addImageAngle, setAddImageAngle] = useState<Angle>('side')
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
      fd.append('angle', uploadAngle)
      const r = await authedFetch('/api/seedance/characters', { method: 'POST', body: fd })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const row: Character = await r.json()
      setItems(prev => [row, ...prev])
      // reset form
      if (uploadPreview) URL.revokeObjectURL(uploadPreview)
      setUploadFile(null); setUploadPreview(''); setUploadName(''); setUploadDesc('')
      setUploadAngle('front')
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

  const replaceCharacter = (updated: Character) => {
    setItems(prev => prev.map(x => x.id === updated.id ? updated : x))
    if (selected?.id === updated.id) setSelected(updated)
  }

  const addImage = async (c: Character, file: File, angle: Angle) => {
    if (addingImage) return
    setAddingImage(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('angle', angle)
      const r = await authedFetch(`/api/seedance/characters/${c.id}/images`, { method: 'POST', body: fd })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const data = await r.json()
      if (data.row) replaceCharacter(data.row as Character)
    } catch (e: any) {
      alert('사진 추가 실패: ' + (e?.message || e))
    } finally { setAddingImage(false) }
  }

  const setAngle = async (c: Character, url: string, angle: Angle | '') => {
    try {
      const r = await authedFetch(`/api/seedance/characters/${c.id}/images/angle`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, angle: angle || null }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const data = await r.json()
      if (data.row) replaceCharacter(data.row as Character)
    } catch (e: any) {
      alert('각도 변경 실패: ' + (e?.message || e))
    }
  }

  const removeImage = async (c: Character, url: string) => {
    if (!confirm('이 사진을 제거할까요?')) return
    try {
      const r = await authedFetch(`/api/seedance/characters/${c.id}/images/remove`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const data = await r.json()
      if (data.row) replaceCharacter(data.row as Character)
    } catch (e: any) {
      alert('사진 제거 실패: ' + (e?.message || e))
    }
  }

  const setPrimary = async (c: Character, url: string) => {
    try {
      const r = await authedFetch(`/api/seedance/characters/${c.id}/images/primary`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const data = await r.json()
      if (data.row) replaceCharacter(data.row as Character)
    } catch (e: any) {
      alert('대표 사진 변경 실패: ' + (e?.message || e))
    }
  }

  const useInGen = (c: Character) => {
    const urls = imageList(c)
    sessionStorage.setItem('seedance_pending_character', JSON.stringify({
      id: c.id, image_url: c.image_url, image_urls: urls, name: c.name,
      angles: (c.meta?.angles && typeof c.meta.angles === 'object') ? c.meta.angles : {},
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', flexShrink: 0 }}>
                사진 각도
              </span>
              <select value={uploadAngle} onChange={e => setUploadAngle(e.target.value as Angle)}
                disabled={uploading} style={{ ...inputSt, width: 'auto', flex: 1 }}>
                {ANGLES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
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
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2,
                    display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                    <span>사용 {c.use_count}회</span>
                    <span style={{ display: 'flex', gap: 4 }}>
                      {c._shared && (
                        <span title={`${c._creator_name || c._creator_email || ''} 공유`}
                          style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                            background: 'var(--accent-light)', color: 'var(--accent)',
                            border: '1px solid var(--accent)' }}>
                          공유받음
                        </span>
                      )}
                      {imageList(c).length > 1 && (
                        <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
                          📷 {imageList(c).length}
                        </span>
                      )}
                    </span>
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
                <div style={{ flex: 1, marginRight: 8, display: 'flex', gap: 6,
                  alignItems: 'center', flexWrap: 'wrap' }}>
                  <input value={nameDraft} onChange={e => setNameDraft(e.target.value)} autoFocus
                    placeholder="인물 이름"
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); saveMeta(selected) }
                      else if (e.key === 'Escape') {
                        setEditingName(false)
                        setNameDraft(selected.name || '')
                        setDescDraft(selected.description || '')
                      }
                    }}
                    style={{ ...inputSt, fontSize: 14, fontWeight: 700, flex: 1, minWidth: 120 }} />
                  <button onClick={() => saveMeta(selected)}
                    style={{ ...smBtn, flexShrink: 0 }}>저장하기</button>
                  <button onClick={() => {
                      setEditingName(false)
                      setNameDraft(selected.name || '')
                      setDescDraft(selected.description || '')
                    }}
                    style={{ ...smBtnGhost, flexShrink: 0 }}>취소</button>
                </div>
              ) : (
                <strong style={{ fontSize: 14, flex: 1 }}>
                  {selected.name || <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(이름 없음)</span>}
                  <button onClick={() => setEditingName(true)} title="이름 수정"
                    style={{ marginLeft: 8, fontSize: 10, color: 'var(--accent)', background: 'none',
                      border: 'none', cursor: 'pointer' }}>✎ 수정</button>
                </strong>
              )}
              {!editingName && (
                <button onClick={() => setSelected(null)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                    color: 'var(--text-muted)', fontSize: 18 }}>×</button>
              )}
            </div>

            <img src={selected.image_url} alt={selected.name || ''}
              style={{ width: '100%', borderRadius: 8, background: '#000', marginBottom: 8 }} />

            <div style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 8 }}>
                <Label>사진 ({imageList(selected).length}장)</Label>
                {canEdit(selected) && (
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <select value={addImageAngle} onChange={e => setAddImageAngle(e.target.value as Angle)}
                      disabled={addingImage}
                      title="추가할 사진의 각도"
                      style={{ fontSize: 10, padding: '2px 4px', borderRadius: 4,
                        border: '1px solid var(--border)', background: 'var(--bg-base)',
                        color: 'var(--text-body)' }}>
                      {ANGLES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                    </select>
                    <label htmlFor={`add-img-${selected.id}`}
                      style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)',
                        border: '1px solid var(--accent)', borderRadius: 4,
                        padding: '3px 8px', cursor: addingImage ? 'wait' : 'pointer',
                        opacity: addingImage ? 0.5 : 1 }}>
                      {addingImage ? '추가 중…' : '+ 사진 추가'}
                    </label>
                    <input id={`add-img-${selected.id}`} type="file" accept="image/*"
                      disabled={addingImage}
                      onChange={e => {
                        const f = e.target.files?.[0]
                        if (f) addImage(selected, f, addImageAngle)
                        e.target.value = ''
                      }}
                      style={{ display: 'none' }} />
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 6 }}>
                {imageList(selected).map((u, i) => {
                  const editable = canEdit(selected)
                  return (
                    <div key={u + i}>
                      <div style={{ position: 'relative' }}>
                        <img src={u} alt=""
                          onClick={() => editable && u !== selected.image_url && setPrimary(selected, u)}
                          title={u === selected.image_url ? '대표 사진' : (editable ? '클릭해서 대표로 지정' : '')}
                          style={{ width: '100%', aspectRatio: '1', objectFit: 'cover',
                            border: u === selected.image_url ? '2px solid var(--accent)' : '1px solid var(--border)',
                            borderRadius: 4, background: '#000',
                            cursor: (editable && u !== selected.image_url) ? 'pointer' : 'default' }} />
                        {u === selected.image_url && (
                          <span style={{ position: 'absolute', top: 2, left: 2, padding: '1px 4px',
                            fontSize: 8, fontWeight: 700, borderRadius: 2,
                            background: 'var(--accent)', color: '#fff' }}>대표</span>
                        )}
                        {getAngle(selected, u) && (
                          <span style={{ position: 'absolute', bottom: 2, left: 2, padding: '1px 4px',
                            fontSize: 8, fontWeight: 700, borderRadius: 2,
                            background: 'rgba(0,0,0,0.7)', color: '#fff' }}>
                            {ANGLE_LABEL[getAngle(selected, u)]}
                          </span>
                        )}
                        {editable && imageList(selected).length > 1 && (
                          <button onClick={() => removeImage(selected, u)}
                            title="이 사진 제거"
                            style={{ position: 'absolute', top: 2, right: 2, padding: '0 4px',
                              fontSize: 10, fontWeight: 700, lineHeight: '14px',
                              background: 'rgba(0,0,0,0.6)', color: '#fff',
                              border: 'none', borderRadius: 2, cursor: 'pointer' }}>×</button>
                        )}
                      </div>
                      {editable ? (
                        <select value={getAngle(selected, u)}
                          onChange={e => setAngle(selected, u, e.target.value as Angle | '')}
                          title="이 사진의 각도"
                          style={{ width: '100%', fontSize: 9, padding: '1px 2px', marginTop: 2,
                            borderRadius: 3, border: '1px solid var(--border)',
                            background: 'var(--bg-base)', color: 'var(--text-body)' }}>
                          <option value="">미지정</option>
                          {ANGLES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                        </select>
                      ) : (
                        <div style={{ fontSize: 9, textAlign: 'center', marginTop: 2,
                          color: 'var(--text-muted)' }}>
                          {ANGLE_LABEL[getAngle(selected, u)] || '–'}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <Label>메모</Label>
            {editingName ? (
              <textarea value={descDraft} onChange={e => setDescDraft(e.target.value)}
                rows={3} style={{ ...inputSt, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
            ) : (
              <div style={{ ...inputSt, minHeight: 38, whiteSpace: 'pre-wrap', color: selected.description ? 'var(--text-body)' : 'var(--text-muted)' }}>
                {selected.description || '(없음)'}
              </div>
            )}

            {!editingName && (
              <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => useInGen(selected)} style={smBtn}>🧑 인물로 사용 →</button>
                <button onClick={() => { navigator.clipboard.writeText(selected.image_url); alert('URL 복사됨') }}
                  style={smBtnGhost}>URL 복사</button>
                {!selected._shared && me && selected.created_by === me.id && (
                  <button onClick={() => setShareModalFor(selected)} style={smBtnGhost}>👥 공유</button>
                )}
                {!selected._shared && (
                  <button onClick={() => remove(selected)}
                    style={{ ...smBtnGhost, color: 'var(--error)', borderColor: 'var(--error)' }}>삭제</button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {shareModalFor && (
        <SeedanceShareModal
          resourceType="characters"
          resourceId={shareModalFor.id}
          resourceLabel={shareModalFor.name || '인물'}
          onClose={() => setShareModalFor(null)}
        />
      )}
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
