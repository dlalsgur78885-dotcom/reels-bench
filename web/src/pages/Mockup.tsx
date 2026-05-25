import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { mockupAuthedFetch, MOCKUP_BASE as MOCKUP_BASE_URL } from '../api'

type Mode = 'url' | 'upload' | 'sequence'
type Status = 'idle' | 'uploading' | 'submitting' | 'queued' | 'recording' | 'compositing' | 'done' | 'failed'

type MotionKind = 'none' | 'zoom-in' | 'zoom-out' | 'pan-tl-br' | 'pan-bl-tr' | 'pulse'

const MOTIONS: { value: MotionKind; label: string }[] = [
  { value: 'none',      label: '정지' },
  { value: 'zoom-in',   label: '🔍↗ 줌인' },
  { value: 'zoom-out',  label: '🔍↘ 줌아웃' },
  { value: 'pan-tl-br', label: '↘ 좌상→우하' },
  { value: 'pan-bl-tr', label: '↗ 좌하→우상' },
  { value: 'pulse',     label: '💓 펄스' },
]

type TransitionKind = 'cut' | 'fade' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'

const TRANSITIONS: { value: TransitionKind; label: string }[] = [
  { value: 'cut',         label: '컷' },
  { value: 'fade',        label: '페이드' },
  { value: 'slide-left',  label: '← 슬라이드' },
  { value: 'slide-right', label: '→ 슬라이드' },
  { value: 'slide-up',    label: '↑ 슬라이드' },
  { value: 'slide-down',  label: '↓ 슬라이드' },
]

interface Scene {
  /** 안정 클라이언트 id (drag/delete key) */
  uid: string
  /** 백엔드 file_id (업로드 후 채워짐) */
  fileId: string
  fileName: string
  isVideo: boolean
  /** blob URL — 썸네일/프리뷰용 */
  preview: string
  durationSec: number
  transition: TransitionKind
  transitionMs: number
  /** 정적 이미지 화면에 적용할 zoompan 모션 (영상 화면은 무시) */
  motion: MotionKind
}

function newSceneUid(): string {
  return `s_${Math.random().toString(36).slice(2, 10)}`
}

type Device = {
  id: string; name: string;
  body_w: number; body_h: number;
  screen_x: number; screen_y: number;
  screen_w: number; screen_h: number;
  screen_radius: number; corner_radius: number;
  color: string; notch: boolean;
}

const ASPECTS = ['9:16', '1:1', '4:5', '3:4', '16:9', '16:10', '4:3'] as const

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

interface BgPresetItem { id: string; label: string }
interface OverlayEffectItem { id: string; label: string }
interface DeviceStyleItem { id: string; label: string }
interface DeviceShadowItem { id: string; label: string }
interface TemplateItem {
  id: string
  label: string
  tagline?: string
  device_id: string
  aspect: string
  bg_preset: string
  device_style: string
  device_shadow: string
  device_shadow_opacity: number
  overlay_effect: string
  motion: string
}
interface SceneShapeItem { id: string; label: string }

interface AnimKeyframe {
  uid: string
  startSec: number
  endSec: number
  motion: MotionKind
}

function newKfUid(): string {
  return `kf_${Math.random().toString(36).slice(2, 10)}`
}

