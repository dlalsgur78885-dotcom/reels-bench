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
