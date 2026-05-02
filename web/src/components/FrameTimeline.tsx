import { useRef, useEffect, useCallback, useState } from 'react'

interface EmotionData {
  pitch: number
  volume: number
  silence: boolean
  emotion: string
  label: string
  confidence: number
}

interface Props {
  frameLines: Record<number, string>
  sortedSecs: number[]
  cutMarkers: number[]
  cumulativeCuts: number[]
  frameImages: Record<number, string>
  audioEmotions?: Record<number, EmotionData>
  ocrSubtitles?: Record<number, string>
  scriptBySec?: Record<number, string>
  bgmChanges?: { sec: number; score: number }[]
}

// 단일강조 + 중성 팔레트
const C_ACCENT = '#307df0'        // var(--accent)
const C_ACCENT_DEEP = '#2664c3'   // var(--primary-600)
const C_MUTED = '#8B94A9'         // var(--text-muted)
const C_MUTED_FILL = 'rgba(139,148,169,0.15)'
const C_GRID = '#F0F1F5'          // var(--border-subtle)
const C_LABEL = '#8B94A9'

export default function FrameTimeline({ frameLines, sortedSecs, cutMarkers, cumulativeCuts, frameImages, audioEmotions, ocrSubtitles, scriptBySec, bgmChanges }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const vlineRef = useRef<HTMLDivElement>(null)
  const [currentSec, setCurrentSec] = useState(sortedSecs[0] ?? 0)
  const [listOpen, setListOpen] = useState(false)
  const dragging = useRef(false)

  // Preload all frame images on mount
  useEffect(() => {
    Object.values(frameImages).forEach(src => {
      if (src && typeof src === 'string' && src.startsWith('http')) {
        const img = new Image()
        img.src = src
      }
    })
  }, [frameImages])

  const maxCut = Math.max(...cumulativeCuts, 1)
  const PAD = { l: 30, r: 10, t: 8, b: 22 }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const area = areaRef.current!
    canvas.width = area.clientWidth
    canvas.height = area.clientHeight
    const ctx = canvas.getContext('2d')!
    const w = canvas.width, h = canvas.height
    const cw = w - PAD.l - PAD.r
    const ch = h - PAD.t - PAD.b

    ctx.clearRect(0, 0, w, h)

    // grid (3 horizontal lines, very subtle)
    ctx.strokeStyle = C_GRID
    ctx.lineWidth = 1
    for (let i = 0; i <= 3; i++) {
      const y = PAD.t + ch * (1 - i / 3)
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke()
    }

    // x labels
    ctx.fillStyle = C_LABEL
    ctx.font = '10px Pretendard Variable, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    const step = Math.max(1, Math.floor(sortedSecs.length / 8))
    for (let i = 0; i < sortedSecs.length; i += step) {
      const x = PAD.l + (i / (sortedSecs.length - 1)) * cw
      ctx.fillText(`0:${String(sortedSecs[i]).padStart(2, '0')}`, x, h - 4)
    }

    // cut marker vertical lines (very faint neutral)
    for (let i = 0; i < sortedSecs.length; i++) {
      if (cutMarkers[i]) {
        const x = PAD.l + (i / (sortedSecs.length - 1)) * cw
        ctx.strokeStyle = 'rgba(139,148,169,0.18)'
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + ch); ctx.stroke()
      }
    }

    // volume area first (background context)
    if (audioEmotions && Object.keys(audioEmotions).length) {
      const maxVol = Math.max(...sortedSecs.map(s => audioEmotions[s + 1]?.volume || 0), 1)
      ctx.fillStyle = C_MUTED_FILL
      ctx.beginPath()
      ctx.moveTo(PAD.l, PAD.t + ch)
      for (let i = 0; i < sortedSecs.length; i++) {
        const x = PAD.l + (i / (sortedSecs.length - 1)) * cw
        const vol = audioEmotions[sortedSecs[i] + 1]?.volume || 0
        ctx.lineTo(x, PAD.t + ch * (1 - vol / maxVol))
      }
      ctx.lineTo(PAD.l + cw, PAD.t + ch)
      ctx.closePath(); ctx.fill()
      ctx.strokeStyle = C_MUTED; ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 0; i < sortedSecs.length; i++) {
        const x = PAD.l + (i / (sortedSecs.length - 1)) * cw
        const vol = audioEmotions[sortedSecs[i] + 1]?.volume || 0
        const y = PAD.t + ch * (1 - vol / maxVol)
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    // BGM change (dashed muted line, no diamond)
    if (bgmChanges && bgmChanges.length) {
      ctx.save()
      ctx.setLineDash([4, 3])
      ctx.strokeStyle = C_MUTED
      ctx.lineWidth = 1
      for (const bc of bgmChanges) {
        const idx = sortedSecs.indexOf(bc.sec)
        if (idx < 0) continue
        const x = PAD.l + (idx / (sortedSecs.length - 1)) * cw
        ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + ch); ctx.stroke()
      }
      ctx.restore()
    }

    // cumulative cuts line (THE primary signal, accent)
    ctx.strokeStyle = C_ACCENT
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i < sortedSecs.length; i++) {
      const x = PAD.l + (i / (sortedSecs.length - 1)) * cw
      const y = PAD.t + ch * (1 - cumulativeCuts[i] / maxCut)
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()

    // cut points (white fill + accent ring on the cumulative line)
    for (let i = 0; i < sortedSecs.length; i++) {
      if (cutMarkers[i]) {
        const x = PAD.l + (i / (sortedSecs.length - 1)) * cw
        const y = PAD.t + ch * (1 - cumulativeCuts[i] / maxCut)
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2)
        ctx.fillStyle = '#FFFFFF'; ctx.fill()
        ctx.lineWidth = 1.5; ctx.strokeStyle = C_ACCENT_DEEP; ctx.stroke()
      }
    }
  }, [sortedSecs, cutMarkers, cumulativeCuts, maxCut, audioEmotions, bgmChanges])

  useEffect(() => {
    draw()
    window.addEventListener('resize', draw)
    return () => window.removeEventListener('resize', draw)
  }, [draw])

  const getSecFromX = (clientX: number) => {
    const rect = areaRef.current!.getBoundingClientRect()
    const cw = rect.width - PAD.l - PAD.r
    let ratio = (clientX - rect.left - PAD.l) / cw
    ratio = Math.max(0, Math.min(1, ratio))
    return sortedSecs[Math.round(ratio * (sortedSecs.length - 1))]
  }

  const updateVline = (sec: number) => {
    setCurrentSec(sec)
    if (!vlineRef.current || !areaRef.current) return
    const rect = areaRef.current.getBoundingClientRect()
    const cw = rect.width - PAD.l - PAD.r
    const idx = sortedSecs.indexOf(sec)
    const x = PAD.l + (idx / (sortedSecs.length - 1)) * cw
    vlineRef.current.style.left = `${x}px`
  }

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true
    updateVline(getSecFromX(e.clientX))
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) updateVline(getSecFromX(e.clientX))
  }
  const onPointerUp = () => { dragging.current = false }

  const desc = frameLines[currentSec] || ''
  const parts = desc.split('|').map(p => p.trim()).filter(Boolean)
  const isCut = cutMarkers[sortedSecs.indexOf(currentSec)] === 1
  const rawImg = frameImages[currentSec + 1]
  const imgSrc = rawImg
    ? (rawImg.startsWith('http') ? rawImg : `data:image/jpeg;base64,${rawImg}`)
    : ''
  const isBgmChange = bgmChanges?.some(bc => bc.sec === currentSec || bc.sec === currentSec + 1)
  const emo = audioEmotions?.[currentSec + 1]
  const ocr = ocrSubtitles?.[currentSec + 1] || ocrSubtitles?.[currentSec]
  const script = scriptBySec?.[currentSec + 1] || scriptBySec?.[currentSec]

  return (
    <>
      <div className="timeline-wrap">
        <div className="timeline-label">프레임 타임라인</div>
        <div className="timeline-legend">
          <span className="legend-item">
            <span className="legend-swatch legend-swatch--accent-line" />누적 컷
          </span>
          {audioEmotions && Object.keys(audioEmotions).length > 0 && (
            <span className="legend-item">
              <span className="legend-swatch legend-swatch--muted-area" />볼륨
            </span>
          )}
          <span className="legend-item">
            <span className="legend-swatch legend-swatch--accent-ring" />컷 포인트
          </span>
          {bgmChanges && bgmChanges.length > 0 && (
            <span className="legend-item">
              <span className="legend-swatch legend-swatch--muted-dash" />BGM 변경
            </span>
          )}
        </div>
        <div
          ref={areaRef}
          className="chart-area"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <canvas ref={canvasRef} />
          <div ref={vlineRef} className="vline" style={{ left: PAD.l }} />
        </div>

        <div className="viewer">
          {imgSrc ? (
            <img className="viewer-img" src={imgSrc} alt="" loading="lazy" decoding="async" />
          ) : (
            <div className="viewer-img" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)' }}>
              이미지 없음
            </div>
          )}
          <div className="viewer-desc">
            <div className="viewer-sec">
              현재 {currentSec}초
              {isCut && <span className="frame-flag">컷</span>}
              {isBgmChange && <span className="frame-flag">BGM</span>}
            </div>
            {emo && (
              <div className="frame-emotion">
                <span className="frame-emotion-label">{emo.label}</span>
                {emo.confidence > 0 && (
                  <span className="frame-emotion-meta">{Math.round(emo.confidence * 100)}%</span>
                )}
                {emo.volume > 0 && <span className="frame-emotion-meta">vol {emo.volume}</span>}
                {emo.pitch > 0 && <span className="frame-emotion-meta">pitch {emo.pitch}Hz</span>}
              </div>
            )}
            {script && <div className="frame-quote">"{script}"</div>}
            {ocr && (
              <div className="frame-caption">
                <span className="frame-caption-tag">CC</span>{ocr}
              </div>
            )}
            {parts.map((p, i) => <div key={i} className="desc-line">{p}</div>)}
            {!desc && <div className="desc-line" style={{ color: 'var(--text-muted)' }}>데이터 없음</div>}
          </div>
        </div>
      </div>

      <div className="frame-list">
        <button
          type="button"
          className="frame-list-toggle"
          aria-expanded={listOpen}
          aria-controls="frame-list-body"
          onClick={() => setListOpen(!listOpen)}
        >
          전체 프레임 ({sortedSecs.length}) {listOpen ? '▴' : '▾'}
        </button>
        {listOpen && (
          <div id="frame-list-body" className="frame-list-body">
            {sortedSecs.map(sec => (
              <button
                key={sec}
                type="button"
                className="frame-list-item"
                onClick={() => updateVline(sec)}
              >
                <strong>{sec}초</strong> {frameLines[sec]}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
