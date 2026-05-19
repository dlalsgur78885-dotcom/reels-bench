import { getAccessToken, forceRefreshToken } from './supabase'

export const BASE = import.meta.env.VITE_API_BASE || ''
// TTS 전용 (Render 별도 배포). 프로덕션 기본값 하드코딩 — Vite env 로드 누락 대비.
const TTS_DEFAULT = import.meta.env.PROD ? 'https://tts-worker-m2zr.onrender.com' : BASE
export const TTS_BASE = import.meta.env.VITE_TTS_API_BASE || TTS_DEFAULT
// Mockup/Figma render 워커 — Playwright + ffmpeg 무거운 작업. Render 별도 인스턴스.
const MOCKUP_DEFAULT = import.meta.env.PROD ? 'https://mockup-worker.onrender.com' : BASE
export const MOCKUP_BASE = import.meta.env.VITE_MOCKUP_API_BASE || MOCKUP_DEFAULT

async function authedHeaders(extra?: HeadersInit, token?: string | null): Promise<HeadersInit> {
  const tk = token ?? await getAccessToken()
  const h: Record<string, string> = { ...(extra as Record<string, string> || {}) }
  if (tk) h['Authorization'] = `Bearer ${tk}`
  return h
}

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await authedHeaders(init.headers)
  const r = await fetch(`${BASE}${path}`, { ...init, headers })
  // 401 → 토큰 만료 의심 → 강제 refresh 후 한 번 재시도.
  // 단 미들웨어가 API key 부재로 401 친 경우 refresh 해봐야 소용없음 → 그대로 반환.
  if (r.status === 401) {
    const body = await r.clone().text().catch(() => '')
    if (/api[_\s-]?key/i.test(body)) return r  // refresh 무의미 → 폭주 방지
    const fresh = await forceRefreshToken()
    if (fresh) {
      const headers2 = await authedHeaders(init.headers, fresh)
      return fetch(`${BASE}${path}`, { ...init, headers: headers2 })
    }
  }
  return r
}

export async function ttsAuthedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await authedHeaders(init.headers)
  return fetch(`${TTS_BASE}${path}`, { ...init, headers })
}

export async function mockupAuthedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await authedHeaders(init.headers)
  return fetch(`${MOCKUP_BASE}${path}`, { ...init, headers })
}

async function get<T>(path: string): Promise<T> {
  const r = await authedFetch(path)
  if (!r.ok) throw new Error(`API ${r.status}`)
  return r.json()
}

const CLIENT_CACHE_PREFIX = 'rb_api_cache:'
const inflightGets = new Map<string, Promise<unknown>>()

function readClientCache<T>(path: string, ttlMs: number): T | null {
  try {
    const raw = sessionStorage.getItem(CLIENT_CACHE_PREFIX + path)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || Date.now() - parsed.t > ttlMs) return null
    return parsed.data as T
  } catch { return null }
}

function writeClientCache(path: string, data: unknown) {
  try {
    sessionStorage.setItem(CLIENT_CACHE_PREFIX + path, JSON.stringify({ t: Date.now(), data }))
  } catch {}
}

async function cachedGet<T>(path: string, ttlMs = 30_000): Promise<T> {
  const cached = readClientCache<T>(path, ttlMs)
  if (cached !== null) return cached
  const existing = inflightGets.get(path) as Promise<T> | undefined
  if (existing) return existing
  const promise = get<T>(path)
    .then(data => {
      writeClientCache(path, data)
      return data
    })
    .finally(() => inflightGets.delete(path))
  inflightGets.set(path, promise)
  return promise
}

function clearClientCache(prefix: string) {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i)
      if (key?.startsWith(CLIENT_CACHE_PREFIX + prefix)) sessionStorage.removeItem(key)
    }
  } catch {}
}

