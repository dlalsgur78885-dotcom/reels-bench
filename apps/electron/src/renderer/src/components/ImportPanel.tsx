/**
 * 미디어 가져오기 패널 — 캡컷 스타일 소스별 4버튼 (슬라이드 7~8).
 *
 *   ① 내 PC          — 로컬 파일 다이얼로그 / 드래그앤드롭
 *   ② 영상 라이브러리 — reels-bench Seedance 저장 영상
 *   ③ TTS & SRT      — reels-bench TTS 오디오 + SRT 자막
 *   ④ AI 영상 생성    — Seedance 생성을 백그라운드로 (편집 블로킹 X)
 *   + 내부 영상       — 릴스벤치에 저장된 분석 릴스
 *
 * MediaLibrary.tsx 상단에 탭으로 박힌다. "내 PC" 탭은 기존 로컬 import UI를
 * 그대로 쓰고(부모가 렌더), 나머지 탭은 이 컴포넌트가 그리드를 그린다.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchVideoLibrary,
  fetchInternalReels,
  fetchReelMediaItem,
  fetchMyScripts,
  fetchScriptTtsState,
  importReel,
  importScriptTts,
  importSfxFromUrl,
  searchFreesound,
  searchOurSfx,
  type RemoteMediaItem,
  type ScriptPickItem,
  type SfxItem
} from '../lib/importSources'
import { importFromUrl } from '../lib/mediaImport'
import {
  PENDING_MEDIA_DRAG_MIME,
  newPendingId,
  registerPending
} from '../lib/pendingImport'
import { cuesToClips, addClipsToStore } from '../lib/captions'
import { submitSeedanceJob, uploadSeedanceImage, type ReelSummary } from '../lib/api'
import {
  fetchMusicLibrary,
  type MusicCategory,
  type MusicTrackItem
} from '../lib/musicLibrary'
import { useAiJobs } from '../store/aiJobs'
import { useProjectStore, newId } from '../store/project'
import { useTimelineUi } from '../store/timelineUi'
import { BrandKitPanel } from './BrandKitPanel'
import type { VideoAudioClip, Clip, MediaAsset } from '../../../shared/project'

export type ImportTab =
  | 'local'
  | 'library'
  | 'tts'
  | 'ai'
  | 'internal'
  | 'music'
  | 'sfx'
  | 'brand'

interface ImportPanelProps {
  tab: ImportTab
  /** 토스트/안내 메시지 보고 (부모의 에러 리스트로 흘려보냄). */
  onNotice: (message: string, kind: 'info' | 'error') => void
}

