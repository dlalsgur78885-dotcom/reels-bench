/**
 * Login screen — userId + password (mirrors web/src/pages/Login.tsx).
 *
 * Synthetic email `<userId>@reels-bench.local` lets us keep Supabase's
 * email/password backend while exposing a clean ID-only UI to internal
 * users. Sign-in vs sign-up is a toggle. No deeplink / OAuth.
 */
import { useState, type FormEvent } from 'react'
import { idToEmail, useAuthStore } from '../store/auth'

const wrap: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#0d0d0d',
  color: '#f5f5f5',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
}

const card: React.CSSProperties = {
  width: 380,
  padding: 32,
  background: '#1a1a1a',
  border: '1px solid #2a2a2a',
  borderRadius: 12,
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
}

const labelSt: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#9aa0a6',
  marginBottom: 6,
  display: 'block'
}

const inputSt: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 14,
  border: '1px solid #374151',
  borderRadius: 6,
  background: '#0d0d0d',
  color: '#f5f5f5',
  boxSizing: 'border-box',
  outline: 'none'
}

const btnPrimary = (disabled: boolean): React.CSSProperties => ({
  width: '100%',
  padding: '10px 16px',
  fontSize: 14,
  fontWeight: 600,
  border: 'none',
  borderRadius: 6,
  background: disabled ? '#374151' : '#3b82f6',
  color: '#fff',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1
})

const linkBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#60a5fa',
  fontSize: 12,
  cursor: 'pointer',
  padding: 0
}

export default function Login(): JSX.Element {
  const signIn = useAuthStore((s) => s.signIn)
  const signUp = useAuthStore((s) => s.signUp)
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setErr('')
    setInfo('')
    setBusy(true)
    try {
      // Pre-validate so we don't even call Supabase with bad input — keeps
      // unit-test surface predictable.
      const email = idToEmail(userId)
      if (!/^[a-z0-9_.\-@]+$/.test(email)) {
        throw new Error('아이디는 영문/숫자/_/-/. 만 사용 가능합니다')
      }
      if (mode === 'signin') {
        await signIn(userId, password)
      } else {
        const r = await signUp(userId, password)
        if (r.needsSignIn) {
          setInfo('가입은 됐는데 세션이 없습니다. 로그인 탭에서 다시 시도해주세요.')
        }
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '실패')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={wrap} data-testid="login-page">
      <form onSubmit={submit} style={card}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Reels Studio</h1>
        <p style={{ fontSize: 13, color: '#9aa0a6', marginBottom: 24 }}>
          {mode === 'signin' ? '계정으로 로그인' : '신규 계정 등록 (첫 가입자는 자동 admin)'}
        </p>

        <div style={{ marginBottom: 14 }}>
          <label style={labelSt}>아이디</label>
          <input
            type="text"
            required
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="minhyuk"
            style={inputSt}
            autoCapitalize="off"
            autoCorrect="off"
            data-testid="login-userid"
          />
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={labelSt}>비밀번호</label>
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="6자 이상"
            style={inputSt}
            data-testid="login-password"
          />
        </div>

        {err && (
          <div
            style={{ color: '#f87171', fontSize: 12, marginBottom: 12 }}
            data-testid="login-error"
          >
            {err}
          </div>
        )}
        {info && (
          <div
            style={{ color: '#34d399', fontSize: 12, marginBottom: 12 }}
            data-testid="login-info"
          >
            {info}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={btnPrimary(busy)}
          data-testid="login-submit"
        >
          {busy ? '...' : mode === 'signin' ? '로그인' : '가입'}
        </button>

        <div
          style={{
            marginTop: 16,
            fontSize: 12,
            color: '#9aa0a6',
            textAlign: 'center'
          }}
        >
          {mode === 'signin' ? (
            <>
              계정 없음?{' '}
              <button
                type="button"
                onClick={() => {
                  setMode('signup')
                  setErr('')
                }}
                style={linkBtn}
                data-testid="login-mode-signup"
              >
                가입하기
              </button>
            </>
          ) : (
            <>
              이미 계정 있음?{' '}
              <button
                type="button"
                onClick={() => {
                  setMode('signin')
                  setErr('')
                }}
                style={linkBtn}
                data-testid="login-mode-signin"
              >
                로그인
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  )
}
