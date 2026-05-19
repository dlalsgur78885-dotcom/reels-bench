/**
 * Supabase client for the Electron renderer.
 *
 * Direct port of `web/src/supabase.ts` — email/password auth with
 * default localStorage adapter (works in sandboxed renderer). No
 * deeplink / OAuth — internal users use synthetic emails
 * `<userId>@reels-bench.local`.
 *
 * Hard-codes the project URL + anon key (publishable; safe in client)
 * to match the web app's pattern. If we later need env override we
 * can switch to `import.meta.env.VITE_SUPABASE_*`.
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://mrpbovbxtablvawszhey.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_BevcIvJOcRgb5hOm1YKEog_pv_DYKyF'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Electron renderer has no URL fragment-based auth callback — set false.
    detectSessionInUrl: false
  }
})

// ── Access-token cache (mirrors web app) ───────────────────────────────────
let cachedAccessToken: string | null = null
let cachedAccessTokenUntil = 0

supabase.auth.onAuthStateChange((_event, session) => {
  cachedAccessToken = session?.access_token ?? null
  cachedAccessTokenUntil = cachedAccessToken ? Date.now() + 30_000 : 0
})

export async function getAccessToken(): Promise<string | null> {
  if (cachedAccessToken && Date.now() < cachedAccessTokenUntil) {
    return cachedAccessToken
  }
  const { data } = await supabase.auth.getSession()
  cachedAccessToken = data.session?.access_token ?? null
  cachedAccessTokenUntil = cachedAccessToken ? Date.now() + 30_000 : 0
  return cachedAccessToken
}

// ── Force-refresh: single-flight + cooldown (avoids 401 storm) ─────────────
let _refreshInflight: Promise<string | null> | null = null
let _lastRefreshFailAt = 0
const _REFRESH_FAIL_COOLDOWN_MS = 5_000

export async function forceRefreshToken(): Promise<string | null> {
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
      setTimeout(() => {
        _refreshInflight = null
      }, 0)
    }
  })()
  return _refreshInflight
}

// Visibility-based refresh (60s throttle) — same idea as web but applies to
// Electron renderer's BrowserWindow visibility change.
let lastRefreshAt = 0
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastRefreshAt < 60_000) return
    lastRefreshAt = Date.now()
    cachedAccessTokenUntil = 0
    supabase.auth.refreshSession().catch(() => {
      /* ignore — background refresh */
    })
  })
}

export const SUPABASE_URL_PUBLIC = SUPABASE_URL
