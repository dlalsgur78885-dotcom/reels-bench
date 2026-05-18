import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { authedFetch, mockupAuthedFetch } from '../api'

type ConnStatus = { connected: boolean; configured: boolean;
  figma_user_id?: string; figma_handle?: string }
type Root = { id: string; name: string; x: number; y: number; w: number; h: number }
type TextLayer = {
  id: string; name: string; text: string;
  x: number; y: number; w: number; h: number;
  font_family: string; font_size: number; font_weight: number;
  color: string; align: string;
  line_height_px?: number; letter_spacing?: number;
}
type FetchResult = {
  file_key: string; node_id: string; root: Root; texts: TextLayer[];
  image_url: string; scale: number;
}

const ANIMATIONS = [
  { key: 'none',        label: '없음' },
  { key: 'fade-in',     label: '페이드 인' },
  { key: 'slide-up',    label: '슬라이드 ↑' },
  { key: 'slide-down',  label: '슬라이드 ↓' },
  { key: 'slide-left',  label: '슬라이드 ←' },
  { key: 'slide-right', label: '슬라이드 →' },
  { key: 'scale-in',    label: '스케일 인' },
  { key: 'typewriter',  label: '타자' },
] as const

type Device = { id: string; name: string }

type LayerEdit = {
  text: string
  color: string
  animation: string
  delay_ms: number
}

type Status = 'idle' | 'submitting' | 'queued' | 'recording' | 'compositing' | 'done' | 'failed'

