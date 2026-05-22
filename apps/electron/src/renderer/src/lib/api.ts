/**
 * Vercel API client — mirrors web/src/api.ts pattern.
 *
 * Phase 3 ships a MINIMAL surface — only the calls Phase 3.3 (prefill UI)
 * actually needs. We adapt to the real backend endpoints discovered in
 * `api/server.py`:
 *
 *   - listMyReels → GET /api/reels  (returns user-visible reels — auth is
 *     bypassed for this endpoint server-side; profile-gated in the web
 *     app at the router level).
 *   - getReelAnalysis → GET /api/extra/<sc>  (Whisper sentences + pro_audio
 *     {bgm/effects/emotion} + script_structure — all the prefill data).
 *   - getReelMetadata → GET /api/metadata/<sc>  (video_url, thumbnail, etc.)
 *
 * Auth: same Bearer pattern as web. 401 → forceRefreshToken → retry once.
 */
import { getAccessToken, forceRefreshToken } from './supabase'

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ||
  'https://reels-bench.vercel.app'

async function authedHeaders(
  extra?: HeadersInit,
  token?: string | null
): Promise<HeadersInit> {
  const tk = token ?? (await getAccessToken())
  const h: Record<string, string> = { ...((extra as Record<string, string>) || {}) }
  if (tk) h['Authorization'] = `Bearer ${tk}`
  return h
}

export async function authedFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = await authedHeaders(init.headers)
  const r = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (r.status === 401) {
    // Detect "API key missing" responses — refresh is useless then.
    const body = await r.clone().text().catch(() => '')
    if (/api[_\s-]?key/i.test(body)) return r
    const fresh = await forceRefreshToken()
    if (fresh) {
      const headers2 = await authedHeaders(init.headers, fresh)
      return fetch(`${API_BASE}${path}`, { ...init, headers: headers2 })
    }
  }
  return r
}

async function get<T>(path: string): Promise<T> {
  const r = await authedFetch(path)
  if (!r.ok) throw new Error(`API ${r.status}`)
  return r.json() as Promise<T>
}

// ── Public shapes (minimal — see web/src/api.ts for full canonical) ───────
export interface ReelSummary {
  shortcode: string
  url: string
  account_category?: string | null
  collected_at: string
}

export interface ReelMetadata {
  shortcode: string
  play_count?: number
  like_count?: number
  comment_count?: number
  video_duration?: number
  thumbnail_url?: string
  video_url?: string
  caption_text?: string
  author_username?: string
  author_full_name?: string
  music_artist?: string
  music_title?: string
  taken_at?: string
}

export interface WhisperSentence {
  start: number
  end: number
  text: string
}

export interface ProAudioBgmSegment {
  start: string
  end: string
  state: 'playing' | 'muted' | 'transition'
  mood?: string
  genre?: string
  volume_level?: 'high' | 'medium' | 'low' | 'muted'
  identified?: string
}

export interface ProAudioSoundEffect {
  time: string
  type: string
  description: string
}

export interface ProAudioEmotion {
  start: string
  end: string
  emotion: string
  intensity: number
  source: 'speech' | 'music' | 'both'
  reason?: string
}

export interface ProAudio {
  duration_sec?: number
  sound_effects?: ProAudioSoundEffect[]
  bgm_segments?: ProAudioBgmSegment[]
  emotion_timeline?: ProAudioEmotion[]
  narration?: { language?: string; tone?: string; pace?: string }
  audio_summary?: string
}

export interface ReelAnalysis {
  shortcode: string
  sentences: WhisperSentence[]
  pro_audio: ProAudio | null
  script_structure: unknown | null
  category: unknown | null
}

/** GET /api/reels — list of recent reels (server returns up to 100). */
export async function listMyReels(): Promise<ReelSummary[]> {
  return get<ReelSummary[]>('/api/reels')
}

// ── My scripts (생성 대본 — meta.tts 에 TTS 작업 저장) ─────────────────────
/**
 * One row of `GET /api/my-scripts` `.scripts[]`. The list endpoint only
 * projects a few `meta` keys (status/work_stage/group_name) — it does NOT
 * carry `meta.tts`, so to know whether a script has a usable TTS job we must
 * fetch the full script via `getMyScript`.
 */
