/**
 * Auth state slice — Supabase email/password.
 *
 * Internal users sign in with a userId (e.g. "minhyuk") which we
 * fold into a synthetic email `<userId>@reels-bench.local` to match
 * the web app's pattern. The `profiles` row is auto-created by a
 * Supabase trigger on `auth.users` insert (see api/server.py:2957),
 * so this store only READS profiles, never writes.
 */
import { create } from 'zustand'
import { supabase } from '../lib/supabase'

const ID_DOMAIN = 'reels-bench.local'
const ID_RE = /^[a-z0-9_.\-@]+$/

export function idToEmail(id: string): string {
  const v = id.trim().toLowerCase()
  return v.includes('@') ? v : `${v}@${ID_DOMAIN}`
}

export function emailToUserIdLabel(email: string): string {
  // For display purposes only. Strip the synthetic ID_DOMAIN suffix; otherwise
  // show the raw local-part.
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

export interface AuthUser {
  id: string
  email: string
  userIdLabel: string
}

export interface AuthProfile {
  role: 'admin' | 'user' | 'employee' | null
  displayName?: string
  active?: boolean
}

export interface AuthStore {
  user: AuthUser | null
  profile: AuthProfile | null
  loading: boolean
  initialized: boolean

  signIn(userId: string, password: string): Promise<void>
  signUp(userId: string, password: string): Promise<{ needsSignIn: boolean }>
  signOut(): Promise<void>
  fetchProfile(): Promise<AuthProfile | null>
  /**
   * Hydrate the store once on app mount. Idempotent — subsequent calls
   * are no-ops. Subscribes to `onAuthStateChange` so subsequent sign-in
   * /sign-out flows update the store automatically.
   */
  hydrate(): Promise<void>
}

let hydrateStarted = false

function userFromSupabase(u: { id: string; email?: string | null } | null | undefined): AuthUser | null {
  if (!u || !u.email) return null
  return { id: u.id, email: u.email, userIdLabel: emailToUserIdLabel(u.email) }
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  profile: null,
  loading: true,
  initialized: false,

  async signIn(userId, password) {
    const email = idToEmail(userId)
    if (!ID_RE.test(email)) {
      throw new Error('아이디는 영문/숫자/_/-/. 만 사용 가능합니다')
    }
    set({ loading: true })
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
      // Auth-state listener (installed in hydrate) will populate user/profile.
      // Force a profile fetch so callers can rely on profile being present
      // immediately after signIn resolves.
      await get().fetchProfile()
    } finally {
      set({ loading: false })
    }
  },

  async signUp(userId, password) {
    const email = idToEmail(userId)
    if (!ID_RE.test(email)) {
      throw new Error('아이디는 영문/숫자/_/-/. 만 사용 가능합니다')
    }
    set({ loading: true })
    try {
      const { data, error } = await supabase.auth.signUp({ email, password })
      if (error) throw error
      // If email confirmation is required, data.session may be null.
      if (data.user && !data.session) {
        return { needsSignIn: true }
      }
      await get().fetchProfile()
      return { needsSignIn: false }
    } finally {
      set({ loading: false })
    }
  },

  async signOut() {
    set({ loading: true })
    try {
      await supabase.auth.signOut()
      // Listener will null out user; explicit clear for snappy UI.
      set({ user: null, profile: null })
    } finally {
      set({ loading: false })
    }
  },

  async fetchProfile() {
    const user = get().user
    if (!user) {
      set({ profile: null })
      return null
    }
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('role, display_name, active')
        .eq('id', user.id)
        .single()
      if (error) {
        // Trigger may still be running for fresh signups; don't throw —
        // log and treat as "no profile yet".
        if (typeof console !== 'undefined') {
          console.warn('[auth] fetchProfile failed', error.message)
        }
        set({ profile: null })
        return null
      }
      const profile: AuthProfile = {
        role: (data?.role as AuthProfile['role']) ?? null,
        displayName: data?.display_name ?? undefined,
        active: data?.active ?? undefined
      }
      set({ profile })
      return profile
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[auth] fetchProfile threw', err)
      set({ profile: null })
      return null
    }
  },

  async hydrate() {
    if (hydrateStarted) return
    hydrateStarted = true
    try {
      const { data } = await supabase.auth.getSession()
      const user = userFromSupabase(data.session?.user)
      set({ user, initialized: true, loading: false })
      if (user) {
        // Best-effort: fetch the profile but don't block hydration.
        void get().fetchProfile()
      }
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[auth] hydrate failed', err)
      set({ initialized: true, loading: false })
    }

    // Subscribe — keep store in sync with Supabase events.
    supabase.auth.onAuthStateChange((event, session) => {
      const user = userFromSupabase(session?.user)
      set({ user })
      if (event === 'SIGNED_OUT') {
        set({ profile: null })
      } else if (user) {
        void get().fetchProfile()
      }
    })
  }
}))
