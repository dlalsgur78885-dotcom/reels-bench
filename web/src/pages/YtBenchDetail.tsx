import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { authedFetch } from '../api'
import { fmtNum, engagementRate, erColor, parseFrameAnalysis } from '../utils'
import FrameTimeline from '../components/FrameTimeline'

const EMO_KO: Record<string, string> = {
  happy: '기쁨', excited: '신남', sad: '슬픔', angry: '분노',
  fearful: '공포', surprised: '놀람', neutral: '중립', calm: '차분',
  crying: '우는', nervous: '불안', curious: '호기심', serious: '진지',
  tired: '피곤', frustrated: '좌절', cheerful: '명랑',
  sarcastic: '비꼬는', mischievously: '장난스러운',
}
const DELIVERY_KO: Record<string, string> = {
  whispers: '속삭임', shouts: '외침', slowly: '천천히', very_fast: '빠르게',
}

interface YtMeta {
  shortcode: string
  view_count: number
  like_count: number
  comment_count: number
  video_duration: number
  thumbnail_url: string
  caption_text: string
  author_username: string
  author_full_name: string
  taken_at: string
}
interface TtsSeg {
  start: string | number
  end: string | number
  direction?: string
  delivery?: string
  text: string
}
interface EmoSegRaw {
  start: string | number
  end: string | number
  emotion: string
  intensity: number
  delivery?: string
  source?: string
  reason?: string
}
interface EmotionData {
  pitch: number
  volume: number
  silence: boolean
  emotion: string
  label: string
  confidence: number
}
interface SfxSeg { time: string; type: string; description: string }
interface BgmSeg { start: string; end: string; mood: string; genre: string; tempo: string; identified?: string }

interface DetailData {
  shortcode: string
  url: string
  metadata: YtMeta
  pro_audio: {
    sound_effects?: SfxSeg[]
    bgm?: BgmSeg[]
    duration_sec?: number
    hook?: any
    narration?: any
    visual_cuts?: any[]
    viral_factors?: string[]
    audio_events?: any[]
    tts_script?: TtsSeg[]
  }
  audio_emotions: Record<number, EmotionData>
  audio_emotions_raw: EmoSegRaw[]
  bgm_changes: { sec: number; score: number }[]
  bgm_changes_raw: BgmSeg[]
  tts: TtsSeg[]
  frame_analysis: string
  frame_ocr: Record<string, string>
  script_by_sec: Record<string, string>
  frame_images: Record<string, string>
  script_structure?: any
  category?: any
}

function toSec(v: string | number): number {
  if (typeof v === 'number') return v
  const s = String(v).trim()
  if (s.includes(':')) {
    const [m, ss] = s.split(':').map(parseFloat)
    return (m || 0) * 60 + (ss || 0)
  }
  return parseFloat(s) || 0
}

type Tab = 'overview' | 'frames' | 'script'

