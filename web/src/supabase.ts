import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://mrpbovbxtablvawszhey.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_BevcIvJOcRgb5hOm1YKEog_pv_DYKyF'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})

let cachedAccessToken: string | null = null
let cachedAccessTokenUntil = 0

supabase.auth.onAuthStateChange((_event, session) => {
  cachedAccessToken = session?.access_token ?? null
  cachedAccessTokenUntil = cachedAccessToken ? Date.now() + 30_000 : 0
})

export async function getAccessToken(): Promise<string | null> {
  if (cachedAccessToken && Date.now() < cachedAccessTokenUntil) return cachedAccessToken
  const { data } = await supabase.auth.getSession()
  cachedAccessToken = data.session?.access_token ?? null
  cachedAccessTokenUntil = cachedAccessToken ? Date.now() + 30_000 : 0
  return cachedAccessToken
}

// 401 받으면 강제로 refreshSession 호출해서 새 토큰 받기.
// 동시 다발 401 이 refresh-token rotation 을 망가뜨리지 않도록 single-flight.
let _refreshInflight: Promise<string | null> | null = null
let _lastRefreshFailAt = 0
const _REFRESH_FAIL_COOLDOWN_MS = 5_000

export async function forceRefreshToken(): Promise<string | null> {
  // 최근에 refresh 실패했으면 잠시 쿨다운 — 401 폭주 시 무한 재시도 방지
  if (Date.now() - _lastRefreshFailAt < _REFRESH_FAIL_COOLDOWN_MS) return null
  if (_refreshInflight) return _refreshInflight
  _refreshInflight = (async () => {
    try {
      const { data, error } = await supabase.auth.refreshSession()
      if (error || !data.session) {
        _lastRefreshFailAt = Date.now()
        return null
      }
      cachedAccessToken = data.session.access_token
      cachedAccessTokenUntil = Date.now() + 30_000
      return cachedAccessToken
    } catch {
      _lastRefreshFailAt = Date.now()
      return null
    } finally {
      // 다음 tick 에 해제 — 같은 micro-task 안의 동시 호출은 모두 같은 promise 받음
      setTimeout(() => { _refreshInflight = null }, 0)
    }
  })()
  return _refreshInflight
}

// 탭 활성화 시 토큰 강제 갱신 — 단, 60초 throttle (잦은 refreshSession 호출이 세션 무효화 원인이 될 수 있음)
let lastRefreshAt = 0
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastRefreshAt < 60_000) return
    lastRefreshAt = Date.now()
    cachedAccessTokenUntil = 0
    supabase.auth.refreshSession().catch(() => {})
  })
}