const KF_COLORS: Record<MotionKind, string> = {
  'none':      '#374151',
  'zoom-in':   '#3b82f6',
  'zoom-out':  '#06b6d4',
  'pan-tl-br': '#f59e0b',
  'pan-bl-tr': '#ec4899',
  'pulse':     '#a855f7',
}

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
  // 단일 이미지에 적용할 motion (영상 업로드 시에는 무시)
  const [uploadMotion, setUploadMotion] = useState<MotionKind>('zoom-in')
  const [uploadMotionDur, setUploadMotionDur] = useState<number>(4.0)

  // Sequence 모드 — 화면 N개
  const [scenes, setScenes] = useState<Scene[]>([])
  const [seqSelectedUid, setSeqSelectedUid] = useState<string>('')

  // 공통
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceId, setDeviceId] = useState<string>('iphone-16-pro')
  const [aspect, setAspect] = useState<typeof ASPECTS[number]>('9:16')
  const [bgColor, setBgColor] = useState('#1a1a2e')
  const [bgFileId, setBgFileId] = useState<string>('')
  const [bgPreview, setBgPreview] = useState<string>('')
  const [deviceScale, setDeviceScale] = useState(0.85)
  // shots.so 벤치 — procedural 배경 카탈로그 + 마감 효과
  const [bgPresets, setBgPresets] = useState<BgPresetItem[]>([])
  const [bgPresetId, setBgPresetId] = useState<string>('')          // '' = preset 미사용 (단색/이미지)
  const [overlayEffects, setOverlayEffects] = useState<OverlayEffectItem[]>([])
  const [overlayEffectId, setOverlayEffectId] = useState<string>('none')
  // shots.so audit 추가분 — 디바이스 스타일/그림자/숨김/모서리
  const [deviceStyles, setDeviceStyles] = useState<DeviceStyleItem[]>([])
  const [deviceStyleId, setDeviceStyleId] = useState<string>('default')
  const [deviceShadows, setDeviceShadows] = useState<DeviceShadowItem[]>([])
  const [deviceShadowId, setDeviceShadowId] = useState<string>('none')
  const [deviceShadowOpacity, setDeviceShadowOpacity] = useState<number>(1.0)
  const [hideMockup, setHideMockup] = useState<boolean>(false)
  const [radiusOverride, setRadiusOverride] = useState<number | null>(null)
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [appliedTemplateId, setAppliedTemplateId] = useState<string>('')
  const [tiltX, setTiltX] = useState<number>(0)
  const [tiltY, setTiltY] = useState<number>(0)
  const [sceneShapesItems, setSceneShapesItems] = useState<SceneShapeItem[]>([])
  const [sceneShapeId, setSceneShapeId] = useState<string>('none')
  // Animations 타임라인 (upload+이미지일 때만 의미)
  const [timelineEnabled, setTimelineEnabled] = useState<boolean>(false)
  const [keyframes, setKeyframes] = useState<AnimKeyframe[]>([])

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
    mockupAuthedFetch('/api/mockup/devices')
      .then(r => r.ok ? r.json() : { devices: [] })
      .then(d => setDevices(d.devices || []))
      .catch(() => {})
    mockupAuthedFetch('/api/mockup/backgrounds')
      .then(r => r.ok ? r.json() : { backgrounds: [] })
      .then(d => setBgPresets(d.backgrounds || []))
      .catch(() => {})
    mockupAuthedFetch('/api/mockup/effects')
      .then(r => r.ok ? r.json() : { effects: [] })
      .then(d => setOverlayEffects(d.effects || []))
      .catch(() => {})
    mockupAuthedFetch('/api/mockup/device-styles')
      .then(r => r.ok ? r.json() : { styles: [] })
      .then(d => setDeviceStyles(d.styles || []))
      .catch(() => {})
    mockupAuthedFetch('/api/mockup/device-shadows')
      .then(r => r.ok ? r.json() : { shadows: [] })
      .then(d => setDeviceShadows(d.shadows || []))
      .catch(() => {})
    mockupAuthedFetch('/api/mockup/templates')
      .then(r => r.ok ? r.json() : { templates: [] })
      .then(d => setTemplates(d.templates || []))
      .catch(() => {})
    mockupAuthedFetch('/api/mockup/scene-shapes')
      .then(r => r.ok ? r.json() : { shapes: [] })
      .then(d => setSceneShapesItems(d.shapes || []))
      .catch(() => {})
  }, [])

  const applyTemplate = (t: TemplateItem) => {
    setAppliedTemplateId(t.id)
    setDeviceId(t.device_id)
    if ((ASPECTS as readonly string[]).includes(t.aspect)) {
      setAspect(t.aspect as typeof ASPECTS[number])
    }
    setBgPresetId(t.bg_preset || '')
    setDeviceStyleId(t.device_style || 'default')
    setDeviceShadowId(t.device_shadow || 'none')
    setDeviceShadowOpacity(t.device_shadow_opacity ?? 1.0)
    setOverlayEffectId(t.overlay_effect || 'none')
    if (mode === 'upload' && !sourceIsVideo) {
      setUploadMotion((t.motion as MotionKind) || 'none')
    }
  }

  useEffect(() => () => {
    if (tickerRef.current) window.clearInterval(tickerRef.current)
    if (pollerRef.current) window.clearInterval(pollerRef.current)
    if (sourcePreview) URL.revokeObjectURL(sourcePreview)
    if (bgPreview) URL.revokeObjectURL(bgPreview)
    scenes.forEach(s => { if (s.preview) URL.revokeObjectURL(s.preview) })
  }, [])

  const device = devices.find(d => d.id === deviceId) ?? null
  const busy = ['uploading', 'submitting', 'queued', 'recording', 'compositing'].includes(status)
  const seqSelectedScene = scenes.find(s => s.uid === seqSelectedUid) ?? scenes[0] ?? null
  const seqTotalSec = useMemo(() => {
    if (scenes.length === 0) return 0
    // 첫 화면은 transition 없음. 이후는 duration − transition_ms 만큼만 누적 (xfade 겹침)
    let t = scenes[0].durationSec
    for (let i = 1; i < scenes.length; i++) {
      const s = scenes[i]
      const xf = s.transition === 'cut' ? 0 : s.transitionMs / 1000
      t += s.durationSec - xf
    }
    return Math.max(0, t)
  }, [scenes])

  const reset = () => {
    setStatus('idle'); setJobId(''); setProgress(''); setOutputUrl(''); setElapsed(0); setError('')
    if (tickerRef.current) { window.clearInterval(tickerRef.current); tickerRef.current = null }
    if (pollerRef.current) { window.clearInterval(pollerRef.current); pollerRef.current = null }
  }

  // shots.so 의 "Start Over" — 모든 입력 + 상태 초기화
  const startOver = () => {
    reset()
    setMode('url')
    setUrl(''); setViewportW(390); setViewportH(844); setDurationSec(6)
    if (sourcePreview) URL.revokeObjectURL(sourcePreview)
    setSourceFileId(''); setSourceFileName(''); setSourceIsVideo(true); setSourcePreview('')
    setUploadMotion('zoom-in'); setUploadMotionDur(4.0)
    scenes.forEach(s => { if (s.preview) URL.revokeObjectURL(s.preview) })
    setScenes([]); setSeqSelectedUid('')
    if (bgPreview) URL.revokeObjectURL(bgPreview)
    setBgFileId(''); setBgPreview('')
    setBgColor('#1a1a2e'); setBgPresetId('')
    setDeviceId('iphone-16-pro'); setAspect('9:16'); setDeviceScale(0.85)
    setDeviceStyleId('default'); setDeviceShadowId('none'); setDeviceShadowOpacity(1.0)
    setOverlayEffectId('none'); setHideMockup(false); setRadiusOverride(null)
    setTiltX(0); setTiltY(0); setSceneShapeId('none')
    setAppliedTemplateId(''); setTimelineEnabled(false); setKeyframes([])
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

  // ── Sequence helpers ──────────────────────────────────────────────────
  const addScenes = async (files: FileList | File[]) => {
    const arr = Array.from(files)
    if (!arr.length) return
    setError('')
    // 1) 낙관적 추가 — 업로드 전이라도 썸네일/순서가 보이게 한다
    const placeholders: Scene[] = arr.map(f => {
      const isVideo = f.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(f.name)
      return {
        uid: newSceneUid(),
        fileId: '',
        fileName: f.name,
        isVideo,
        preview: URL.createObjectURL(f),
        durationSec: 2.5,
        transition: 'fade',
        transitionMs: 400,
        motion: isVideo ? 'none' : 'zoom-in',
      }
    })
    setScenes(prev => [...prev, ...placeholders])
    if (!seqSelectedUid && placeholders[0]) setSeqSelectedUid(placeholders[0].uid)
    // 2) 순차 업로드 (parallel 도 가능하지만 worker 1대라 큰 이득 없음)
    setStatus('uploading')
    try {
      for (let i = 0; i < arr.length; i++) {
        const res = await uploadFile(arr[i])
        const uid = placeholders[i].uid
        setScenes(prev => prev.map(s => s.uid === uid
          ? { ...s, fileId: res.file_id, isVideo: res.is_video } : s))
      }
      setStatus('idle')
    } catch (e: any) {
      setStatus('failed'); setError(e?.message || String(e))
    }
  }

  const removeScene = (uid: string) => {
    setScenes(prev => {
      const target = prev.find(s => s.uid === uid)
      if (target?.preview) URL.revokeObjectURL(target.preview)
      const next = prev.filter(s => s.uid !== uid)
      if (seqSelectedUid === uid) setSeqSelectedUid(next[0]?.uid || '')
      return next
    })
  }

  const updateScene = (uid: string, patch: Partial<Scene>) => {
    setScenes(prev => prev.map(s => s.uid === uid ? { ...s, ...patch } : s))
  }

  const moveScene = (uid: string, dir: -1 | 1) => {
    setScenes(prev => {
      const idx = prev.findIndex(s => s.uid === uid)
      if (idx < 0) return prev
      const j = idx + dir
      if (j < 0 || j >= prev.length) return prev
      const next = prev.slice()
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
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
    if (mode === 'sequence') {
      if (scenes.length < 2) { setError('화면을 2개 이상 추가하세요'); return }
      const missing = scenes.find(s => !s.fileId)
      if (missing) { setError(`업로드 미완료: ${missing.fileName}`); return }
    }
    startTicker()
    try {
      setStatus('submitting')
      const path = mode === 'sequence' ? '/api/mockup/generate-sequence' : '/api/mockup/generate'
      const common = {
        bg_preset: bgPresetId || null,
        overlay_effect: overlayEffectId === 'none' ? null : overlayEffectId,
        device_shadow: deviceShadowId === 'none' ? null : deviceShadowId,
        device_shadow_opacity: deviceShadowOpacity,
        device_style: deviceStyleId === 'default' ? null : deviceStyleId,
        hide_mockup: hideMockup,
        radius_override: radiusOverride,
        tilt_x: tiltX,
        tilt_y: tiltY,
        scene_shapes: sceneShapeId === 'none' ? null : sceneShapeId,
      }
      const body = mode === 'sequence'
        ? {
            scenes: scenes.map(s => ({
              file_id: s.fileId,
              duration_sec: s.durationSec,
              transition: s.transition,
              transition_ms: s.transitionMs,
              motion: s.isVideo ? 'none' : s.motion,
            })),
            device_id: deviceId, aspect, bg_color: bgColor,
            bg_file_id: bgFileId || null,
            device_scale: deviceScale,
            ...common,
          }
        : {
            mode, url: mode === 'url' ? url : null,
            source_file_id: mode === 'upload' ? sourceFileId : null,
            bg_file_id: bgFileId || null,
            device_id: deviceId, aspect, bg_color: bgColor,
            device_scale: deviceScale,
            viewport_w: viewportW, viewport_h: viewportH,
            // upload+이미지+motion 이면 motion_dur 가 영상 길이를 결정 — 그 외는 기존 durationSec
            duration_sec: (mode === 'upload' && !sourceIsVideo && uploadMotion !== 'none')
              ? uploadMotionDur : durationSec,
            motion: (mode === 'upload' && !sourceIsVideo && !timelineEnabled) ? uploadMotion : 'none',
            animation_keyframes:
              (mode === 'upload' && !sourceIsVideo && timelineEnabled && keyframes.length > 0)
                ? keyframes.map(k => ({
                    start_sec: k.startSec, end_sec: k.endSec, motion: k.motion,
                  }))
                : null,
            ...common,
          }
      const r = await mockupAuthedFetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
    <div style={{ padding: 10, minHeight: 'calc(100vh - 20px)' }}>
      {/* 상단 toolbar — shots.so 스타일 (얇은 한 줄) */}
      <div style={{ marginBottom: 10, padding: '8px 12px', display: 'flex',
                     alignItems: 'center', gap: 12,
                     background: 'var(--bg-surface)',
                     border: '1px solid var(--border)', borderRadius: 6 }}>
        <Link to="/" style={{ fontSize: 12, color: 'var(--text-muted)' }}>← 홈</Link>
        <span style={{ fontSize: 14, fontWeight: 700 }}>앱 목업</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {device?.name || '...'} · {aspect}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, marginRight: 8,
                       color: status === 'done' ? 'var(--success, #10b981)'
                            : status === 'failed' ? 'var(--error)' : 'var(--text-muted)' }}>
          {statusLabel[status]}
          {(busy || status === 'done') && (
            <span style={{ marginLeft: 6, fontFamily: 'monospace' }}>{elapsed}s</span>
          )}
        </span>
        <button onClick={startOver} disabled={busy}
          style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600,
                   background: 'transparent', color: 'var(--text-secondary)',
                   border: '1px solid var(--border)', borderRadius: 4,
                   cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.5 : 1 }}>
          Start Over
        </button>
        <button onClick={submit} disabled={busy}
          style={{ padding: '6px 16px', fontSize: 12, fontWeight: 700,
                   background: busy ? 'var(--bg-elevated)' : 'var(--accent)',
                   color: busy ? 'var(--text-muted)' : '#fff',
                   border: 'none', borderRadius: 4,
                   cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1 }}>
          {busy ? statusLabel[status] : 'Export'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr 280px', gap: 10, alignItems: 'start' }}>
        {/* 좌: 모든 입력 (shots.so 스타일 — 스크롤 가능 사이드패널) */}
        <div style={{ ...cardSt, padding: 12, maxHeight: 'calc(100vh - 80px)',
                       overflowY: 'auto', overflowX: 'hidden' }}>

          {/* ───── TEMPLATES (사전 콤보) ───── */}
          {templates.length > 0 && (
            <div style={{ paddingBottom: 10 }}>
              <SectionHeader>Templates</SectionHeader>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                {templates.map(t => (
                  <button key={t.id} onClick={() => !busy && applyTemplate(t)} disabled={busy}
                    title={t.tagline}
                    style={{
                      textAlign: 'left', padding: 8, borderRadius: 6,
                      background: 'var(--bg-base)',
                      border: appliedTemplateId === t.id
                        ? '2px solid var(--accent)' : '1px solid var(--border)',
                      cursor: busy ? 'wait' : 'pointer',
                      display: 'flex', flexDirection: 'column', gap: 2,
                      minHeight: 50,
                    }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {t.label}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.3 }}>
                      {t.tagline}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ───── MEDIA (모드 + 입력) ───── */}
          <div style={sectionSt}>
            <SectionHeader>Media</SectionHeader>
            <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
              {(['url', 'upload', 'sequence'] as const).map(m => (
                <button key={m} onClick={() => !busy && setMode(m)} disabled={busy}
                  style={{ ...tabBtn(mode === m, busy), fontSize: 11, padding: '6px 10px' }}>
                  {m === 'url' ? 'URL' : m === 'upload' ? '단일' : '시퀀스'}
                </button>
              ))}
            </div>

          {mode === 'sequence' ? (
            <SceneList
              scenes={scenes}
              selectedUid={seqSelectedUid}
              onSelect={setSeqSelectedUid}
              onAddFiles={addScenes}
              onRemove={removeScene}
              onUpdate={updateScene}
              onMove={moveScene}
              disabled={busy}
            />
          ) : mode === 'url' ? (
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
              {/* 이미지일 때만 motion preset 노출 — 정적 캡처를 살아있는 mp4로 */}
              {sourceFileId && !sourceIsVideo && (
                <div style={{ marginTop: 14, padding: 10,
                  background: 'var(--bg-base)', borderRadius: 6,
                  border: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between',
                                alignItems: 'center', marginBottom: 6 }}>
                    <Label>모션 (이미지 → 영상)</Label>
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center',
                                    fontSize: 11, color: 'var(--text-secondary)',
                                    cursor: busy ? 'wait' : 'pointer' }}>
                      <input type="checkbox" checked={timelineEnabled} disabled={busy}
                        onChange={e => setTimelineEnabled(e.target.checked)} />
                      고급 타임라인
                    </label>
                  </div>
                  {!timelineEnabled ? (
                    <>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                        {MOTIONS.map(m => (
                          <button key={m.value}
                            onClick={() => !busy && setUploadMotion(m.value)} disabled={busy}
                            style={chipBtn(uploadMotion === m.value, busy)}>
                            {m.label}
                          </button>
                        ))}
                      </div>
                      {uploadMotion !== 'none' && (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 40 }}>길이</span>
                          <input type="range" min={1.5} max={10} step={0.1}
                            value={uploadMotionDur} disabled={busy}
                            onChange={e => setUploadMotionDur(Number(e.target.value))}
                            style={{ flex: 1 }} />
                          <span style={{ fontSize: 11, color: 'var(--text-secondary)', width: 36 }}>
                            {uploadMotionDur.toFixed(1)}s
                          </span>
                        </div>
                      )}
                      <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
                        {uploadMotion === 'none'
                          ? '정지 PNG로 출력'
                          : '미세 줌·팬으로 영상화 (mp4)'}
                      </div>
                    </>
                  ) : (
                    <KeyframeList
                      totalSec={uploadMotionDur}
                      onTotalChange={setUploadMotionDur}
                      keyframes={keyframes}
                      onChange={setKeyframes}
                      disabled={busy}
                    />
                  )}
                </div>
              )}
            </>
          )}
          </div>

          {/* ───── DEVICE ───── */}
          <div style={sectionSt}>
            <SectionHeader>Device</SectionHeader>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {devices.map(d => (
                <button key={d.id} onClick={() => !busy && setDeviceId(d.id)} disabled={busy}
                  style={chipBtn(deviceId === d.id, busy)}>{d.name}</button>
              ))}
            </div>
          </div>

          {/* ───── STYLE ───── */}
          {deviceStyles.length > 0 && (
            <div style={sectionSt}>
              <SectionHeader>Style</SectionHeader>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {deviceStyles.map(s => (
                  <button key={s.id} onClick={() => !busy && setDeviceStyleId(s.id)} disabled={busy}
                    style={{ ...chipBtn(deviceStyleId === s.id, busy), fontSize: 11 }}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ───── SHADOW ───── */}
          {deviceShadows.length > 0 && (
            <div style={sectionSt}>
              <SectionHeader hint={deviceShadowId !== 'none'
                ? `${Math.round(deviceShadowOpacity * 100)}%` : undefined}>
                Shadow
              </SectionHeader>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                {deviceShadows.map(s => (
                  <button key={s.id} onClick={() => !busy && setDeviceShadowId(s.id)} disabled={busy}
                    style={{ ...chipBtn(deviceShadowId === s.id, busy), fontSize: 11 }}>
                    {s.label}
                  </button>
                ))}
              </div>
              {deviceShadowId !== 'none' && (
                <input type="range" min={0} max={100} step={1}
                  value={Math.round(deviceShadowOpacity * 100)} disabled={busy}
                  onChange={e => setDeviceShadowOpacity(Number(e.target.value) / 100)}
                  style={{ width: '100%' }} />
              )}
            </div>
          )}

          {/* ───── BORDER (radius) ───── */}
          <div style={sectionSt}>
            <SectionHeader>Border</SectionHeader>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Radius</span>
              <input type="number" min={0} max={500} step={10}
                value={radiusOverride ?? ''} disabled={busy}
                placeholder="auto"
                onChange={e => {
                  const v = e.target.value.trim()
                  if (!v) { setRadiusOverride(null); return }
                  const n = parseInt(v, 10)
                  setRadiusOverride(Number.isFinite(n) ? n : null)
                }}
                style={{ width: 70, fontSize: 12, padding: '4px 6px',
                  border: '1px solid var(--border)', borderRadius: 4,
                  background: 'var(--bg-base)', color: 'var(--text-body)' }} />
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>px</span>
            </div>
          </div>

          {/* ───── VISIBILITY ───── */}
          <div style={sectionSt}>
            <SectionHeader>Visibility</SectionHeader>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12,
                            color: 'var(--text-secondary)', cursor: busy ? 'wait' : 'pointer' }}>
              <input type="checkbox" checked={hideMockup} disabled={busy}
                onChange={e => setHideMockup(e.target.checked)} />
              Hide Mockup (콘텐츠만 표시)
            </label>
          </div>

          {/* (Tilt / 비율 / 디바이스 크기 = LAYOUT preset — 우측 패널로 이동) */}

          {/* ───── SCENE ───── */}
          {sceneShapesItems.length > 0 && (
            <div style={sectionSt}>
              <SectionHeader>Scene</SectionHeader>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {sceneShapesItems.map(s => (
                  <button key={s.id} onClick={() => !busy && setSceneShapeId(s.id)} disabled={busy}
                    style={{ ...chipBtn(sceneShapeId === s.id, busy), fontSize: 11 }}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* (비율 + 디바이스 크기 = LAYOUT preset — 우측 패널로 이동) */}

          {/* ───── BACKGROUND ───── */}
          <div style={sectionSt}>
            <SectionHeader hint={bgPresetId ? 'preset' : (bgFileId ? 'image' : 'color')}>
              Background
            </SectionHeader>
            {/* preset 카탈로그 */}
            {bgPresets.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)',
                             gap: 6, marginBottom: 10 }}>
                <button onClick={() => !busy && setBgPresetId('')} disabled={busy}
                  title="solid / image"
                  style={{
                    aspectRatio: '3/4', borderRadius: 6, fontSize: 9, fontWeight: 600,
                    background: 'var(--bg-base)', color: 'var(--text-muted)',
                    border: bgPresetId === '' ? '2px solid var(--accent)' : '1px solid var(--border)',
                    cursor: busy ? 'wait' : 'pointer',
                  }}>None</button>
                {bgPresets.map(p => (
                  <button key={p.id} onClick={() => !busy && setBgPresetId(p.id)} disabled={busy}
                    title={p.label}
                    style={{
                      aspectRatio: '3/4', borderRadius: 6, padding: 0,
                      backgroundImage: `url(${MOCKUP_BASE_URL}/api/mockup/background/${p.id}.png)`,
                      backgroundSize: 'cover', backgroundPosition: 'center',
                      border: bgPresetId === p.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                      cursor: busy ? 'wait' : 'pointer',
                      position: 'relative', overflow: 'hidden',
                    }}>
                    <span style={{
                      position: 'absolute', bottom: 2, left: 0, right: 0,
                      fontSize: 9, fontWeight: 600, color: '#fff',
                      textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                    }}>{p.label}</span>
                  </button>
                ))}
              </div>
            )}
            {/* solid 컬러 (preset 미선택 시) */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {BG_PRESETS.map(p => (
                <button key={p.value} onClick={() => !busy && setBgColor(p.value)} disabled={busy}
                  title={p.label}
                  style={{
                    width: 24, height: 24, borderRadius: 4,
                    background: p.value,
                    border: bgColor === p.value ? '2px solid var(--accent)' : '1px solid var(--border)',
                    cursor: busy ? 'wait' : 'pointer',
                    opacity: bgPresetId ? 0.4 : 1,
                  }} />
              ))}
              <input type="color" value={bgColor} onChange={e => setBgColor(e.target.value)}
                disabled={busy}
                style={{ width: 24, height: 24, padding: 0, border: '1px solid var(--border)',
                  borderRadius: 4, cursor: busy ? 'wait' : 'pointer', background: 'transparent',
                  opacity: bgPresetId ? 0.4 : 1 }} />
            </div>
            {/* 이미지 업로드 */}
            <FilePicker preview={bgPreview} previewKind="image"
              onPick={onPickBg} disabled={busy} accept="image/*" compact />
          </div>

          {/* ───── EFFECTS (영상 마감 효과) ───── */}
          {overlayEffects.length > 0 && (
            <div style={sectionSt}>
              <SectionHeader hint="video">Effects</SectionHeader>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {overlayEffects.map(e => (
                  <button key={e.id}
                    onClick={() => !busy && setOverlayEffectId(e.id)} disabled={busy}
                    style={{ ...chipBtn(overlayEffectId === e.id, busy), fontSize: 11 }}>
                    {e.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Export 버튼은 상단 toolbar 로 이동 */}
        </div>

        {/* 우: 프리뷰 + 결과 */}
        <div style={cardSt}>
          <Label>
            미리보기
            {mode === 'sequence' && scenes.length > 0 && (
              <span style={{ marginLeft: 6, fontWeight: 500, color: 'var(--text-muted)' }}>
                · 선택된 화면 (총 {scenes.length}개 · 약 {seqTotalSec.toFixed(1)}s)
              </span>
            )}
          </Label>
          {previewBox && device && (() => {
            // 배경 우선순위: bg_preset > bg_image > bg_color (백엔드와 동일)
            let bgStyle: string
            if (bgPresetId) {
              bgStyle = `center/cover url(${MOCKUP_BASE_URL}/api/mockup/background/${bgPresetId}.png)`
            } else if (bgPreview) {
              bgStyle = `center/cover url(${bgPreview})`
            } else {
              bgStyle = bgColor
            }
            // tilt CSS perspective — 합성 결과와는 다르지만 시각 힌트
            const tiltTransform = (tiltX !== 0 || tiltY !== 0)
              ? `perspective(1200px) rotateY(${-tiltX}deg) rotateX(${tiltY}deg)`
              : 'none'
            return (
            <div style={{
              width: previewBox.canvasW, height: previewBox.canvasH,
              margin: '0 auto', position: 'relative',
              background: bgStyle,
              borderRadius: 6, overflow: 'hidden',
              border: '1px solid var(--border)',
              transform: tiltTransform,
              transformOrigin: 'center center',
              transition: 'transform 0.2s',
            }}>
              {/* screen 영역 — sequence(선택된 화면) 또는 upload(업로드 이미지) 미리보기 */}
              {(() => {
                const scale = previewBox.devH / device.body_h
                const scrL = (previewBox.canvasW - previewBox.devW) / 2 + device.screen_x * scale
                const scrT = (previewBox.canvasH - previewBox.devH) / 2 + device.screen_y * scale
                const scrW = device.screen_w * scale
                const scrH = device.screen_h * scale
                const common: React.CSSProperties = {
                  position: 'absolute', left: scrL, top: scrT, width: scrW, height: scrH,
                  objectFit: 'cover', borderRadius: device.screen_radius * scale,
                  pointerEvents: 'none', background: '#000',
                }
                if (mode === 'sequence' && seqSelectedScene) {
                  return seqSelectedScene.isVideo
                    ? <video src={seqSelectedScene.preview} muted autoPlay loop playsInline style={common} />
                    : <img src={seqSelectedScene.preview} alt="" style={common} />
                }
                if (mode === 'upload' && sourcePreview) {
                  return sourceIsVideo
                    ? <video src={sourcePreview} muted autoPlay loop playsInline style={common} />
                    : <img src={sourcePreview} alt="" style={common} />
                }
                return null
              })()}
              {!hideMockup && (() => {
                const params = new URLSearchParams()
                if (deviceStyleId && deviceStyleId !== 'default') params.set('style', deviceStyleId)
                if (deviceShadowId && deviceShadowId !== 'none') {
                  params.set('shadow', deviceShadowId)
                  params.set('shadow_opacity', deviceShadowOpacity.toFixed(2))
                }
                if (radiusOverride != null) params.set('radius', String(radiusOverride))
                const qs = params.toString()
                const url = `${MOCKUP_BASE_URL}/api/mockup/frame/${device.id}.png${qs ? '?' + qs : ''}`
                return (
                  <img
                    src={url}
                    alt={device.name}
                    style={{
                      position: 'absolute',
                      width: previewBox.devW, height: previewBox.devH,
                      left: (previewBox.canvasW - previewBox.devW) / 2,
                      top: (previewBox.canvasH - previewBox.devH) / 2,
                      pointerEvents: 'none',
                    }}
                  />
                )
              })()}
            </div>
            )
          })()}
        </div>

        {/* 우: BASE LAYOUT 미니 프리뷰 카드 + Zoom/Tilt + 상태/결과 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* ───── BASE LAYOUT 카드 (작은 미니 미리보기) ───── */}
          {previewBox && device && (
            <div style={{ ...cardSt, padding: 12 }}>
              <SectionHeader>Base Layout</SectionHeader>
              {/* 미니 캔버스 — 비율 그대로 축소 */}
              {(() => {
                const W = 220
                const [aw, ah] = aspect.split(':').map(Number)
                const H = Math.round((W * ah) / aw)
                const devH = H * deviceScale
                const ratio = device.body_w / device.body_h
                const devW = devH * ratio
                let bg: string
                if (bgPresetId) bg = `center/cover url(${MOCKUP_BASE_URL}/api/mockup/background/${bgPresetId}.png)`
                else if (bgPreview) bg = `center/cover url(${bgPreview})`
                else bg = bgColor
                return (
                  <div style={{ width: W, height: H, margin: '0 auto',
                                position: 'relative', background: bg,
                                borderRadius: 4, overflow: 'hidden',
                                border: '1px solid var(--border)' }}>
                    {!hideMockup && (
                      <div style={{ position: 'absolute',
                                    left: (W - devW) / 2, top: (H - devH) / 2,
                                    width: devW, height: devH,
                                    background: '#222', borderRadius: 8,
                                    border: '1px solid #444' }} />
                    )}
                  </div>
                )
              })()}
              {/* 비율 chip */}
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 10 }}>
                {ASPECTS.map(a => (
                  <button key={a} onClick={() => !busy && setAspect(a)} disabled={busy}
                    style={{ ...chipBtn(aspect === a, busy),
                             fontSize: 10, padding: '3px 6px' }}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ───── ZOOM (디바이스 크기) ───── */}
          <div style={{ ...cardSt, padding: 12 }}>
            <SectionHeader hint={`${Math.round(deviceScale * 100)}%`}>Zoom</SectionHeader>
            <input type="range" min={50} max={95} value={Math.round(deviceScale * 100)}
              onChange={e => setDeviceScale(Number(e.target.value) / 100)}
              disabled={busy} style={{ width: '100%' }} />
          </div>

          {/* ───── TILT (3D perspective) ───── */}
          <div style={{ ...cardSt, padding: 12 }}>
            <SectionHeader hint={`${tiltX}° / ${tiltY}°`}>Tilt</SectionHeader>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 28 }}>X</span>
              <input type="range" min={-30} max={30} step={1}
                value={tiltX} disabled={busy}
                onChange={e => setTiltX(Number(e.target.value))}
                style={{ flex: 1 }} />
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 28 }}>Y</span>
              <input type="range" min={-30} max={30} step={1}
                value={tiltY} disabled={busy}
                onChange={e => setTiltY(Number(e.target.value))}
                style={{ flex: 1 }} />
            </div>
          </div>

          {/* ───── STATUS + RESULT ───── */}
          <div style={{ ...cardSt, padding: 12 }}>
            <SectionHeader>Status</SectionHeader>
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

      {/* 하단 풀너비 timeline - sequence 또는 timeline 모드일 때 */}
      {((mode === 'sequence' && scenes.length > 0)
        || (mode === 'upload' && !sourceIsVideo && timelineEnabled && keyframes.length > 0)) ? (
        <div style={{ ...cardSt, marginTop: 10, padding: 12 }}>
          <SectionHeader
            hint={mode === 'sequence'
              ? `${scenes.length}개 화면 · ${seqTotalSec.toFixed(1)}s`
              : `${keyframes.length}개 키프레임 · ${uploadMotionDur.toFixed(1)}s`}>
            {mode === 'sequence' ? 'Sequence Track' : 'Animations Timeline'}
          </SectionHeader>
          <div style={{ position: 'relative', height: 36, background: '#111',
                         borderRadius: 4, border: '1px solid var(--border)',
                         overflow: 'hidden' }}>
            {mode === 'sequence' ? (() => {
              const total = seqTotalSec || 1
              let cursor = 0
              return scenes.map((s, idx) => {
                const left = `${(cursor / total) * 100}%`
                const width = `${(s.durationSec / total) * 100}%`
                const segDur = s.durationSec
                const xf = (idx > 0 && s.transition !== 'cut') ? s.transitionMs / 1000 : 0
                cursor += segDur - xf
                const hue = (idx * 53) % 360
                return (
                  <div key={s.uid} title={`#${idx + 1} ${s.fileName}`}
                    onClick={() => setSeqSelectedUid(s.uid)}
                    style={{ position: 'absolute', top: 0, bottom: 0, left, width,
                             background: s.uid === seqSelectedUid
                               ? `hsl(${hue}, 70%, 55%)` : `hsl(${hue}, 50%, 40%)`,
                             borderRight: '1px solid #000', fontSize: 9,
                             color: '#fff', display: 'flex', alignItems: 'center',
                             justifyContent: 'center', cursor: 'pointer',
                             overflow: 'hidden', whiteSpace: 'nowrap', padding: '0 4px' }}>
                    #{idx + 1}
                  </div>
                )
              })
            })() : (() => {
              const total = uploadMotionDur || 1
              const sorted = [...keyframes].sort((a, b) => a.startSec - b.startSec)
              return sorted.map(k => {
                const left = `${(k.startSec / total) * 100}%`
                const width = `${((k.endSec - k.startSec) / total) * 100}%`
                return (
                  <div key={k.uid} title={`${k.motion} ${k.startSec.toFixed(1)}~${k.endSec.toFixed(1)}s`}
                    style={{ position: 'absolute', top: 0, bottom: 0, left, width,
                             background: KF_COLORS[k.motion] || '#374151', opacity: 0.85,
                             borderRight: '1px solid #000', fontSize: 9, color: '#fff',
                             display: 'flex', alignItems: 'center', justifyContent: 'center',
                             overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    {k.motion}
                  </div>
                )
              })
            })()}
            {/* 1초 단위 눈금 */}
            {(() => {
              const total = mode === 'sequence' ? seqTotalSec : uploadMotionDur
              const n = Math.floor(total) + 1
              return Array.from({ length: n }, (_, i) => (
                <div key={i} style={{ position: 'absolute', top: 0, bottom: 0,
                                       left: `${(i / Math.max(0.1, total)) * 100}%`,
                                       width: 1, background: 'rgba(255,255,255,0.18)' }} />
              ))
            })()}
          </div>
          <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)',
                         display: 'flex', justifyContent: 'space-between' }}>
            <span>0:00</span>
            <span>{(mode === 'sequence' ? seqTotalSec : uploadMotionDur).toFixed(1)}s</span>
          </div>
        </div>
      ) : null}
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
// 좌측 패널의 한 섹션 — 옅은 구분선 + 내부 padding 으로 그룹화
const sectionSt: React.CSSProperties = {
  padding: '10px 0 10px',
  borderTop: '1px solid var(--border-subtle)',
}

// shots.so 의 작은 caps section header
function SectionHeader({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                   marginBottom: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700,
                     color: 'var(--text-muted)',
                     letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        {children}
      </div>
      {hint && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{hint}</div>}
    </div>
  )
}

const chipBtn = (active: boolean, busy: boolean): React.CSSProperties => ({
  padding: '6px 12px', fontSize: 12, fontWeight: 600,
  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
  borderRadius: 6,
  background: active ? 'rgba(99,102,241,0.12)' : 'var(--bg-base)',
  color: active ? 'var(--accent)' : 'var(--text-secondary)',
  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
})

// ── Scene list (시퀀스 모드) ─────────────────────────────────────────────

function SceneList(props: {
  scenes: Scene[]
  selectedUid: string
  onSelect: (uid: string) => void
  onAddFiles: (files: FileList | File[]) => void
  onRemove: (uid: string) => void
  onUpdate: (uid: string, patch: Partial<Scene>) => void
  onMove: (uid: string, dir: -1 | 1) => void
  disabled?: boolean
}) {
  const { scenes, selectedUid, onSelect, onAddFiles, onRemove, onUpdate, onMove, disabled } = props
  const inputId = 'mockup-scene-files'
  return (
    <div>
      <Label>화면 시퀀스 ({scenes.length}개)</Label>
      <div style={{ marginBottom: 10, fontSize: 11, color: 'var(--text-muted)' }}>
        앱 캡처 이미지 또는 짧은 영상을 여러 개 올리면 한 줄로 이어 붙여요.
        화면별로 길이와 화면→화면 전환을 조절할 수 있어요.
      </div>

      {scenes.length === 0 ? (
        <label htmlFor={inputId}
          style={{ display: 'block', padding: 32, textAlign: 'center',
            cursor: disabled ? 'wait' : 'pointer',
            border: '1.5px dashed var(--border)', borderRadius: 6,
            background: 'var(--bg-base)', color: 'var(--text-muted)', fontSize: 12 }}>
          + 화면 추가 (여러 개 선택 가능)
        </label>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          {scenes.map((s, idx) => {
            const isFirst = idx === 0
            const active = s.uid === selectedUid
            return (
              <div key={s.uid}
                onClick={() => onSelect(s.uid)}
                style={{
                  display: 'grid', gridTemplateColumns: '54px 1fr auto', gap: 10,
                  padding: 8, alignItems: 'center',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 6, background: active ? 'rgba(99,102,241,0.08)' : 'var(--bg-base)',
                  cursor: 'pointer',
                }}>
                {/* 썸네일 */}
                <div style={{ width: 54, height: 96, borderRadius: 4, overflow: 'hidden',
                  background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {s.preview
                    ? (s.isVideo
                        ? <video src={s.preview} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <img src={s.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />)
                    : <span style={{ fontSize: 10, color: '#888' }}>...</span>}
                </div>

                {/* 메타 / 컨트롤 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      #{idx + 1} · {s.fileName}
                    </span>
                    <span style={{ fontSize: 10, color: s.fileId ? 'var(--success, #10b981)' : 'var(--text-muted)' }}>
                      {s.fileId ? '✓' : '업로드 중'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 40 }}>길이</span>
                    <input type="range" min={0.5} max={10} step={0.1}
                      value={s.durationSec} disabled={disabled}
                      onChange={e => onUpdate(s.uid, { durationSec: Number(e.target.value) })}
                      onClick={e => e.stopPropagation()}
                      style={{ flex: 1 }} />
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)', width: 32 }}>
                      {s.durationSec.toFixed(1)}s
                    </span>
                  </div>
                  {!s.isVideo && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 40 }}>모션</span>
                      <select value={s.motion} disabled={disabled}
                        onChange={e => onUpdate(s.uid, { motion: e.target.value as MotionKind })}
                        onClick={e => e.stopPropagation()}
                        style={{ flex: 1, fontSize: 11, padding: '2px 4px',
                          background: 'var(--bg-elevated)', color: 'var(--text-body)',
                          border: '1px solid var(--border)', borderRadius: 4 }}>
                        {MOTIONS.map(m => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {!isFirst && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 40 }}>전환</span>
                      <select value={s.transition} disabled={disabled}
                        onChange={e => onUpdate(s.uid, { transition: e.target.value as TransitionKind })}
                        onClick={e => e.stopPropagation()}
                        style={{ fontSize: 11, padding: '2px 4px',
                          background: 'var(--bg-elevated)', color: 'var(--text-body)',
                          border: '1px solid var(--border)', borderRadius: 4 }}>
                        {TRANSITIONS.map(t => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                      {s.transition !== 'cut' && (
                        <>
                          <input type="range" min={50} max={1500} step={50}
                            value={s.transitionMs} disabled={disabled}
                            onChange={e => onUpdate(s.uid, { transitionMs: Number(e.target.value) })}
                            onClick={e => e.stopPropagation()}
                            style={{ flex: 1, minWidth: 60 }} />
                          <span style={{ fontSize: 10, color: 'var(--text-secondary)', width: 38 }}>
                            {s.transitionMs}ms
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* 액션 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
                  onClick={e => e.stopPropagation()}>
                  <button onClick={() => onMove(s.uid, -1)} disabled={disabled || idx === 0}
                    style={smallIconBtn} title="위로">↑</button>
                  <button onClick={() => onMove(s.uid, 1)} disabled={disabled || idx === scenes.length - 1}
                    style={smallIconBtn} title="아래로">↓</button>
                  <button onClick={() => onRemove(s.uid)} disabled={disabled}
                    style={{ ...smallIconBtn, color: 'var(--error)' }} title="삭제">✕</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <label htmlFor={inputId}
        style={{
          display: 'inline-block', padding: '8px 14px', fontSize: 12, fontWeight: 600,
          cursor: disabled ? 'wait' : 'pointer',
          background: 'var(--bg-elevated)', color: 'var(--text-body)',
          border: '1px solid var(--border)', borderRadius: 6, opacity: disabled ? 0.6 : 1,
        }}>+ 화면 추가</label>
      <input id={inputId} type="file" accept="image/*,video/*" multiple
        disabled={disabled}
        onChange={e => {
          if (e.target.files) onAddFiles(e.target.files)
          e.target.value = ''
        }}
        style={{ display: 'none' }} />
    </div>
  )
}

const smallIconBtn: React.CSSProperties = {
  width: 24, height: 22, fontSize: 11,
  background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

// ── KeyframeList (Animations 타임라인) ──────────────────────────────────

function KeyframeList(props: {
  totalSec: number
  onTotalChange: (v: number) => void
  keyframes: AnimKeyframe[]
  onChange: (kfs: AnimKeyframe[]) => void
  disabled?: boolean
}) {
  const { totalSec, onTotalChange, keyframes, onChange, disabled } = props

  const addKf = () => {
    const last = keyframes[keyframes.length - 1]
    const startSec = last ? Math.min(last.endSec, totalSec - 0.5) : 0
    const endSec = Math.min(totalSec, startSec + 2.0)
    onChange([...keyframes, {
      uid: newKfUid(),
      startSec, endSec,
      motion: 'zoom-in',
    }])
  }

  const update = (uid: string, patch: Partial<AnimKeyframe>) => {
    onChange(keyframes.map(k => k.uid === uid ? { ...k, ...patch } : k))
  }

  const remove = (uid: string) => {
    onChange(keyframes.filter(k => k.uid !== uid))
  }

  // 가로 막대 시각화 — 정렬된 keyframes 를 0~totalSec 비율로 배치
  const sorted = [...keyframes].sort((a, b) => a.startSec - b.startSec)

  return (
    <div>
      {/* 전체 길이 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 60 }}>전체 길이</span>
        <input type="range" min={2} max={20} step={0.5}
          value={totalSec} disabled={disabled}
          onChange={e => onTotalChange(Number(e.target.value))}
          style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', width: 36 }}>
          {totalSec.toFixed(1)}s
        </span>
      </div>

      {/* 가로 막대 시각화 */}
      <div style={{
        position: 'relative', height: 28, background: '#111', borderRadius: 4,
        marginBottom: 10, border: '1px solid var(--border)', overflow: 'hidden',
      }}>
        {sorted.map(k => {
          const left = `${(k.startSec / Math.max(0.1, totalSec)) * 100}%`
          const width = `${((k.endSec - k.startSec) / Math.max(0.1, totalSec)) * 100}%`
          return (
            <div key={k.uid} title={`${k.motion} ${k.startSec.toFixed(1)}~${k.endSec.toFixed(1)}s`}
              style={{
                position: 'absolute', top: 0, bottom: 0, left, width,
                background: KF_COLORS[k.motion] || '#374151', opacity: 0.85,
                borderRight: '1px solid #000', fontSize: 9, color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden', whiteSpace: 'nowrap',
              }}>
              {k.motion}
            </div>
          )
        })}
        {/* 시간 눈금 — 1초마다 */}
        {Array.from({ length: Math.floor(totalSec) + 1 }, (_, i) => (
          <div key={i} style={{
            position: 'absolute', top: 0, bottom: 0,
            left: `${(i / Math.max(0.1, totalSec)) * 100}%`,
            width: 1, background: 'rgba(255,255,255,0.15)',
          }} />
        ))}
      </div>

      {/* 키프레임 리스트 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {keyframes.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: 6 }}>
            아직 키프레임 없음 — "+ 키프레임 추가"로 시작하세요.
          </div>
        )}
        {keyframes.map((k, idx) => (
          <div key={k.uid} style={{
            display: 'grid',
            gridTemplateColumns: '24px 60px 50px 60px 50px 1fr 24px',
            gap: 6, alignItems: 'center', padding: 6,
            background: 'var(--bg-elevated)', borderRadius: 4,
            border: `1px solid ${KF_COLORS[k.motion]}40`,
          }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>#{idx + 1}</span>
            <input type="number" min={0} max={totalSec} step={0.1}
              value={k.startSec} disabled={disabled}
              onChange={e => update(k.uid, { startSec: Number(e.target.value) })}
              style={kfNumSt} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>→</span>
            <input type="number" min={0} max={totalSec} step={0.1}
              value={k.endSec} disabled={disabled}
              onChange={e => update(k.uid, { endSec: Number(e.target.value) })}
              style={kfNumSt} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>s</span>
            <select value={k.motion} disabled={disabled}
              onChange={e => update(k.uid, { motion: e.target.value as MotionKind })}
              style={{ fontSize: 11, padding: '3px 4px',
                background: 'var(--bg-base)', color: 'var(--text-body)',
                border: '1px solid var(--border)', borderRadius: 4 }}>
              {MOTIONS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <button onClick={() => remove(k.uid)} disabled={disabled}
              style={{ ...smallIconBtn, color: 'var(--error)' }} title="삭제">✕</button>
          </div>
        ))}
      </div>

      <button onClick={addKf} disabled={disabled || keyframes.length >= 20}
        style={{
          padding: '6px 12px', fontSize: 11, fontWeight: 600,
          background: 'var(--bg-elevated)', color: 'var(--text-body)',
          border: '1px solid var(--border)', borderRadius: 6,
          cursor: disabled ? 'wait' : 'pointer',
        }}>+ 키프레임 추가</button>
      <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
        구간 사이 빈 공간은 자동으로 정지로 채워져요. 겹치는 구간은 뒤 keyframe이 이깁니다.
      </div>
    </div>
  )
}

const kfNumSt: React.CSSProperties = {
  width: '100%', padding: '3px 4px', fontSize: 11,
  border: '1px solid var(--border)', borderRadius: 4,
  background: 'var(--bg-base)', color: 'var(--text-body)',
}
