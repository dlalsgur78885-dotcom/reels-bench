import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { authedFetch, mockupAuthedFetch, BASE } from '../api'

type Mode = 'url' | 'upload'
type Status = 'idle' | 'uploading' | 'submitting' | 'queued' | 'recording' | 'compositing' | 'done' | 'failed'

type Device = {
  id: string; name: string;
  body_w: number; body_h: number;
  screen_x: number; screen_y: number;
  screen_w: number; screen_h: number;
  screen_radius: number; corner_radius: number;
  color: string; notch: boolean;
}

const ASPECTS = ['9:16', '1:1', '16:9'] as const

const BG_PRESETS = [
  { label: '딥 네이비', value: '#1a1a2e' },
  { label: '미드나잇',   value: '#0f172a' },
  { label: '인디고',     value: '#312e81' },
  { label: '핑크',       value: '#fb7185' },
  { label: '민트',       value: '#10b981' },
  { label: '오렌지',     value: '#f97316' },
  { label: '라이트',     value: '#f3f4f6' },
  { label: '블랙',       value: '#0a0a0a' },
]

export default function Mockup() {
  const [mode, setMode] = useState<Mode>('url')

  // URL 모드
  const [url, setUrl] = useState('')
  const [viewportW, setViewportW] = useState(390)
  const [viewportH, setViewportH] = useState(844)
  const [durationSec, setDurationSec] = useState(6)

  // Upload 모드
  const [sourceFileId, setSourceFileId] = useState<string>('')
  const [sourceFileName, setSourceFileName] = useState<string>('')
  const [sourceIsVideo, setSourceIsVideo] = useState(true)
  const [sourcePreview, setSourcePreview] = useState<string>('')

  // 공통
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceId, setDeviceId] = useState<string>('iphone-16-pro')
  const [aspect, setAspect] = useState<typeof ASPECTS[number]>('9:16')
  const [bgColor, setBgColor] = useState('#1a1a2e')
  const [bgFileId, setBgFileId] = useState<string>('')
  const [bgPreview, setBgPreview] = useState<string>('')
  const [deviceScale, setDeviceScale] = useState(0.85)

  // 진행
  const [status, setStatus] = useState<Status>('idle')
  const [jobId, setJobId] = useState('')
  const [progress, setProgress] = useState('')
  const [outputUrl, setOutputUrl] = useState('')
  const [outputKind, setOutputKind] = useState<'mp4' | 'png'>('mp4')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')

  const tickerRef = useRef<number | null>(null)
  const pollerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)

  useEffect(() => {
    authedFetch('/api/mockup/devices')
      .then(r => r.ok ? r.json() : { devices: [] })
      .then(d => setDevices(d.devices || []))
      .catch(() => {})
  }, [])

  useEffect(() => () => {
    if (tickerRef.current) window.clearInterval(tickerRef.current)
    if (pollerRef.current) window.clearInterval(pollerRef.current)
    if (sourcePreview) URL.revokeObjectURL(sourcePreview)
    if (bgPreview) URL.revokeObjectURL(bgPreview)
  }, [])

  const device = devices.find(d => d.id === deviceId) ?? null
  const busy = ['uploading', 'submitting', 'queued', 'recording', 'compositing'].includes(status)

  const reset = () => {
    setStatus('idle'); setJobId(''); setProgress(''); setOutputUrl(''); setElapsed(0); setError('')
    if (tickerRef.current) { window.clearInterval(tickerRef.current); tickerRef.current = null }
    if (pollerRef.current) { window.clearInterval(pollerRef.current); pollerRef.current = null }
  }
  const startTicker = () => {
    startedAtRef.current = Date.now(); setElapsed(0)
    tickerRef.current = window.setInterval(() =>
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000)
  }
  const stopTicker = () => {
    if (tickerRef.current) { window.clearInterval(tickerRef.current); tickerRef.current = null }
  }

  const uploadFile = async (f: File): Promise<{ file_id: string; is_video: boolean }> => {
    const fd = new FormData()
    fd.append('file', f)
    const r = await mockupAuthedFetch('/api/mockup/upload', { method: 'POST', body: fd })
    if (!r.ok) throw new Error(`업로드 ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return r.json()
  }

  const onPickSource = async (f: File | null) => {
    if (sourcePreview) URL.revokeObjectURL(sourcePreview)
    if (!f) { setSourceFileId(''); setSourceFileName(''); setSourcePreview(''); return }
    setSourceFileName(f.name)
    setSourcePreview(URL.createObjectURL(f))
    try {
      setStatus('uploading')
      const res = await uploadFile(f)
      setSourceFileId(res.file_id)
      setSourceIsVideo(res.is_video)
      setStatus('idle')
    } catch (e: any) {
      setError(e?.message || String(e)); setStatus('failed')
    }
  }

  const onPickBg = async (f: File | null) => {
    if (bgPreview) URL.revokeObjectURL(bgPreview)
    if (!f) { setBgFileId(''); setBgPreview(''); return }
    setBgPreview(URL.createObjectURL(f))
    try {
      const res = await uploadFile(f)
      setBgFileId(res.file_id)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const submit = async () => {
    reset()
    if (mode === 'url' && !url.startsWith('http')) { setError('http(s):// URL 필요'); return }
    if (mode === 'upload' && !sourceFileId) { setError('소스 파일 업로드 필요'); return }
    startTicker()
    try {
      setStatus('submitting')
      const r = await mockupAuthedFetch('/api/mockup/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode, url: mode === 'url' ? url : null,
          source_file_id: mode === 'upload' ? sourceFileId : null,
          bg_file_id: bgFileId || null,
          device_id: deviceId, aspect, bg_color: bgColor,
          device_scale: deviceScale,
          viewport_w: viewportW, viewport_h: viewportH,
          duration_sec: durationSec,
        }),
      })
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
      const data = await r.json()
      const jid = data.job_id
      setJobId(jid); setStatus('queued')

      pollerRef.current = window.setInterval(async () => {
        try {
          const pr = await mockupAuthedFetch(`/api/mockup/status?job_id=${encodeURIComponent(jid)}`)
          if (!pr.ok) return
          const ps = await pr.json()
          setStatus(ps.status); setProgress(ps.progress || '')
          if (ps.status === 'done') {
            setOutputUrl(ps.output_url); setOutputKind(ps.output_kind || 'mp4')
            stopTicker()
            if (pollerRef.current) { window.clearInterval(pollerRef.current); pollerRef.current = null }
          } else if (ps.status === 'failed') {
            setError(ps.error || '생성 실패')
            stopTicker()
            if (pollerRef.current) { window.clearInterval(pollerRef.current); pollerRef.current = null }
          }
        } catch {}
      }, 1500) as unknown as number
    } catch (e: any) {
      stopTicker()
      setStatus('failed'); setError(e?.message || String(e))
    }
  }

  const statusLabel: Record<Status, string> = {
    idle: '대기',
    uploading: '업로드 중',
    submitting: '제출 중',
    queued: '대기열',
    recording: progress || '페이지 녹화 중',
    compositing: progress || '합성 중',
    done: '완료',
    failed: '실패',
  }

  // 프리뷰 — 디바이스 미니어처 + 배경
  const previewBox = useMemo(() => {
    if (!device) return null
    const [aw, ah] = aspect.split(':').map(Number)
    const canvasH = 480
    const canvasW = Math.round((canvasH * aw) / ah)
    const devH = canvasH * deviceScale
    const ratio = device.body_w / device.body_h
    const devW = devH * ratio
    return { canvasW, canvasH, devW, devH }
  }, [device, aspect, deviceScale])

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: 24 }}>
      <div style={{ marginBottom: 18, display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <Link to="/" style={{ fontSize: 12, color: 'var(--text-muted)' }}>← 홈</Link>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>앱 목업 영상</h1>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          URL 녹화 OR 영상/이미지 업로드 → 디바이스 프레임에 합성
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 18 }}>
        {/* 좌: 입력 */}
        <div style={cardSt}>
          {/* 모드 */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {(['url', 'upload'] as const).map(m => (
              <button key={m} onClick={() => !busy && setMode(m)} disabled={busy}
                style={tabBtn(mode === m, busy)}>
                {m === 'url' ? 'URL 녹화' : '영상/이미지 업로드'}
              </button>
            ))}
          </div>

          {mode === 'url' ? (
            <>
              <Label>웹 페이지 URL</Label>
              <input type="url" value={url} onChange={e => setUrl(e.target.value)}
                placeholder="https://yourapp.com" disabled={busy} style={inputSt} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 10 }}>
                <NumField label="Viewport W" value={viewportW}
                  min={320} max={1024} step={1} disabled={busy}
                  onChange={setViewportW} />
                <NumField label="Viewport H" value={viewportH}
                  min={480} max={1366} step={1} disabled={busy}
                  onChange={setViewportH} />
                <NumField label="녹화 길이(초)" value={durationSec}
                  min={2} max={30} step={1} disabled={busy}
                  onChange={setDurationSec} />
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                기본값 = iPhone 13 Pro mobile viewport. 사이트가 모바일 뷰를 지원해야 자연스러움.
              </div>
            </>
          ) : (
            <>
              <Label>소스 파일 (mp4 / webm / mov / png / jpg)</Label>
              <FilePicker preview={sourcePreview} previewKind={sourceIsVideo ? 'video' : 'image'}
                onPick={onPickSource} disabled={busy} accept="video/*,image/*" />
              {sourceFileName && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  {sourceFileName} · {sourceIsVideo ? '영상' : '이미지'}
                </div>
              )}
            </>
          )}

          <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '18px 0' }} />

          {/* 디바이스 */}
          <Label>디바이스</Label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {devices.map(d => (
              <button key={d.id} onClick={() => !busy && setDeviceId(d.id)} disabled={busy}
                style={chipBtn(deviceId === d.id, busy)}>{d.name}</button>
            ))}
          </div>

          {/* 비율 */}
          <Label>출력 비율</Label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {ASPECTS.map(a => (
              <button key={a} onClick={() => !busy && setAspect(a)} disabled={busy}
                style={chipBtn(aspect === a, busy)}>{a}</button>
            ))}
          </div>

          {/* 디바이스 크기 */}
          <Label>디바이스 크기 ({Math.round(deviceScale * 100)}%)</Label>
          <input type="range" min={50} max={95} value={Math.round(deviceScale * 100)}
            onChange={e => setDeviceScale(Number(e.target.value) / 100)}
            disabled={busy} style={{ width: '100%', marginBottom: 14 }} />

          {/* 배경 */}
          <Label>배경 색상</Label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {BG_PRESETS.map(p => (
              <button key={p.value} onClick={() => !busy && setBgColor(p.value)} disabled={busy}
                title={p.label}
                style={{
                  width: 28, height: 28, borderRadius: 6,
                  background: p.value,
                  border: bgColor === p.value ? '2px solid var(--accent)' : '1px solid var(--border)',
                  cursor: busy ? 'wait' : 'pointer',
                }} />
            ))}
            <input type="color" value={bgColor} onChange={e => setBgColor(e.target.value)}
              disabled={busy}
              style={{ width: 28, height: 28, padding: 0, border: '1px solid var(--border)',
                borderRadius: 6, cursor: busy ? 'wait' : 'pointer', background: 'transparent' }} />
          </div>

          <Label>배경 이미지 (선택)</Label>
          <FilePicker preview={bgPreview} previewKind="image"
            onPick={onPickBg} disabled={busy} accept="image/*" compact />
          {bgFileId && (
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--success, #10b981)' }}>
              ✓ 배경 이미지 적용됨 (단색보다 우선)
            </div>
          )}

          <button onClick={submit} disabled={busy}
            style={{
              marginTop: 18, width: '100%', padding: '10px 14px',
              fontSize: 14, fontWeight: 700,
              background: busy ? 'var(--bg-elevated)' : 'var(--accent)',
              color: busy ? 'var(--text-muted)' : '#fff',
              border: 'none', borderRadius: 6,
              cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1,
            }}>
            {busy ? statusLabel[status] : '목업 생성'}
          </button>
        </div>

        {/* 우: 프리뷰 + 결과 */}
        <div style={cardSt}>
          <Label>미리보기</Label>
          {previewBox && device && (
            <div style={{
              width: previewBox.canvasW, height: previewBox.canvasH,
              margin: '0 auto', position: 'relative',
              background: bgPreview ? `center/cover url(${bgPreview})` : bgColor,
              borderRadius: 6, overflow: 'hidden',
              border: '1px solid var(--border)',
            }}>
              <img
                src={`${BASE}/api/mockup/frame/${device.id}.png`}
                alt={device.name}
                style={{
                  position: 'absolute',
                  width: previewBox.devW, height: previewBox.devH,
                  left: (previewBox.canvasW - previewBox.devW) / 2,
                  top: (previewBox.canvasH - previewBox.devH) / 2,
                  pointerEvents: 'none',
                }}
              />
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <Label>상태</Label>
            <div style={{
              padding: 12, borderRadius: 6, background: 'var(--bg-base)',
              border: '1px solid var(--border)', fontSize: 13,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontWeight: 600,
                color: status === 'done' ? 'var(--success, #10b981)'
                  : status === 'failed' ? 'var(--error)' : 'var(--text-primary)' }}>
                {statusLabel[status]}
              </span>
              {(busy || status === 'done') && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                  {elapsed}s
                </span>
              )}
            </div>
            {error && (
              <div style={{ marginTop: 8, padding: 10, borderRadius: 6,
                background: 'rgba(239,68,68,0.08)', border: '1px solid var(--error)',
                fontSize: 12, color: 'var(--error)' }}>
                {error}
              </div>
            )}
          </div>

          {outputUrl && (
            <div style={{ marginTop: 14 }}>
              <Label>결과</Label>
              {outputKind === 'mp4' ? (
                <video src={outputUrl} controls autoPlay loop muted
                  style={{ width: '100%', borderRadius: 8, background: '#000' }} />
              ) : (
                <img src={outputUrl} alt="mockup"
                  style={{ width: '100%', borderRadius: 8, background: '#000' }} />
              )}
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <a href={outputUrl} download target="_blank" rel="noopener noreferrer"
                  style={linkBtnSt}>↓ 다운로드</a>
                <button onClick={() => navigator.clipboard.writeText(outputUrl)}
                  style={linkBtnSt}>URL 복사</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── UI bits ──

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)',
      marginBottom: 6, letterSpacing: '0.02em' }}>{children}</div>
  )
}

function NumField({ label, value, min, max, step, disabled, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  disabled?: boolean; onChange: (n: number) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <input type="number" value={value} min={min} max={max} step={step}
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value) || min)}
        style={inputSt} />
    </div>
  )
}

function FilePicker({ preview, previewKind, onPick, disabled, accept, compact }: {
  preview: string; previewKind: 'video' | 'image';
  onPick: (f: File | null) => void; disabled?: boolean; accept: string; compact?: boolean;
}) {
  const inputId = `mockup-file-${accept.slice(0, 5)}`
  if (preview) {
    return (
      <div style={{ position: 'relative' }}>
        {previewKind === 'video'
          ? <video src={preview} muted autoPlay loop
              style={{ width: '100%', maxHeight: compact ? 100 : 220,
                objectFit: 'cover', borderRadius: 6, background: '#000',
                border: '1px solid var(--border)' }} />
          : <img src={preview}
              style={{ width: '100%', maxHeight: compact ? 100 : 220,
                objectFit: 'cover', borderRadius: 6, background: '#000',
                border: '1px solid var(--border)' }} />}
        <button onClick={() => onPick(null)} disabled={disabled}
          style={{ position: 'absolute', top: 6, right: 6, padding: '3px 8px',
            fontSize: 10, fontWeight: 600, border: 'none', borderRadius: 4,
            background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer' }}>교체</button>
      </div>
    )
  }
  return (
    <>
      <label htmlFor={inputId}
        style={{ display: 'block', padding: compact ? 12 : 24, textAlign: 'center',
          cursor: disabled ? 'wait' : 'pointer',
          border: '1.5px dashed var(--border)', borderRadius: 6,
          background: 'var(--bg-base)', color: 'var(--text-muted)', fontSize: 12 }}>
        + 클릭하여 파일 선택
      </label>
      <input id={inputId} type="file" accept={accept}
        onChange={e => onPick(e.target.files?.[0] || null)} disabled={disabled}
        style={{ display: 'none' }} />
    </>
  )
}

const cardSt: React.CSSProperties = {
  padding: 16, background: 'var(--bg-surface)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
}
const inputSt: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: 12,
  border: '1px solid var(--border)', borderRadius: 6,
  background: 'var(--bg-base)', color: 'var(--text-body)',
  boxSizing: 'border-box',
}
const linkBtnSt: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 600,
  background: 'var(--bg-elevated)', color: 'var(--accent)',
  border: '1px solid var(--border)', borderRadius: 4,
  textDecoration: 'none', cursor: 'pointer',
}
const tabBtn = (active: boolean, busy: boolean): React.CSSProperties => ({
  padding: '8px 14px', fontSize: 12, fontWeight: 700,
  border: '1px solid var(--border)', borderRadius: 6,
  background: active ? 'var(--accent)' : 'transparent',
  color: active ? '#fff' : 'var(--text-secondary)',
  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
})
const chipBtn = (active: boolean, busy: boolean): React.CSSProperties => ({
  padding: '6px 12px', fontSize: 12, fontWeight: 600,
  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
  borderRadius: 6,
  background: active ? 'rgba(99,102,241,0.12)' : 'var(--bg-base)',
  color: active ? 'var(--accent)' : 'var(--text-secondary)',
  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
})
