/**
 * 미디어 가져오기 — 소스별 import 로직 (캡컷 스타일 4버튼).
 *
 * 슬라이드 7~8 "저장된 영상 & 음성 가져오기" 스펙:
 *   ① 내 PC          — 로컬 파일 다이얼로그 (MediaLibrary.tsx가 직접 처리)
 *   ② 영상 라이브러리 — reels-bench Seedance 영상 라이브러리
 *   ③ TTS & SRT      — reels-bench TTS 오디오 + SRT 자막
 *   ④ AI 영상 생성    — Seedance 생성을 백그라운드로 걸고 완료 시 자동 import
 *   + 내부 영상       — 릴스벤치에 저장된 분석 릴스
 *
 * 이 모듈은 "목록 fetch" + "선택 항목 import"만 담당. UI(그리드/버튼)는
 * MediaLibrary.tsx, 백그라운드 생성 잡 추적은 store/aiJobs.ts가 맡는다.
 */
import {
  authedFetch,
  getTtsJob,
  getMyScript,
  listMyScripts,
  listSeedanceVideos,
  listMyReels,
  getReelMetadata,
  resolveApiUrl,
  type SeedanceVideo,
  type ReelSummary,
  type TtsSentence,
  type TtsJobState
} from './api'
import { importFromUrl, type UrlImportResult } from './mediaImport'
import { getReelVideoUrl } from './api'
import { useProjectStore } from '../store/project'
import type { SfxMeta } from '../../../shared/project'

// ---------------------------------------------------------------------------
// 공통 — 가져오기 그리드 한 칸을 표현하는 정규화된 아이템.
// ---------------------------------------------------------------------------
export interface RemoteMediaItem {
  /** 소스 내 안정 id. */
  id: string
  /** 그리드에 표시할 제목. */
  title: string
  /** https 썸네일 URL (없으면 placeholder). */
  thumbnailUrl?: string
  /** 다운로드 대상 https URL. */
  downloadUrl: string
  /** 가져온 파일에 붙일 확장자 힌트 ('.mp4' | '.mp3'). */
  ext: '.mp4' | '.mp3'
  /** "1080p · 4s · 9:16" 같은 부가 정보. */
  subtitle?: string
}

// ---------------------------------------------------------------------------
// ② 영상 라이브러리 — Seedance 저장 영상.
// ---------------------------------------------------------------------------
export async function fetchVideoLibrary(): Promise<RemoteMediaItem[]> {
  const rows = await listSeedanceVideos()
  return rows.map((v: SeedanceVideo) => ({
    id: v.id,
    title: v.name || v.prompt?.slice(0, 40) || '제목 없음',
    thumbnailUrl: v.meta?.thumbnail_url || undefined,
    downloadUrl: v.video_url,
    ext: '.mp4' as const,
    subtitle: [
      v.resolution,
      v.duration ? `${v.duration}s` : null,
      v.aspect_ratio
    ]
      .filter(Boolean)
      .join(' · ')
  }))
}

// ---------------------------------------------------------------------------
// ④ 내부 영상 — 릴스벤치에 저장된 분석 릴스.
//   목록은 /api/reels (shortcode만), 썸네일/영상 URL은 카드별 lazy metadata.
// ---------------------------------------------------------------------------
export async function fetchInternalReels(): Promise<ReelSummary[]> {
  return listMyReels()
}

/**
 * 분석 릴스 1건의 메타데이터(썸네일 + 영상 URL)를 가져온다. 카드별 lazy
 * 호출용. 실패해도 throw하지 않고 null 반환.
 */
export async function fetchReelMediaItem(
  shortcode: string
): Promise<RemoteMediaItem | null> {
  try {
    const md = await getReelMetadata(shortcode)
    if (!md.video_url) return null
    return {
      id: shortcode,
      title: md.author_username
        ? `${shortcode} · @${md.author_username}`
        : shortcode,
      thumbnailUrl: md.thumbnail_url || undefined,
      downloadUrl: md.video_url,
      ext: '.mp4',
      subtitle: md.video_duration
        ? `${Math.round(md.video_duration)}s`
        : undefined
    }
  } catch {
    return null
  }
}

/**
 * 분석 릴스 import — 영상 URL이 만료(403)됐을 때 재발급(re-scrape)까지 시도.
 */
