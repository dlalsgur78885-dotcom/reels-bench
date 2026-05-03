import { useEffect, useState, lazy, Suspense } from 'react'
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom'
import { supabase } from './supabase'
import { api, type UserProfile } from './api'
import { AuthContext } from './auth'
import './App.css'

// 라우트 코드 스플리팅 — 각 페이지는 첫 진입 시 별도 청크로 로드
const Home = lazy(() => import('./pages/Home'))
const Bench = lazy(() => import('./pages/Bench'))
const BenchDetail = lazy(() => import('./pages/BenchDetail'))
const AnalysisPage = lazy(() => import('./pages/AnalysisPage'))
const Channels = lazy(() => import('./pages/Channels'))
const ReelIntake = lazy(() => import('./pages/ReelIntake'))
const Login = lazy(() => import('./pages/Login'))
const ScriptGen = lazy(() => import('./pages/ScriptGen'))
const MyProducts = lazy(() => import('./pages/MyProducts'))
const Phrases = lazy(() => import('./pages/Phrases'))
const Settings = lazy(() => import('./pages/Settings'))

function RouteFallback() {
  return <div style={{ padding: 40, color: 'var(--text-muted)' }}>불러오는 중…</div>
}

const ME_CACHE_KEY = 'cached_me'
const ME_CACHE_TTL_MS = 60 * 60 * 1000  // 60분

interface CachedMeEnvelope { t: number; profile: UserProfile }

function loadCachedMe(): UserProfile | null {
  try {
    const raw = localStorage.getItem(ME_CACHE_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    // 구버전 (envelope 아님) 호환
    if (obj && typeof obj === 'object' && 'profile' in obj && 't' in obj) {
      return (obj as CachedMeEnvelope).profile
    }
    return obj as UserProfile
  } catch { return null }
}
function loadCachedMeAge(): number | null {
  try {
    const raw = localStorage.getItem(ME_CACHE_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    return obj && typeof obj.t === 'number' ? Date.now() - obj.t : null
  } catch { return null }
}
function saveCachedMe(p: UserProfile | null) {
  try {
    if (p) localStorage.setItem(ME_CACHE_KEY, JSON.stringify({ t: Date.now(), profile: p }))
    else localStorage.removeItem(ME_CACHE_KEY)
  } catch {}
}

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
  const [me, setMe] = useState<UserProfile | null>(loadCachedMe)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [meLoading, setMeLoading] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setBootstrapping(false)
    })
    // SIGNED_OUT 이벤트에서만 캐시 wipe — 일시적 session=null/토큰 갱신 중에는 보존
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'SIGNED_OUT') {
        setMe(null)
        saveCachedMe(null)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (bootstrapping) return
    if (!session) { setMeLoading(false); return }
    // cached_me가 신선하면 (< 60분) refetch 스킵 — cold start에서 /api/me 호출 자체 회피
    const age = loadCachedMeAge()
    if (age !== null && age < ME_CACHE_TTL_MS) {
      setMeLoading(false)
      return
    }
    setMeLoading(true)
    api.me()
      .then(p => { setMe(p); saveCachedMe(p) })
      .catch(() => {})
      .finally(() => setMeLoading(false))
  }, [session, bootstrapping])

  // 캐시된 me가 있으면 부트스트랩 완료 전에 낙관적으로 레이아웃 렌더 → 즉시 권한 버튼 노출.
  // 세션이 유효하지 않으면 bootstrap 종료 후 다음 분기에서 로그인으로 라우팅.
  if (bootstrapping && !me) return null

  if (!bootstrapping && !session) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    )
  }

  return (
    <AuthContext.Provider value={{ me }}>
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
        </nav>
        <UserMenu me={me} />
      </aside>
      <main className="main">
        <Suspense fallback={<RouteFallback />}>
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
          <Route path="/settings" element={
            meLoading ? <div style={{ padding: 40, color: 'var(--text-muted)' }}>로딩...</div>
            : me?.role === 'admin' ? <Settings />
            : <Navigate to="/" replace />
          } />
          {/* 이전 경로 → 설정 탭으로 redirect */}
          <Route path="/users" element={<Navigate to="/settings?tab=users" replace />} />
          <Route path="/admin/secrets" element={<Navigate to="/settings?tab=secrets" replace />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
        </Suspense>
      </main>
    </div>
    </AuthContext.Provider>
  )
}

function UserMenu({ me }: { me: UserProfile | null }) {
  const navigate = useNavigate()
  const logout = async () => { await supabase.auth.signOut(); navigate('/login') }
  const btnSt: React.CSSProperties = {
    width: '100%', padding: '6px 10px', fontSize: 11,
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-base)', color: 'var(--text-secondary)', cursor: 'pointer',
  }
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
      <button onClick={logout} style={btnSt}>로그아웃</button>
      {me?.role === 'admin' && (
        <button onClick={() => navigate('/settings')} style={{ ...btnSt, marginTop: 6 }}>설정</button>
      )}
    </div>
  )
}