export default function YtBenchDetail() {
  const { shortcode } = useParams<{ shortcode: string }>()
  const navigate = useNavigate()
  const [data, setData] = useState<DetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<Tab>('overview')

  useEffect(() => {
    if (!shortcode) return
    setLoading(true)
    authedFetch(`/api/yt/bench/${shortcode}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then(setData)
      .catch(e => setErr(String(e.message || e)))
      .finally(() => setLoading(false))
  }, [shortcode])

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>불러오는 중...</div>
  if (err || !data) return <div style={{ padding: 40, color: 'var(--error)' }}>오류: {err || '데이터 없음'}</div>

  const m = data.metadata
  const pa = data.pro_audio
  const er = engagementRate(m.like_count, m.view_count)
  const duration = pa.duration_sec || m.video_duration || 0
  const ss = data.script_structure as any
  const parsed = data.frame_analysis ? parseFrameAnalysis(data.frame_analysis) : null

  // Record<string, X> → Record<number, X> 변환 (JSON 키는 string)
  const audioEmosNumeric: Record<number, EmotionData> = {}
  for (const [k, v] of Object.entries(data.audio_emotions || {})) {
    audioEmosNumeric[Number(k)] = v
  }
  const ocrNumeric: Record<number, string> = {}
  for (const [k, v] of Object.entries(data.frame_ocr || {})) {
    ocrNumeric[Number(k)] = v
  }
  const scriptBySecNumeric: Record<number, string> = {}
  for (const [k, v] of Object.entries(data.script_by_sec || {})) {
    scriptBySecNumeric[Number(k)] = v
  }
  const frameImagesNumeric: Record<number, string> = {}
  for (const [k, v] of Object.entries(data.frame_images || {})) {
    frameImagesNumeric[Number(k)] = v
  }

  return (
    <>
      <button className="detail-back" onClick={() => navigate('/yt/bench')}>
        ← 벤치마크
      </button>

      <div className="detail-header">
        <h1>{m.author_full_name || m.author_username || data.shortcode}</h1>
        <a
          href={data.url || `https://www.youtube.com/shorts/${data.shortcode}`}
          target="_blank"
          rel="noopener noreferrer"
          className="external-link"
        >
          YouTube ↗
        </a>
        <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--text-muted)' }}>
          {data.shortcode}
        </span>
      </div>

      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-label">조회수</div>
          <div className="kpi-value">{fmtNum(m.view_count)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">좋아요</div>
          <div className="kpi-value">{fmtNum(m.like_count)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">참여율</div>
          <div className="kpi-value" style={{ color: erColor(er) }}>{er}%</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">길이</div>
          <div className="kpi-value">{Math.round(duration)}초</div>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>개요</button>
        <button className={`tab${tab === 'frames' ? ' active' : ''}`} onClick={() => setTab('frames')}>프레임 분석</button>
        <button className={`tab${tab === 'script' ? ' active' : ''}`} onClick={() => setTab('script')}>대본 분석</button>
      </div>

      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 24 }}>
          <div>
            <div style={{ width: '100%', borderRadius: 'var(--radius-lg)', overflow: 'hidden', aspectRatio: '9/16', background: '#000' }}>
              <iframe
                src={`https://www.youtube.com/embed/${data.shortcode}`}
                title={data.shortcode}
                style={{ width: '100%', height: '100%', border: 0 }}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>BGM</span>
              <span style={{ color: 'var(--text-body)' }}>
                {(pa.bgm && pa.bgm[0]) ? `${pa.bgm[0].genre} · ${pa.bgm[0].mood}` : '오리지널'}
              </span>
            </div>
            {data.category ? (
              <div className="section-card" style={{ marginTop: 12, padding: 12 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {data.category.topic && <span className="tag-pill">{data.category.topic}</span>}
                  {data.category.topic_detail && <span className="tag-pill">{data.category.topic_detail}</span>}
                  {data.category.style && <span className="tag-pill">{data.category.style}</span>}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(data.category.tags || []).map((t: string, i: number) => (
                    <span key={i} className="tag-pill tag-pill--small">{t.startsWith('#') ? t : `#${t}`}</span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="section-card" style={{ marginTop: 12, padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>
                카테고리 분석 없음
              </div>
            )}
          </div>

          <div>
            <div style={{ marginBottom: 16 }}>
              <div className="eyebrow-label">대본</div>
              {data.tts.length > 0 ? (
                <div className="transcript-box" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {data.tts.map((s, i) => {
                    const sStart = toSec(s.start)
                    const sEnd = toSec(s.end)
                    let bestEmo: EmoSegRaw | null = null
                    let bestOv = 0
                    for (const e of (data.audio_emotions_raw || [])) {
                      const eS = toSec(e.start)
                      const eE = toSec(e.end)
                      const ov = Math.max(0, Math.min(sEnd, eE) - Math.max(sStart, eS))
                      if (ov > bestOv) { bestOv = ov; bestEmo = e }
                    }
                    return (
                      <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <span style={{
                          fontSize: 11, fontVariantNumeric: 'tabular-nums',
                          color: 'var(--text-muted)', flexShrink: 0, minWidth: 64,
                        }}>
                          {sStart.toFixed(1)}-{sEnd.toFixed(1)}초
                        </span>
                        {s.direction && (
                          <span className="tag-pill tag-pill--small" style={{ flexShrink: 0 }}>{s.direction}</span>
                        )}
                        {bestEmo && (
                          <span className="tag-pill tag-pill--small" style={{ flexShrink: 0, color: 'var(--success)', borderColor: 'var(--success)' }}>
                            {EMO_KO[bestEmo.emotion] || bestEmo.emotion} {Math.round((bestEmo.intensity || 0) * 100)}%
                          </span>
                        )}
                        {s.delivery && s.delivery !== 'normal' && DELIVERY_KO[s.delivery] && (
                          <span className="tag-pill tag-pill--small" style={{ flexShrink: 0, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
                            {DELIVERY_KO[s.delivery]}
                          </span>
                        )}
                        <span style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-primary)' }}>{s.text}</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>대본 없음</div>
              )}
            </div>

            <div>
              <div className="eyebrow-label">댓글 ({m.comment_count || 0})</div>
              <div className="scroll-box scroll-box--padded-x" style={{ color: 'var(--text-muted)', fontSize: 12, padding: 12 }}>
                YouTube 댓글 수집 미구현
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'frames' && parsed && (
        <FrameTimeline
          frameLines={parsed.frameLines}
          sortedSecs={parsed.sortedSecs}
          cutMarkers={parsed.cutMarkers}
          cumulativeCuts={parsed.cumulativeCuts}
          frameImages={frameImagesNumeric}
          audioEmotions={audioEmosNumeric}
          ocrSubtitles={ocrNumeric}
          scriptBySec={scriptBySecNumeric}
          bgmChanges={data.bgm_changes}
        />
      )}
      {tab === 'frames' && !parsed && (
        <div className="empty-state">프레임 분석 없음</div>
      )}

      {tab === 'script' && (
        <div>
          {ss ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <div className="eyebrow-label" style={{ marginBottom: 0 }}>대본 구조</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
                {([
                  ['Hook', 'hook'],
                  ['Intro', 'intro'],
                  ['Body', 'body'],
                  ['CTA', 'cta'],
                ] as const).map(([title, key]) => {
                  const sec = ss[key] || {}
                  return (
                    <div key={key} className="section-card">
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>{title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                        {sec.seconds}{sec.type ? ` | ${sec.type}` : ''}
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text-body)', lineHeight: 1.6, marginBottom: 8 }}>
                        "{(sec.text || '').substring(0, 150)}{(sec.text || '').length > 150 ? '...' : ''}"
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                        {sec.analysis || ''}
                      </div>
                    </div>
                  )
                })}
              </div>
              {ss.overall && (
                <div className="section-card section-card--block" style={{ marginBottom: 20 }}>
                  <strong>Flow:</strong> {ss.overall.flow}<br />
                  <strong style={{ color: 'var(--success)' }}>Strength:</strong> {ss.overall.strength}<br />
                  <strong style={{ color: 'var(--error)' }}>Improve:</strong> {ss.overall.weakness}
                </div>
              )}
            </>
          ) : (
            <div className="empty-state" style={{ marginBottom: 20 }}>
              대본 구조 분석 없음
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {(pa.bgm && pa.bgm.length > 0) && (
              <div className="section-card" style={{ padding: 14 }}>
                <div className="eyebrow-label">BGM</div>
                {pa.bgm.map((b, idx) => (
                  <div key={idx} style={{ fontSize: 13, marginTop: 4 }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>[{b.start}-{b.end}]</span>
                    {' '}<strong>{b.genre}</strong> · {b.mood} · {b.tempo}
                  </div>
                ))}
              </div>
            )}
            {(pa.sound_effects && pa.sound_effects.length > 0) && (
              <div className="section-card" style={{ padding: 14 }}>
                <div className="eyebrow-label">효과음</div>
                {pa.sound_effects.map((s, idx) => (
                  <div key={idx} style={{ fontSize: 13, marginTop: 4 }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>[{s.time}]</span>
                    {' '}<strong>{s.type}</strong> — {s.description}
                  </div>
                ))}
              </div>
            )}
            {pa.hook && (
              <div className="section-card" style={{ padding: 14 }}>
                <div className="eyebrow-label">훅</div>
                <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', margin: '4px 0 0', fontFamily: 'inherit' }}>
                  {typeof pa.hook === 'string' ? pa.hook : JSON.stringify(pa.hook, null, 2)}
                </pre>
              </div>
            )}
            {pa.viral_factors && pa.viral_factors.length > 0 && (
              <div className="section-card" style={{ padding: 14 }}>
                <div className="eyebrow-label">바이럴 요인</div>
                <ul style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: 13, lineHeight: 1.6 }}>
                  {pa.viral_factors.map((v, idx) => (
                    <li key={idx}>{typeof v === 'string' ? v : JSON.stringify(v)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
