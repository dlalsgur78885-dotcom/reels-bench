import { useEffect, useMemo, useState } from 'react'
import type { MediaAsset } from '../../../shared/project'
import { useProjectStore } from '../store/project'
import { importFilesByPath } from '../lib/mediaImport'
import { ImportPanel, type ImportTab } from './ImportPanel'

/** dataTransfer MIME used to carry a mediaId from MediaLibrary to Timeline. */
export const MEDIA_DRAG_MIME = 'application/x-reels-media-id'
// Reels 11 슬라이드 11 — drag 중에도 media kind 를 알 수 있도록 kind 별
// MIME 동시 등록. dragOver 시점엔 dataTransfer.getData 가 빈 문자열만
// 반환하므로 (보안) MIME types 배열로 호환성을 판단.
export const MEDIA_DRAG_KIND_MIME = (kind: 'video' | 'audio' | 'image'): string =>
  `application/x-reels-media-kind-${kind}`

const SUPPORTED_EXTS = new Set([
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v',
  'mp3',
  'wav',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif'
])

const ALL_FOLDERS = '__all__'

type MediaSortKey =
  | 'importedDesc'
  | 'importedAsc'
  | 'nameAsc'
  | 'nameDesc'
  | 'durationDesc'
  | 'durationAsc'
  | 'kindAsc'
  | 'sizeDesc'

const MEDIA_SORT_OPTIONS: { key: MediaSortKey; label: string }[] = [
  { key: 'importedDesc', label: '최근 가져온 순' },
  { key: 'importedAsc', label: '오래된 순' },
  { key: 'nameAsc', label: '이름 오름차순' },
  { key: 'nameDesc', label: '이름 내림차순' },
  { key: 'durationDesc', label: '길이 긴 순' },
  { key: 'durationAsc', label: '길이 짧은 순' },
  { key: 'kindAsc', label: '종류별' },
  { key: 'sizeDesc', label: '용량 큰 순' }
]

function extOf(filePath: string): string {
  const ix = filePath.lastIndexOf('.')
  if (ix < 0) return ''
  return filePath.slice(ix + 1).toLowerCase()
}

function isSupported(filePath: string): boolean {
  return SUPPORTED_EXTS.has(extOf(filePath))
}

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return '—'
  const totalSec = Math.round(ms / 1000)
  const mm = Math.floor(totalSec / 60)
  const ss = totalSec % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

function fmtSize(bytes: number): string {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  const kb = bytes / 1024
  return `${kb.toFixed(0)} KB`
}

function parentDir(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (i <= 0) return ''
  return filePath.slice(0, i)
}