async function _errMsg(r: Response, status: number): Promise<string> {
  try {
    const data = await r.json()
    const detail = data?.detail || data?.error || data?.message
    if (detail) return `API ${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  } catch {}
  try {
    const text = await r.text()
    if (text) return `API ${status}: ${text.slice(0, 300)}`
  } catch {}
  return `API ${status}`
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await authedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await _errMsg(r, r.status))
  return r.json()
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const r = await authedFetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await _errMsg(r, r.status))
  return r.json()
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await authedFetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await _errMsg(r, r.status))
  return r.json()
}

async function del<T>(path: string): Promise<T> {
  const r = await authedFetch(path, { method: 'DELETE' })
  if (!r.ok) {
    const data = await r.json().catch(() => ({}))
    throw new Error(data.detail || data.error || `API ${r.status}`)
  }
  return r.json()
}

export interface Reel {
  shortcode: string
  url: string
  author: string
  account_category?: string
  collected_at: string
}

export interface Metadata {
  shortcode: string
  play_count: number
  like_count: number
  comment_count: number
  video_duration: number
  thumbnail_url: string
  video_url: string
  caption_text: string
  author_username: string
  author_full_name?: string
  music_artist?: string
  music_title?: string
  taken_at?: string
}

export interface Transcript {
  shortcode: string
  transcript: string
  duration_seconds: number
  language: string
}

export interface Analysis {
  shortcode: string
  analysis: string
  analyzed_at: string
}

export interface DetailData {
  metadata: Metadata | null
  transcript: Transcript | null
  analysis: Analysis | null
  comments: { comment_text: string; comment_author: string; comment_likes: number }[]
  extra: ExtraData | null
  frame_images: Record<number, string>
}

export interface DashboardData {
  reels: Reel[]
  metadata: Metadata[]
  transcripts: Transcript[]
  analyses: Analysis[]
  stats: {
    total_reels: number
    total_plays: number
    total_likes: number
    analyzed_count: number
  }
}

export interface AnalysisStatus {
  status: 'idle' | 'running' | 'done' | 'error'
  step?: string
  progress?: number
  message?: string
  frame_images?: Record<number, string>
}

export interface ExtraData {
  ocr_subtitles: Record<number, string>
  audio_emotions: Record<number, {
    pitch: number
    volume: number
    silence: boolean
    emotion: string
    label: string
    confidence: number
  }>
  script_structure: {
    hook?: { text: string; type?: string; seconds?: string; analysis?: string }
    intro?: { text: string; seconds?: string; analysis?: string }
    body?: { text: string; seconds?: string; key_points?: string[]; analysis?: string }
    cta?: { text: string; type?: string; seconds?: string; analysis?: string }
    overall?: { flow?: string; strength?: string; weakness?: string }
  } | null
  bgm_changes?: { sec: number; score: number }[]
  pro_audio?: {
    duration_sec?: number
    sound_effects?: { time: string; type: string; description: string }[]
    bgm_segments?: {
      start: string
      end: string
      state: 'playing' | 'muted' | 'transition'
      mood?: string
      genre?: string
      tempo_bpm?: number
      volume_level?: 'high' | 'medium' | 'low' | 'muted'
      identified?: string
      change_reason?: string
    }[]
    emotion_timeline?: {
      start: string
      end: string
      emotion: string
      intensity: number
      source: 'speech' | 'music' | 'both'
      reason?: string
    }[]
    narration?: { language?: string; tone?: string; pace?: string }
    audio_summary?: string
  }
  script_by_sec: Record<number, string>
  sentences: { start: number; end: number; text: string }[]
  category: {
    content_type?: string
    content_type_detail?: string
    industry?: string
    industry_detail?: string
    topic?: string
    topic_detail?: string
    style?: string
    tags: string[]
  } | null
  comment_triggers: {
    triggers: {
      element: string
      source: string
      timestamp: string | null
      reaction_type: string
      sample_comments: string[]
      comment_count: number
      analysis: string
    }[]
    summary: {
      dominant_reaction: string
      engagement_driver: string
      content_strength: string
      improvement: string
    }
  } | null
}

export interface BenchItem {
  shortcode: string
  author: string
  play_count: number
  like_count: number
  comment_count: number
  thumbnail_url: string
  collected_at: string
  analyzed: boolean
  ad_suitability?: string | null
  usp_count?: number | null
  body_structure?: string | null
  hook_type?: string | null
  cta_type?: string | null
}

export interface BenchPage {
  items: BenchItem[]
  stats: { total_reels: number; total_plays: number; total_likes: number; analyzed_count: number }
  total: number
  page: number
  has_more: boolean
}

/** Build thumb URL — Supabase Storage 직접. 404 시 onError로 backend fallback. */
const SUPABASE_URL = 'https://mrpbovbxtablvawszhey.supabase.co'
export function thumbUrl(shortcode: string): string {
  if (!shortcode) return ''
  return `${SUPABASE_URL}/storage/v1/object/public/thumbs/${shortcode}.webp`
}
export function thumbFallbackUrl(shortcode: string): string {
  if (!shortcode) return ''
  return `${BASE}/api/thumb/${shortcode}`
}

export interface PhraseHookIntroItem {
  shortcode: string
  author: string
  play_count: number
  like_count: number
  thumbnail_url: string
  hook_text: string
  hook_type: string
  hook_seconds: string
  intro_text: string
  intro_seconds: string
}

export interface PhraseCtaItem {
  shortcode: string
  author: string
  play_count: number
  like_count: number
  thumbnail_url: string
  cta_text: string
  cta_type: string
  cta_seconds: string
}

export type PhrasesItem = PhraseHookIntroItem | PhraseCtaItem

export interface PhrasesPage {
  items: PhrasesItem[]
  total: number
  page: number
  has_more: boolean
}

export interface AdItem {
  shortcode: string
  url: string
  page_name: string
  caption: string
  video_url: string
  video_duration: number
  thumbnail_url: string
  collected_at: string
  start_date: string
  media_type: 'video' | 'image' | string
  platforms: string[]
}

export interface AdsPage {
  items: AdItem[]
  total: number
  page: number
  has_more: boolean
}

export interface AdsFilters {
  page?: number
  limit?: number
  q?: string
  date_from?: string
  date_to?: string
  sort?: 'recent' | 'oldest'
}

export interface BenchFilters {
  page?: number
  limit?: number
  sort?: string
  q?: string
  plays_min?: number
  plays_max?: number
  er_min?: number
  er_max?: number
  date_from?: string
  date_to?: string
  ad_suitability?: string
  usp_count?: string
  body_structure?: string
  hook_type?: string
  cta_type?: string
}

export const api = {
  bench: (p: BenchFilters = {}) => {
    const params = new URLSearchParams()
    params.set('page', String(p.page ?? 1))
    params.set('limit', String(p.limit ?? 30))
    params.set('sort', p.sort ?? 'plays')
    if (p.q) params.set('q', p.q)
    if (p.plays_min) params.set('plays_min', String(p.plays_min))
    if (p.plays_max) params.set('plays_max', String(p.plays_max))
    if (p.er_min) params.set('er_min', String(p.er_min))
    if (p.er_max) params.set('er_max', String(p.er_max))
    if (p.date_from) params.set('date_from', p.date_from)
    if (p.date_to) params.set('date_to', p.date_to)
    if (p.ad_suitability) params.set('ad_suitability', p.ad_suitability)
    if (p.usp_count) params.set('usp_count', p.usp_count)
    if (p.body_structure) params.set('body_structure', p.body_structure)
    if (p.hook_type) params.set('hook_type', p.hook_type)
    if (p.cta_type) params.set('cta_type', p.cta_type)
    return cachedGet<BenchPage>(`/api/bench?${params}`, 30_000)
  },
  ads: (p: AdsFilters = {}) => {
    const params = new URLSearchParams()
    params.set('page', String(p.page ?? 1))
    params.set('limit', String(p.limit ?? 30))
    params.set('sort', p.sort ?? 'recent')
    if (p.q) params.set('q', p.q)
    if (p.date_from) params.set('date_from', p.date_from)
    if (p.date_to) params.set('date_to', p.date_to)
    return get<AdsPage>(`/api/ads?${params}`)
  },
  phrases: (part: 'hook_intro' | 'cta', p: BenchFilters = {}) => {
    const params = new URLSearchParams()
    params.set('part', part)
    params.set('page', String(p.page ?? 1))
    params.set('limit', String(p.limit ?? 30))
    params.set('sort', p.sort ?? 'plays')
    if (p.q) params.set('q', p.q)
    if (p.plays_min) params.set('plays_min', String(p.plays_min))
    if (p.plays_max) params.set('plays_max', String(p.plays_max))
    if (p.er_min) params.set('er_min', String(p.er_min))
    if (p.er_max) params.set('er_max', String(p.er_max))
    if (p.date_from) params.set('date_from', p.date_from)
    if (p.date_to) params.set('date_to', p.date_to)
    if (p.ad_suitability) params.set('ad_suitability', p.ad_suitability)
    if (p.usp_count) params.set('usp_count', p.usp_count)
    if (p.body_structure) params.set('body_structure', p.body_structure)
    if (p.hook_type) params.set('hook_type', p.hook_type)
    if (p.cta_type) params.set('cta_type', p.cta_type)
    return cachedGet<PhrasesPage>(`/api/phrases?${params}`, 30_000)
  },
  dashboard: () => get<DashboardData>('/api/dashboard'),
  reels: () => get<Reel[]>('/api/reels'),
  addReel: (url: string, analyze = false) => post<ReelAddResult>('/api/reels', { url, analyze }),
  importFbAd: (url: string, analyze = true) =>
    post<{ shortcode: string; imported: boolean; ad_id?: string; page_name?: string; video_url?: string; message?: string }>(
      '/api/fb-ad/import', { url, analyze },
    ),
  metadata: (sc: string) => get<Metadata>(`/api/metadata/${sc}`),
  detail: (sc: string) => cachedGet<DetailData>(`/api/detail/${sc}`, 45_000),
  transcript: (sc: string) => get<Transcript>(`/api/transcripts/${sc}`),
  analysis: (sc: string) => get<Analysis>(`/api/analyses/${sc}`),
  comments: (sc: string) => cachedGet<{ comment_text: string; comment_author: string; comment_likes: number }[]>(`/api/comments/${sc}`, 45_000),
  startAnalysis: (sc: string) => post<{ message: string }>('/api/analyze', { shortcode: sc }),
  analysisStatus: (sc: string) => get<AnalysisStatus>(`/api/analysis-status/${sc}`),
  frameImages: (sc: string) => cachedGet<Record<number, string>>(`/api/frame-images/${sc}`, 120_000),
  extra: async (sc: string, opts?: { fresh?: boolean }) => {
    if (opts?.fresh) {
      // fresh fetch → 가져온 결과를 캐시에 덮어쓰기 (재분석 후 옛 캐시 반환 방지)
      const d = await get<ExtraData>(`/api/extra/${sc}?_t=${Date.now()}`)
      writeClientCache(`/api/extra/${sc}`, d)
      return d
    }
    return cachedGet<ExtraData>(`/api/extra/${sc}`, 45_000)
  },
  updateExtra: (sc: string, data: { script_structure?: any; category?: any; sentences?: any[] }) =>
    patch<any>(`/api/extra/${sc}`, { shortcode: sc, ...data }),
  fetchComments: (sc: string) => post<{ count: number; comments: any[] }>(`/api/comments/${sc}/fetch`, {}),
  channels: () => cachedGet<Channel[]>('/api/channels', 60_000),
  addChannel: (username: string) => post<{ message: string; username: string }>('/api/channels', { username })
    .then(r => { clearClientCache('/api/channels'); return r }),
  updateChannel: (username: string, data: { is_active?: boolean }) =>
    patch<any>(`/api/channels/${username}`, data).then(r => { clearClientCache('/api/channels'); return r }),
  deleteChannel: (username: string) => del<{ message?: string; error?: string }>(`/api/channels/${encodeURIComponent(username)}`)
    .then(r => { clearClientCache('/api/channels'); return r }),
  deleteChannelById: (id: number) => del<{ message?: string; error?: string; id?: number }>(`/api/channels/by-id/${id}`)
    .then(r => { clearClientCache('/api/channels'); return r }),
  userAnalysis: (username: string, limit = 24) =>
    cachedGet<UserAnalysis>(`/api/users/${encodeURIComponent(username)}/analysis?limit=${limit}`, 60_000),
  refineScript: (draft: any, usps: any[], reference_shortcode?: string, skipOpts?: { skip_chunk_sections?: string[]; skip_sentence_starts?: number[] }, variant: 'default' | 'strong' = 'default', target_persona?: any, productFence?: { name?: string; capability_out?: string | null }) =>
    post<any>('/api/script/refine', {
      draft, usps, reference_shortcode,
      skip_chunk_sections: skipOpts?.skip_chunk_sections,
      skip_sentence_starts: skipOpts?.skip_sentence_starts,
      variant,
      target_persona,
      product_name: productFence?.name,
      product_capability_out: productFence?.capability_out,
    }),
  extractPersonas: (usp: string, reviews: string[], pain_solved = '', product_id?: number, usp_index?: number) =>
    post<{ personas: PersonaCandidate[]; _cached?: boolean }>('/api/script/personas', { usp, reviews, pain_solved, product_id, usp_index }),
  extractUnifiedPersonas: (usps: Array<{ usp: string; description?: string; reviews?: string[] }>, product_name = '') =>
    post<{
      common_pain: string
      common_context: string
      common_audience: string
      shared_keywords: string[]
      personas: PersonaCandidate[]
    }>('/api/script/unified-personas', { usps, product_name }),
  updateUspPersonas: (pid: number, usp_index: number, personas: PersonaCandidate[]) =>
    patch<{ message: string; personas: PersonaCandidate[] }>(`/api/my-products/${pid}/usp-personas`, { usp_index, personas }),
  referenceInfo: (sc: string) =>
    get<ReferenceInfo>(`/api/script/reference-info/${sc}`),
  getRefSentences: (sc: string, source: 'reels' | 'youtube' = 'reels') =>
    get<{ shortcode: string; source: string; sentences: Array<{ start: number; end: number; text: string; section: string }> }>(`/api/script/ref-sentences/${sc}?source=${source}`),
  updateSectionChunks: (sc: string, chunks: any[], source: 'reels' | 'youtube' = 'reels') =>
    patch<{ shortcode: string; count: number }>(`/api/script/section-chunks/${sc}?source=${source}`, { chunks })
      .then(r => { clearClientCache(`/api/extra/${sc}`); return r }),
  updateHookArchetype: (sc: string, archetype: string, opts?: { pattern?: string; core_word?: string; source?: 'reels' | 'youtube' }) =>
    patch<{ shortcode: string; archetype: { archetype: string; pattern: string; core_word: string; reasoning: string } }>(
      `/api/script/hook-archetype/${sc}?source=${opts?.source || 'reels'}`,
      { archetype, pattern: opts?.pattern, core_word: opts?.core_word },
    ).then(r => { clearClientCache(`/api/extra/${sc}`); return r }),
  suggestUspDescription: (input: { product_name: string; usp_name: string; reviews?: string[] }) =>
    post<{ description: string; parts: { 문제: string; 해결: string; 혜택: string; 핵심_명사: string } }>(
      '/api/usp/suggest-description',
      input,
    ),
  generateUspReviews: (input: { product_name: string; usp_name: string; usp_description?: string; existing_reviews?: string[]; count?: number }) =>
    post<{ reviews: string[] }>('/api/usp/generate-reviews', input),
  // 생성된 대본 저장·관리
  saveGenScript: (pid: number, input: { ref_shortcode?: string; source_type?: 'insta' | 'youtube' | 'fb_ads'; persona_name?: string; title?: string; sentences: any[]; meta?: any; caption?: string; pinned_comment?: string }) =>
    post<{ id: string; product_id: number; title: string }>(`/api/my-products/${pid}/scripts`, input),
  updateGenScript: (pid: number, sid: string, input: { title?: string; caption?: string; pinned_comment?: string; sentences?: any[]; shooting_plan_url?: string; status?: 'pending' | 'done'; group_name?: string; stages?: any[] }) =>
    patch<{ updated: boolean; row: any }>(`/api/my-products/${pid}/scripts/${sid}`, input),
  refineSavedScript: (pid: number, sid: string, variant: 'default' | 'strong' = 'default') =>
    post<{ refined: boolean; key: 'alt_a' | 'alt_b'; row: any }>(`/api/my-products/${pid}/scripts/${sid}/refine`, { variant }),
  listScriptShares: (pid: number, sid: string) =>
    get<Array<{ id: string; shared_with_id: string; shared_by: string; permission: 'view' | 'edit'; created_at: string; shared_with_email?: string; shared_with_name?: string; shared_by_email?: string }>>(`/api/my-products/${pid}/scripts/${sid}/shares`),
  addScriptShare: (pid: number, sid: string, input: { shared_with_id: string; permission: 'view' | 'edit' }) =>
    post<{ id: string }>(`/api/my-products/${pid}/scripts/${sid}/shares`, input),
  listColleagues: () =>
    get<Array<{ id: string; display_name: string | null; email: string }>>('/api/users/colleagues'),
  adminScriptStats: (days = 30, metric: 'saved' | 'completed' = 'saved') =>
    get<{ date_range: string[]; users: Array<{ user_id: string; display_name?: string; email?: string; total: number; by_date: Record<string, number> }>; metric: 'saved' | 'completed' }>(`/api/admin/script-stats?days=${days}&metric=${metric}`),
  // USP 그룹핑
  listUspGroups: (pid: number) =>
    get<Array<{ id: string; product_id: number; name: string; color: string | null; order_idx: number; usp_indexes: number[]; capability_out?: string | null }>>(`/api/my-products/${pid}/usp-groups`),
  createUspGroup: (pid: number, input: { name: string; color?: string; order_idx?: number; capability_out?: string }) =>
    post<{ id: string; name: string; color: string | null; order_idx: number }>(`/api/my-products/${pid}/usp-groups`, input),
  updateUspGroup: (pid: number, gid: string, input: { name?: string; color?: string; order_idx?: number; capability_out?: string }) =>
    patch<{ updated: boolean }>(`/api/my-products/${pid}/usp-groups/${gid}`, input),
  deleteUspGroup: (pid: number, gid: string) =>
    del<{ deleted: boolean }>(`/api/my-products/${pid}/usp-groups/${gid}`),
  setUspGroupMembers: (pid: number, gid: string, usp_indexes: number[]) =>
    put<{ count: number }>(`/api/my-products/${pid}/usp-groups/${gid}/members`, { usp_indexes }),
  deleteScriptShare: (pid: number, sid: string, share_id: string) =>
    del<{ deleted: boolean }>(`/api/my-products/${pid}/scripts/${sid}/shares/${share_id}`),
  listGenScripts: (pid: number) =>
    get<Array<{ id: string; ref_shortcode: string | null; source_type: string; persona_name: string | null; title: string; meta: any; created_at: string; created_by: string }>>(`/api/my-products/${pid}/scripts`),
  getGenScript: (pid: number, sid: string) =>
    get<{ id: string; product_id: number; ref_shortcode: string | null; source_type: string; persona_name: string | null; title: string; sentences: any[]; meta: any; created_at: string }>(`/api/my-products/${pid}/scripts/${sid}`),
  deleteGenScript: (pid: number, sid: string) =>
    del<{ deleted: boolean }>(`/api/my-products/${pid}/scripts/${sid}`),
  listAllMyScripts: () =>
    get<{
      products: Array<{ id: number; name: string }>
      scripts: Array<{ id: string; product_id: number; ref_shortcode: string | null; source_type: string; persona_name: string | null; title: string; meta: any; created_at: string; created_by: string; _shared?: boolean; _permission?: 'view' | 'edit'; _creator_name?: string; _creator_email?: string }>
    }>('/api/my-scripts'),
  scriptProgress: (sessionId: string) =>
    get<{ session_id: string; found: boolean; step?: string; percent?: number; message?: string; started_at?: number; updated_at?: number }>(
      `/api/script/progress/${sessionId}`,
    ),
  analyzeSectionChunks: (sc: string, source: 'reels' | 'youtube' = 'reels') =>
    post<any>(`/api/script/analyze-section-chunks/${sc}?source=${source}`, {})
      .then(r => { clearClientCache(`/api/extra/${sc}`); return r }),
  previewMapping: (sc: string, product_id: number, source: 'reels' | 'youtube' = 'reels') =>
    post<{
      shortcode: string
      product: { id: number; name: string; usps: any[] }
      section_chunks: Array<{ section: string; topic: string; role: string; primary_usp_id: number | null; summary: string; sentences?: { start: number; end: number; text: string }[] }>
      chunk_mapping: Array<{
        chunk_section: string
        user_usp_ids: number[]
        user_usp_names: string[]
        user_usp_id: number | null   // primary (backward compat — user_usp_ids[0])
        user_usp_name: string | null
        chunk_role: string
        chunk_topic: string
        chunk_summary: string
        chunk_ref_usp_ids: number[]  // ref USPs (참고용)
        reason: string
        confidence?: 'strong' | 'loose' | 'none'
      }>
      unused_user_usps: Array<{ user_usp_id: number; user_usp_name: string }>
      unmatched_chunks: Array<{ chunk_section: string; reason: string }>
      ref_desires: Array<{
        name: string; pain: string; desire: string; scenario: string
        job_statement?: string; lf8?: number; lf8_label?: string
        pain_scene?: string; desire_scene?: string; identity?: string
      }>
      hook_archetype?: {
        archetype: string; pattern?: string; core_word?: string; reasoning?: string
        candidates?: Array<{ archetype: string; pattern?: string; core_word?: string; score: number }>
      } | null
    }>(`/api/script/preview-mapping/${sc}`, { product_id, source }),
  classifySentences: (sc: string) =>
    post<{ shortcode: string; total_sentences: number; sections: Record<string, number> }>(`/api/script/classify-sentences/${sc}`, {})
      .then(r => { clearClientCache(`/api/extra/${sc}`); return r }),
  // Admin Secrets
  listSecrets: () => get<{ id: string; name: string; description: string; updated_at: string }[]>('/api/admin/secrets'),
  upsertSecret: (name: string, value: string, description = '') =>
    post<{ id: string; name: string; message: string }>('/api/admin/secrets', { name, value, description }),
  deleteSecret: (name: string) =>
    del<{ deleted: boolean }>(`/api/admin/secrets/${encodeURIComponent(name)}`),
  // My Products
  listMyProducts: () => cachedGet<MyProduct[]>('/api/my-products', 30_000),
  createMyProduct: (data: { name: string; persona?: string; usps?: any[]; capability_out?: string | null }) =>
    post<MyProduct>('/api/my-products', data).then(r => { clearClientCache('/api/my-products'); return r }),
  updateMyProduct: (id: number, data: { name: string; persona?: string; usps?: any[]; capability_out?: string | null }) =>
    patch<MyProduct>(`/api/my-products/${id}`, data).then(r => { clearClientCache('/api/my-products'); return r }),
  deleteMyProduct: (id: number) => del<{ message: string }>(`/api/my-products/${id}`)
    .then(r => { clearClientCache('/api/my-products'); return r }),
  // My Products: 공유
  listProductShares: (pid: number) => get<ShareInfo[]>(`/api/my-products/${pid}/shares`),
  shareProduct: (pid: number, userIds: string[], permission: 'view' | 'edit') =>
    post<{ message: string; count: number }>(`/api/my-products/${pid}/shares`, {
      user_ids: userIds, permission,
    }),
  unshareProduct: (pid: number, userId: string) =>
    del<{ message: string }>(`/api/my-products/${pid}/shares/${userId}`),
  shareableUsers: () => get<ShareableUser[]>('/api/users/shareable'),
  // Auth
  me: () => get<UserProfile>('/api/me'),
  listUsers: () => get<UserProfile[]>('/api/users'),
  inviteUser: (email: string, displayName?: string, role: 'admin' | 'employee' = 'employee', password?: string) =>
    post<{ message: string; profile: UserProfile; temp_password: string }>('/api/users', {
      email, display_name: displayName, role, password,
    }),
  updateUser: (id: string, data: { role?: 'admin' | 'employee'; active?: boolean; display_name?: string; can_delete_reels?: boolean }) =>
    patch<UserProfile>(`/api/users/${id}`, data),
  deleteUser: (id: string) => del<{ message: string }>(`/api/users/${id}`),
  deleteReel: (shortcode: string) => del<{ message: string }>(`/api/reels/${shortcode}`),
  bulkDeleteReels: (shortcodes: string[]) =>
    post<{ deleted: string[]; failed: string[]; deleted_count: number; failed_count: number }>(
      '/api/reels/bulk-delete', { shortcodes },
    ),
}

export interface ReferenceInfo {
  shortcode: string
  duration_sec: number
  total_sentences: number
  body_slot_count: number
  body_class: { type: string; guide: string }
  recommended_usps: number
}

export interface PersonaCandidate {
  name: string
  scenario: string
  pain?: string
  desire?: string
  // JTBD + LF8 + Visual Scenes (Schwartz/Whitman 프레임워크)
  job_statement?: string
  lf8?: number  // 1~8 (Drew Whitman Life Force 8)
  lf8_label?: string
  pain_scene?: string
  desire_scene?: string
  identity?: string
  signals: string[]
  destinations?: string[]
  review_count: number
  sample_reviews: string[]
  tone_hint: string
  // ▼ TTS 메타필드 (글쓰기에는 절대 미사용 — 백엔드/프론트 writer code에서 접근 금지)
  gender?: 'male' | 'female' | 'unknown'
  voice?: string  // yuna | han_aim | jennie | male | joonpark
}

export interface MyProduct {
  id: number
  owner_id: string
  name: string
  persona: string | null
  usps: { usp: string; reviews: string[] }[]
  capability_out?: string | null   // 상품 전체 fence — "절대 안 하는 기능" (writer 환각 차단)
  created_at: string
  updated_at: string
  is_shared?: boolean
  permission?: 'owner' | 'view' | 'edit'
  owner_name?: string
}

export interface ShareInfo {
  shared_with_id: string
  permission: 'view' | 'edit'
  display_name: string
  email: string | null
  created_at: string
}

export interface ShareableUser {
  id: string
  email: string
  display_name: string | null
}

export interface UserProfile {
  id: string
  email: string
  display_name: string | null
  role: 'admin' | 'employee'
  active: boolean
  can_delete_reels: boolean
  created_at: string
  last_login_at: string | null
}

export interface Channel {
  id: number
  username: string
  is_active: boolean
  reel_count: number
  last_collected_at: string | null
  created_at: string
}

export interface UserAnalysisItem extends BenchItem {
  url: string
  taken_at?: string | null
  analysis_excerpt: string
  analyzed_at?: string | null
  topic?: string | null
  style?: string | null
  tags: string[]
}

export interface UserAnalysis {
  username: string
  stats: {
    total_reels: number
    analyzed_count: number
    total_plays: number
    total_likes: number
    avg_er: number
    best_shortcode: string | null
  }
  items: UserAnalysisItem[]
  insights: {
    top_reel: UserAnalysisItem | null
    top_tags: { tag: string; count: number }[]
    latest_analyzed_at: string | null
    summary: string
  }
}

export interface ReelAddResult {
  message: string
  shortcode: string
  url: string
  author: string
  has_metadata: boolean
  analysis_started: boolean
}
