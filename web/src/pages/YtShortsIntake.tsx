import { useMemo, useState } from 'react'

const LS_KEY = 'yt_shorts_intake_pending'

interface PendingItem {
  videoId: string
  url: string
  addedAt: number
}

function loadPending(): PendingItem[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}
function savePending(list: PendingItem[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)) } catch {}
}

// YouTube Shorts / video URL → 11-char video id
function parseVideoId(value: string): string {
  const raw = value.trim()
  if (!raw) return ''
  // shorts/<ID>
  const m1 = raw.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i)
  if (m1) return m1[1].slice(0, 11)
  // youtu.be/<ID>
  const m2 = raw.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/i)
  if (m2) return m2[1].slice(0, 11)
  // watch?v=<ID>
  const m3 = raw.match(/[?&]v=([A-Za-z0-9_-]{6,})/i)
  if (m3) return m3[1].slice(0, 11)
  // 그냥 ID
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw
  return ''
}

export default function YtShortsIntake() {
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<PendingItem[]>(loadPending)
  const [msg, setMsg] = useState('')

  const parsed = useMemo(() => {
    const lines = input.split(/[\n,]+/).map(l => l.trim()).filter(Boolean)
    const ids = lines.map(parseVideoId).filter(Boolean)
    return [...new Set(ids)]
  }, [input])

  const isBatch = parsed.length > 1

  const onAdd = () => {
    if (parsed.length === 0) {
      setMsg('유효한 YouTube Shorts URL을 입력하세요')
      return
    }
    const now = Date.now()
    const fresh: PendingItem[] = parsed.map(id => ({
      videoId: id,
      url: `https://www.youtube.com/shorts/${id}`,
      addedAt: now,
    }))
    // 중복 제거하며 머지
    const seen = new Set(pending.map(p => p.videoId))
    const merged = [
      ...fresh.filter(p => !seen.has(p.videoId)),
      ...pending,
    ].slice(0, 50)
    setPending(merged)
    savePending(merged)
    setInput('')
    setMsg(`${fresh.length}개 임시 큐에 추가됨 (DB 연결 후 실제 분석 트리거)`)
  }

  const onRemove = (id: string) => {
    const next = pending.filter(p => p.videoId !== id)
    setPending(next)
    savePending(next)
  }

  const onClear = () => {
    setPending([])
    savePending([])
    setMsg('큐 비움')
  }

  return (
    <>
      <div className="page-header">
        <h1>숏폼 추가</h1>
        <p>YouTube Shorts URL 입력 → 임시 큐 (DB 스키마 확정 후 분석 시작)</p>
      </div>

      <div className="section-card" style={{ padding: 20, marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          Shorts URL (여러 개 한 줄씩 입력)
        </label>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          rows={4}
          placeholder={'https://www.youtube.com/shorts/abcdefghijk\nhttps://youtu.be/xxxxxxxxxxx'}
          style={{
            width: '100%', marginTop: 6, padding: 10,
            border: '1px solid var(--border)', borderRadius: 6,
            fontFamily: 'monospace', fontSize: 12, resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <button
            onClick={onAdd}
            disabled={parsed.length === 0}
            className="btn-primary btn-primary--sm"
          >
            {isBatch ? `${parsed.length}개 추가` : '추가'}
          </button>
          {parsed.length > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              인식된 ID: {parsed.slice(0, 3).map(id => <code key={id} style={{ marginRight: 4 }}>{id}</code>)}
              {parsed.length > 3 && `+${parsed.length - 3}`}
            </span>
          )}
          {msg && <span style={{ fontSize: 12, color: 'var(--accent)' }}>{msg}</span>}
        </div>
      </div>

      <div className="section-card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
            임시 큐 ({pending.length})
          </h2>
          {pending.length > 0 && (
            <button
              onClick={onClear}
              style={{
                marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)',
                border: '1px solid var(--border-subtle)', background: 'transparent',
                borderRadius: 4, padding: '4px 8px', cursor: 'pointer',
              }}
            >전체 삭제</button>
          )}
        </div>
        {pending.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text-muted)', textAlign: 'center', fontSize: 13 }}>
            큐가 비어있습니다
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pending.map(p => (
              <div
                key={p.videoId}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
                  border: '1px solid var(--border-subtle)', borderRadius: 6,
                  fontSize: 13,
                }}
              >
                <img
                  src={`https://i.ytimg.com/vi/${p.videoId}/mqdefault.jpg`}
                  alt=""
                  style={{ width: 60, height: 80, objectFit: 'cover', borderRadius: 4, background: 'var(--bg-elevated)' }}
                  loading="lazy"
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <code style={{ fontSize: 12, fontWeight: 600 }}>{p.videoId}</code>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    <a href={p.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                      열기 ↗
                    </a>
                    <span style={{ marginLeft: 8 }}>
                      {new Date(p.addedAt).toLocaleString('ko-KR')}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => onRemove(p.videoId)}
                  style={{
                    fontSize: 11, color: 'var(--error)', border: 'none',
                    background: 'transparent', cursor: 'pointer',
                  }}
                >삭제</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