export interface MyScriptSummary {
  id: string
  product_id: number
  title: string | null
  persona_name?: string | null
  ref_shortcode?: string | null
  source_type?: string | null
  created_at: string
}

export interface MyScriptsResponse {
  products: { id: number; name: string }[]
  scripts: MyScriptSummary[]
}

/** GET /api/my-scripts — every saved script across owned + shared products. */
export async function listMyScripts(): Promise<MyScriptsResponse> {
  const raw = await get<Partial<MyScriptsResponse>>('/api/my-scripts')
  return {
    products: Array.isArray(raw.products) ? raw.products : [],
    scripts: Array.isArray(raw.scripts) ? raw.scripts : []
  }
}

/**
 * The `meta.tts` blob saved onto a generated script. `job` carries the full
 * TTS job state (same shape as `TtsJobState`). Older scripts may not have it.
 */
export interface ScriptTtsMeta {
  job?: Partial<TtsJobState> & { job_id?: string }
  saved_at?: string
}

/** Full generated script — `select=*`, so `meta` (incl. `meta.tts`) is present. */
export interface MyScriptDetail {
  id: string
  product_id: number
  title: string | null
  meta?: { tts?: ScriptTtsMeta } & Record<string, unknown>
}

/**
 * GET /api/my-products/<pid>/scripts/<sid> — a single script with full `meta`.
 * Used to pull `meta.tts.job` for the TTS & SRT import tab.
 */
export async function getMyScript(
  productId: number,
  scriptId: string
): Promise<MyScriptDetail> {
  return get<MyScriptDetail>(
    `/api/my-products/${encodeURIComponent(String(productId))}/scripts/${encodeURIComponent(scriptId)}`
  )
}

/** GET /api/extra/<sc> — Whisper sentences + Gemini3 pro_audio. */
export async function getReelAnalysis(shortcode: string): Promise<ReelAnalysis> {
  const raw = await get<{
    sentences?: WhisperSentence[]
    pro_audio?: ProAudio | null
    script_structure?: unknown | null
    category?: unknown | null
  }>(`/api/extra/${encodeURIComponent(shortcode)}`)
  return {
    shortcode,
    sentences: Array.isArray(raw.sentences) ? raw.sentences : [],
    pro_audio: raw.pro_audio ?? null,
    script_structure: raw.script_structure ?? null,
    category: raw.category ?? null
  }
}

/** GET /api/metadata/<sc> — video_url + thumbnail + duration etc. */
export async function getReelMetadata(shortcode: string): Promise<ReelMetadata> {
  return get<ReelMetadata>(`/api/metadata/${encodeURIComponent(shortcode)}`)
}

// ── Seedance video library ─────────────────────────────────────────────────
/**
 * One row of the Seedance video library (`GET /api/seedance/videos`).
 * Mirrors the canonical `Video` shape in web/src/pages/SeedanceLibrary.tsx —
 * only the fields the editor's import grid needs are typed here.
 */
export interface SeedanceVideo {
  id: string
  name: string | null
  prompt: string | null
  /** Public Supabase Storage URL (https). */
  video_url: string
  resolution: string | null
  duration: string | null
  aspect_ratio: string | null
  generate_audio: boolean | null
  created_at: string
  /** Optional thumbnail (some rows carry one in meta). */
  meta?: { thumbnail_url?: string } | null
}

/** GET /api/seedance/videos — the user's saved + shared AI-generated videos. */
export async function listSeedanceVideos(): Promise<SeedanceVideo[]> {
  const rows = await get<SeedanceVideo[]>('/api/seedance/videos')
  return Array.isArray(rows) ? rows : []
}

// ── Seedance image upload (local file → fal storage public URL) ────────────
/**
 * POST /api/seedance/upload — uploads a local image to fal storage and
 * returns its public https URL. The backend expects `multipart/form-data`
 * with a single `file` field. Used as the start frame for AI generation.
 *
 * `data` is the raw image bytes (an `ArrayBuffer`, e.g. from
 * `File.arrayBuffer()`); `fileName` only feeds the file extension.
 */
