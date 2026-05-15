import { useEffect, useMemo, useState } from 'react'
import { authedFetch } from '../api'

interface PendingItem {
  shortcode: string
  collected_at: string
}

// YouTube Shorts / video URL → 11-char video id
function parseVideoId(value: string): string {
  const raw = value.trim()
  if (!raw) return ''
  const m1 = raw.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i)
  if (m1) return m1[1].slice(0, 11)
  const m2 = raw.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/i)
  if (m2) return m2[1].slice(0, 11)
  const m3 = raw.match(/[?&]v=([A-Za-z0-9_-]{6,})/i)
  if (m3) return m3[1].slice(0, 11)
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw
  return ''
}

export default function YtShortsIntake() {
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<PendingItem[]>([])
  const [analyzedCount, setAnalyzedCount] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState('')

  const parsed = useMemo(() => {
    const lines = input.split(/[\n,]+/).map(l => l.trim()).filter(Boolean)
    const ids = lines.map(parseVideoId).filter(Boolean)
    return [...new Set(ids)]
  }, [input])

  const isBatch = parsed.length > 1

  const fetchStatus = async () => {
    try {
      const r = await authedFetch('/api/yt/intake/status')
      if (!r.ok) return
      const d = await r.json()
      setPending(d.pending || [])
      setAnalyzedCount(d.analyzed_count || 0)
    } catch {}
  }

  useEffect(() => {
    const first = window.setTimeout(fetchStatus, 500)
    const t = setInterval(fetchStatus, 8000)  // 8초마다 갱신 (워커 polling 10초)
    return () => { window.clearTimeout(first); clearInterval(t) }
  }, [])

  const onAdd = async () => {
    if (parsed.length === 0) {
      setMsg('유효한 YouTube Shorts URL을 입력하세요'); return
    }
    setSubmitting(true); setMsg('')
    try {
      const r = await authedFetch('/api/yt/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_ids: parsed }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.detail || `API ${r.status}`)
      }
      const d = await r.json()
      setMsg(`${d.queued}개 큐 등록 완료 — 워커가 분석 시작 (PC에서 \`python auto_yt_worker.py\` 실행 중일 때)`)
      setInput('')
      await fetchStatus()
    } catch (e: any) {
      setMsg(`오류: ${e.message || e}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>숏폼 추가</h1>
        <p>YouTube Shorts URL 입력 → 자동 분석 큐 (워커 polling)</p>
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
            disabled={parsed.length === 0 || submitting}
            className="btn-primary btn-primary--sm"
          >
            {submitting ? '추가 중…' : (isBatch ? `${parsed.length}개 추가` : '추가')}
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
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
            분석 대기 ({pending.length})
          </h2>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            완료: {analyzedCount}개
          </span>
          <button
            onClick={fetchStatus}
            style={{
              marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)',
              border: '1px solid var(--border-subtle)', background: 'transparent',
              borderRadius: 4, padding: '4px 8px', cursor: 'pointer',
            }}
          >새로고침</button>
        </div>
        {pending.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text-muted)', textAlign: 'center', fontSize: 13 }}>
            대기 큐 비어있음 ✓
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pending.map(p => (
              <div
                key={p.shortcode}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
                  border: '1px solid var(--border-subtle)', borderRadius: 6,
                  fontSize: 13,
                }}
              >
                <img
                  src={`https://i.ytimg.com/vi/${p.shortcode}/mqdefault.jpg`}
                  alt=""
                  style={{ width: 60, height: 80, objectFit: 'cover', borderRadius: 4, background: 'var(--bg-elevated)' }}
                  loading="lazy"
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <code style={{ fontSize: 12, fontWeight: 600 }}>{p.shortcode}</code>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    <a href={`https://www.youtube.com/shorts/${p.shortcode}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                      열기 ↗
                    </a>
                    <span style={{ marginLeft: 8 }}>
                      {p.collected_at ? new Date(p.collected_at).toLocaleString('ko-KR') : ''}
                    </span>
                  </div>
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  대기 중
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
