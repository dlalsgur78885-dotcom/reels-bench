import { useEffect, useRef, useState } from 'react'
import { authedFetch, BASE } from '../api'

type Status = 'idle' | 'uploading' | 'submitting' | 'queued' | 'in_progress' | 'completed' | 'failed'

const RESOLUTIONS = ['480p', '720p', '1080p'] as const
const DURATIONS = ['4', '5', '6', '8', '10', '12', '15'] as const
const ASPECTS = ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9', 'auto'] as const

export default function Seedance() {
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string>('')  // 로컬 미리보기
  const [imageUrl, setImageUrl] = useState<string>('')  // fal upload 후 URL
  const [prompt, setPrompt] = useState('카메라가 천천히 줌인하며 따뜻한 햇살이 비추는 장면')
  const [resolution, setResolution] = useState<typeof RESOLUTIONS[number]>('720p')
  const [duration, setDuration] = useState<typeof DURATIONS[number]>('4')
  const [aspectRatio, setAspectRatio] = useState<typeof ASPECTS[number]>('9:16')
  const [generateAudio, setGenerateAudio] = useState(false)

  const [status, setStatus] = useState<Status>('idle')
  const [requestId, setRequestId] = useState<string>('')
  const [elapsed, setElapsed] = useState(0)
  const [queuePosition, setQueuePosition] = useState<number | null>(null)
  const [videoUrl, setVideoUrl] = useState<string>('')
  const [error, setError] = useState<string>('')

  const tickerRef = useRef<number | null>(null)
  const pollerRef = useRef<number | null>(null)
  const startedAtRef = useRef<number>(0)

  useEffect(() => () => {
    if (tickerRef.current) window.clearInterval(tickerRef.current)
    if (pollerRef.current) window.clearInterval(pollerRef.current)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [])

  const onPickFile = (f: File | null) => {
    setFile(f)
    setImageUrl('')
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(f ? URL.createObjectURL(f) : '')
  }

  const reset = () => {
    setStatus('idle')
    setRequestId('')
    setElapsed(0)
    setQueuePosition(null)
    setVideoUrl('')
    setError('')
    if (tickerRef.current) { window.clearInterval(tickerRef.current); tickerRef.current = null }
    if (pollerRef.current) { window.clearInterval(pollerRef.current); pollerRef.current = null }
  }

  const startTicker = () => {
    startedAtRef.current = Date.now()
    setElapsed(0)
    tickerRef.current = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000))
    }, 1000)
  }

  const stopTicker = () => {
    if (tickerRef.current) { window.clearInterval(tickerRef.current); tickerRef.current = null }
  }

  const submit = async () => {
    reset()
    if (!file && !imageUrl) { setError('이미지가 필요합니다'); return }
    if (!prompt.trim()) { setError('프롬프트를 입력하세요'); return }

    try {
      let urlForFal = imageUrl
      if (file && !imageUrl) {
        setStatus('uploading')
        startTicker()
        const fd = new FormData()
        fd.append('file', file)
        const r = await authedFetch('/api/seedance/upload', { method: 'POST', body: fd })
        if (!r.ok) throw new Error(`업로드 ${r.status}: ${(await r.text()).slice(0, 200)}`)
        const data = await r.json()
        urlForFal = data.image_url
        setImageUrl(urlForFal)
      }

      setStatus('submitting')
      const sr = await authedFetch('/api/seedance/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt, image_url: urlForFal, resolution, duration, aspect_ratio: aspectRatio,
          generate_audio: generateAudio,
        }),
      })
      if (!sr.ok) throw new Error(`제출 ${sr.status}: ${(await sr.text()).slice(0, 200)}`)
      const sub = await sr.json()
      const rid = sub.request_id
      setRequestId(rid)
      setStatus('queued')

      pollerRef.current = window.setInterval(async () => {
        try {
          const pr = await authedFetch(`/api/seedance/status?request_id=${encodeURIComponent(rid)}`)
          if (!pr.ok) return
          const ps = await pr.json()
          setQueuePosition(ps.queue_position ?? null)
          const s = (ps.status || '').toUpperCase()
          if (s === 'IN_PROGRESS') setStatus('in_progress')
          else if (s === 'IN_QUEUE') setStatus('queued')
          else if (s === 'COMPLETED') {
            setStatus('completed')
            setVideoUrl(ps.video_url || '')
            stopTicker()
            if (pollerRef.current) { window.clearInterval(pollerRef.current); pollerRef.current = null }
          } else if (s === 'FAILED') {
            setStatus('failed')
            setError('생성 실패')
            stopTicker()
            if (pollerRef.current) { window.clearInterval(pollerRef.current); pollerRef.current = null }
          }
        } catch {}
      }, 4000) as unknown as number
    } catch (e: any) {
      stopTicker()
      setStatus('failed')
      setError(e?.message || String(e))
    }
  }

  const statusLabel: Record<Status, string> = {
    idle: '대기',
    uploading: '이미지 업로드 중',
    submitting: '제출 중',
    queued: queuePosition !== null ? `대기열 #${queuePosition}` : '대기열',
    in_progress: '생성 중',
    completed: '완료',
    failed: '실패',
  }

  const busy = status === 'uploading' || status === 'submitting' || status === 'queued' || status === 'in_progress'

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Seedance 2.0 — 이미지 → 영상</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
          이미지 + 프롬프트로 4–15초 영상 생성. 720p 기준 약 3분 소요.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        {/* 좌: 입력 */}
        <div style={cardSt}>
          <Label>이미지 (최대 30MB)</Label>
          <div style={{ marginBottom: 12 }}>
            {previewUrl ? (
              <div style={{ position: 'relative' }}>
                <img src={previewUrl} alt="preview"
                  style={{ width: '100%', maxHeight: 320, objectFit: 'contain',
                    background: 'var(--bg-base)', borderRadius: 6, border: '1px solid var(--border)' }} />
                <button onClick={() => onPickFile(null)} disabled={busy}
                  style={{ position: 'absolute', top: 6, right: 6, padding: '4px 10px',
                    fontSize: 11, fontWeight: 600, border: 'none', borderRadius: 4,
                    background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer' }}>
                  교체
                </button>
              </div>
            ) : (
              <label htmlFor="seedance-file"
                style={{ display: 'block', padding: 30, textAlign: 'center', cursor: 'pointer',
                  border: '1.5px dashed var(--border)', borderRadius: 8,
                  background: 'var(--bg-base)', color: 'var(--text-muted)', fontSize: 13 }}>
                + 클릭해서 이미지 선택
              </label>
            )}
            <input id="seedance-file" type="file" accept="image/*"
              onChange={e => onPickFile(e.target.files?.[0] || null)} disabled={busy}
              style={{ display: 'none' }} />
          </div>

          <Label>프롬프트 (영문 권장 — 한글도 OK)</Label>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} disabled={busy}
            rows={4} style={textareaSt} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 12 }}>
            <Select label="해상도" value={resolution} options={[...RESOLUTIONS]}
              onChange={v => setResolution(v as any)} disabled={busy} />
            <Select label="길이(초)" value={duration} options={[...DURATIONS]}
              onChange={v => setDuration(v as any)} disabled={busy} />
            <Select label="비율" value={aspectRatio} options={[...ASPECTS]}
              onChange={v => setAspectRatio(v as any)} disabled={busy} />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={generateAudio} onChange={e => setGenerateAudio(e.target.checked)} disabled={busy} />
            오디오도 함께 생성 (체크 시 비용·시간 증가)
          </label>

          <button onClick={submit} disabled={busy || !file}
            style={{
              marginTop: 16, width: '100%', padding: '10px 14px',
              fontSize: 14, fontWeight: 700,
              background: busy ? 'var(--bg-elevated)' : 'var(--accent)',
              color: busy ? 'var(--text-muted)' : '#fff',
              border: 'none', borderRadius: 6, cursor: busy ? 'wait' : 'pointer',
              opacity: busy || !file ? 0.6 : 1,
            }}>
            {busy ? statusLabel[status] : '영상 생성'}
          </button>
        </div>

        {/* 우: 결과 */}
        <div style={cardSt}>
          <Label>상태</Label>
          <div style={{
            padding: 12, borderRadius: 6, background: 'var(--bg-base)',
            border: '1px solid var(--border)', fontSize: 13,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontWeight: 600,
              color: status === 'completed' ? 'var(--success, #10b981)'
                : status === 'failed' ? 'var(--error)' : 'var(--text-primary)' }}>
              {statusLabel[status]}
            </span>
            {(busy || status === 'completed') && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                {elapsed}s
              </span>
            )}
          </div>
          {requestId && (
            <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              req: {requestId}
            </div>
          )}
          {error && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 6,
              background: 'rgba(239,68,68,0.08)', border: '1px solid var(--error)',
              fontSize: 12, color: 'var(--error)' }}>
              {error}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <Label>결과 영상</Label>
            {videoUrl ? (
              <>
                <video src={videoUrl} controls autoPlay loop
                  style={{ width: '100%', borderRadius: 8, background: '#000' }} />
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <a href={videoUrl} download target="_blank" rel="noopener noreferrer"
                    style={linkBtnSt}>↓ 다운로드</a>
                  <button onClick={() => navigator.clipboard.writeText(videoUrl)}
                    style={linkBtnSt}>URL 복사</button>
                </div>
              </>
            ) : (
              <div style={{ padding: 50, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)',
                background: 'var(--bg-base)', borderRadius: 8, border: '1px dashed var(--border)' }}>
                {busy ? '생성 중…' : '아직 결과 없음'}
              </div>
            )}
          </div>
        </div>
      </div>
      {BASE && <div style={{ display: 'none' }}>{BASE}</div>}
    </div>
  )
}

const cardSt: React.CSSProperties = {
  padding: 16, background: 'var(--bg-surface)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
}
const textareaSt: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: 13, lineHeight: 1.5,
  border: '1px solid var(--border)', borderRadius: 6,
  background: 'var(--bg-base)', color: 'var(--text-body)',
  resize: 'vertical', fontFamily: 'inherit',
}
const linkBtnSt: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 600,
  background: 'var(--bg-elevated)', color: 'var(--accent)',
  border: '1px solid var(--border)', borderRadius: 4,
  textDecoration: 'none', cursor: 'pointer',
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)',
      marginBottom: 6, letterSpacing: '0.02em' }}>{children}</div>
  )
}

function Select({ label, value, options, onChange, disabled }: {
  label: string; value: string; options: string[];
  onChange: (v: string) => void; disabled?: boolean;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
        style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-body)' }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}