export async function uploadSeedanceImage(
  data: ArrayBuffer,
  fileName: string,
  mimeType?: string
): Promise<string> {
  const blob = new Blob([data], {
    type: mimeType || 'application/octet-stream'
  })
  const form = new FormData()
  form.append('file', blob, fileName || 'image.jpg')
  // NOTE: do NOT set Content-Type — the browser sets the multipart boundary.
  const r = await authedFetch('/api/seedance/upload', {
    method: 'POST',
    body: form
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`업로드 실패 (${r.status})${txt ? `: ${txt.slice(0, 200)}` : ''}`)
  }
  const json = (await r.json()) as { image_url?: string }
  if (!json.image_url) {
    throw new Error('업로드 응답에 image_url이 없습니다')
  }
  return json.image_url
}

// ── Seedance AI generation (image → video, optionally with audio/BGM) ───────
export type SeedanceSubmitMode = 'transition' | 'reference'

export interface SeedanceSubmitRequestBody {
  prompt: string
  mode?: SeedanceSubmitMode
  /** transition mode — start frame image URL. */
  image_url?: string
  /** transition mode — optional end frame image URL. */
  end_image_url?: string | null
  /** reference mode — 1..9 reference image URLs. */
  reference_image_urls?: string[]
  resolution?: string
  duration?: string
  aspect_ratio?: string
  /** When true the model also generates audio (used as the "BGM" option). */
  generate_audio?: boolean
  seed?: number | null
}

export interface SeedanceSubmitResult {
  request_id: string
  status_url?: string
  response_url?: string
  queue_position?: number
  mode: SeedanceSubmitMode
}

/** POST /api/seedance/submit — kick off an async fal.ai generation job. */
export async function submitSeedanceJob(
  body: SeedanceSubmitRequestBody
): Promise<SeedanceSubmitResult> {
  const r = await authedFetch('/api/seedance/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`API ${r.status}${txt ? `: ${txt.slice(0, 200)}` : ''}`)
  }
  return r.json() as Promise<SeedanceSubmitResult>
}

export interface SeedanceStatusResult {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | string
  queue_position?: number | null
  /** Present once status === 'COMPLETED'. The fal CDN video URL. */
  video_url?: string | null
  seed?: number | null
  result_error?: string
}

/** GET /api/seedance/status?request_id=… — poll an in-flight generation job. */
export async function getSeedanceStatus(
  requestId: string
): Promise<SeedanceStatusResult> {
  return get<SeedanceStatusResult>(
    `/api/seedance/status?request_id=${encodeURIComponent(requestId)}`
  )
}

// ── TTS job (audio + per-sentence timing for SRT) ──────────────────────────
export interface TtsSentence {
  text?: string
  /** Start time in seconds (present after synthesis alignment). */
  start?: number
  /** End time in seconds. */
  end?: number
}

export interface TtsJobState {
  job_id: string
  voice_name?: string
  sentences: TtsSentence[]
  total_duration?: number
  /** Relative ('/api/tts/...') or absolute (Supabase) URL of the final mp3. */
  final_url: string
  is_supabase?: boolean
  created_at?: string
}

/**
 * GET /api/tts/job/<job_id> — full TTS job state. `final_url` may be a
 * relative path; callers should resolve it against API_BASE before download.
 */
export async function getTtsJob(jobId: string): Promise<TtsJobState> {
  const raw = await get<Partial<TtsJobState>>(
    `/api/tts/job/${encodeURIComponent(jobId)}`
  )
  return {
    job_id: raw.job_id ?? jobId,
    voice_name: raw.voice_name,
    sentences: Array.isArray(raw.sentences) ? raw.sentences : [],
    total_duration: raw.total_duration,
    final_url: raw.final_url ?? `/api/tts/files/${jobId}/final.mp3`,
    is_supabase: raw.is_supabase,
    created_at: raw.created_at
  }
}

/** Resolve a possibly-relative API URL to an absolute https URL. */
export function resolveApiUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`
}

/**
 * Convenience: pull the video URL for a reel from its metadata.
 * Returns null if the reel has no metadata or no video_url field.
 */
export async function getReelVideoUrl(shortcode: string): Promise<string | null> {
  try {
    const md = await getReelMetadata(shortcode)
    return md.video_url || null
  } catch {
    return null
  }
}