// ---------------------------------------------------------------------------
// Styles — MediaLibrary.tsx 톤과 일치.
// ---------------------------------------------------------------------------
const styles = {
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  } as React.CSSProperties,
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
    gap: 8
  } as React.CSSProperties,
  tile: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    overflow: 'hidden',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column'
  } as React.CSSProperties,
  tileThumb: {
    width: '100%',
    aspectRatio: '9 / 16',
    background: '#0d0d0d',
    objectFit: 'cover',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#475569',
    fontSize: 22
  } as React.CSSProperties,
  tileTitle: {
    padding: '6px 8px',
    fontSize: 11,
    fontWeight: 600,
    color: '#e2e8f0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  tileSub: {
    padding: '0 8px 6px',
    fontSize: 10,
    color: '#64748b'
  } as React.CSSProperties,
  state: {
    color: '#9aa0a6',
    fontSize: 12,
    padding: 16,
    textAlign: 'center'
  } as React.CSSProperties,
  errorBox: {
    background: '#2a0d0d',
    border: '1px solid #4a1f1f',
    color: '#fca5a5',
    borderRadius: 6,
    fontSize: 11,
    padding: '8px 12px'
  } as React.CSSProperties,
  retry: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 12,
    cursor: 'pointer',
    alignSelf: 'center'
  } as React.CSSProperties,
  // ── AI 생성 폼 ──
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: 4
  } as React.CSSProperties,
  label: {
    fontSize: 11,
    color: '#9aa0a6',
    fontWeight: 600
  } as React.CSSProperties,
  textarea: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 12,
    resize: 'vertical',
    minHeight: 64,
    fontFamily: 'inherit'
  } as React.CSSProperties,
  input: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    width: '100%',
    boxSizing: 'border-box'
  } as React.CSSProperties,
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    color: '#cbd5e1'
  } as React.CSSProperties,
  primaryBtn: {
    background: '#10b981',
    color: '#04231a',
    border: 'none',
    borderRadius: 6,
    padding: '8px 14px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer'
  } as React.CSSProperties,
  jobRow: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 11,
    display: 'flex',
    flexDirection: 'column',
    gap: 2
  } as React.CSSProperties,
  jobDismiss: {
    background: 'transparent',
    color: '#64748b',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    alignSelf: 'flex-end'
  } as React.CSSProperties,
  hint: {
    fontSize: 10,
    color: '#64748b',
    lineHeight: 1.5
  } as React.CSSProperties,
  idInputRow: {
    display: 'flex',
    gap: 6
  } as React.CSSProperties,
  // ── 대본 picker 리스트 ──
  scriptList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  } as React.CSSProperties,
  scriptRow: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    cursor: 'pointer'
  } as React.CSSProperties,
  scriptRowDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed'
  } as React.CSSProperties,
  scriptTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: '#e2e8f0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  scriptSub: {
    fontSize: 10,
    color: '#64748b'
  } as React.CSSProperties,
  scriptBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#86efac'
  } as React.CSSProperties,
  fileBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '8px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    alignSelf: 'flex-start'
  } as React.CSSProperties,
  imgPreview: {
    width: '100%',
    maxHeight: 160,
    objectFit: 'contain',
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 6
  } as React.CSSProperties,
  // ── 음악 라이브러리 ──
  filterBar: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  } as React.CSSProperties,
  chipRow: {
    display: 'flex',
    gap: 4
  } as React.CSSProperties,
  chip: {
    flex: '1 1 auto',
    background: '#1a1a1a',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '5px 8px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  chipActive: {
    background: '#10b981',
    color: '#04231a',
    borderColor: '#10b981'
  } as React.CSSProperties,
  searchInput: {
    background: '#0d0d0d',
    color: '#f5f5f5',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    width: '100%',
    boxSizing: 'border-box'
  } as React.CSSProperties,
  musicList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  } as React.CSSProperties,
  musicRow: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '8px 10px',
    display: 'flex',
    alignItems: 'center',
    gap: 10
  } as React.CSSProperties,
  musicGlyph: {
    fontSize: 18,
    width: 24,
    textAlign: 'center',
    flexShrink: 0,
    color: '#94a3b8'
  } as React.CSSProperties,
  musicInfo: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2
  } as React.CSSProperties,
  musicTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: '#e2e8f0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  musicMeta: {
    fontSize: 10,
    color: '#64748b',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center'
  } as React.CSSProperties,
  musicTag: {
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '1px 5px',
    fontSize: 9,
    color: '#94a3b8'
  } as React.CSSProperties,
  musicPreviewNote: {
    fontSize: 10,
    color: '#fca5a5'
  } as React.CSSProperties,
  musicBtns: {
    display: 'flex',
    gap: 4,
    flexShrink: 0
  } as React.CSSProperties,
  iconBtn: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '5px 9px',
    fontSize: 12,
    cursor: 'pointer',
    lineHeight: 1
  } as React.CSSProperties,
  addBtn: {
    background: '#10b981',
    color: '#04231a',
    border: 'none',
    borderRadius: 6,
    padding: '5px 10px',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer'
  } as React.CSSProperties,
  loadMore: {
    background: '#1f2937',
    color: '#f5f5f5',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '8px 14px',
    fontSize: 12,
    cursor: 'pointer',
    alignSelf: 'center'
  } as React.CSSProperties,
  // ── 효과음 (Phase 8) ──
  sfxSourceToggle: {
    display: 'flex',
    gap: 4,
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: 4
  } as React.CSSProperties,
  sfxSourceBtn: {
    flex: '1 1 0',
    background: 'transparent',
    color: '#9aa0a6',
    border: 'none',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  sfxSourceBtnActive: {
    background: '#10b981',
    color: '#04231a'
  } as React.CSSProperties,
  sfxSearchRow: {
    display: 'flex',
    gap: 6
  } as React.CSSProperties,
  sfxSearchBtn: {
    background: '#10b981',
    color: '#04231a',
    border: 'none',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  sfxGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  } as React.CSSProperties,
  sfxCard: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  } as React.CSSProperties,
  sfxCardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8
  } as React.CSSProperties,
  sfxCardName: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    fontWeight: 600,
    color: '#e2e8f0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  sfxCardMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
    fontSize: 10,
    color: '#64748b'
  } as React.CSSProperties,
  sfxTagsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4
  } as React.CSSProperties,
  sfxTag: {
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '1px 5px',
    fontSize: 9,
    color: '#94a3b8'
  } as React.CSSProperties,
  sfxLicenseCc0: {
    background: '#0d2a1a',
    color: '#86efac',
    border: '1px solid #1f4a35',
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 9,
    fontWeight: 700,
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  sfxLicenseCcBy: {
    background: '#0d1a2a',
    color: '#93c5fd',
    border: '1px solid #1e3a5f',
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 9,
    fontWeight: 700,
    cursor: 'help',
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  sfxLicenseOther: {
    background: '#2a1f0d',
    color: '#fbbf24',
    border: '1px solid #4a3a1f',
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 9,
    fontWeight: 700,
    cursor: 'help',
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  sfxBtnRow: {
    display: 'flex',
    gap: 6,
    justifyContent: 'flex-end'
  } as React.CSSProperties,
  sfxWarnBanner: {
    background: '#2a1f0d',
    border: '1px solid #4a3a1f',
    color: '#fbbf24',
    borderRadius: 6,
    fontSize: 11,
    padding: '8px 12px',
    lineHeight: 1.5
  } as React.CSSProperties
}

// ===========================================================================
// 공통 — 원격 미디어 그리드 (썸네일 + 제목, 클릭 시 import).
// ===========================================================================
function RemoteGrid(props: {
  items: RemoteMediaItem[]
  /** 이미 가져온 항목 id (재import 표시용). */
  importedIds: Set<string>
  busyId: string | null
  onPick: (item: RemoteMediaItem) => void
  /** Drag-and-drop bridge — called when the user starts dragging a tile to
   *  the timeline. Must kick off the import and return a Promise for the
   *  resulting MediaAsset (or null on failure). */
  onDragImport?: (item: RemoteMediaItem) => Promise<MediaAsset | null>
}): JSX.Element {
  const { items, importedIds, busyId, onPick, onDragImport } = props
  return (
    <div style={styles.grid} data-testid="remote-grid">
      {items.map((it) => {
        const done = importedIds.has(it.id)
        const busy = busyId === it.id
        return (
          <div
            key={it.id}
            style={{
              ...styles.tile,
              opacity: busy ? 0.6 : 1,
              borderColor: done ? '#10b981' : '#2a2a2a',
              cursor: onDragImport ? 'grab' : 'pointer'
            }}
            onClick={() => !busy && onPick(it)}
            draggable={Boolean(onDragImport)}
            onDragStart={
              onDragImport
                ? (e) => {
                    e.dataTransfer.effectAllowed = 'copy'
                    const tempId = newPendingId()
                    e.dataTransfer.setData(PENDING_MEDIA_DRAG_MIME, tempId)
                    e.dataTransfer.setData('text/plain', it.title)
                    const p = onDragImport(it)
                    registerPending(tempId, p, it.title)
                  }
                : undefined
            }
            data-testid={`remote-tile-${it.id}`}
            title={it.title}
          >
            {it.thumbnailUrl ? (
              <img
                src={it.thumbnailUrl}
                alt={it.title}
                style={styles.tileThumb}
                referrerPolicy="no-referrer"
                onError={(e) => {
                  ;(e.currentTarget as HTMLImageElement).style.visibility =
                    'hidden'
                }}
              />
            ) : (
              <div style={styles.tileThumb}>
                {it.ext === '.mp3' ? '♪' : '▶'}
              </div>
            )}
            <div style={styles.tileTitle}>
              {busy ? '가져오는 중…' : done ? '✓ ' : ''}
              {it.title}
            </div>
            {it.subtitle && <div style={styles.tileSub}>{it.subtitle}</div>}
          </div>
        )
      })}
    </div>
  )
}

// ===========================================================================
// ② 영상 라이브러리.
// ===========================================================================
function VideoLibraryTab({
  onNotice
}: {
  onNotice: ImportPanelProps['onNotice']
}): JSX.Element {
  const [items, setItems] = useState<RemoteMediaItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchVideoLibrary()
      .then(setItems)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => load(), [load])

  const onPick = useCallback(
    async (it: RemoteMediaItem) => {
      setBusyId(it.id)
      const r = await importFromUrl(it.downloadUrl, {
        suggestedName: `${it.id}${it.ext}`,
        displayName: it.title
      })
      setBusyId(null)
      if (r.ok) {
        setImportedIds((prev) => new Set(prev).add(it.id))
        onNotice(`"${it.title}" 가져옴`, 'info')
      } else {
        onNotice(`가져오기 실패: ${r.error}`, 'error')
      }
    },
    [onNotice]
  )

  // CRITICAL — hooks must run on every render path, so this useCallback
  // sits BEFORE the early returns below. Moving it after them produces
  // a hook-count mismatch (React error #310) the moment the tab switches
  // from "loading" to "ready".
  const onDragImport = useCallback(
    async (it: RemoteMediaItem): Promise<MediaAsset | null> => {
      setBusyId(it.id)
      const r = await importFromUrl(it.downloadUrl, {
        suggestedName: `${it.id}${it.ext}`,
        displayName: it.title
      })
      setBusyId(null)
      if (r.ok && r.asset) {
        setImportedIds((prev) => new Set(prev).add(it.id))
        onNotice(`"${it.title}" 가져옴`, 'info')
        return r.asset
      }
      onNotice(`가져오기 실패: ${r.error}`, 'error')
      return null
    },
    [onNotice]
  )
  if (loading) return <div style={styles.state}>영상 라이브러리 불러오는 중…</div>
  if (error) {
    return (
      <div style={styles.body}>
        <div style={styles.errorBox}>불러오기 실패: {error}</div>
        <button style={styles.retry} onClick={load}>
          다시 시도
        </button>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div style={styles.state}>
        저장된 영상이 없습니다. 웹앱에서 먼저 생성·저장해주세요.
      </div>
    )
  }
  return (
    <div style={styles.body}>
      <RemoteGrid
        items={items}
        importedIds={importedIds}
        busyId={busyId}
        onPick={onPick}
        onDragImport={onDragImport}
      />
    </div>
  )
}

// ===========================================================================
// ④ 내부 영상 — 분석 릴스.
// ===========================================================================
function InternalReelsTab({
  onNotice
}: {
  onNotice: ImportPanelProps['onNotice']
}): JSX.Element {
  const [reels, setReels] = useState<ReelSummary[]>([])
  const [items, setItems] = useState<Record<string, RemoteMediaItem>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)
  const enrichStarted = useRef<Set<string>>(new Set())

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    enrichStarted.current.clear()
    setItems({})
    fetchInternalReels()
      .then((rows) => setReels(rows.slice(0, 60)))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => load(), [load])

  // 카드별 lazy metadata (썸네일 + 영상 URL) 채우기.
  useEffect(() => {
    for (const r of reels) {
      const sc = r.shortcode
      if (enrichStarted.current.has(sc)) continue
      enrichStarted.current.add(sc)
      void fetchReelMediaItem(sc).then((it) => {
        if (it) setItems((prev) => ({ ...prev, [sc]: it }))
      })
    }
  }, [reels])

  const onPick = useCallback(
    async (sc: string) => {
      setBusyId(sc)
      const r = await importReel(sc)
      setBusyId(null)
      if (r.ok) {
        setImportedIds((prev) => new Set(prev).add(sc))
        onNotice(`릴스 "${sc}" 가져옴`, 'info')
      } else {
        onNotice(`가져오기 실패: ${r.error}`, 'error')
      }
    },
    [onNotice]
  )

  if (loading) return <div style={styles.state}>릴스 목록 불러오는 중…</div>
  if (error) {
    return (
      <div style={styles.body}>
        <div style={styles.errorBox}>불러오기 실패: {error}</div>
        <button style={styles.retry} onClick={load}>
          다시 시도
        </button>
      </div>
    )
  }
  if (reels.length === 0) {
    return <div style={styles.state}>저장된 릴스가 없습니다.</div>
  }

  // metadata가 채워진 카드 우선, 나머지는 placeholder tile.
  const gridItems: RemoteMediaItem[] = reels.map(
    (r) =>
      items[r.shortcode] ?? {
        id: r.shortcode,
        title: r.shortcode,
        downloadUrl: '',
        ext: '.mp4' as const,
        subtitle: '메타데이터 불러오는 중…'
      }
  )
  const onDragImport = async (
    it: RemoteMediaItem
  ): Promise<MediaAsset | null> => {
    setBusyId(it.id)
    const r = await importReel(it.id)
    setBusyId(null)
    if (r.ok && r.asset) {
      setImportedIds((prev) => new Set(prev).add(it.id))
      onNotice(`릴스 "${it.id}" 가져옴`, 'info')
      return r.asset
    }
    onNotice(`가져오기 실패: ${r.error}`, 'error')
    return null
  }
  return (
    <div style={styles.body}>
      <RemoteGrid
        items={gridItems}
        importedIds={importedIds}
        busyId={busyId}
        onPick={(it) => onPick(it.id)}
        onDragImport={onDragImport}
      />
    </div>
  )
}

