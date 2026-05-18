import { useEffect, useState, Suspense } from 'react'
import { lazyWithRetry as lazy } from './lazyWithRetry'
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
const ScriptGenWizard = lazy(() => import('./pages/ScriptGenWizard'))
const TtsGen = lazy(() => import('./pages/TtsGen'))
const MyProducts = lazy(() => import('./pages/MyProducts'))
const MyProductEdit = lazy(() => import('./pages/MyProductEdit'))
const MyProductScripts = lazy(() => import('./pages/MyProductScripts'))
const MyScripts = lazy(() => import('./pages/MyScripts'))
const MyScriptDetail = lazy(() => import('./pages/MyScriptDetail'))
const Phrases = lazy(() => import('./pages/Phrases'))
const Ads = lazy(() => import('./pages/Ads'))
const Settings = lazy(() => import('./pages/Settings'))
const Youtubers = lazy(() => import('./pages/Youtubers'))
const YtShortsIntake = lazy(() => import('./pages/YtShortsIntake'))
const YtBench = lazy(() => import('./pages/YtBench'))
const YtBenchDetail = lazy(() => import('./pages/YtBenchDetail'))
const FbAdvertisers = lazy(() => import('./pages/FbAdvertisers'))
const FbSearchAdvertisers = lazy(() => import('./pages/FbSearchAdvertisers'))
const FbSearchAds = lazy(() => import('./pages/FbSearchAds'))
const FbAdImportPage = lazy(() => import('./pages/FbAdImportPage'))
const Seedance = lazy(() => import('./pages/Seedance'))
const SeedanceLibrary = lazy(() => import('./pages/SeedanceLibrary'))

const routePrefetchers: Record<string, () => Promise<unknown>> = {
  '/': () => import('./pages/Home'),
  '/bench': () => import('./pages/Bench'),
  '/channels': () => import('./pages/Channels'),
  '/reels/new': () => import('./pages/ReelIntake'),
  '/phrases': () => import('./pages/Phrases'),
  '/my-products': () => import('./pages/MyProducts'),
  '/yt/channels': () => import('./pages/Youtubers'),
  '/fb/advertisers': () => import('./pages/FbAdvertisers'),
  '/fb/search/ads': () => import('./pages/FbSearchAds'),
}
const routeDataPrefetchers: Record<string, () => Promise<unknown>> = {
  '/': () => api.bench({ page: 1, limit: 40, sort: 'recent' }),
  '/bench': () => api.bench({ page: 1, limit: 50, sort: 'plays' }),
  '/channels': () => api.channels(),
  '/phrases': () => api.phrases('hook_intro', { page: 1, limit: 30, sort: 'plays' }),
  '/my-products': () => api.listMyProducts(),
}
const prefetchedRoutes = new Set<string>()
const prefetchedRouteData = new Set<string>()

function prefetchRoute(path: string) {
  const prefetcher = routePrefetchers[path]
  if (!prefetcher || prefetchedRoutes.has(path)) return
  prefetchedRoutes.add(path)
  prefetcher().catch(() => {})
}

function prefetchRouteData(path: string) {
  const prefetcher = routeDataPrefetchers[path]
  if (!prefetcher || prefetchedRouteData.has(path)) return
  prefetchedRouteData.add(path)
  prefetcher().catch(() => {})
}

function prefetchRouteWork(path: string) {
  prefetchRoute(path)
  prefetchRouteData(path)
}

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

type Platform = 'ig' | 'yt' | 'fb'

const PLATFORM_KEY = 'selected_platform'
const PLATFORMS: { key: Platform; label: string }[] = [
  { key: 'ig', label: '인스타' },
  { key: 'yt', label: '유튜브' },
  { key: 'fb', label: '페북 라이브러리' },
]

const NAV_BY_PLATFORM: Record<Platform, { to: string; label: string; icon: string }[]> = {
  ig: [
    { to: '/', label: '홈', icon: '&#x2302;' },
    { to: '/bench', label: '벤치마크', icon: '&#x25A6;' },
    { to: '/channels', label: '채널', icon: '&#x2631;' },
    { to: '/reels/new', label: '릴스 추가', icon: '&#x2795;' },
    { to: '/phrases', label: '문구별 보기', icon: '&#x201C;' },
  ],
  yt: [
    { to: '/', label: '홈', icon: '&#x2302;' },
    { to: '/yt/bench', label: '벤치마크', icon: '&#x25A6;' },
    { to: '/yt/channels', label: '채널', icon: '&#x2631;' },
    { to: '/yt/shorts/new', label: '숏폼 추가', icon: '&#x2795;' },
    { to: '/yt/phrases', label: '문구별 보기', icon: '&#x201C;' },
  ],
  fb: [
    { to: '/', label: '홈', icon: '&#x2302;' },
    { to: '/fb/advertisers', label: '광고주', icon: '&#x2631;' },
    { to: '/fb/search/ads', label: '광고 검색', icon: '&#x1F50D;' },
    { to: '/fb/import', label: '광고 import', icon: '&#x2795;' },
  ],
}

