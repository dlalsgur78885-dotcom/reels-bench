import { useEffect, useState } from 'react'
import { api } from '../api'

interface Item { id: string; name: string; description: string; updated_at: string }

const KNOWN: { name: string; description: string }[] = [
  { name: 'GEMINI_API_KEY', description: 'Gemini Pro API key (대본 생성·분석)' },
]

export default function Secrets() {
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [editName, setEditName] = useState('')
  const [editValue, setEditValue] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')

  const load = async () => {
    setLoading(true); setErr('')
    try {
      const data = await api.listSecrets()
      setItems(data)
    } catch (e: any) {
      setErr(e.message || '로드 실패')
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const onEdit = (name: string, description = '') => {
    setEditName(name); setEditValue(''); setEditDesc(description); setSavedMsg('')
  }

  const onSave = async () => {
    if (!editName.trim() || !editValue.trim()) {
      setErr('이름·값 모두 입력하세요'); return
    }
    setSaving(true); setErr(''); setSavedMsg('')
    try {
      await api.upsertSecret(editName.trim(), editValue, editDesc)
      setSavedMsg(`✓ ${editName} 갱신 완료. 캐시 무효화됨, 즉시 반영.`)
      setEditValue('')
      load()
    } catch (e: any) {
      setErr(e.message || '저장 실패')
    }
    setSaving(false)
  }

  const onDelete = async (name: string) => {
    if (!confirm(`${name} 삭제하시겠습니까?`)) return
    try {
      await api.deleteSecret(name)
      load()
    } catch (e: any) {
      setErr(e.message || '삭제 실패')
    }
  }

  // Known names not yet registered
  const registeredNames = new Set(items.map(i => i.name))
  const missing = KNOWN.filter(k => !registeredNames.has(k.name))

  return (
    <>
      <div className="page-header">
        <h1>🔐 시크릿 관리</h1>
        <p>Supabase Vault에 저장된 API 키. admin 전용 · 5분 캐시.</p>
      </div>

      {err && <div style={{ color: 'var(--error)', fontSize: 13, padding: 10, background: 'rgba(239,68,68,0.10)', borderRadius: 'var(--radius-sm)', marginBottom: 12 }}>{err}</div>}

      {/* 등록된 시크릿 */}
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 16,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
          등록된 시크릿 ({items.length})
        </div>
        {loading ? <div>로딩…</div> : items.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>등록된 시크릿이 없습니다.</div>
        ) : (
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={th}>이름</th>
                <th style={th}>설명</th>
                <th style={th}>갱신일</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={td}><code style={{ fontFamily: 'monospace', fontSize: 12 }}>{it.name}</code></td>
                  <td style={{ ...td, color: 'var(--text-secondary)' }}>{it.description || '—'}</td>
                  <td style={{ ...td, color: 'var(--text-muted)', fontSize: 11 }}>{new Date(it.updated_at).toLocaleString()}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => onEdit(it.name, it.description)} style={btn('accent')}>변경</button>
                    <button onClick={() => onDelete(it.name)} style={{ ...btn('error'), marginLeft: 6 }}>삭제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {missing.length > 0 && (
          <div style={{
            marginTop: 12, padding: 10, fontSize: 12,
            background: '#fff3cd', color: '#856404', borderRadius: 'var(--radius-sm)',
          }}>
            ⚠️ 미등록 시크릿: {missing.map(m => (
              <button key={m.name} onClick={() => onEdit(m.name, m.description)}
                style={{ ...btn('accent'), marginLeft: 6, fontSize: 11 }}>
                + {m.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 편집 폼 */}
      {editName && (
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--accent)',
          borderRadius: 'var(--radius-md)', padding: 16,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
            {registeredNames.has(editName) ? '시크릿 갱신' : '시크릿 추가'}: <code>{editName}</code>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>이름 (key)</label>
            <input value={editName} onChange={e => setEditName(e.target.value)}
              style={inp} placeholder="GEMINI_API_KEY" disabled={registeredNames.has(editName)} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>값 (value)</label>
            <input type="password" value={editValue} onChange={e => setEditValue(e.target.value)}
              style={inp} placeholder="새 값을 입력하면 기존 값을 덮어씁니다" autoFocus />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              ※ 값은 저장 후 다시 보이지 않습니다. 안전한 곳에 백업 권장.
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>설명 (선택)</label>
            <input value={editDesc} onChange={e => setEditDesc(e.target.value)} style={inp} />
          </div>

          {savedMsg && (
            <div style={{
              padding: 10, fontSize: 12, marginBottom: 10,
              background: '#d4edda', color: '#155724', borderRadius: 'var(--radius-sm)',
            }}>{savedMsg}</div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { setEditName(''); setEditValue(''); setEditDesc(''); setSavedMsg('') }}
              style={btn('muted')}>취소</button>
            <button onClick={onSave} disabled={saving || !editValue.trim()}
              style={{ ...btn('accent'), flex: 1, padding: '10px 16px', fontSize: 13 }}>
              {saving ? '저장 중…' : '저장'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 8px', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }
const td: React.CSSProperties = { padding: '8px', fontSize: 12 }
const lbl: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }
const inp: React.CSSProperties = { width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'inherit' }

function btn(variant: 'accent' | 'error' | 'muted'): React.CSSProperties {
  const colors = {
    accent: { bg: 'var(--accent)', color: '#fff' },
    error: { bg: 'transparent', color: 'var(--error)', border: 'var(--error)' },
    muted: { bg: 'var(--bg-elevated)', color: 'var(--text-secondary)' },
  }[variant]
  return {
    padding: '6px 12px', fontSize: 12, fontWeight: 600,
    border: variant === 'error' ? `1px solid ${(colors as any).border}` : 'none',
    borderRadius: 'var(--radius-sm)',
    background: colors.bg, color: colors.color, cursor: 'pointer',
  }
}
