import { useEffect, useMemo, useState } from 'react'
import type { MediaAsset } from '../../../shared/project'
import { useProjectStore } from '../store/project'
import { importFilesByPath } from '../lib/mediaImport'

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
    minWidth: 280
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
    whiteSpace: 'nowrap'
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
  } as React.CSSProperties
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------
export function MediaLibrary(): JSX.Element {
  const media = useProjectStore((s) => s.project.media)
  const removeMedia = useProjectStore((s) => s.removeMedia)

  const [dragOver, setDragOver] = useState(false)
  const [importing, setImporting] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  /** mediaId -> data URI (loaded lazily after hydration). */
  const [thumbCache, setThumbCache] = useState<Record<string, string>>({})

  const assets = useMemo(
    () =>
      Object.values(media).sort((a, b) => b.importedAt - a.importedAt),
    [media]
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

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <div style={styles.title}>미디어 라이브러리</div>
        <button
          style={styles.importBtn}
          onClick={onImportClick}
          data-testid="import-button"
        >
          가져오기
        </button>
      </div>

      <div
        style={{ ...styles.drop, ...(dragOver ? styles.dropActive : {}) }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }}
        onDragEnter={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          setDragOver(false)
        }}
        onDrop={onDrop}
        data-testid="drop-zone"
      >
        {dragOver
          ? '여기에 놓아주세요'
          : '파일을 드래그하거나 위 [가져오기]를 눌러주세요'}
      </div>

      {importing.length > 0 && (
        <div style={styles.importingRow}>
          가져오는 중… {importing.length}개
        </div>
      )}

      {errors.map((msg, idx) => (
        <div
          key={`${idx}-${msg}`}
          style={styles.errorRow}
          onClick={() => dismissError(idx)}
          role="button"
        >
          {msg}
        </div>
      ))}

      {assets.length === 0 ? (
        <div style={styles.empty}>
          비어있어요. 영상·음원·이미지를 가져오세요.
        </div>
      ) : (
        <div style={styles.list} data-testid="media-list">
          {assets.map((a) => (
            <MediaCard
              key={a.id}
              asset={a}
              thumbUri={thumbCache[a.id]}
              onRemove={() => removeMedia(a.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function MediaCard(props: {
  asset: MediaAsset
  thumbUri?: string
  onRemove: () => void
}): JSX.Element {
  const { asset, thumbUri, onRemove } = props
  return (
    <div
      style={styles.card}
      data-testid="media-card"
      data-media-id={asset.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy'
        e.dataTransfer.setData('application/x-reels-media-id', asset.id)
        e.dataTransfer.setData('text/plain', asset.id)
      }}
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
        <div style={styles.filename} title={asset.fileName}>
          {asset.fileName}
        </div>
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