function folderName(dir: string): string {
  if (!dir) return '폴더 없음'
  const trimmed = dir.replace(/[\\/]$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return i >= 0 ? trimmed.slice(i + 1) : trimmed
}

function compareBySort(a: MediaAsset, b: MediaAsset, sortKey: MediaSortKey): number {
  const byName = a.fileName.localeCompare(b.fileName, 'ko')
  switch (sortKey) {
    case 'importedAsc':
      return a.importedAt - b.importedAt || byName
    case 'nameAsc':
      return byName || b.importedAt - a.importedAt
    case 'nameDesc':
      return -byName || b.importedAt - a.importedAt
    case 'durationDesc':
      return b.durationMs - a.durationMs || byName
    case 'durationAsc':
      return a.durationMs - b.durationMs || byName
    case 'kindAsc':
      return a.kind.localeCompare(b.kind) || byName
    case 'sizeDesc':
      return b.fileSizeBytes - a.fileSizeBytes || byName
    case 'importedDesc':
    default:
      return b.importedAt - a.importedAt || byName
  }
}

// ---------------------------------------------------------------------------
// Styles.
// ---------------------------------------------------------------------------
const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: '#141414',
    borderRight: '1px solid #2a2a2a',
    minWidth: 280,
    position: 'relative',
    transition: 'box-shadow 120ms ease, background 120ms ease'
  } as React.CSSProperties,
  wrapDragActive: {
    background: '#1a2a22',
    boxShadow: 'inset 0 0 0 3px #10b981'
  } as React.CSSProperties,
  wrapDragOverlay: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(16, 185, 129, 0.10)',
    color: '#86efac',
    fontSize: 16,
    fontWeight: 700,
    zIndex: 50,
    border: '3px dashed #10b981',
    borderRadius: 6
  } as React.CSSProperties,
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid #2a2a2a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8
  } as React.CSSProperties,
  title: {
    fontSize: 13,
    fontWeight: 600,
    color: '#f5f5f5',
    letterSpacing: 0.2
  } as React.CSSProperties,
  importBtn: {
    background: '#10b981',
    color: '#04231a',
    border: 'none',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer'
  } as React.CSSProperties,
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  } as React.CSSProperties,
  libraryControls: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
    padding: '0 12px 10px'
  } as React.CSSProperties,
  controlBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0
  } as React.CSSProperties,
  controlLabel: {
    fontSize: 10,
    color: '#64748b',
    fontWeight: 700
  } as React.CSSProperties,
  select: {
    width: '100%',
    minWidth: 0,
    background: '#0d0d0d',
    color: '#e2e8f0',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 11,
    fontWeight: 600
  } as React.CSSProperties,
  card: {
    display: 'flex',
    gap: 10,
    padding: 8,
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    cursor: 'grab',
    position: 'relative'
  } as React.CSSProperties,
  thumb: {
    width: 72,
    height: 72,
    flexShrink: 0,
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    objectFit: 'cover',
    display: 'block'
  } as React.CSSProperties,
  thumbPlaceholder: {
    width: 72,
    height: 72,
    flexShrink: 0,
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    color: '#475569',
    fontSize: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  } as React.CSSProperties,
  info: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2
  } as React.CSSProperties,
  filename: {
    fontSize: 12,
    fontWeight: 600,
    color: '#f5f5f5',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'text'
  } as React.CSSProperties,
  filenameInput: {
    fontSize: 12,
    fontWeight: 600,
    color: '#f5f5f5',
    background: '#0a0a0a',
    border: '1px solid #4f46e5',
    borderRadius: 3,
    padding: '2px 4px',
    width: '100%',
    boxSizing: 'border-box',
    outline: 'none'
  } as React.CSSProperties,
  meta: {
    fontSize: 11,
    color: '#9aa0a6'
  } as React.CSSProperties,
  metaSub: {
    fontSize: 10,
    color: '#64748b'
  } as React.CSSProperties,
  removeBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    border: 'none',
    borderRadius: 10,
    background: '#0d0d0d',
    color: '#fca5a5',
    fontSize: 14,
    lineHeight: 1,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  } as React.CSSProperties,
  renameBtn: {
    position: 'absolute',
    top: 4,
    right: 28,
    width: 20,
    height: 20,
    border: 'none',
    borderRadius: 10,
    background: '#0d0d0d',
    color: '#a5b4fc',
    fontSize: 12,
    lineHeight: 1,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  } as React.CSSProperties,
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#64748b',
    fontSize: 12,
    padding: 16,
    textAlign: 'center'
  } as React.CSSProperties,
  drop: {
    margin: 12,
    padding: 16,
    border: '2px dashed #334155',
    borderRadius: 8,
    color: '#9aa0a6',
    fontSize: 12,
    textAlign: 'center',
    transition: 'background 120ms ease, border-color 120ms ease'
  } as React.CSSProperties,
  dropActive: {
    borderColor: '#10b981',
    background: 'rgba(16, 185, 129, 0.08)',
    color: '#86efac'
  } as React.CSSProperties,
  importingRow: {
    margin: '0 12px',
    padding: '8px 12px',
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    color: '#cbd5e1',
    fontSize: 11
  } as React.CSSProperties,
  errorRow: {
    margin: '0 12px',
    padding: '8px 12px',
    background: '#2a0d0d',
    border: '1px solid #4a1f1f',
    borderRadius: 6,
    color: '#fca5a5',
    fontSize: 11
  } as React.CSSProperties,
  infoRow: {
    margin: '0 12px',
    padding: '8px 12px',
    background: '#0d2a1a',
    border: '1px solid #1f4a35',
    borderRadius: 6,
    color: '#86efac',
    fontSize: 11
  } as React.CSSProperties,
  // ── 소스별 4버튼 탭 바 ──
  tabBar: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    padding: '8px 10px',
    borderBottom: '1px solid #2a2a2a',
    background: '#101010'
  } as React.CSSProperties,
  tabBtn: {
    flex: '1 1 auto',
    minWidth: 70,
    background: '#1a1a1a',
    color: '#9aa0a6',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  } as React.CSSProperties,
  tabBtnActive: {
    background: '#10b981',
    color: '#04231a',
    borderColor: '#10b981'
  } as React.CSSProperties,
  libraryContextMenu: {
    position: 'fixed',
    zIndex: 1000,
    width: 220,
    maxHeight: 420,
    overflowY: 'auto',
    background: '#111827',
    border: '1px solid #334155',
    borderRadius: 8,
    boxShadow: '0 18px 40px rgba(0,0,0,0.45)',
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  } as React.CSSProperties,
  contextSectionTitle: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: 800,
    padding: '4px 6px 2px'
  } as React.CSSProperties,
  contextBtn: {
    width: '100%',
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    color: '#e2e8f0',
    padding: '6px 8px',
    fontSize: 11,
    cursor: 'pointer'
  } as React.CSSProperties,
  contextBtnActive: {
    background: '#10b981',
    color: '#04231a',
    fontWeight: 800
  } as React.CSSProperties
}

