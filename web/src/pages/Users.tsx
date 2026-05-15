import { useEffect, useState } from 'react'
import { api } from '../api'
import type { UserProfile } from '../api'

const CACHE_KEY = 'settings_users_cache'

function readCache(): UserProfile[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function writeCache(users: UserProfile[]) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(users)) } catch {}
}

export default function Users() {
  const cachedUsers = readCache()
  const [users, setUsers] = useState<UserProfile[]>(cachedUsers || [])
  const [loading, setLoading] = useState(!cachedUsers)
  const [err, setErr] = useState('')
  const [showInvite, setShowInvite] = useState(false)
  const [inviteId, setInviteId] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [invitePw, setInvitePw] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'employee'>('employee')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteMsg, setInviteMsg] = useState('')

  const ID_DOMAIN = 'reels-bench.local'
  const idToEmail = (id: string) => id.includes('@') ? id : `${id.trim().toLowerCase()}@${ID_DOMAIN}`
  const emailToId = (email: string) => (email || '').replace(`@${ID_DOMAIN}`, '')

  const load = async () => {
    if (!readCache()) setLoading(true)
    setErr('')
    try {
      const data = await api.listUsers()
      setUsers(data)
      writeCache(data)
    } catch (e: any) {
      setErr(e.message || '로딩 실패')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const invite = async () => {
    if (!inviteId) return
    if (!/^[a-z0-9_.\-]+$/.test(inviteId.trim().toLowerCase())) {
      setInviteMsg('아이디는 영문/숫자/_/-/. 만 가능합니다')
      return
    }
    setInviteBusy(true); setInviteMsg('')
    try {
      const email = idToEmail(inviteId)
      const res = await api.inviteUser(email, inviteName || undefined, inviteRole, invitePw || undefined)
      setInviteMsg(res.message || '초대 완료')
      setInviteId(''); setInviteName(''); setInvitePw('')
      load()
    } catch (e: any) {
      setInviteMsg(e.message || '실패')
    }
    setInviteBusy(false)
  }

  const updateRole = async (id: string, role: 'admin' | 'employee') => {
    try { await api.updateUser(id, { role }); load() } catch (e: any) { alert(e.message) }
  }
  const toggleActive = async (id: string, active: boolean) => {
    try { await api.updateUser(id, { active: !active }); load() } catch (e: any) { alert(e.message) }
  }
  const toggleDeletePerm = async (id: string, current: boolean) => {
    try { await api.updateUser(id, { can_delete_reels: !current }); load() } catch (e: any) { alert(e.message) }
  }
  const removeUser = async (id: string, email: string) => {
    if (!confirm(`${email} 계정을 완전히 삭제할까요?`)) return
    try { await api.deleteUser(id); load() } catch (e: any) { alert(e.message) }
  }

  return (
    <>
      <div className="page-header">
        <h1>직원 관리</h1>
        <p>{users.length}명</p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <button onClick={() => setShowInvite(!showInvite)} style={{
          padding: '8px 16px', fontSize: 13, fontWeight: 600,
          border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)',
          background: showInvite ? 'var(--accent)' : 'var(--accent-light)',
          color: showInvite ? '#fff' : 'var(--accent)', cursor: 'pointer',
        }}>+ 직원 초대</button>
      </div>

      {showInvite && (
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 16,
          display: 'grid', gridTemplateColumns: '1.4fr 1.4fr 1fr 0.9fr auto', gap: 10, alignItems: 'end',
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>아이디</div>
            <input type="text" value={inviteId} onChange={e => setInviteId(e.target.value)}
              placeholder="minhyuk" style={inputSt} autoCapitalize="off" autoCorrect="off" />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>표시 이름</div>
            <input value={inviteName} onChange={e => setInviteName(e.target.value)} placeholder="(선택)" style={inputSt} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>비밀번호</div>
            <input type="text" value={invitePw} onChange={e => setInvitePw(e.target.value)}
              placeholder="(빈칸시 자동)" style={inputSt} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>권한</div>
            <select value={inviteRole} onChange={e => setInviteRole(e.target.value as any)} style={inputSt}>
              <option value="employee">직원</option>
              <option value="admin">관리자</option>
            </select>
          </div>
          <button onClick={invite} disabled={inviteBusy || !inviteId} style={{
            padding: '8px 14px', fontSize: 13, fontWeight: 600,
            border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            background: 'var(--accent)', color: '#fff', opacity: inviteBusy ? 0.6 : 1,
          }}>{inviteBusy ? '...' : '초대'}</button>
          {inviteMsg && <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--text-secondary)' }}>{inviteMsg}</div>}
        </div>
      )}

      {err && <div style={{ padding: 12, background: '#FEE2E2', borderRadius: 'var(--radius-md)', color: '#DC2626', fontSize: 13, marginBottom: 16 }}>{err}</div>}

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}>
              <th style={th}>아이디</th>
              <th style={th}>이름</th>
              <th style={th}>권한</th>
              <th style={th}>상태</th>
              <th style={th}>릴스 삭제</th>
              <th style={th}>가입일</th>
              <th style={th}>최근 로그인</th>
              <th style={{ ...th, textAlign: 'right' }}>작업</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>로딩...</td></tr>}
            {!loading && users.length === 0 && <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>직원이 없습니다</td></tr>}
            {users.map(u => (
              <tr key={u.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <td style={td}>{emailToId(u.email)}</td>
                <td style={td}>{u.display_name || '—'}</td>
                <td style={td}>
                  <select value={u.role} onChange={e => updateRole(u.id, e.target.value as any)}
                    style={{ ...inputSt, padding: '4px 8px', width: 100, fontSize: 12 }}>
                    <option value="employee">직원</option>
                    <option value="admin">관리자</option>
                  </select>
                </td>
                <td style={td}>
                  <button onClick={() => toggleActive(u.id, u.active)} style={{
                    padding: '3px 10px', fontSize: 11, fontWeight: 600,
                    border: '1px solid', borderRadius: 999, cursor: 'pointer',
                    color: u.active ? 'var(--success)' : 'var(--text-muted)',
                    borderColor: u.active ? 'var(--success)' : 'var(--border)',
                    background: u.active ? '#F0FDF4' : 'var(--bg-elevated)',
                  }}>{u.active ? '활성' : '비활성'}</button>
                </td>
                <td style={td}>
                  {u.role === 'admin' ? (
                    <span style={{
                      padding: '3px 10px', fontSize: 11, fontWeight: 600,
                      color: 'var(--text-muted)', background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)', borderRadius: 999,
                    }} title="관리자는 자동으로 삭제 가능">자동</span>
                  ) : (
                    <button onClick={() => toggleDeletePerm(u.id, u.can_delete_reels)} style={{
                      padding: '3px 10px', fontSize: 11, fontWeight: 600,
                      border: '1px solid', borderRadius: 999, cursor: 'pointer',
                      color: u.can_delete_reels ? 'var(--accent)' : 'var(--text-muted)',
                      borderColor: u.can_delete_reels ? 'var(--accent)' : 'var(--border)',
                      background: u.can_delete_reels ? 'var(--accent-light)' : 'var(--bg-elevated)',
                    }}>{u.can_delete_reels ? '허용' : '차단'}</button>
                  )}
                </td>
                <td style={{ ...td, color: 'var(--text-muted)', fontSize: 11 }}>{u.created_at?.slice(0, 10)}</td>
                <td style={{ ...td, color: 'var(--text-muted)', fontSize: 11 }}>{u.last_login_at?.slice(0, 16)?.replace('T', ' ') || '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button onClick={() => removeUser(u.id, emailToId(u.email))} style={{
                    padding: '3px 10px', fontSize: 11, color: 'var(--error)',
                    border: '1px solid var(--error)', borderRadius: 4, background: 'transparent', cursor: 'pointer',
                  }}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 700,
  color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.08em',
}
const td: React.CSSProperties = { padding: '10px 14px' }
const inputSt: React.CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 13,
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-base)', color: 'var(--text-primary)',
}
