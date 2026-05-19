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