// ===========================================================================
// ③ TTS & SRT — 내 대본 picker. 대본의 meta.tts.job에 저장된 TTS를 가져온다.
// ===========================================================================
/** 대본별 TTS 보유 여부 — undefined: 확인 중, true/false: 확인 완료. */
type TtsAvailability = Record<string, boolean | undefined>

function TtsTab({
  onNotice
}: {
  onNotice: ImportPanelProps['onNotice']
}): JSX.Element {
  const [scripts, setScripts] = useState<ScriptPickItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** scriptId -> TTS 보유 여부 (lazy 확인). */
  const [hasTts, setHasTts] = useState<TtsAvailability>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set())
  const checkStarted = useRef<Set<string>>(new Set())

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    checkStarted.current.clear()
    setHasTts({})
    fetchMyScripts()
      .then((rows) => setScripts(rows))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => load(), [load])

  // 대본별 TTS 보유 여부를 lazy로 확인 (목록 API에는 meta.tts가 없음).
  useEffect(() => {
    for (const s of scripts) {
      if (checkStarted.current.has(s.id)) continue
      checkStarted.current.add(s.id)
      void fetchScriptTtsState(s.productId, s.id).then((job) => {
        setHasTts((prev) => ({ ...prev, [s.id]: !!job }))
      })
    }
  }, [scripts])

  const doImportTts = useCallback(
    async (s: ScriptPickItem, addCaptions: boolean): Promise<MediaAsset | null> => {
      if (hasTts[s.id] !== true) return null
      setBusyId(s.id)
      const r = await importScriptTts(s.productId, s.id)
      setBusyId(null)
      if (!r.ok) {
        onNotice(`TTS 가져오기 실패: ${r.error}`, 'error')
        return null
      }
      let captionMsg = ''
      const asset = r.mediaId
        ? useProjectStore.getState().project.media[r.mediaId] ?? null
        : null
      // pptx10 슬라이드 14 (급함) — TTS audio 도 자동으로 voice track 에
      // clip 추가. 이전엔 자막만 timeline 추가하고 audio 는 라이브러리만
      // 들어감 → 재생 시 소리 안 들림 보고. 자막 onPick 경로(addCaptions)
      // 일 때만 — drag 경로는 timeline drop handler 가 별도로 처리.
      if (addCaptions && asset && asset.kind === 'audio') {
        const store = useProjectStore.getState()
        const trackId = store.ensureAudioTrack('voice')
        const dur = asset.durationMs > 0 ? asset.durationMs : 1000
        const clip: VideoAudioClip = {
          id: newId(),
          kind: 'media',
          mediaId: asset.id,
          trackId,
          startMs: 0,
          endMs: dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        }
        store.addClip(clip)
      }
      if (addCaptions && r.cues && r.cues.length > 0) {
        const clips = cuesToClips(r.cues)
        if (clips.length > 0) {
          addClipsToStore(clips)
          captionMsg = ` + 자막 ${clips.length}개`
        }
      }
      setImportedIds((prev) => new Set(prev).add(s.id))
      onNotice(`"${s.title}" TTS 오디오 가져옴${captionMsg}`, 'info')
      return asset
    },
    [hasTts, onNotice]
  )
  const onPick = useCallback(
    async (s: ScriptPickItem) => {
      await doImportTts(s, true)
    },
    [doImportTts]
  )

  if (loading) return <div style={styles.state}>대본 목록 불러오는 중…</div>
  if (error) {
    return (
      <div style={styles.body}>
        <div style={styles.errorBox}>불러오기 실패: {error}</div>
        <button style={styles.retry} onClick={load}>
          다시 시도
        </button>
      </div>
    )
  }
  if (scripts.length === 0) {
    return (
      <div style={styles.state}>
        저장된 대본이 없습니다. 웹앱에서 먼저 대본을 만들어주세요.
      </div>
    )
  }

  // TTS 있는 대본 우선 정렬 (확인 중/없음은 뒤로).
  const sorted = [...scripts].sort((a, b) => {
    const av = hasTts[a.id] === true ? 0 : 1
    const bv = hasTts[b.id] === true ? 0 : 1
    return av - bv
  })

  return (
    <div style={styles.body}>
      <div style={styles.hint}>
        대본을 누르면 그 대본에 저장된 TTS 오디오와 문장별 타이밍(SRT)을
        가져옵니다. 오디오는 미디어 패널에, 자막은 자막 트랙에 추가됩니다.
      </div>
      <div style={styles.scriptList} data-testid="script-picker-list">
        {sorted.map((s) => {
          const state = hasTts[s.id]
          const checking = state === undefined
          const available = state === true
          const busy = busyId === s.id
          const done = importedIds.has(s.id)
          return (
            <div
              key={s.id}
              style={{
                ...styles.scriptRow,
                ...(available ? {} : styles.scriptRowDisabled),
                borderColor: done ? '#10b981' : '#2a2a2a',
                opacity: busy ? 0.6 : available ? 1 : 0.45
              }}
              onClick={() => available && !busy && onPick(s)}
              draggable={available && !busy}
              onDragStart={
                available && !busy
                  ? (e) => {
                      e.dataTransfer.effectAllowed = 'copy'
                      const tempId = newPendingId()
                      e.dataTransfer.setData(PENDING_MEDIA_DRAG_MIME, tempId)
                      e.dataTransfer.setData('text/plain', s.title)
                      registerPending(tempId, doImportTts(s, false), s.title)
                    }
                  : undefined
              }
              data-testid={`script-row-${s.id}`}
              title={s.title}
            >
              <div style={styles.scriptTitle}>
                {done ? '✓ ' : ''}
                {s.title}
              </div>
              {s.subtitle && <div style={styles.scriptSub}>{s.subtitle}</div>}
              <div style={styles.scriptBadge}>
                {busy
                  ? '가져오는 중…'
                  : checking
                    ? 'TTS 확인 중…'
                    : available
                      ? '🎙 TTS 작업 있음 — 클릭해서 가져오기'
                      : 'TTS 작업 없음'}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ===========================================================================
// ④ AI 영상 생성 (백그라운드) — 로컬 이미지 업로드 → Seedance 시작 프레임.
// ===========================================================================
type UploadPhase = 'idle' | 'uploading' | 'done' | 'error'

function AiGenerateTab({
  onNotice
}: {
  onNotice: ImportPanelProps['onNotice']
}): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [withBgm, setWithBgm] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  // ── 로컬 이미지 업로드 상태 ──
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>('idle')
  const [uploadError, setUploadError] = useState<string | null>(null)
  /** 업로드 완료된 이미지의 fal storage URL (Seedance 시작 프레임). */
  const [imageUrl, setImageUrl] = useState('')
  /** 로컬 미리보기용 object URL. */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const jobs = useAiJobs((s) => s.jobs)
  const registerJob = useAiJobs((s) => s.registerJob)
  const dismissJob = useAiJobs((s) => s.dismissJob)

  // 컴포넌트 언마운트 시 미리보기 object URL 정리.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const onFilePicked = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      if (!file.type.startsWith('image/')) {
        setUploadPhase('error')
        setUploadError('이미지 파일만 업로드할 수 있습니다')
        return
      }
      // 이전 미리보기 정리 + 새 미리보기.
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(file)
      })
      setFileName(file.name)
      setUploadPhase('uploading')
      setUploadError(null)
      setImageUrl('')
      try {
        const buf = await file.arrayBuffer()
        const url = await uploadSeedanceImage(buf, file.name, file.type)
        setImageUrl(url)
        setUploadPhase('done')
      } catch (err) {
        setUploadPhase('error')
        setUploadError(err instanceof Error ? err.message : String(err))
      }
    },
    []
  )

  const onSubmit = useCallback(async () => {
    const p = prompt.trim()
    if (!p) {
      onNotice('프롬프트를 입력하세요', 'error')
      return
    }
    if (!imageUrl) {
      onNotice('시작 이미지를 업로드하세요 (Seedance는 이미지→영상)', 'error')
      return
    }
    setSubmitting(true)
    try {
      const res = await submitSeedanceJob({
        prompt: p,
        mode: 'transition',
        image_url: imageUrl,
        generate_audio: withBgm
      })
      registerJob(res.request_id, p)
      onNotice('AI 영상 생성을 백그라운드로 시작했습니다', 'info')
      setPrompt('')
      setImageUrl('')
      setUploadPhase('idle')
      setUploadError(null)
      setFileName('')
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    } catch (err) {
      onNotice(
        `생성 요청 실패: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
    } finally {
      setSubmitting(false)
    }
  }, [prompt, imageUrl, withBgm, registerJob, onNotice])

  const jobList = Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt)
  const uploading = uploadPhase === 'uploading'

  return (
    <div style={styles.body}>
      <div style={styles.form}>
        <div style={styles.label}>프롬프트</div>
        <textarea
          style={styles.textarea}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="생성할 영상을 설명하세요"
          disabled={submitting}
          data-testid="ai-prompt-input"
        />
        <div style={styles.label}>시작 이미지 (로컬 파일)</div>
        {/* 숨겨진 file input — 렌더러 File은 arrayBuffer()로 바로 읽힌다. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            void onFilePicked(e.target.files?.[0])
            // 같은 파일 재선택 허용.
            e.target.value = ''
          }}
          data-testid="ai-image-file"
        />
        <button
          style={styles.fileBtn}
          onClick={() => fileInputRef.current?.click()}
          disabled={submitting || uploading}
          data-testid="ai-image-pick-btn"
        >
          {uploading
            ? '업로드 중…'
            : uploadPhase === 'done'
              ? '이미지 변경'
              : '이미지 선택'}
        </button>
        {previewUrl && (
          <img src={previewUrl} alt={fileName} style={styles.imgPreview} />
        )}
        {uploadPhase === 'uploading' && (
          <div style={styles.hint}>이미지 업로드 중… ({fileName})</div>
        )}
        {uploadPhase === 'done' && (
          <div style={{ ...styles.hint, color: '#86efac' }}>
            ✓ 이미지 업로드 완료 — 생성 시작 가능
          </div>
        )}
        {uploadPhase === 'error' && (
          <div style={styles.errorBox}>
            이미지 업로드 실패: {uploadError}
          </div>
        )}
        <label style={styles.checkRow}>
          <input
            type="checkbox"
            checked={withBgm}
            onChange={(e) => setWithBgm(e.target.checked)}
            disabled={submitting}
          />
          BGM·오디오 함께 생성
        </label>
        <button
          style={styles.primaryBtn}
          onClick={onSubmit}
          disabled={submitting || uploading || uploadPhase !== 'done'}
          data-testid="ai-submit-btn"
        >
          {submitting ? '요청 중…' : '백그라운드로 생성 시작'}
        </button>
        <div style={styles.hint}>
          로컬 이미지를 업로드하면 그 이미지를 시작 프레임으로 영상을
          생성합니다. 생성은 백그라운드에서 진행되며 편집을 막지 않습니다.
          완료되면 영상이 미디어 패널에 자동 추가됩니다.
        </div>
      </div>

      {jobList.length > 0 && (
        <>
          <div style={{ ...styles.label, marginTop: 8 }}>생성 잡</div>
          {jobList.map((j) => (
            <div key={j.id} style={styles.jobRow} data-testid={`ai-job-${j.id}`}>
              <div style={{ color: '#e2e8f0', fontWeight: 600 }}>{j.label}</div>
              <div style={{ color: phaseColor(j.phase) }}>
                {phaseLabel(j)}
              </div>
              {(j.phase === 'done' || j.phase === 'error') && (
                <button
                  style={styles.jobDismiss}
                  onClick={() => dismissJob(j.id)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function phaseColor(phase: string): string {
  if (phase === 'done') return '#86efac'
  if (phase === 'error') return '#fca5a5'
  return '#9aa0a6'
}

function phaseLabel(j: {
  phase: string
  queuePosition?: number
  error?: string
}): string {
  switch (j.phase) {
    case 'queued':
      return j.queuePosition != null
        ? `큐 대기 중 (${j.queuePosition}번)`
        : '큐 대기 중…'
    case 'running':
      return '생성 중…'
    case 'importing':
      return '영상 가져오는 중…'
    case 'done':
      return '✓ 미디어 패널에 추가됨'
    case 'error':
      return `실패: ${j.error ?? '알 수 없는 오류'}`
    default:
      return j.phase
  }
}

// ===========================================================================
// 음악 라이브러리 — 음악·효과음 카탈로그 (미리듣기 + 오디오 트랙 삽입).
// ===========================================================================
/** ms → "MM:SS". */
function fmtMmSs(ms: number): string {
  if (!ms || ms <= 0) return '0:00'
  const totalSec = Math.round(ms / 1000)
  const mm = Math.floor(totalSec / 60)
  const ss = totalSec % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}

/**
 * 타임라인 [startMs, startMs+durMs) 구간과 겹치는 클립이 있으면, 겹치는
 * 클립들 중 가장 늦은 끝(endMs) 뒤로 밀어 비어있는 시작점을 돌려준다.
 * 겹치는 게 없으면 startMs 그대로.
 */
function resolvePlacementMs(
  clips: Clip[],
  startMs: number,
  durMs: number
): number {
  const wantEnd = startMs + durMs
  let maxOverlapEnd = -1
  for (const c of clips) {
    if (c.startMs < wantEnd && c.endMs > startMs) {
      if (c.endMs > maxOverlapEnd) maxOverlapEnd = c.endMs
    }
  }
  return maxOverlapEnd >= 0 ? maxOverlapEnd : startMs
}

const MUSIC_CATEGORY_CHIPS: { key: 'all' | MusicCategory; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'music', label: '음악' },
  { key: 'sfx', label: '효과음' }
]

function MusicLibraryTab({
  onNotice
}: {
  onNotice: ImportPanelProps['onNotice']
}): JSX.Element {
  const [items, setItems] = useState<MusicTrackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<'all' | MusicCategory>('all')
  const [query, setQuery] = useState('')
  /** 300ms 디바운스된 검색어 — 실제 fetch 트리거. */
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  // ── 미리듣기 상태 ──
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  /**
   * 미리듣기 전용 단일 <audio>. 타임라인 transport(useTimelineUi)와 절대
   * 연동하지 않는다 — 재생/일시정지가 타임라인과 무관하게 독립 동작.
   */
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (audioRef.current === null && typeof Audio !== 'undefined') {
    audioRef.current = new Audio()
  }

  // 검색어 디바운스 (300ms).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(t)
  }, [query])

  // category / 디바운스 검색어 변경 시 첫 페이지 재조회.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchMusicLibrary({ category, q: debouncedQuery })
      .then((res) => {
        if (cancelled) return
        setItems(res.items)
        setNextCursor(res.nextCursor)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setItems([])
        setNextCursor(undefined)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [category, debouncedQuery])

  // 미리듣기 audio 이벤트 — ended/error/pause 시 재생 표시 해제.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onEnded = (): void => setPreviewingId(null)
    const onPause = (): void => setPreviewingId(null)
    const onErr = (): void => {
      setPreviewingId(null)
      setPreviewError(el.dataset.trackId ?? null)
    }
    el.addEventListener('ended', onEnded)
    el.addEventListener('pause', onPause)
    el.addEventListener('error', onErr)
    return () => {
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('error', onErr)
    }
  }, [])

  // 언마운트 시 미리듣기 정리.
  useEffect(() => {
    return () => {
      const el = audioRef.current
      if (el) {
        el.pause()
        el.removeAttribute('src')
        el.load()
      }
    }
  }, [])

  const togglePreview = useCallback((it: MusicTrackItem) => {
    const el = audioRef.current
    if (!el) return
    setPreviewError(null)
    // 같은 행을 다시 누르면 정지.
    if (previewingId === it.id) {
      el.pause()
      setPreviewingId(null)
      return
    }
    // 다른 행 선택 — 이전 미리듣기 정지 후 새로 재생.
    el.pause()
    el.dataset.trackId = it.id
    el.src = it.previewUrl ?? it.downloadUrl
    el.currentTime = 0
    setPreviewingId(it.id)
    void el.play().catch(() => {
      setPreviewingId(null)
      setPreviewError(it.id)
    })
  }, [previewingId])

  const onAdd = useCallback(
    async (it: MusicTrackItem) => {
      setBusyId(it.id)
      const r = await importFromUrl(it.downloadUrl, {
        suggestedName: `${it.id}${it.ext}`,
        displayName: it.artist ? `${it.title} · ${it.artist}` : it.title
      })
      if (!r.ok || !r.asset) {
        setBusyId(null)
        onNotice(`추가 실패: ${r.error ?? '알 수 없는 오류'}`, 'error')
        return
      }
      const asset = r.asset
      const store = useProjectStore.getState()
      // 트랙 해석 — 음악은 BGM, 효과음은 SFX 트랙.
      let trackId: string
      if (it.category === 'music') {
        trackId = store.ensureAudioTrack('bgm')
      } else {
        const sfxTrack = store.project.tracks.find(
          (t) => t.kind === 'audio' && t.role === 'sfx'
        )
        if (sfxTrack) {
          trackId = sfxTrack.id
        } else {
          const created = store.addTrack('audio', 'sfx')
          if (created) {
            trackId = created
          } else {
            // 오디오 트랙 cap 도달 — BGM 트랙으로 폴백.
            trackId = store.ensureAudioTrack('bgm')
            onNotice(
              '효과음 트랙을 만들 수 없어 BGM 트랙에 추가했습니다',
              'error'
            )
          }
        }
      }
      // 플레이헤드 위치에 배치 — 겹치면 겹친 클립 끝 뒤로.
      const playheadMs = useTimelineUi.getState().playheadMs
      const targetTrack = useProjectStore
        .getState()
        .project.tracks.find((t) => t.id === trackId)
      const startMs = resolvePlacementMs(
        targetTrack?.clips ?? [],
        playheadMs,
        asset.durationMs
      )
      const clip: VideoAudioClip = {
        id: newId(),
        kind: 'media',
        mediaId: asset.id,
        trackId,
        startMs,
        endMs: startMs + asset.durationMs,
        trimInMs: 0,
        trimOutMs: asset.durationMs,
        speed: 1
      }
      useProjectStore.getState().addClip(clip)
      setAddedIds((prev) => new Set(prev).add(it.id))
      setBusyId(null)
      onNotice(`"${it.title}" 추가됨`, 'info')
    },
    [onNotice]
  )

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    fetchMusicLibrary({ category, q: debouncedQuery, cursor: nextCursor })
      .then((res) => {
        setItems((prev) => [...prev, ...res.items])
        setNextCursor(res.nextCursor)
      })
      .catch((e: unknown) =>
        onNotice(
          `더 불러오기 실패: ${e instanceof Error ? e.message : String(e)}`,
          'error'
        )
      )
      .finally(() => setLoadingMore(false))
  }, [nextCursor, loadingMore, category, debouncedQuery, onNotice])

  const retry = useCallback(() => {
    // debouncedQuery 의존 effect를 다시 트리거하기 위해 강제로 동일값 set.
    setDebouncedQuery((q) => q)
    setLoading(true)
    setError(null)
    fetchMusicLibrary({ category, q: debouncedQuery })
      .then((res) => {
        setItems(res.items)
        setNextCursor(res.nextCursor)
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setLoading(false))
  }, [category, debouncedQuery])

  // 필터 바 — 어느 상태에서나 보이게 상단에 고정.
  const filterBar = (
    <div style={styles.filterBar}>
      <div style={styles.chipRow}>
        {MUSIC_CATEGORY_CHIPS.map((c) => (
          <button
            key={c.key}
            style={{
              ...styles.chip,
              ...(category === c.key ? styles.chipActive : {})
            }}
            onClick={() => setCategory(c.key)}
            data-testid={`music-chip-${c.key}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <input
        style={styles.searchInput}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="제목·아티스트·분위기 검색"
        data-testid="music-search"
      />
    </div>
  )

  return (
    <div style={styles.body}>
      {filterBar}
      {loading ? (
        <div style={styles.state}>음악 라이브러리 불러오는 중…</div>
      ) : error ? (
        <>
          <div style={styles.errorBox}>불러오기 실패: {error}</div>
          <button style={styles.retry} onClick={retry}>
            다시 시도
          </button>
        </>
      ) : items.length === 0 ? (
        <div style={styles.state}>
          {query.trim()
            ? '검색 결과가 없습니다.'
            : '음악 라이브러리가 비어있습니다.'}
        </div>
      ) : (
        <>
          <div style={styles.musicList} data-testid="music-list">
            {items.map((it) => {
              const busy = busyId === it.id
              const added = addedIds.has(it.id)
              const playing = previewingId === it.id
              return (
                <div
                  key={it.id}
                  style={{
                    ...styles.musicRow,
                    opacity: busy ? 0.6 : 1,
                    borderColor: added ? '#10b981' : '#2a2a2a'
                  }}
                  data-testid={`music-row-${it.id}`}
                  title={it.title}
                  draggable={!busy}
                  onDragStart={
                    !busy
                      ? (e) => {
                          e.dataTransfer.effectAllowed = 'copy'
                          const tempId = newPendingId()
                          e.dataTransfer.setData(PENDING_MEDIA_DRAG_MIME, tempId)
                          e.dataTransfer.setData('text/plain', it.title)
                          setBusyId(it.id)
                          const p = importFromUrl(it.downloadUrl, {
                            suggestedName: `${it.id}${it.ext}`,
                            displayName: it.artist
                              ? `${it.title} · ${it.artist}`
                              : it.title
                          }).then((r): MediaAsset | null => {
                            setBusyId(null)
                            if (r.ok && r.asset) {
                              setAddedIds((prev) => new Set(prev).add(it.id))
                              onNotice(`"${it.title}" 가져옴`, 'info')
                              return r.asset
                            }
                            onNotice(
                              `가져오기 실패: ${r.error ?? '알 수 없는 오류'}`,
                              'error'
                            )
                            return null
                          })
                          registerPending(tempId, p, it.title)
                        }
                      : undefined
                  }
                >
                  <div style={styles.musicGlyph}>
                    {it.category === 'sfx' ? '🔊' : '♪'}
                  </div>
                  <div style={styles.musicInfo}>
                    <div style={styles.musicTitle}>
                      {added ? '✓ ' : ''}
                      {it.title}
                    </div>
                    <div style={styles.musicMeta}>
                      {it.artist && <span>{it.artist}</span>}
                      <span>{fmtMmSs(it.durationMs)}</span>
                      {it.bpm != null && (
                        <span style={styles.musicTag}>{it.bpm} BPM</span>
                      )}
                      {it.mood && (
                        <span style={styles.musicTag}>{it.mood}</span>
                      )}
                      {it.genre && (
                        <span style={styles.musicTag}>{it.genre}</span>
                      )}
                    </div>
                    {previewError === it.id && (
                      <div style={styles.musicPreviewNote}>
                        미리듣기를 재생할 수 없습니다
                      </div>
                    )}
                  </div>
                  <div style={styles.musicBtns}>
                    <button
                      style={styles.iconBtn}
                      onClick={() => togglePreview(it)}
                      data-testid={`music-preview-${it.id}`}
                      title={playing ? '미리듣기 정지' : '미리듣기'}
                    >
                      {playing ? '⏸' : '▶'}
                    </button>
                    <button
                      style={styles.addBtn}
                      onClick={() => void onAdd(it)}
                      disabled={busy}
                      data-testid={`music-add-${it.id}`}
                    >
                      {busy ? '추가 중…' : '추가'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          {nextCursor && (
            <button
              style={styles.loadMore}
              onClick={loadMore}
              disabled={loadingMore}
              data-testid="music-load-more"
            >
              {loadingMore ? '불러오는 중…' : '더 보기'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ===========================================================================
// Phase 8 — 효과음 (SFX) 탭.
//   소스 토글: 우리 라이브러리 / Freesound.
//   결과 카드: 이름 · 길이 · 라이선스 배지 · 태그 · 저작자(Freesound).
//     ▶ 미리듣기 — HTMLAudioElement 하나로 동시 1개만 재생.
//     가져오기 — `importSfxFromUrl`로 다운로드 + sfxMeta 부착.
//   라이선스 배지: CC0(녹색) · CC-BY(파랑, 저작자 표기 안내 툴팁) · 기타(주황).
//   Freesound 503(키 미설정)은 별도 경고 배너로 graceful degrade.
// ===========================================================================
type SfxSource = 'ours' | 'freesound'

function SfxTab({
  onNotice
}: {
  onNotice: ImportPanelProps['onNotice']
}): JSX.Element {
  const [source, setSource] = useState<SfxSource>('ours')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<SfxItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Freesound 키 미설정(503) 전용 경고 — 일반 error와 분리해 톤을 다르게. */
  const [freesoundUnconfigured, setFreesoundUnconfigured] = useState(false)
  /** 처음 진입 직후 / 검색 전 안내 상태 식별용. */
  const [hasSearched, setHasSearched] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set())
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [previewErrorId, setPreviewErrorId] = useState<string | null>(null)

  /** 미리듣기 전용 단일 <audio>. 한 번에 한 트랙만 재생. */
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (audioRef.current === null && typeof Audio !== 'undefined') {
    audioRef.current = new Audio()
  }

  // audio 이벤트 — 종료/일시정지/에러 시 재생 표시 해제.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onEnded = (): void => setPreviewingId(null)
    const onPause = (): void => setPreviewingId(null)
    const onErr = (): void => {
      setPreviewingId(null)
      setPreviewErrorId(el.dataset.sfxId ?? null)
    }
    el.addEventListener('ended', onEnded)
    el.addEventListener('pause', onPause)
    el.addEventListener('error', onErr)
    return () => {
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('error', onErr)
    }
  }, [])

  // 언마운트 시 정리.
  useEffect(() => {
    return () => {
      const el = audioRef.current
      if (el) {
        el.pause()
        el.removeAttribute('src')
        el.load()
      }
    }
  }, [])

  // 소스 전환 시 결과·에러 초기화 (검색은 사용자가 다시 트리거).
  useEffect(() => {
    setItems([])
    setError(null)
    setFreesoundUnconfigured(false)
    setHasSearched(false)
    setPreviewErrorId(null)
    const el = audioRef.current
    if (el) el.pause()
  }, [source])

  const runSearch = useCallback(async () => {
    const q = query.trim()
    // 우리 라이브러리는 빈 검색도 허용(전체 목록), Freesound는 검색어 필요.
    if (source === 'freesound' && !q) {
      onNotice('Freesound는 검색어를 입력해야 합니다', 'error')
      return
    }
    setLoading(true)
    setError(null)
    setFreesoundUnconfigured(false)
    setHasSearched(true)
    setPreviewErrorId(null)
    try {
      const rows =
        source === 'ours'
          ? await searchOurSfx(q || undefined)
          : await searchFreesound(q)
      setItems(rows)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'FREESOUND_NOT_CONFIGURED') {
        setItems([])
        setFreesoundUnconfigured(true)
      } else {
        setItems([])
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }, [query, source, onNotice])

  const togglePreview = useCallback(
    (it: SfxItem) => {
      const el = audioRef.current
      if (!el) return
      setPreviewErrorId(null)
      if (previewingId === it.id) {
        el.pause()
        setPreviewingId(null)
        return
      }
      el.pause()
      el.dataset.sfxId = it.id
      el.src = it.previewUrl
      el.currentTime = 0
      setPreviewingId(it.id)
      void el.play().catch(() => {
        setPreviewingId(null)
        setPreviewErrorId(it.id)
      })
    },
    [previewingId]
  )

  const onImport = useCallback(
    async (it: SfxItem) => {
      // 미리듣기 중이면 정지 (다운로드 중에도 계속 재생되는 것 방지).
      const el = audioRef.current
      if (el && previewingId === it.id) {
        el.pause()
        setPreviewingId(null)
      }
      setBusyId(it.id)
      const meta = {
        source: it.source,
        license: it.license,
        ...(it.attribution ? { attribution: it.attribution } : {}),
        ...(it.sourceUrl ? { sourceUrl: it.sourceUrl } : {})
      }
      const r = await importSfxFromUrl(it.downloadUrl, it.name, meta)
      setBusyId(null)
      if (r.ok) {
        setImportedIds((prev) => new Set(prev).add(it.id))
        onNotice(`효과음 "${it.name}" 가져옴`, 'info')
      } else {
        onNotice(`효과음 가져오기 실패: ${r.error}`, 'error')
      }
    },
    [onNotice, previewingId]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void runSearch()
    }
  }

  const licenseBadge = (it: SfxItem): JSX.Element => {
    const lic = it.license
    if (lic === 'CC0') {
      return (
        <span
          style={styles.sfxLicenseCc0}
          data-testid={`sfx-license-${it.id}`}
          title="퍼블릭 도메인 — 자유롭게 사용 가능"
        >
          CC0
        </span>
      )
    }
    if (lic === 'CC-BY') {
      return (
        <span
          style={styles.sfxLicenseCcBy}
          data-testid={`sfx-license-${it.id}`}
          title={`저작자 표기 필요${it.attribution ? ` — ${it.attribution}` : ''}`}
        >
          CC-BY
        </span>
      )
    }
    return (
      <span
        style={styles.sfxLicenseOther}
        data-testid={`sfx-license-${it.id}`}
        title={`라이선스: ${lic} — 사용 조건 확인 필요`}
      >
        {lic}
      </span>
    )
  }

  return (
    <div style={styles.body}>
      {/* 소스 토글 */}
      <div
        style={styles.sfxSourceToggle}
        data-testid="sfx-source-toggle"
        role="tablist"
      >
        <button
          style={{
            ...styles.sfxSourceBtn,
            ...(source === 'ours' ? styles.sfxSourceBtnActive : {})
          }}
          onClick={() => setSource('ours')}
          data-testid="sfx-source-ours"
          role="tab"
          aria-selected={source === 'ours'}
        >
          우리 라이브러리
        </button>
        <button
          style={{
            ...styles.sfxSourceBtn,
            ...(source === 'freesound' ? styles.sfxSourceBtnActive : {})
          }}
          onClick={() => setSource('freesound')}
          data-testid="sfx-source-freesound"
          role="tab"
          aria-selected={source === 'freesound'}
        >
          Freesound
        </button>
      </div>

      {/* 검색바 */}
      <div style={styles.sfxSearchRow}>
        <input
          style={styles.searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            source === 'freesound'
              ? '예: rain, footsteps, swoosh (검색어 필수)'
              : '예: 박수, 알림음 (비워두면 전체)'
          }
          data-testid="sfx-search-input"
        />
        <button
          style={styles.sfxSearchBtn}
          onClick={() => void runSearch()}
          disabled={loading}
          data-testid="sfx-search-btn"
        >
          {loading ? '검색 중…' : '검색'}
        </button>
      </div>

      <div style={styles.hint}>
        가져오는 효과음에는 라이선스 정보가 자동으로 함께 저장됩니다.
        CC-BY는 추후 영상 내보내기 시 저작자 표기가 자동으로 들어갈 수 있게
        준비됩니다.
      </div>

      {/* Freesound 503 — 별도 톤의 경고 배너 */}
      {freesoundUnconfigured && (
        <div style={styles.sfxWarnBanner} data-testid="sfx-error">
          Freesound API 키가 설정되지 않았습니다 — 관리자에게 설정을 요청하거나
          “우리 라이브러리” 탭을 사용해주세요.
        </div>
      )}

      {/* 일반 에러 배너 */}
      {error && !freesoundUnconfigured && (
        <div style={styles.errorBox} data-testid="sfx-error">
          불러오기 실패: {error}
        </div>
      )}

      {/* 결과 */}
      {loading ? (
        <div style={styles.state}>효과음 검색 중…</div>
      ) : items.length === 0 ? (
        !error && !freesoundUnconfigured ? (
          <div style={styles.state} data-testid="sfx-empty">
            {hasSearched
              ? '검색 결과가 없습니다.'
              : source === 'freesound'
                ? '검색어를 입력해 Freesound에서 효과음을 찾아보세요.'
                : '검색어를 입력하거나 [검색]을 눌러 전체 라이브러리를 보세요.'}
          </div>
        ) : null
      ) : (
        <div style={styles.sfxGrid} data-testid="sfx-grid">
          {items.map((it) => {
            const busy = busyId === it.id
            const done = importedIds.has(it.id)
            const playing = previewingId === it.id
            const previewBroken = previewErrorId === it.id
            return (
              <div
                key={it.id}
                style={{
                  ...styles.sfxCard,
                  opacity: busy ? 0.6 : 1,
                  borderColor: done ? '#10b981' : '#2a2a2a'
                }}
                data-testid={`sfx-card-${it.id}`}
                title={it.name}
                draggable={!busy}
                onDragStart={
                  !busy
                    ? (e) => {
                        e.dataTransfer.effectAllowed = 'copy'
                        const tempId = newPendingId()
                        e.dataTransfer.setData(PENDING_MEDIA_DRAG_MIME, tempId)
                        e.dataTransfer.setData('text/plain', it.name)
                        const el = audioRef.current
                        if (el && previewingId === it.id) {
                          el.pause()
                          setPreviewingId(null)
                        }
                        setBusyId(it.id)
                        const meta = {
                          source: it.source,
                          license: it.license,
                          ...(it.attribution ? { attribution: it.attribution } : {}),
                          ...(it.sourceUrl ? { sourceUrl: it.sourceUrl } : {})
                        }
                        const p = importSfxFromUrl(it.downloadUrl, it.name, meta).then(
                          (r): MediaAsset | null => {
                            setBusyId(null)
                            if (r.ok && r.asset) {
                              setImportedIds((prev) => new Set(prev).add(it.id))
                              onNotice(`효과음 "${it.name}" 가져옴`, 'info')
                              return r.asset
                            }
                            onNotice(`효과음 가져오기 실패: ${r.error}`, 'error')
                            return null
                          }
                        )
                        registerPending(tempId, p, it.name)
                      }
                    : undefined
                }
              >
                <div style={styles.sfxCardHeader}>
                  <div style={styles.sfxCardName}>
                    {done ? '✓ ' : ''}🔊 {it.name}
                  </div>
                  {licenseBadge(it)}
                </div>
                <div style={styles.sfxCardMeta}>
                  <span>{fmtMmSs(it.durationMs)}</span>
                  {it.source === 'freesound' && it.username && (
                    <span>by {it.username}</span>
                  )}
                  {it.source === 'freesound' && it.sourceUrl && (
                    <a
                      href={it.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: '#94a3b8', textDecoration: 'underline' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      원본
                    </a>
                  )}
                </div>
                {it.tags.length > 0 && (
                  <div style={styles.sfxTagsRow}>
                    {it.tags.slice(0, 6).map((t) => (
                      <span key={t} style={styles.sfxTag}>
                        #{t}
                      </span>
                    ))}
                  </div>
                )}
                {previewBroken && (
                  <div style={styles.musicPreviewNote}>
                    미리듣기를 재생할 수 없습니다
                  </div>
                )}
                <div style={styles.sfxBtnRow}>
                  <button
                    style={styles.iconBtn}
                    onClick={() => togglePreview(it)}
                    data-testid={`sfx-preview-${it.id}`}
                    title={playing ? '미리듣기 정지' : '미리듣기'}
                  >
                    {playing ? '⏸ 정지' : '▶ 미리듣기'}
                  </button>
                  <button
                    style={styles.addBtn}
                    onClick={() => void onImport(it)}
                    disabled={busy}
                    data-testid={`sfx-import-${it.id}`}
                  >
                    {busy ? '가져오는 중…' : '가져오기'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ===========================================================================
// 라우터.
// ===========================================================================
export function ImportPanel({ tab, onNotice }: ImportPanelProps): JSX.Element {
  switch (tab) {
    case 'library':
      return <VideoLibraryTab onNotice={onNotice} />
    case 'tts':
      return <TtsTab onNotice={onNotice} />
    case 'ai':
      return <AiGenerateTab onNotice={onNotice} />
    case 'internal':
      return <InternalReelsTab onNotice={onNotice} />
    case 'music':
      return <MusicLibraryTab onNotice={onNotice} />
    case 'sfx':
      return <SfxTab onNotice={onNotice} />
    case 'brand':
      return <BrandKitPanel onNotice={onNotice} />
    default:
      // 'local' 탭은 부모(MediaLibrary)가 직접 렌더 — 여기 도달하지 않음.
      return <div style={styles.state} />
  }
}
