import { useState } from 'react'

type Character = { id: string; name: string | null; image_url: string | null }

// 인물 그룹 생성·수정 모달 — 이름 + 인물 1명 지정.
export default function CharacterGroupModal({
  initial, characters, onSave, onClose,
}: {
  initial?: { id: string; name: string; character_id: string | null } | null
  characters: Character[]
  onSave: (name: string, characterId: string | null) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [charId, setCharId] = useState<string>(initial?.character_id || '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!name.trim()) { alert('그룹 이름을 입력하세요'); return }
    setSaving(true)
    try {
      await onSave(name.trim(), charId || null)
      onClose()
    } catch (e: any) {
      alert('저장 실패: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div onClick={() => !saving && onClose()}
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 380, background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 16, boxShadow: '0 8px 30px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong style={{ fontSize: 14 }}>{initial ? '인물 그룹 수정' : '새 인물 그룹'}</strong>
          <button onClick={() => !saving && onClose()}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 18 }}>×</button>
        </div>

        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>그룹 이름</label>
        <input value={name} onChange={e => setName(e.target.value)} autoFocus
          placeholder="예: 30대 남성 모델 A"
          onKeyDown={e => { if (e.key === 'Enter') save() }}
          style={{ width: '100%', marginTop: 4, marginBottom: 12, padding: '7px 9px',
            fontSize: 13, border: '1px solid var(--border)', borderRadius: 6,
            background: 'var(--bg-base)', color: 'var(--text-body)' }} />

        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>인물</label>
        <select value={charId} onChange={e => setCharId(e.target.value)}
          style={{ width: '100%', marginTop: 4, marginBottom: 6, padding: '7px 9px',
            fontSize: 13, border: '1px solid var(--border)', borderRadius: 6,
            background: 'var(--bg-base)', color: 'var(--text-body)' }}>
          <option value="">— 인물 미지정 —</option>
          {characters.map(c => (
            <option key={c.id} value={c.id}>{c.name || '이름 없는 인물'}</option>
          ))}
        </select>
        {charId && (() => {
          const c = characters.find(x => x.id === charId)
          return c?.image_url ? (
            <img src={c.image_url} alt={c.name || ''}
              style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6,
                border: '1px solid var(--border)', marginBottom: 6 }} />
          ) : null
        })()}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={() => !saving && onClose()}
            style={{ padding: '6px 14px', fontSize: 12, background: 'transparent',
              color: 'var(--text-muted)', border: '1px solid var(--border)',
              borderRadius: 6, cursor: 'pointer' }}>취소</button>
          <button onClick={save} disabled={saving}
            style={{ padding: '6px 14px', fontSize: 12, fontWeight: 700,
              background: 'var(--accent)', color: '#fff', border: 'none',
              borderRadius: 6, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
