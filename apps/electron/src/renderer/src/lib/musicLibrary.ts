/**
 * 음악 라이브러리 — in-editor 음악·효과음 카탈로그 클라이언트 (renderer 전용).
 *
 * `GET /api/audio-library` 를 호출해 미리듣기·삽입 가능한 트랙 목록을 받는다.
 * 영상 라이브러리(`importSources.ts`)와 같은 패턴: 목록 fetch만 담당하고,
 * UI(리스트/미리듣기/추가 버튼)는 `ImportPanel.tsx` 의 `MusicLibraryTab` 이,
 * 실제 다운로드+ingest는 `mediaImport.ts` 의 `importFromUrl` 이 맡는다.
 *
 * 이 엔드포인트는 백엔드에 아직 없을 수 있다 — 그 경우 다른 원격 탭과 동일하게
 * 에러/빈 상태로 graceful degrade 한다.
 */
import { authedFetch } from './api'

/** 카탈로그 항목 분류. */
export type MusicCategory = 'music' | 'sfx'

/** 음악 라이브러리 한 행 — 정규화된 트랙 아이템. */
export interface MusicTrackItem {
  /** 카탈로그 내 안정 id. */
  id: string
  category: MusicCategory
  /** 표시 제목. */
  title: string
  /** 아티스트/제작자 (있을 때만). */
  artist?: string
  /** 트랙 길이 (ms). */
  durationMs: number
  /** 분당 비트 (음악, 있을 때만). */
  bpm?: number
  /** 분위기 태그 (있을 때만). */
  mood?: string
  /** 장르 태그 (있을 때만). */
  genre?: string
  /** 타임라인에 삽입할 때 다운로드할 https URL. */
  downloadUrl: string
  /** 미리듣기 전용 https URL (없으면 downloadUrl로 미리듣기). */
  previewUrl?: string
  /** 가져온 파일에 붙일 확장자 힌트. */
  ext: '.mp3' | '.wav' | '.m4a'
}

/** `GET /api/audio-library` 응답의 raw 한 행 (backend snake_case). */
interface RawAudioLibraryItem {
  id?: string
  category?: string
  title?: string
  artist?: string | null
  duration_sec?: number | null
  bpm?: number | null
  mood?: string | null
  genre?: string | null
  file_url?: string
  preview_url?: string | null
  ext?: string
}

/** `GET /api/audio-library` 응답 전체. */
interface RawAudioLibraryResponse {
  items?: RawAudioLibraryItem[]
  next_cursor?: string | null
}

const ALLOWED_EXTS: ReadonlyArray<MusicTrackItem['ext']> = [
  '.mp3',
  '.wav',
  '.m4a'
]

/** raw ext 문자열을 허용된 확장자로 정규화 (기본 '.mp3'). */
function normalizeExt(raw: string | undefined): MusicTrackItem['ext'] {
  const v = (raw ?? '').toLowerCase().trim()
  const dotted = v.startsWith('.') ? v : `.${v}`
  return (ALLOWED_EXTS as readonly string[]).includes(dotted)
    ? (dotted as MusicTrackItem['ext'])
    : '.mp3'
}

/** raw category를 'music' | 'sfx'로 정규화 (기본 'music'). */
function normalizeCategory(raw: string | undefined): MusicCategory {
  return raw === 'sfx' ? 'sfx' : 'music'
}

/** raw 한 행을 정규화된 `MusicTrackItem`으로 변환. */
function mapItem(raw: RawAudioLibraryItem): MusicTrackItem {
  const durSec = Number(raw.duration_sec)
  const item: MusicTrackItem = {
    id: String(raw.id ?? ''),
    category: normalizeCategory(raw.category),
    title: raw.title || '제목 없음',
    durationMs: Number.isFinite(durSec) && durSec > 0 ? Math.round(durSec * 1000) : 0,
    downloadUrl: raw.file_url ?? '',
    ext: normalizeExt(raw.ext)
  }
  if (raw.artist) item.artist = raw.artist
  if (raw.bpm != null && Number.isFinite(Number(raw.bpm))) {
    item.bpm = Math.round(Number(raw.bpm))
  }
  if (raw.mood) item.mood = raw.mood
  if (raw.genre) item.genre = raw.genre
  if (raw.preview_url) item.previewUrl = raw.preview_url
  return item
}

/**
 * 음악 라이브러리 목록을 가져온다. 서버사이드 필터(`category`/`q`) + 커서 페이징.
 * 실패 시 throw 하므로 호출자(UI)가 에러 박스를 그릴 수 있다.
 */
export async function fetchMusicLibrary(opts?: {
  category?: 'all' | MusicCategory
  q?: string
  cursor?: string
}): Promise<{ items: MusicTrackItem[]; nextCursor?: string }> {
  const params = new URLSearchParams()
  const cat = opts?.category ?? 'all'
  if (cat !== 'all') params.set('category', cat)
  const q = (opts?.q ?? '').trim()
  if (q) params.set('q', q)
  if (opts?.cursor) params.set('cursor', opts.cursor)
  const qs = params.toString()
  const r = await authedFetch(`/api/audio-library${qs ? `?${qs}` : ''}`)
  if (!r.ok) throw new Error(`API ${r.status}`)
  const raw = (await r.json()) as RawAudioLibraryResponse
  const items = Array.isArray(raw.items)
    ? raw.items.map(mapItem).filter((it) => it.id && it.downloadUrl)
    : []
  const result: { items: MusicTrackItem[]; nextCursor?: string } = { items }
  if (raw.next_cursor) result.nextCursor = raw.next_cursor
  return result
}
