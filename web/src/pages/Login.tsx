import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'

const ID_DOMAIN = 'reels-bench.local'
const idToEmail = (id: string) => {
  const v = id.trim().toLowerCase()
  return v.includes('@') ? v : `${v}@${ID_DOMAIN}`
}

export default function Login() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(''); setInfo(''); setLoading(true)
    try {
      const email = idToEmail(userId)
      if (!/^[a-z0-9_.\-@]+$/.test(email)) {
        throw new Error('아이디는 영문/숫자/_/-/. 만 사용 가능합니다')
      }
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        navigate('/')
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        if (data.user && !data.session) {
          setInfo('가입은 됐는데 세션이 없습니다. 로그인 탭에서 다시 시도해주세요.')
        } else {
          navigate('/')
        }
      }
    } catch (e: any) {
      setErr(e.message || '실패')
    }
    setLoading(false)
  }

  const labelSt: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }
  const inputSt: React.CSSProperties = {
    width: '100%', padding: '10px 12px', fontSize: 14,
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-base)', color: 'var(--text-primary)',
  }

  return (
    <div style={{ minHeight: 'calc(100vh - 80px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={submit} style={{
        width: 380, padding: 32, background: 'var(--bg-surface)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-md)',
      }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Reels Bench</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 24 }}>
          {mode === 'signin' ? '계정으로 로그인' : '신규 계정 등록 (첫 가입자는 자동 admin)'}
        </p>

        <div style={{ marginBottom: 14 }}>
          <label style={labelSt}>아이디</label>
          <input type="text" required value={userId} onChange={e => setUserId(e.target.value)}
            placeholder="minhyuk" style={inputSt} autoCapitalize="off" autoCorrect="off" />
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={labelSt}>비밀번호</label>
          <input type="password" required minLength={6} value={password}
            onChange={e => setPassword(e.target.value)} placeholder="6자 이상" style={inputSt} />
        </div>

        {err && <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>{err}</div>}
        {info && <div style={{ color: 'var(--success)', fontSize: 12, marginBottom: 12 }}>{info}</div>}

        <button type="submit" disabled={loading} style={{
          width: '100%', padding: '10px 16px', fontSize: 14, fontWeight: 600,
          border: 'none', borderRadius: 'var(--radius-sm)',
          background: 'var(--accent)', color: '#fff', cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1,
        }}>
          {loading ? '...' : mode === 'signin' ? '로그인' : '가입'}
        </button>

        <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
          {mode === 'signin' ? (
            <>계정 없음? <button type="button" onClick={() => { setMode('signup'); setErr('') }}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, cursor: 'pointer', padding: 0 }}>
              가입하기</button></>
          ) : (
            <>이미 계정 있음? <button type="button" onClick={() => { setMode('signin'); setErr('') }}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, cursor: 'pointer', padding: 0 }}>
              로그인</button></>
          )}
        </div>
      </form>
    </div>
  )
}