export async function importReel(shortcode: string): Promise<UrlImportResult> {
  const item = await fetchReelMediaItem(shortcode)
  if (!item) {
    return { ok: false, error: '릴스 영상 URL을 찾지 못했습니다' }
  }
  let result = await importFromUrl(item.downloadUrl, {
    suggestedName: `${shortcode}.mp4`,
    displayName: item.title
  })
  // 만료된 CDN URL — 한 번 재발급 시도.
  if (!result.ok) {
    const fresh = await getReelVideoUrl(shortcode)
    if (fresh && fresh !== item.downloadUrl) {
      result = await importFromUrl(fresh, {
        suggestedName: `${shortcode}.mp4`,
        displayName: item.title
      })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// ③ TTS & SRT — TTS job의 오디오 + 문장별 타이밍으로 자막.
// ---------------------------------------------------------------------------
export interface TtsSrtCue {
  startMs: number
  endMs: number
  text: string
}

/** TTS job의 sentences(초 단위 start/end)를 SRT cue(ms)로 변환. */
export function ttsSentencesToCues(
  sentences: TtsSentence[],
  totalDurationMs: number
): TtsSrtCue[] {
  const cues: TtsSrtCue[] = []
  for (const s of sentences) {
    const text = (s.text ?? '').trim()
    if (!text) continue
    let startMs = Math.round((Number(s.start) || 0) * 1000)
    let endMs = Math.round((Number(s.end) || 0) * 1000)
    if (!Number.isFinite(startMs) || startMs < 0) startMs = 0
    if (!Number.isFinite(endMs) || endMs <= startMs) {
      endMs = startMs + 1500
    }
    cues.push({ startMs, endMs, text })
  }
  // 타이밍 정보가 전혀 없으면(모든 cue가 0~) 균등 분할 fallback.
  const hasTiming = cues.some((c) => c.startMs > 0 || c.endMs !== 1500)
  if (!hasTiming && cues.length > 0 && totalDurationMs > 0) {
    const slot = totalDurationMs / cues.length
    return cues.map((c, i) => ({
      startMs: Math.round(i * slot),
      endMs: Math.round((i + 1) * slot),
      text: c.text
    }))
  }
  return cues
}

export interface TtsImportResult {
  ok: boolean
  /** 가져온 오디오 미디어 에셋의 id. */
  mediaId?: string
  /** SRT에서 만든 cue 목록 (호출자가 caption clip으로 변환). */
  cues?: TtsSrtCue[]
  error?: string
}

/**
 * TtsJobState(또는 그 부분집합)에서 오디오 + 자막을 가져온다. `getTtsJob`로
 * 받았든 대본 `meta.tts.job`에서 꺼냈든 동일하게 동작. NEVER throws.
 */
export async function importTtsFromJobState(
  job: Partial<TtsJobState> & { job_id?: string }
): Promise<TtsImportResult> {
  try {
    if (!job.final_url) {
      return { ok: false, error: 'TTS 오디오 URL이 없습니다' }
    }
    const audioUrl = resolveApiUrl(job.final_url)
    const label = job.voice_name || job.job_id || 'tts'
    const dl = await importFromUrl(audioUrl, {
      suggestedName: `tts-${job.job_id || Date.now()}.mp3`,
      displayName: `TTS · ${label}`
    })
    if (!dl.ok || !dl.asset) {
      return { ok: false, error: dl.error || 'TTS 오디오 다운로드 실패' }
    }
    const totalMs = Math.round((job.total_duration ?? 0) * 1000)
    const cues = ttsSentencesToCues(
      Array.isArray(job.sentences) ? job.sentences : [],
      totalMs
    )
    return { ok: true, mediaId: dl.asset.id, cues }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * TTS job 1건을 가져온다 — 오디오는 미디어로 import, sentences는 SRT cue로.
 * 슬라이드: "누르면 바로 가져오게끔". NEVER throws.
 */
export async function importTtsJob(jobId: string): Promise<TtsImportResult> {
  try {
    const job = await getTtsJob(jobId)
    return importTtsFromJobState(job)
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

// ---------------------------------------------------------------------------
// ③ 대본 picker — 내 대본의 meta.tts.job에 저장된 TTS 작업을 가져온다.
//   목록은 /api/my-scripts, 개별 대본의 meta.tts는 상세 조회로만 확보 가능.
// ---------------------------------------------------------------------------
/** 대본 picker 한 행 — 목록 단계에서 알 수 있는 최소 정보. */
export interface ScriptPickItem {
  /** generated_scripts.id */
  id: string
  /** my_products.id — 상세 조회에 필요. */
  productId: number
  /** 표시 제목. */
  title: string
  /** 부가 정보 (상품명 · 생성일). */
  subtitle?: string
}

/**
 * 내 대본 목록을 picker용으로 가져온다. 최신순. NEVER throws → 실패 시 throw로
 * 호출자(UI)가 에러 박스를 그릴 수 있게 함.
 */
export async function fetchMyScripts(): Promise<ScriptPickItem[]> {
  const { products, scripts } = await listMyScripts()
  const prodName = new Map(products.map((p) => [p.id, p.name]))
  return scripts.map((s) => {
    const created = s.created_at
      ? new Date(s.created_at).toLocaleDateString('ko-KR')
      : ''
    return {
      id: s.id,
      productId: s.product_id,
      title: s.title || s.persona_name || s.ref_shortcode || '제목 없음',
      subtitle: [prodName.get(s.product_id), created]
        .filter(Boolean)
        .join(' · ')
    }
  })
}

/**
 * 대본 1건의 TTS 보유 여부를 확인한다. picker 카드별 lazy 호출용.
 * 반환: TTS 작업이 있으면 그 job, 없으면 null. 실패해도 throw 안 함.
 */
export async function fetchScriptTtsState(
  productId: number,
  scriptId: string
): Promise<(Partial<TtsJobState> & { job_id?: string }) | null> {
  try {
    const detail = await getMyScript(productId, scriptId)
    const job = detail.meta?.tts?.job
    return job && job.final_url ? job : null
  } catch {
    return null
  }
}

/**
 * 대본 1건을 골라 그 대본에 저장된 TTS 작업(오디오 + 문장 타이밍)을 가져온다.
 * `meta.tts.job`이 없는 대본이면 ok:false. NEVER throws.
 */
export async function importScriptTts(
  productId: number,
  scriptId: string
): Promise<TtsImportResult> {
  try {
    const detail = await getMyScript(productId, scriptId)
    const job = detail.meta?.tts?.job
    if (!job || !job.final_url) {
      return { ok: false, error: '이 대본에는 저장된 TTS 작업이 없습니다' }
    }
    return importTtsFromJobState(job)
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 8 — 효과음 (SFX).
//   소스 2종:
//     ① 우리 라이브러리   GET /api/sfx?q=&tag=&limit=&offset=
//     ② Freesound 프록시  GET /api/sfx/freesound/search?q=&page=&license=
//   import는 둘 다 https URL 다운로드 — 기존 `importFromUrl` 재사용.
//   import 직후 `updateMediaSfxMeta`로 license/attribution을 부착해 추후
//   export 단계에서 credit roll에 자동 노출할 수 있게 한다.
// ---------------------------------------------------------------------------

/** 효과음 한 행 — UI 그리드의 정규화된 카드 데이터. */
export interface SfxItem {
  /** 소스 내 안정 id ('ours-123' / 'freesound-456' 형태로 prefix). */
  id: string
  /** 표시 이름. */
  name: string
  /** 태그 목록 (검색·표시용). */
  tags: string[]
  /** 길이 (ms, 미상이면 0). */
  durationMs: number
  /** 미리듣기 + 다운로드 대상 https URL. 우리 라이브러리는 동일. */
  previewUrl: string
  /** Freesound 'preview HQ MP3'의 다운로드 URL (있으면 이걸로 import). */
  downloadUrl: string
  /** 라이선스 짧은 코드 ('CC0', 'CC-BY', …). */
  license: string
  /** CC-BY일 때 표기할 저작자 이름. */
  attribution?: string
  /** 원본 페이지 URL (Freesound 카드 등). */
  sourceUrl?: string
  /** 소스 종류. */
  source: 'ours' | 'freesound'
  /** Freesound 업로더 username (표시용). */
  username?: string
}

/** `GET /api/sfx` 응답의 raw row. */
interface RawOurSfxRow {
  id?: string | number
  name?: string
  tags?: unknown
  duration_ms?: number | null
  url?: string
  license?: string
  attribution?: string | null
  source?: string
}

/** `GET /api/sfx/freesound/search` 응답의 raw row. */
interface RawFreesoundRow {
  id?: string | number
  name?: string
  tags?: unknown
  duration_ms?: number | null
  preview_url?: string
  freesound_url?: string
  license?: string
  attribution?: string | null
  username?: string | null
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => t.length > 0)
    .slice(0, 12)
}

function normalizeLicense(raw: string | undefined): string {
  const v = (raw ?? '').trim()
  if (!v) return 'CC-BY'
  // 흔한 표기 정규화: 'Creative Commons 0' → 'CC0' 등.
  const lo = v.toLowerCase()
  if (lo.includes('cc0') || lo.includes('zero') || lo === 'public domain') {
    return 'CC0'
  }
  if (lo.includes('by-nc')) return 'CC-BY-NC'
  if (lo.includes('by-sa')) return 'CC-BY-SA'
  if (lo.includes('by')) return 'CC-BY'
  return v
}

/**
 * 우리 라이브러리 검색 — `GET /api/sfx?q=&tag=&limit=&offset=`.
 * 401/503/네트워크 오류는 throw — 호출자(UI)가 에러 박스를 그린다.
 */
export async function searchOurSfx(
  q?: string,
  tag?: string,
  opts?: { limit?: number; offset?: number }
): Promise<SfxItem[]> {
  const params = new URLSearchParams()
  const qs = (q ?? '').trim()
  if (qs) params.set('q', qs)
  const ts = (tag ?? '').trim()
  if (ts) params.set('tag', ts)
  if (opts?.limit != null) params.set('limit', String(opts.limit))
  if (opts?.offset != null) params.set('offset', String(opts.offset))
  const qstr = params.toString()
  const r = await authedFetch(`/api/sfx${qstr ? `?${qstr}` : ''}`)
  if (!r.ok) {
    const msg = await r.text().catch(() => '')
    throw new Error(`API ${r.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`)
  }
  const raw = (await r.json()) as RawOurSfxRow[]
  if (!Array.isArray(raw)) return []
  return raw
    .map((row): SfxItem | null => {
      const url = row.url
      if (!url) return null
      const id = `ours-${String(row.id ?? '')}`
      return {
        id,
        name: row.name || '제목 없음',
        tags: normalizeTags(row.tags),
        durationMs:
          row.duration_ms != null && Number.isFinite(Number(row.duration_ms))
            ? Math.max(0, Math.round(Number(row.duration_ms)))
            : 0,
        previewUrl: url,
        downloadUrl: url,
        license: normalizeLicense(row.license),
        attribution: row.attribution ?? undefined,
        source: 'ours' as const
      }
    })
    .filter((it): it is SfxItem => it !== null)
}

/**
 * Freesound 프록시 검색 — `GET /api/sfx/freesound/search?q=&page=&license=`.
 *   - 503 → 'API 키 미설정' 메시지로 surface (UI에서 별도 배너 처리).
 *   - 401/네트워크 오류는 throw.
 *   - preview_url 이 없는 row는 제외 (import 불가).
 */
export async function searchFreesound(
  q: string,
  license?: string,
  page?: number
): Promise<SfxItem[]> {
  const qs = (q ?? '').trim()
  if (!qs) return []
  const params = new URLSearchParams({ q: qs })
  if (license) params.set('license', license)
  if (page != null && page > 0) params.set('page', String(page))
  const r = await authedFetch(`/api/sfx/freesound/search?${params.toString()}`)
  if (r.status === 503) {
    // 키 미설정 — 호출자가 별도 배너로 처리할 수 있게 sentinel 에러.
    throw new Error('FREESOUND_NOT_CONFIGURED')
  }
  if (!r.ok) {
    const msg = await r.text().catch(() => '')
    throw new Error(`API ${r.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`)
  }
  // 백엔드는 페이지네이션 메타와 함께 `{count, next, previous, results: [...]}`
  // 객체로 반환한다. 호환을 위해 flat 배열도 받아준다.
  const json = (await r.json()) as
    | { results?: RawFreesoundRow[] }
    | RawFreesoundRow[]
  const raw: RawFreesoundRow[] = Array.isArray(json)
    ? json
    : Array.isArray(json?.results)
      ? json.results
      : []
  return raw
    .map((row): SfxItem | null => {
      const preview = row.preview_url
      if (!preview) return null
      const id = `freesound-${String(row.id ?? '')}`
      const attribution = row.attribution ?? row.username ?? undefined
      const item: SfxItem = {
        id,
        name: row.name || '제목 없음',
        tags: normalizeTags(row.tags),
        durationMs:
          row.duration_ms != null && Number.isFinite(Number(row.duration_ms))
            ? Math.max(0, Math.round(Number(row.duration_ms)))
            : 0,
        previewUrl: preview,
        downloadUrl: preview,
        license: normalizeLicense(row.license),
        source: 'freesound' as const
      }
      if (attribution) item.attribution = attribution
      if (row.freesound_url) item.sourceUrl = row.freesound_url
      if (row.username) item.username = row.username
      return item
    })
    .filter((it): it is SfxItem => it !== null)
}

/**
 * 효과음 import — 기존 `importFromUrl` 래퍼 + import 직후 `MediaAsset`에
 * sfxMeta(license/attribution/source) 부착. NEVER throws.
 *
 * 호출 측이 직접 `importFromUrl`을 쓰지 않고 이걸 거쳐야 export 단계에서
 * credit roll을 자동 생성할 수 있다.
 */
export async function importSfxFromUrl(
  url: string,
  name: string,
  meta: SfxMeta
): Promise<UrlImportResult> {
  const safeName = (name && name.trim()) || 'sfx'
  // mp3 확장자 강제 — Freesound preview는 mp3, 우리 라이브러리도 mp3 권장.
  const suggested = safeName.toLowerCase().endsWith('.mp3')
    ? safeName
    : `${safeName}.mp3`
  const r = await importFromUrl(url, {
    suggestedName: suggested,
    displayName: name
  })
  if (r.ok && r.asset) {
    try {
      useProjectStore.getState().updateMediaSfxMeta(r.asset.id, meta)
    } catch (err) {
      // 스토어 부착 실패는 import 자체의 성공을 깨지 않는다.
      console.warn('[sfx] updateMediaSfxMeta failed', err)
    }
  }
  return r
}