export default function FigmaMockup() {
  const [params, setParams] = useSearchParams()

  const [conn, setConn] = useState<ConnStatus | null>(null)
  const [connLoading, setConnLoading] = useState(true)
  const [connError, setConnError] = useState('')

  // URL → fetch
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [design, setDesign] = useState<FetchResult | null>(null)

  // edits: layer id → edit
  const [edits, setEdits] = useState<Record<string, LayerEdit>>({})
  const [duration, setDuration] = useState(4)

  // device options
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceId, setDeviceId] = useState<string>('')  // '' = no device frame
  const [aspect, setAspect] = useState('9:16')
  const [bgColor, setBgColor] = useState('#1a1a2e')
  const [deviceScale, setDeviceScale] = useState(0.85)

  // render job
  const [status, setStatus] = useState<Status>('idle')
  const [jobId, setJobId] = useState('')
  const [progress, setProgress] = useState('')
  const [outputUrl, setOutputUrl] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [renderError, setRenderError] = useState('')

  const tickerRef = useRef<number | null>(null)
  const pollerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)

  // OAuth callback 메시지 처리
  useEffect(() => {
    if (params.get('figma_connected') === '1') {
      setParams({}, { replace: true })
      refreshStatus()
    } else if (params.get('figma_error')) {
      setConnError(`Figma 연결 실패: ${params.get('figma_error')}`)
      setParams({}, { replace: true })
    }
  }, [params, setParams])

  useEffect(() => { refreshStatus() }, [])
  useEffect(() => {
    authedFetch('/api/mockup/devices')
      .then(r => r.ok ? r.json() : { devices: [] })
      .then(d => setDevices((d.devices || []).map((x: any) => ({ id: x.id, name: x.name }))))
      .catch(() => {})
  }, [])
  useEffect(() => () => {
    if (tickerRef.current) window.clearInterval(tickerRef.current)
    if (pollerRef.current) window.clearInterval(pollerRef.current)
  }, [])

  const refreshStatus = async () => {
    setConnLoading(true)
    try {
      const r = await authedFetch('/api/figma/status')
      if (!r.ok) throw new Error(`${r.status}`)
      setConn(await r.json())
    } catch {
      setConn({ connected: false, configured: false })
    } finally {
      setConnLoading(false)
    }
  }

  const connectFigma = async () => {
    setConnError('')
    try {
      const r = await authedFetch('/api/figma/oauth/start')
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
      const data = await r.json()
      window.location.href = data.authorize_url
    } catch (e: any) {
      setConnError(e?.message || String(e))
    }
  }

  const disconnectFigma = async () => {
    if (!window.confirm('Figma 연결을 해제하시겠습니까?')) return
    try {
      await authedFetch('/api/figma/disconnect', { method: 'POST' })
      setConn({ connected: false, configured: true })
      setDesign(null)
      setEdits({})
    } catch {}
  }

  const fetchDesign = async () => {
    setFetchError(''); setDesign(null); setEdits({})
    if (!url.includes('figma.com')) { setFetchError('Figma URL 입력 필요'); return }
    setFetching(true)
    try {
      const r = await authedFetch('/api/figma/fetch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, scale: 2.0 }),
      })
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
      const data: FetchResult = await r.json()
      setDesign(data)
      // 초기 edits = 원본 text 그대로 + animation=none
      const e: Record<string, LayerEdit> = {}
      data.texts.forEach((t, i) => {
        e[t.id] = {
          text: t.text, color: t.color,
          animation: i < 3 ? 'fade-in' : 'none',
          delay_ms: i * 150,
        }
      })
      setEdits(e)
    } catch (e: any) {
      setFetchError(e?.message || String(e))
    } finally {
      setFetching(false)
    }
  }

  const updateEdit = (id: string, patch: Partial<LayerEdit>) => {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  const renderVideo = async () => {
    if (!design) return
    setRenderError(''); setOutputUrl(''); setStatus('submitting')
    if (tickerRef.current) window.clearInterval(tickerRef.current)
    if (pollerRef.current) window.clearInterval(pollerRef.current)
    startedAtRef.current = Date.now(); setElapsed(0)
    tickerRef.current = window.setInterval(() =>
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000)

    const layers = design.texts.map(t => {
      const e = edits[t.id] || { text: t.text, color: t.color, animation: 'none', delay_ms: 0 }
      return {
        id: t.id, text: e.text, color: e.color,
        x: t.x, y: t.y, w: t.w, h: t.h,
        font_family: t.font_family, font_size: t.font_size,
        font_weight: t.font_weight, align: t.align,
        line_height_px: t.line_height_px, letter_spacing: t.letter_spacing,
        animation: e.animation, delay_ms: e.delay_ms,
      }
    })

    try {
      const r = await mockupAuthedFetch('/api/figma/render-video', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: design.image_url,
          frame_w: Math.round(design.root.w),
          frame_h: Math.round(design.root.h),
          layers,
          duration_sec: duration,
          device_id: deviceId || null,
          aspect, bg_color: bgColor, device_scale: deviceScale,
        }),
      })
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
      const data = await r.json()
      const jid = data.job_id
      setJobId(jid); setStatus('queued')
      pollerRef.current = window.setInterval(async () => {
        try {
          const pr = await mockupAuthedFetch(`/api/figma/render-status?job_id=${encodeURIComponent(jid)}`)
          if (!pr.ok) return
          const ps = await pr.json()
          setStatus(ps.status); setProgress(ps.progress || '')
          if (ps.status === 'done') {
            setOutputUrl(ps.output_url)
            if (tickerRef.current) { window.clearInterval(tickerRef.current); tickerRef.current = null }
            if (pollerRef.current) { window.clearInterval(pollerRef.current); pollerRef.current = null }
          } else if (ps.status === 'failed') {
            setRenderError(ps.error || '실패')
            if (tickerRef.current) { window.clearInterval(tickerRef.current); tickerRef.current = null }
            if (pollerRef.current) { window.clearInterval(pollerRef.current); pollerRef.current = null }
          }
        } catch {}
      }, 1500) as unknown as number
    } catch (e: any) {
      setStatus('failed'); setRenderError(e?.message || String(e))
      if (tickerRef.current) { window.clearInterval(tickerRef.current); tickerRef.current = null }
    }
  }

  // 프리뷰 캔버스 크기 (최대 폭 380px)
  const previewBox = useMemo(() => {
    if (!design) return null
    const W = design.root.w, H = design.root.h
    const maxW = 380
    const scale = Math.min(1, maxW / W)
    return { W, H, scale, dw: W * scale, dh: H * scale }
  }, [design])

  const statusLabel: Record<Status, string> = {
    idle: '대기', submitting: '제출 중', queued: '대기열',
    recording: progress || '녹화 중', compositing: progress || '합성 중',
    done: '완료', failed: '실패',
  }
  const busy = ['submitting', 'queued', 'recording', 'compositing'].includes(status)

  // ── 렌더 분기 ──

  if (connLoading) {
    return <div style={{ padding: 40, color: 'var(--text-muted)' }}>연결 상태 확인 중…</div>
  }

  if (!conn?.configured) {
    return (
      <div style={{ maxWidth: 700, margin: '40px auto', padding: 24 }}>
        <Link to="/" style={{ fontSize: 12, color: 'var(--text-muted)' }}>← 홈</Link>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '8px 0 16px' }}>Figma 목업 — 설정 필요</h1>
        <div style={{ padding: 16, background: 'var(--bg-surface)',
          border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, lineHeight: 1.6 }}>
          <p>관리자가 먼저 <code>FIGMA_CLIENT_ID</code> + <code>FIGMA_CLIENT_SECRET</code> 시크릿을 등록해야 합니다.</p>
          <p style={{ marginTop: 8 }}>
            <a href="https://www.figma.com/developers/apps" target="_blank" rel="noreferrer"
              style={{ color: 'var(--accent)' }}>Figma → My OAuth apps</a> 에서 새 앱 생성 →
            callback URL은 <code style={{ fontSize: 11 }}>{location.origin}/api/figma/oauth/callback</code>
          </p>
        </div>
      </div>
    )
  }

  if (!conn.connected) {
    return (
      <div style={{ maxWidth: 700, margin: '40px auto', padding: 24 }}>
        <Link to="/" style={{ fontSize: 12, color: 'var(--text-muted)' }}>← 홈</Link>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '8px 0 16px' }}>Figma 목업</h1>
        <div style={{ padding: 20, background: 'var(--bg-surface)',
          border: '1px solid var(--border)', borderRadius: 6, textAlign: 'center' }}>
          <p style={{ fontSize: 14, marginBottom: 16 }}>
            Figma 디자인을 가져오려면 먼저 본인 Figma 계정을 연결하세요.
          </p>
          <button onClick={connectFigma} style={primaryBtnSt}>Figma 연결</button>
          {connError && (
            <div style={{ marginTop: 12, padding: 8, fontSize: 12,
              background: 'rgba(239,68,68,0.08)', color: 'var(--error)',
              border: '1px solid var(--error)', borderRadius: 4 }}>
              {connError}
            </div>
          )}
        </div>
      </div>
    )
  }

  // 연결됨 → 메인 UI
  return (
    <div style={{ maxWidth: 1320, margin: '0 auto', padding: 24 }}>
      <div style={{ marginBottom: 18, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <Link to="/" style={{ fontSize: 12, color: 'var(--text-muted)' }}>← 홈</Link>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Figma 목업 영상</h1>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          연결: {conn.figma_handle || conn.figma_user_id || 'Figma 계정'}
        </span>
        <button onClick={disconnectFigma}
          style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 11,
            background: 'transparent', color: 'var(--text-muted)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>
          연결 해제
        </button>
      </div>

      {/* URL fetch */}
      <div style={{ ...cardSt, marginBottom: 14 }}>
        <Label>Figma URL (프레임/컴포넌트 선택 후 Copy link to selection)</Label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input type="url" value={url} onChange={e => setUrl(e.target.value)}
            placeholder="https://www.figma.com/design/.../?node-id=12-34"
            disabled={fetching} style={{ ...inputSt, flex: 1 }}
            onKeyDown={e => { if (e.key === 'Enter') fetchDesign() }} />
          <button onClick={fetchDesign} disabled={fetching || !url}
            style={{ ...primaryBtnSt, opacity: (fetching || !url) ? 0.6 : 1 }}>
            {fetching ? '가져오는 중…' : '디자인 가져오기'}
          </button>
        </div>
        {fetchError && (
          <div style={errBoxSt}>{fetchError}</div>
        )}
      </div>

      {design && previewBox && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          {/* 좌: 프리뷰 */}
          <div style={cardSt}>
            <Label>프리뷰 (편집된 텍스트 + 원본 이미지)</Label>
            <div style={{
              width: previewBox.dw, height: previewBox.dh, position: 'relative',
              border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
              background: '#fff', margin: '0 auto',
            }}>
              <img src={design.image_url} alt={design.root.name}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                  objectFit: 'cover' }} />
              {design.texts.map(t => {
                const e = edits[t.id]
                const txt = e?.text ?? t.text
                const color = e?.color ?? t.color
                return (
                  <div key={t.id} style={{
                    position: 'absolute',
                    left: t.x * previewBox.scale,
                    top: t.y * previewBox.scale,
                    width: t.w * previewBox.scale,
                    minHeight: t.h * previewBox.scale,
                    color,
                    fontFamily: `'${t.font_family}', system-ui, sans-serif`,
                    fontSize: t.font_size * previewBox.scale,
                    fontWeight: t.font_weight,
                    textAlign: t.align as any,
                    lineHeight: t.line_height_px ? `${t.line_height_px * previewBox.scale}px` : 'normal',
                    letterSpacing: t.letter_spacing ? `${t.letter_spacing * previewBox.scale}px` : 'normal',
                    pointerEvents: 'none',
                  }}>{txt}</div>
                )
              })}
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
              프레임: {design.root.name} · {Math.round(design.root.w)} × {Math.round(design.root.h)}px ·
              텍스트 {design.texts.length}개
            </div>
          </div>

          {/* 우: 편집 패널 */}
          <div style={cardSt}>
            <Label>텍스트 편집 + 애니메이션</Label>
            <div style={{ maxHeight: 380, overflowY: 'auto', paddingRight: 4 }}>
              {design.texts.map((t, i) => {
                const e = edits[t.id] || { text: t.text, color: t.color, animation: 'none', delay_ms: 0 }
                return (
                  <div key={t.id} style={{
                    padding: 10, marginBottom: 8,
                    background: 'var(--bg-base)', border: '1px solid var(--border)',
                    borderRadius: 6,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
                        #{i + 1} · {t.name || '(이름 없음)'}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {Math.round(t.font_size)}px {t.font_weight}
                      </span>
                    </div>
                    <textarea value={e.text} onChange={ev => updateEdit(t.id, { text: ev.target.value })}
                      rows={Math.min(3, Math.max(1, (e.text || '').split('\n').length))}
                      style={{ ...inputSt, fontSize: 12, marginBottom: 6,
                        fontFamily: 'inherit', resize: 'vertical' }} />
                    <div style={{ display: 'grid', gridTemplateColumns: '40px 1.4fr 1fr', gap: 6 }}>
                      <input type="color" value={e.color}
                        onChange={ev => updateEdit(t.id, { color: ev.target.value })}
                        style={{ width: '100%', height: 28, padding: 0,
                          border: '1px solid var(--border)', borderRadius: 4,
                          background: 'transparent', cursor: 'pointer' }} />
                      <select value={e.animation}
                        onChange={ev => updateEdit(t.id, { animation: ev.target.value })}
                        style={selectSt}>
                        {ANIMATIONS.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
                      </select>
                      <input type="number" min={0} max={5000} step={100}
                        value={e.delay_ms} placeholder="지연(ms)"
                        onChange={ev => updateEdit(t.id, { delay_ms: Number(ev.target.value) || 0 })}
                        style={inputSt} />
                    </div>
                  </div>
                )
              })}
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '14px 0' }} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <div>
                <Label>영상 길이 (초)</Label>
                <input type="number" min={2} max={20} step={1} value={duration}
                  onChange={e => setDuration(Number(e.target.value) || 4)} style={inputSt} />
              </div>
              <div>
                <Label>디바이스 프레임</Label>
                <select value={deviceId} onChange={e => setDeviceId(e.target.value)} style={selectSt}>
                  <option value="">없음 (원본 비율)</option>
                  {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            </div>

            {deviceId && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                <div>
                  <Label>비율</Label>
                  <select value={aspect} onChange={e => setAspect(e.target.value)} style={selectSt}>
                    <option value="9:16">9:16</option>
                    <option value="1:1">1:1</option>
                    <option value="16:9">16:9</option>
                  </select>
                </div>
                <div>
                  <Label>배경</Label>
                  <input type="color" value={bgColor} onChange={e => setBgColor(e.target.value)}
                    style={{ width: '100%', height: 28, padding: 0, border: '1px solid var(--border)',
                      borderRadius: 4, background: 'transparent', cursor: 'pointer' }} />
                </div>
                <div>
                  <Label>크기 ({Math.round(deviceScale * 100)}%)</Label>
                  <input type="range" min={50} max={95} value={Math.round(deviceScale * 100)}
                    onChange={e => setDeviceScale(Number(e.target.value) / 100)}
                    style={{ width: '100%', marginTop: 4 }} />
                </div>
              </div>
            )}

            <button onClick={renderVideo} disabled={busy}
              style={{ ...primaryBtnSt, width: '100%', marginTop: 10,
                opacity: busy ? 0.7 : 1 }}>
              {busy ? statusLabel[status] : '영상 생성'}
            </button>

            {(busy || status === 'done' || status === 'failed') && (
              <div style={{
                marginTop: 10, padding: 10, fontSize: 12, borderRadius: 4,
                background: 'var(--bg-base)', border: '1px solid var(--border)',
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span style={{ fontWeight: 600,
                  color: status === 'done' ? 'var(--success, #10b981)'
                    : status === 'failed' ? 'var(--error)' : 'var(--text-primary)' }}>
                  {statusLabel[status]}
                </span>
                <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{elapsed}s</span>
              </div>
            )}
            {renderError && <div style={errBoxSt}>{renderError}</div>}

            {outputUrl && (
              <div style={{ marginTop: 12 }}>
                <video src={outputUrl} controls autoPlay loop muted
                  style={{ width: '100%', borderRadius: 6, background: '#000' }} />
                <a href={outputUrl} download target="_blank" rel="noopener noreferrer"
                  style={{ ...linkBtnSt, display: 'inline-block', marginTop: 8 }}>
                  ↓ 다운로드
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)',
      marginBottom: 6, letterSpacing: '0.02em' }}>{children}</div>
  )
}

const cardSt: React.CSSProperties = {
  padding: 16, background: 'var(--bg-surface)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
}
const inputSt: React.CSSProperties = {
  width: '100%', padding: '7px 10px', fontSize: 12,
  border: '1px solid var(--border)', borderRadius: 4,
  background: 'var(--bg-base)', color: 'var(--text-body)',
  boxSizing: 'border-box',
}
const selectSt: React.CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 12,
  border: '1px solid var(--border)', borderRadius: 4,
  background: 'var(--bg-base)', color: 'var(--text-body)',
}
const primaryBtnSt: React.CSSProperties = {
  padding: '8px 16px', fontSize: 13, fontWeight: 700,
  background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer',
}
const linkBtnSt: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 600,
  background: 'var(--bg-elevated)', color: 'var(--accent)',
  border: '1px solid var(--border)', borderRadius: 4,
  textDecoration: 'none', cursor: 'pointer',
}
const errBoxSt: React.CSSProperties = {
  marginTop: 8, padding: 10, fontSize: 12,
  background: 'rgba(239,68,68,0.08)', color: 'var(--error)',
  border: '1px solid var(--error)', borderRadius: 4,
}