const IMPORT_TABS: { key: ImportTab; label: string }[] = [
  { key: 'local', label: '① 내 PC' },
  { key: 'library', label: '② 영상 라이브러리' },
  { key: 'tts', label: '③ TTS & SRT' },
  { key: 'ai', label: '④ AI 영상 생성' },
  { key: 'internal', label: '내부 영상' },
  { key: 'music', label: '음악' },
  { key: 'sfx', label: '🔊 효과음' },
  { key: 'brand', label: '브랜드 키트' }
]

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------
export function MediaLibrary(): JSX.Element {
  const media = useProjectStore((s) => s.project.media)
  const removeMedia = useProjectStore((s) => s.removeMedia)
  const renameMedia = useProjectStore((s) => s.renameMedia)

  const [dragOver, setDragOver] = useState(false)
  const [importing, setImporting] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [notices, setNotices] = useState<string[]>([])
  /** 현재 선택된 가져오기 소스 탭. */
  const [tab, setTab] = useState<ImportTab>('local')
  const [folderFilter, setFolderFilter] = useState<string>(ALL_FOLDERS)
  const [sortKey, setSortKey] = useState<MediaSortKey>('importedDesc')
  const [libraryMenu, setLibraryMenu] = useState<{ x: number; y: number } | null>(
    null
  )
  /** mediaId -> data URI (loaded lazily after hydration). */
  const [thumbCache, setThumbCache] = useState<Record<string, string>>({})

  /** ImportPanel(원격 소스 탭)에서 올라오는 안내/에러 메시지 핸들러. */
  const handleNotice = (message: string, kind: 'info' | 'error'): void => {
    if (kind === 'error') {
      setErrors((prev) => [message, ...prev])
    } else {
      setNotices((prev) => [message, ...prev])
    }
  }

  const allAssets = useMemo(() => Object.values(media), [media])

  const folders = useMemo(() => {
    const byPath = new Map<string, { path: string; label: string; count: number }>()
    for (const asset of allAssets) {
      const dir = parentDir(asset.path)
      const cur = byPath.get(dir)
      if (cur) cur.count += 1
      else byPath.set(dir, { path: dir, label: folderName(dir), count: 1 })
    }
    return [...byPath.values()].sort((a, b) => a.label.localeCompare(b.label, 'ko'))
  }, [allAssets])

  useEffect(() => {
    if (folderFilter === ALL_FOLDERS) return
    if (!folders.some((f) => f.path === folderFilter)) {
      setFolderFilter(ALL_FOLDERS)
    }
  }, [folderFilter, folders])

  const assets = useMemo(
    () =>
      allAssets
        .filter((a) => folderFilter === ALL_FOLDERS || parentDir(a.path) === folderFilter)
        .sort((a, b) => compareBySort(a, b, sortKey)),
    [allAssets, folderFilter, sortKey]
  )

  // Hydrate thumbnail data URIs for assets that have a thumbnailPath but
  // whose data URI isn't in memory yet (e.g. after app restart).
  useEffect(() => {
    let cancelled = false
    const toLoad = assets.filter(
      (a) => a.thumbnailPath && !thumbCache[a.id]
    )
    if (toLoad.length === 0) return
    void Promise.all(
      toLoad.map(async (a) => {
        if (!a.thumbnailPath) return null
        const uri = await window.electron.media.readThumbnail(a.thumbnailPath)
        return uri ? ([a.id, uri] as const) : null
      })
    ).then((results) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const r of results) if (r) next[r[0]] = r[1]
      if (Object.keys(next).length > 0) {
        setThumbCache((prev) => ({ ...prev, ...next }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [assets, thumbCache])

  const ingest = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    const supported = paths.filter(isSupported)
    const unsupported = paths.filter((p) => !isSupported(p))
    for (const u of unsupported) {
      setErrors((prev) => [
        `지원하지 않는 형식: ${u.split(/[/\\]/).pop() ?? u}`,
        ...prev
      ])
    }
    if (supported.length === 0) return

    setImporting((prev) => [...prev, ...supported])
    try {
      const onAssetReady = (asset: MediaAsset, dataUri: string): void => {
        setThumbCache((prev) => ({ ...prev, [asset.id]: dataUri }))
      }
      const onError = (filePath: string, err: string): void => {
        setErrors((prev) => [
          `${filePath.split(/[/\\]/).pop() ?? filePath}: ${err}`,
          ...prev
        ])
      }
      await importFilesByPath(supported, { onAssetReady, onError })
    } finally {
      setImporting((prev) =>
        prev.filter((p) => !supported.includes(p))
      )
    }
  }

  const onImportClick = async (): Promise<void> => {
    if (!window.electron?.fs?.pickFiles) return
    const picked = await window.electron.fs.pickFiles({
      multi: true,
      filters: [
        {
          name: '미디어',
          extensions: [
            'mp4',
            'mov',
            'mkv',
            'webm',
            'mp3',
            'wav',
            'm4a',
            'jpg',
            'jpeg',
            'png',
            'webp'
          ]
        }
      ]
    })
    await ingest(picked)
  }

  const onDrop = async (e: React.DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    const paths: string[] = []
    for (const f of files) {
      const p = window.electron?.getPathForFile?.(f) ?? ''
      if (p) paths.push(p)
    }
    if (paths.length === 0) {
      setErrors((prev) => [
        '드롭한 파일의 경로를 읽지 못했습니다 (Electron 32+ 필요)',
        ...prev
      ])
      return
    }
    await ingest(paths)
  }

  const dismissError = (idx: number): void => {
    setErrors((prev) => prev.filter((_, i) => i !== idx))
  }
  const dismissNotice = (idx: number): void => {
    setNotices((prev) => prev.filter((_, i) => i !== idx))
  }

  /** 어느 탭에서나 보이는 안내/에러 배너. */
  const banners = (
    <>
      {errors.map((msg, idx) => (
        <div
          key={`err-${idx}-${msg}`}
          style={styles.errorRow}
          onClick={() => dismissError(idx)}
          role="button"
        >
          {msg}
        </div>
      ))}
      {notices.map((msg, idx) => (
        <div
          key={`info-${idx}-${msg}`}
          style={styles.infoRow}
          onClick={() => dismissNotice(idx)}
          role="button"
        >
          {msg}
        </div>
      ))}
    </>
  )

  // pptx10 slide 5 — OS 파일을 패널 어디든 떨어뜨려도 import 되게 wrap
  // 전체로 drop zone 확장. 작은 점선 박스(`styles.drop`)는 시각 안내만
  // 담당하고 실제 receiver는 wrapper. dragOver state는 wrapper에서 권위
  // 있게 관리하고, dragLeave는 자식 element 가로지름을 무시하기 위해
  // relatedTarget 가 wrapper 안이면 skip.
  const wrapDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dragOver) setDragOver(true)
  }
  const wrapDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    const related = e.relatedTarget as Node | null
    if (related && e.currentTarget.contains(related)) return
    setDragOver(false)
  }
  const wrapDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    void onDrop(e)
  }
  const openLibraryMenu = (e: React.MouseEvent<HTMLElement>): void => {
    if (tab !== 'local') return
    e.preventDefault()
    setLibraryMenu({ x: e.clientX, y: e.clientY })
  }
  const closeLibraryMenu = (): void => setLibraryMenu(null)
  // pptx10 슬라이드 5 (0.2.22) — dragOver 시 wrap 전체에 dashed 강조 +
  // 가운데 안내 텍스트 overlay. 작은 점선 박스만 활성화 보이던 0.2.16의
  // 잔여 시각 누락 보강. overlay 는 pointer-events: none 이라 drop 이벤트
  // 는 그대로 wrap 이 받음.
  const wrapStyle: React.CSSProperties =
    dragOver
      ? { ...styles.wrap, ...styles.wrapDragActive }
      : styles.wrap
  return (
    <div
      style={wrapStyle}
      onDragOver={wrapDragOver}
      onDragEnter={wrapDragOver}
      onDragLeave={wrapDragLeave}
      onDrop={wrapDrop}
      onClick={closeLibraryMenu}
    >
      {dragOver && (
        <div style={styles.wrapDragOverlay} data-testid="wrap-drop-overlay">
          여기에 놓아주세요 — 현재 탭에서도 가져오기
        </div>
      )}
      <div style={styles.header}>
        <div style={styles.title}>미디어 가져오기</div>
        {tab === 'local' && (
          <button
            style={styles.importBtn}
            onClick={onImportClick}
            data-testid="import-button"
          >
            가져오기
          </button>
        )}
      </div>

      {/* ── 소스별 4버튼 (+ 내부 영상) ── */}
      <div style={styles.tabBar} data-testid="import-tabs">
        {IMPORT_TABS.map((t) => (
          <button
            key={t.key}
            style={{
              ...styles.tabBtn,
              ...(tab === t.key ? styles.tabBtnActive : {})
            }}
            onClick={() => setTab(t.key)}
            data-testid={`import-tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'local' ? (
        <>
          <div
            style={{ ...styles.drop, ...(dragOver ? styles.dropActive : {}) }}
            data-testid="drop-zone"
            onContextMenu={openLibraryMenu}
          >
            {dragOver
              ? '여기에 놓아주세요'
              : '파일을 드래그하거나 위 [가져오기]를 눌러주세요'}
          </div>

          <div style={styles.libraryControls} data-testid="media-library-controls">
            <label style={styles.controlBlock}>
              <span style={styles.controlLabel}>폴더</span>
              <select
                value={folderFilter}
                onChange={(e) => setFolderFilter(e.currentTarget.value)}
                style={styles.select}
                data-testid="media-folder-filter"
              >
                <option value={ALL_FOLDERS}>전체 폴더 ({allAssets.length})</option>
                {folders.map((f) => (
                  <option key={f.path || 'none'} value={f.path}>
                    {f.label} ({f.count})
                  </option>
                ))}
              </select>
            </label>
            <label style={styles.controlBlock}>
              <span style={styles.controlLabel}>분류</span>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.currentTarget.value as MediaSortKey)}
                style={styles.select}
                data-testid="media-sort-select"
              >
                {MEDIA_SORT_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {importing.length > 0 && (
            <div style={styles.importingRow}>
              가져오는 중… {importing.length}개
            </div>
          )}

          {banners}

          {allAssets.length === 0 ? (
            <div style={styles.empty} onContextMenu={openLibraryMenu}>
              비어있어요. 영상·음원·이미지를 가져오세요.
            </div>
          ) : assets.length === 0 ? (
            <div style={styles.empty} onContextMenu={openLibraryMenu}>
              선택한 폴더에 표시할 미디어가 없습니다.
            </div>
          ) : (
            <div
              style={styles.list}
              data-testid="media-list"
              onContextMenu={(e) => {
                if (e.target === e.currentTarget) openLibraryMenu(e)
              }}
            >
              {assets.map((a) => (
                <MediaCard
                  key={a.id}
                  asset={a}
                  thumbUri={thumbCache[a.id]}
                  onRemove={() => removeMedia(a.id)}
                  onRename={(n) => renameMedia(a.id, n)}
                />
              ))}
            </div>
          )}
          {libraryMenu && (
            <div
              style={{
                ...styles.libraryContextMenu,
                left: libraryMenu.x,
                top: libraryMenu.y
              }}
              data-testid="media-library-context-menu"
              onClick={(e) => e.stopPropagation()}
            >
              <div style={styles.contextSectionTitle}>폴더</div>
              <button
                style={{
                  ...styles.contextBtn,
                  ...(folderFilter === ALL_FOLDERS ? styles.contextBtnActive : {})
                }}
                onClick={() => {
                  setFolderFilter(ALL_FOLDERS)
                  closeLibraryMenu()
                }}
                data-testid="media-context-folder-all"
              >
                전체 폴더 ({allAssets.length})
              </button>
              {folders.map((f) => (
                <button
                  key={f.path || 'none'}
                  style={{
                    ...styles.contextBtn,
                    ...(folderFilter === f.path ? styles.contextBtnActive : {})
                  }}
                  onClick={() => {
                    setFolderFilter(f.path)
                    closeLibraryMenu()
                  }}
                  data-testid="media-context-folder"
                  title={f.path}
                >
                  {f.label} ({f.count})
                </button>
              ))}
              <div style={styles.contextSectionTitle}>분류</div>
              {MEDIA_SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  style={{
                    ...styles.contextBtn,
                    ...(sortKey === opt.key ? styles.contextBtnActive : {})
                  }}
                  onClick={() => {
                    setSortKey(opt.key)
                    closeLibraryMenu()
                  }}
                  data-testid={`media-context-sort-${opt.key}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {banners}
          <ImportPanel tab={tab} onNotice={handleNotice} />
        </>
      )}
    </div>
  )
}

function MediaCard(props: {
  asset: MediaAsset
  thumbUri?: string
  onRemove: () => void
  onRename: (newName: string) => void
}): JSX.Element {
  const { asset, thumbUri, onRemove, onRename } = props
  const [dragging, setDragging] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(asset.fileName)
  // 외부에서 fileName 이 바뀌면 (timeline 쪽에서 rename) draft 동기화.
  useEffect(() => { if (!editing) setDraft(asset.fileName) }, [asset.fileName, editing])
  const commit = (): void => {
    setEditing(false)
    const trimmed = draft.trim()
    if (!trimmed || trimmed === asset.fileName) {
      setDraft(asset.fileName)
      return
    }
    onRename(trimmed)
  }
  const cardStyle: React.CSSProperties = dragging
    ? { ...styles.card, opacity: 0.55 }
    : styles.card
  return (
    <div
      style={cardStyle}
      data-testid="media-card"
      data-media-id={asset.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy'
        // Two MIME types: the strict one (consumed by Timeline) and a
        // text fallback for debugging / other drop targets.
        e.dataTransfer.setData(MEDIA_DRAG_MIME, asset.id)
        // Reels 11 슬라이드 11 — kind-tagged MIME 도 함께 등록.
        e.dataTransfer.setData(MEDIA_DRAG_KIND_MIME(asset.kind), asset.id)
        e.dataTransfer.setData('text/plain', asset.id)
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
      onContextMenu={(e) => {
        e.preventDefault()
        onRemove()
      }}
    >
      {thumbUri ? (
        <img src={thumbUri} alt={asset.fileName} style={styles.thumb} />
      ) : (
        <div style={styles.thumbPlaceholder}>
          {asset.kind === 'audio' ? '♪' : asset.kind === 'image' ? '◇' : '▶'}
        </div>
      )}
      <div style={styles.info}>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit() }
              else if (e.key === 'Escape') { e.preventDefault(); setDraft(asset.fileName); setEditing(false) }
              e.stopPropagation()
            }}
            onClick={(e) => e.stopPropagation()}
            onDragStart={(e) => e.preventDefault()}
            data-testid="media-card-rename-input"
            style={styles.filenameInput}
          />
        ) : (
          <div
            style={styles.filename}
            title={asset.fileName + ' — 더블클릭으로 이름 변경'}
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true) }}
            data-testid="media-card-name"
          >
            {asset.fileName}
          </div>
        )}
        <div style={styles.meta}>
          {fmtDuration(asset.durationMs)}
          {asset.width > 0 && ` · ${asset.width}×${asset.height}`}
        </div>
        <div style={styles.metaSub}>
          {asset.kind}
          {asset.fileSizeBytes ? ` · ${fmtSize(asset.fileSizeBytes)}` : ''}
        </div>
      </div>
      <button
        style={styles.renameBtn}
        onClick={(e) => {
          e.stopPropagation()
          setEditing(true)
        }}
        aria-label="이름 변경"
        title="이름 변경 (또는 파일명 더블클릭)"
        data-testid="media-card-rename-btn"
      >
        ✎
      </button>
      <button
        style={styles.removeBtn}
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label="삭제"
        title="삭제"
      >
        ×
      </button>
    </div>
  )
}