function loadPlatform(): Platform {
  try {
    const v = localStorage.getItem(PLATFORM_KEY)
    if (v === 'ig' || v === 'yt' || v === 'fb') return v
  } catch {}
  return 'ig'
}
function savePlatform(p: Platform) {
  try { localStorage.setItem(PLATFORM_KEY, p) } catch {}
}

export default function App() {
  const [session, setSession] = useState<any>(null)
  const [me, setMe] = useState<UserProfile | null>(loadCachedMe)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [meLoading, setMeLoading] = useState(false)
  const [platform, setPlatform] = useState<Platform>(loadPlatform)
  const onPlatformChange = (p: Platform) => {
    setPlatform(p)
    savePlatform(p)
  }

  useEffect(() => {
    if (bootstrapping || !session) return
    const timer = window.setTimeout(() => {
      NAV_BY_PLATFORM[platform].slice(0, 4).forEach(n => prefetchRoute(n.to))
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [bootstrapping, session, platform])

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
        <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 4, borderBottom: '1px solid var(--border-subtle)' }}>
          {PLATFORMS.map(p => (
            <button
              key={p.key}
              type="button"
              onClick={() => onPlatformChange(p.key)}
              style={{
                padding: '8px 10px', textAlign: 'left',
                fontSize: 13, fontWeight: platform === p.key ? 700 : 500,
                background: platform === p.key ? 'var(--accent)' : 'transparent',
                color: platform === p.key ? '#fff' : 'var(--text-secondary)',
                border: '1px solid',
                borderColor: platform === p.key ? 'var(--accent)' : 'var(--border-subtle)',
                borderRadius: 6, cursor: 'pointer',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <nav className="sb-nav">
          {NAV_BY_PLATFORM[platform].map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              onMouseEnter={() => prefetchRouteWork(n.to)}
              onFocus={() => prefetchRouteWork(n.to)}
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
          <Route path="/" element={<Home platform={platform} />} />
          <Route path="/reels/new" element={<ReelIntake />} />
          <Route path="/bench" element={<Bench />} />
          <Route path="/bench/:shortcode" element={<BenchDetail />} />
          <Route path="/phrases" element={<Phrases />} />
          <Route path="/ads" element={<Ads />} />
          <Route path="/analysis" element={<AnalysisPage />} />
          <Route path="/channels" element={<Channels />} />
          <Route path="/yt/channels" element={<Youtubers />} />
          <Route path="/yt/bench" element={<YtBench />} />
          <Route path="/yt/bench/:shortcode" element={<YtBenchDetail />} />
          <Route path="/yt/shorts/new" element={<YtShortsIntake />} />
          <Route path="/yt/phrases" element={<YtStub title="문구별 보기 (유튜브)" />} />
          <Route path="/fb/advertisers" element={<FbAdvertisers />} />
          <Route path="/fb/search/advertisers" element={<FbSearchAdvertisers />} />
          <Route path="/fb/search/ads" element={<FbSearchAds />} />
          <Route path="/fb/import" element={<FbAdImportPage />} />
          <Route path="/script" element={<ScriptGen />} />
          <Route path="/script/new/:shortcode" element={<ScriptGenWizard />} />
          <Route path="/script/new/yt/:shortcode" element={<ScriptGenWizard />} />
          <Route path="/tts" element={<TtsGen />} />
          <Route path="/my-products" element={<MyProducts />} />
          <Route path="/my-products/new" element={<MyProductEdit />} />
          <Route path="/my-products/:id/edit" element={<MyProductEdit />} />
          <Route path="/my-products/:id/scripts" element={<MyProductScripts />} />
          <Route path="/my-scripts" element={<MyScripts />} />
          <Route path="/my-scripts/:pid/:sid" element={<MyScriptDetail />} />
          <Route path="/seedance" element={<Seedance />} />
          <Route path="/seedance/library" element={<SeedanceLibrary />} />
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

function YtStub({ title }: { title: string }) {
  return (
    <>
      <div className="page-header">
        <h1>{title}</h1>
        <p>준비 중 — 유튜브 숏폼 분석은 인스타 구조를 따라 곧 추가됩니다.</p>
      </div>
      <div className="section-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
        아직 데이터가 없습니다.
      </div>
    </>
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
      <button
        onClick={() => navigate('/my-scripts')}
        style={{ ...btnSt, marginBottom: 6 }}
      >🎬 대본</button>
      <button
        onMouseEnter={() => prefetchRouteWork('/my-products')}
        onFocus={() => prefetchRouteWork('/my-products')}
        onClick={() => navigate('/my-products')}
        style={{ ...btnSt, marginBottom: 6 }}
      >내 상품</button>
      <button onClick={() => navigate('/seedance')} style={{ ...btnSt, marginBottom: 6 }}>🎞 영상 생성</button>
      <button onClick={() => navigate('/seedance/library')} style={{ ...btnSt, marginBottom: 6 }}>📁 영상 라이브러리</button>
      <button onClick={logout} style={btnSt}>로그아웃</button>
      {me?.role === 'admin' && (
        <button onClick={() => navigate('/settings')} style={{ ...btnSt, marginTop: 6 }}>설정</button>
      )}
    </div>
  )
}
