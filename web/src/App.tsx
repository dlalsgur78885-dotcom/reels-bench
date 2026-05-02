import { useEffect, useState } from 'react'
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom'
import Home from './pages/Home'
import Bench from './pages/Bench'
import BenchDetail from './pages/BenchDetail'
import AnalysisPage from './pages/AnalysisPage'
import Channels from './pages/Channels'
import ReelIntake from './pages/ReelIntake'
import Login from './pages/Login'
import Users from './pages/Users'
import Secrets from './pages/Secrets'
import ScriptGen from './pages/ScriptGen'
import MyProducts from './pages/MyProducts'
import Phrases from './pages/Phrases'
import { supabase } from './supabase'
import { api, type UserProfile } from './api'
import './App.css'

const NAV = [
  { to: '/', label: '홈', icon: '&#x2302;' },
  { to: '/bench', label: '벤치마크', icon: '&#x25A6;' },
  { to: '/channels', label: '채널', icon: '&#x2631;' },
  { to: '/reels/new', label: '릴스 추가', icon: '&#x2795;' },
  { to: '/my-products', label: '내 상품', icon: '&#x1F4E6;' },
  { to: '/phrases', label: '문구별 보기', icon: '&#x201C;' },
]

export default function App() {
  const [session, setSession] = useState<any>(null)
  const [me, setMe] = useState<UserProfile | null>(null)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [meLoading, setMeLoading] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setBootstrapping(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) { setMe(null); setMeLoading(false); return }
    setMeLoading(true)
    api.me().then(setMe).catch(() => setMe(null)).finally(() => setMeLoading(false))
  }, [session])

  if (bootstrapping) return null

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sb-logo">릴스 벤치</div>
        <nav className="sb-nav">
          {NAV.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) => `sb-item${isActive ? ' active' : ''}`}
            >
              <span className="sb-icon" dangerouslySetInnerHTML={{ __html: n.icon }} />
              {n.label}
            </NavLink>
          ))}
          {me?.role === 'admin' && (
            <>
              <NavLink to="/users" className={({ isActive }) => `sb-item${isActive ? ' active' : ''}`}>
                <span className="sb-icon">&#x1F465;</span>
                직원 관리
              </NavLink>
              <NavLink to="/admin/secrets" className={({ isActive }) => `sb-item${isActive ? ' active' : ''}`}>
                <span className="sb-icon">&#x1F510;</span>
                시크릿
              </NavLink>
            </>
          )}
        </nav>
        <UserMenu me={me} />
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/reels/new" element={<ReelIntake />} />
          <Route path="/bench" element={<Bench />} />
          <Route path="/bench/:shortcode" element={<BenchDetail />} />
          <Route path="/phrases" element={<Phrases />} />
          <Route path="/analysis" element={<AnalysisPage />} />
          <Route path="/channels" element={<Channels />} />
          <Route path="/script" element={<ScriptGen />} />
          <Route path="/my-products" element={<MyProducts />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/users" element={
            meLoading ? <div style={{ padding: 40, color: 'var(--text-muted)' }}>로딩...</div>
            : me?.role === 'admin' ? <Users />
            : <Navigate to="/" replace />
          } />
          <Route path="/admin/secrets" element={
            meLoading ? <div style={{ padding: 40, color: 'var(--text-muted)' }}>로딩...</div>
            : me?.role === 'admin' ? <Secrets />
            : <Navigate to="/" replace />
          } />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  )
}

function UserMenu({ me }: { me: UserProfile | null }) {
  const navigate = useNavigate()
  const logout = async () => { await supabase.auth.signOut(); navigate('/login') }
  return (
    <div style={{
      marginTop: 'auto', padding: '12px 14px', borderTop: '1px solid var(--border-subtle)',
      fontSize: 12, color: 'var(--text-secondary)',
    }}>
      <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {me?.display_name || (me?.email || '').replace('@reels-bench.local', '') || '...'}
      </div>
      <div style={{ fontSize: 10, marginBottom: 6 }}>
        {me?.role === 'admin' ? '관리자' : '직원'}
      </div>
      <button onClick={logout} style={{
        width: '100%', padding: '6px 10px', fontSize: 11,
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-base)', color: 'var(--text-secondary)', cursor: 'pointer',
      }}>로그아웃</button>
    </div>
  )
}
