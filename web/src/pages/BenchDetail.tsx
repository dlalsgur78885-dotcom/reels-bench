import { useEffect, useState, useRef, Fragment } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api, thumbUrl } from '../api'
import type { Metadata, Transcript, Analysis, AnalysisStatus, ExtraData } from '../api'
import { fmtNum, engagementRate, erColor, parseFrameAnalysis } from '../utils'
import FrameTimeline from '../components/FrameTimeline'
import Thumb from '../components/Thumb'

const EMO_KO_ONLY: Record<string, string> = {
  happy: '기쁨', excited: '신남', sad: '슬픔', angry: '분노',
  fearful: '공포', surprised: '놀람', neutral: '중립', calm: '차분',
  crying: '우는', nervous: '불안', curious: '호기심', serious: '진지',
  tired: '피곤', frustrated: '좌절', cheerful: '명랑',
  sarcastic: '비꼬는', mischievously: '장난스러운',
}
const DELIVERY_KO: Record<string, string> = {
  whispers: '속삭임', shouts: '외침', slowly: '천천히', very_fast: '빠르게',
}

function mmssToSec(v: string | number): number {
  if (typeof v === 'number') return v
  const parts = String(v).split(':').map(parseFloat)
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parseFloat(String(v)) || 0
}

function buildTTSScript(extra: any): string {
  const sentences = extra?.sentences as Array<{ start: number; end: number; text: string }> | undefined
  if (!sentences || !sentences.length) return ''
  const ttsScript = extra?.pro_audio?.tts_script as Array<{ start: string|number; end: string|number; direction?: string; delivery?: string; text: string }> | undefined
  const tl = extra?.pro_audio?.emotion_timeline as Array<{ start: string|number; end: string|number; emotion: string; intensity: number }> | undefined
  const ae = extra?.audio_emotions as Record<string|number, { label?: string; emotion?: string; confidence?: number }> | undefined

  const lines: string[] = []
  for (const s of sentences) {
    const parts: string[] = []
    // direction
    const ttsItem = ttsScript?.find(t => Math.abs(parseFloat(String(t.start)) - s.start) < 0.5)
    if (ttsItem?.direction) parts.push(`(${ttsItem.direction})`)
    // delivery (속도/톤)
    const delivery = ttsItem?.delivery
    if (delivery && delivery !== 'normal' && DELIVERY_KO[delivery]) {
      parts.push(`(${DELIVERY_KO[delivery]})`)
    }
    // emotion + %
    let emoKey = ''
    let emoConf = 0
    if (tl && tl.length) {
      let bestOverlap = 0
      for (const seg of tl) {
        const segStart = mmssToSec(seg.start)
        const segEnd = mmssToSec(seg.end)
        const ov = Math.max(0, Math.min(s.end, segEnd) - Math.max(s.start, segStart))
        if (ov > bestOverlap) {
          bestOverlap = ov
          emoKey = seg.emotion
          emoConf = seg.intensity || 0
        }
      }
    }
    if (!emoKey && ae) {
      const startSec = Math.floor(s.start) + 1
      const endSec = Math.max(startSec, Math.ceil(s.end))
      const counts: Record<string, { n: number; conf: number }> = {}
      for (let k = startSec; k <= endSec; k++) {
        const e = ae[k] || ae[String(k)]
        if (!e?.emotion) continue
        if (!counts[e.emotion]) counts[e.emotion] = { n: 0, conf: 0 }
        counts[e.emotion].n += 1
        counts[e.emotion].conf += e.confidence || 0
      }
      const top = Object.entries(counts).sort((a, b) => b[1].n - a[1].n)[0]
      if (top) {
        emoKey = top[0]
        emoConf = top[1].conf / top[1].n
      }
    }
    if (emoKey) {
      const ko = EMO_KO_ONLY[emoKey] || emoKey
      const pct = Math.round((emoConf || 0) * 100)
      parts.push(pct > 0 ? `(${ko} ${pct}%)` : `(${ko})`)
    }
    lines.push(`${parts.join('')} ${s.text}`.trim())
  }
  return lines.join('\n')
}

export default function BenchDetail() {
  const { shortcode } = useParams<{ shortcode: string }>()
  const navigate = useNavigate()
  const [meta, setMeta] = useState<Metadata | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [comments, setComments] = useState<{ comment_text: string; comment_author: string; comment_likes: number }[]>([])
  const [frameImages, setFrameImages] = useState<Record<number, string>>({})
  const [extra, setExtra] = useState<ExtraData | null>(null)
  const [tab, setTab] = useState<'overview' | 'frames' | 'script'>('overview')
  const [analyzing, setAnalyzing] = useState<AnalysisStatus | null>(null)
  const pollRef = useRef<number | null>(null)
  const [editing, setEditing] = useState<'script' | 'category' | 'sentences' | null>(null)
  const [editSentences, setEditSentences] = useState<Array<{ start: number; end: number; text: string; direction?: string; emotion?: string; intensity?: number; delivery?: string; section?: string }>>([])
  const [editForm, setEditForm] = useState<any>(null)
  const [editError, setEditError] = useState('')
  const [saving, setSaving] = useState(false)
  const [ttsScript, setTtsScript] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(false)

  // Esc로 열린 모달 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (saving) return
      if (editing) { setEditing(null); return }
      if (ttsScript !== null) { setTtsScript(null); setCopied(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, ttsScript, saving])

  const autoStarted = useRef(false)

  useEffect(() => {
    if (!shortcode) return
    api.metadata(shortcode).then(setMeta).catch(() => {})
    api.transcript(shortcode).then(setTranscript).catch(() => {})
    api.analysis(shortcode).then(a => {
      setAnalysis(a)
    }).catch(() => {
      // 분석 결과 없으면 자동 시작
      if (!autoStarted.current) {
        autoStarted.current = true
        startAnalysis()
      }
    })
    api.comments(shortcode).then(setComments).catch(() => {})
    api.extra(shortcode).then(d => {
        if (d && Object.keys(d).length) {
          setExtra(d)
          if ((d as any).frame_images && Object.keys((d as any).frame_images).length) {
            setFrameImages((d as any).frame_images)
          }
        }
      }).catch(() => {})
    api.frameImages(shortcode).then(images => {
      if (images && Object.keys(images).length) setFrameImages(images)
    }).catch(() => {})
  }, [shortcode])

  const startAnalysis = async () => {
    if (!shortcode) return
    setAnalyzing({ status: 'running', step: '시작 중', progress: 0 })
    await api.startAnalysis(shortcode)
    // poll
    pollRef.current = window.setInterval(async () => {
      const st = await api.analysisStatus(shortcode)
      setAnalyzing(st)
      if (st.status === 'done' || st.status === 'error') {
        if (pollRef.current) clearInterval(pollRef.current)
        if (st.status === 'done') {
          // status에 analysis가 포함되어 있으면 바로 사용
          const stAny = st as any
          if (stAny.analysis) {
            setAnalysis(stAny.analysis)
          } else {
            api.analysis(shortcode).then(setAnalysis).catch(() => {})
          }
          if (st.frame_images) setFrameImages(st.frame_images)
          api.extra(shortcode).then(d => {
        if (d && Object.keys(d).length) {
          setExtra(d)
          if ((d as any).frame_images && Object.keys((d as any).frame_images).length) {
            setFrameImages((d as any).frame_images)
          }
        }
      }).catch(() => {})
          api.frameImages(shortcode).then(images => {
            if (images && Object.keys(images).length) setFrameImages(images)
          }).catch(() => {})
        }
      }
    }, 3000)
  }

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  if (!shortcode) return null

  const plays = meta?.play_count || 0
  const likes = meta?.like_count || 0
  const er = engagementRate(likes, plays)
  const duration = meta?.video_duration || 0
  const hasAnalysis = !!analysis?.analysis

  // parse frame analysis
  const parsed = hasAnalysis ? parseFrameAnalysis(analysis!.analysis) : null

  return (
    <>
      <button className="detail-back" onClick={() => navigate('/bench')}>
        ← 벤치마크
      </button>

      <div className="detail-header">
        <h1>@{meta?.author_username || shortcode}</h1>
        <button
          className="btn-primary btn-primary--sm"
          onClick={() => navigate(`/script?ref=${shortcode}`)}
          disabled={!hasAnalysis}
          title={hasAnalysis ? '이 릴스를 참고로 새 광고 대본 만들기' : '분석이 완료되어야 사용 가능'}
          style={{ marginRight: 10 }}>
          이 릴스로 대본 만들기
        </button>
        <a
          href={`https://www.instagram.com/reel/${shortcode}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="external-link"
        >
          Instagram ↗
        </a>
      </div>

      {analyzing?.status === 'running' && (
        <div className="progress-wrap">
          <div style={{ fontSize: 13, color: 'var(--text-body)' }}>{analyzing.step}</div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${analyzing.progress || 0}%` }} />
          </div>
        </div>
      )}
      {analyzing?.status === 'error' && (
        <div className="error-banner">분석 실패: {analyzing.message}</div>
      )}

      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-label">조회수</div>
          <div className="kpi-value">{fmtNum(plays)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">좋아요</div>
          <div className="kpi-value">{fmtNum(likes)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">참여율</div>
          <div className="kpi-value" style={{ color: erColor(er) }}>{er}%</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">길이</div>
          <div className="kpi-value">{duration.toFixed(0)}초</div>
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
            <Thumb src={shortcode ? thumbUrl(shortcode) : undefined} shortcode={shortcode} style={{ width: '100%', borderRadius: 'var(--radius-lg)', aspectRatio: '9/16', objectFit: 'cover' }} />
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>BGM</span>
              <span style={{ color: 'var(--text-body)' }}>{meta?.music_title || '오리지널'}</span>
            </div>
            {extra?.category && (
              <div className="section-card" style={{ marginTop: 12, padding: 12, position: 'relative' }}>
                <button className="btn-ghost"
                  onClick={() => {
                    setEditing('category')
                    setEditForm({
                      content_type: extra.category?.content_type || '',
                      content_type_detail: extra.category?.content_type_detail || '',
                      industry: extra.category?.industry || '',
                      industry_detail: extra.category?.industry_detail || '',
                      topic: extra.category?.topic || '',
                      topic_detail: extra.category?.topic_detail || '',
                      style: extra.category?.style || '',
                      tags: [...(extra.category?.tags || [])],
                    })
                    setEditError('')
                  }}
                  style={{ position: 'absolute', top: 8, right: 8 }}>
                  수정
                </button>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  <span className="tag-pill">
                    {extra.category.topic || extra.category.content_type_detail || extra.category.content_type}
                  </span>
                  <span className="tag-pill">
                    {extra.category.topic_detail || extra.category.industry_detail || extra.category.industry}
                  </span>
                  {extra.category.style && (
                    <span className="tag-pill">{extra.category.style}</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {extra.category.tags?.map((tag, i) => (
                    <span key={i} className="tag-pill tag-pill--small">#{tag}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div>
            <div style={{ marginBottom: 16 }}>
              <div className="eyebrow-label">대본</div>
              {transcript ? (
                <div className="transcript-box">{transcript.transcript}</div>
              ) : (
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>대본 없음</div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div className="eyebrow-label">캡션</div>
                <div className="scroll-box scroll-box--prewrap">
                  {meta?.caption_text || '캡션 없음'}
                </div>
              </div>
              <div>
                <div className="eyebrow-label">댓글 ({comments.length})</div>
                <div className="scroll-box scroll-box--padded-x">
                  {comments.slice(0, 30).map((c, i) => (
                    <div key={i} className="comment-row">
                      <span className="comment-author">@{c.comment_author}</span>
                      <span className="comment-text">
                        {c.comment_text}
                        {c.comment_likes > 0 && <span className="comment-likes">&#9829;{c.comment_likes}</span>}
                      </span>
                    </div>
                  ))}
                  {!comments.length && (
                    <div style={{ padding: '12px 0', textAlign: 'center' }}>
                      <button
                        className="btn-primary"
                        style={{ fontSize: 12, padding: '6px 14px' }}
                        onClick={async () => {
                          const res = await api.fetchComments(shortcode!)
                          if (res.comments?.length) {
                            setComments(res.comments)
                          }
                        }}
                      >댓글 수집</button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 댓글 반응 분석 */}
            {extra?.comment_triggers && (
              <div style={{ gridColumn: '1 / -1', marginTop: 8 }}>
                <div className="eyebrow-label" style={{ marginBottom: 12 }}>댓글 반응 분석</div>
                {extra.comment_triggers.summary && (
                  <div className="section-card section-card--block" style={{ background: 'var(--bg-elevated)', marginBottom: 16 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{extra.comment_triggers.summary.engagement_driver}</div>
                    <div><strong>주요 반응:</strong> {extra.comment_triggers.summary.dominant_reaction}</div>
                    <div><strong style={{ color: 'var(--success)' }}>강점:</strong> {extra.comment_triggers.summary.content_strength}</div>
                    <div><strong style={{ color: 'var(--error)' }}>개선:</strong> {extra.comment_triggers.summary.improvement}</div>
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {extra.comment_triggers.triggers?.map((t: any, i: number) => {
                    const sourceLabel: Record<string, string> = {
                      transcript: '대본', video: '영상', caption: '캡션',
                    }
                    return (
                      <div key={i} className="section-card">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span className="tag-pill tag-pill--strong">{t.reaction_type}</span>
                          <span className="tag-pill tag-pill--small">{sourceLabel[t.source] || t.source}</span>
                          {t.timestamp && (
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{t.timestamp}</span>
                          )}
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                            ~{t.comment_count}개 댓글
                          </span>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                          "{t.element}"
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 8 }}>
                          {t.analysis}
                        </div>
                        {t.sample_comments?.length > 0 && (
                          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 6 }}>
                            {t.sample_comments.map((c: string, j: number) => (
                              <div key={j} style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, paddingLeft: 8, fontStyle: 'italic', marginBottom: 4 }}>
                                "{c}"
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'frames' && parsed && (
        <FrameTimeline
          frameLines={parsed.frameLines}
          sortedSecs={parsed.sortedSecs}
          cutMarkers={parsed.cutMarkers}
          cumulativeCuts={parsed.cumulativeCuts}
          frameImages={frameImages}
          audioEmotions={extra?.audio_emotions}
          ocrSubtitles={extra?.ocr_subtitles}
          scriptBySec={extra?.script_by_sec}
          bgmChanges={extra?.bgm_changes}
        />
      )}
      {tab === 'frames' && !parsed && (
        <div className="empty-state">
          {analyzing?.status === 'running'
            ? '프레임 분석을 진행 중입니다…'
            : '프레임 분석을 자동으로 시작합니다.'}
        </div>
      )}

      {tab === 'script' && (
        <div>
          {extra?.script_structure && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <div className="eyebrow-label" style={{ marginBottom: 0 }}>대본 구조</div>
                <button className="btn-ghost"
                  onClick={() => {
                    setEditing('script')
                    const ss = extra.script_structure || {} as any
                    setEditForm({
                      hook: { text: '', type: '', seconds: '', analysis: '', ...(ss.hook || {}) },
                      intro: { text: '', seconds: '', analysis: '', ...(ss.intro || {}) },
                      body: { text: '', seconds: '', analysis: '', key_points: [], ...(ss.body || {}) },
                      cta: { text: '', type: '', seconds: '', analysis: '', ...(ss.cta || {}) },
                      overall: { flow: '', strength: '', weakness: '', ...(ss.overall || {}) },
                    })
                    setEditError('')
                  }}>
                  수정
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
                {([
                  ['Hook', 'hook'],
                  ['Intro', 'intro'],
                  ['Body', 'body'],
                  ['CTA', 'cta'],
                ] as const).map(([title, key]) => {
                  const sec = (extra.script_structure as any)?.[key] || {}
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
              {extra.script_structure.overall && (
                <div className="section-card section-card--block" style={{ marginBottom: 20 }}>
                  <strong>Flow:</strong> {extra.script_structure.overall.flow}<br />
                  <strong style={{ color: 'var(--success)' }}>Strength:</strong> {extra.script_structure.overall.strength}<br />
                  <strong style={{ color: 'var(--error)' }}>Improve:</strong> {extra.script_structure.overall.weakness}
                </div>
              )}
            </>
          )}
          {extra?.sentences && extra.sentences.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <div className="eyebrow-label" style={{ marginBottom: 0 }}>문장 타임라인 ({extra.sentences.length})</div>
                <button
                  className="btn-accent-ghost"
                  onClick={() => setTtsScript(buildTTSScript(extra))}
                >TTS 스크립트 생성</button>
                <button
                  className="btn-ghost btn-ghost--inline"
                  onClick={async () => {
                    if (!confirm('AI가 각 문장의 섹션(HOOK/INTRO/BODY/CTA)을 자동 분류하고 저장합니다. ~10초 소요. 기존 수동 지정 섹션은 덮어쓰여집니다.')) return
                    try {
                      const r = await api.classifySentences(shortcode!)
                      alert(`분류 완료: ${r.total_sentences}문장\n${Object.entries(r.sections).map(([k,v])=>`${k.toUpperCase()}: ${v}`).join(' / ')}`)
                      const d = await api.extra(shortcode!)
                      if (d && Object.keys(d).length) setExtra(d)
                    } catch (e: any) {
                      alert('분류 실패: ' + (e?.message || ''))
                    }
                  }}
                >섹션 자동 분류</button>
                <button
                  className="btn-ghost btn-ghost--inline"
                  onClick={() => { setEditing('sentences'); setEditSentences(JSON.parse(JSON.stringify(extra.sentences))); setEditError('') }}
                >문장 수정</button>
              </div>
              {extra.sentences.map((s, i) => {
                // TTS direction 매칭 (pro_audio.tts_script)
                const ttsScript = (extra as any)?.pro_audio?.tts_script as Array<{start: string|number; end: string|number; direction: string; text: string}> | undefined
                const ttsItem = ttsScript?.find(t => Math.abs(parseFloat(String(t.start)) - s.start) < 0.5)
                const direction = ttsItem?.direction
                // 감정 매칭: pro_audio.emotion_timeline 우선, audio_emotions 폴백
                const mmssToSec = (v: string | number): number => {
                  if (typeof v === 'number') return v
                  const parts = String(v).split(':').map(parseFloat)
                  if (parts.length === 2) return parts[0] * 60 + parts[1]
                  return parseFloat(String(v)) || 0
                }
                let emoLabel = ''
                let emoConf = 0
                const tl = (extra as any)?.pro_audio?.emotion_timeline as Array<{ start: string|number; end: string|number; emotion: string; intensity: number }> | undefined
                if (tl && tl.length) {
                  let bestOverlap = 0
                  for (const seg of tl) {
                    const segStart = mmssToSec(seg.start)
                    const segEnd = mmssToSec(seg.end)
                    const ov = Math.max(0, Math.min(s.end, segEnd) - Math.max(s.start, segStart))
                    if (ov > bestOverlap) {
                      bestOverlap = ov
                      emoLabel = EMO_KO_ONLY[seg.emotion] || seg.emotion
                      emoConf = seg.intensity || 0
                    }
                  }
                }
                if (!emoLabel) {
                  const ae = extra.audio_emotions as Record<string | number, { label?: string; emotion?: string; confidence?: number }> | undefined
                  if (ae) {
                    const startSec = Math.floor(s.start) + 1
                    const endSec = Math.max(startSec, Math.ceil(s.end))
                    const counts: Record<string, { n: number; conf: number; label: string }> = {}
                    for (let k = startSec; k <= endSec; k++) {
                      const e = ae[k] || ae[String(k)]
                      if (!e?.emotion) continue
                      const key = e.emotion
                      if (!counts[key]) counts[key] = { n: 0, conf: 0, label: e.label || EMO_KO_ONLY[key] || e.emotion }
                      counts[key].n += 1
                      counts[key].conf += e.confidence || 0
                    }
                    const top = Object.values(counts).sort((a, b) => b.n - a.n)[0]
                    if (top) {
                      emoLabel = top.label
                      emoConf = top.conf / top.n
                    }
                  }
                }
                // 1. sentence.section override 우선
                // 2. 없으면 script_structure 시간 범위로 계산
                const sOverride = (s as any).section as string | undefined
                let section = ''
                if (sOverride) {
                  section = sOverride.toUpperCase()
                } else {
                  const ss = extra.script_structure
                  if (ss) {
                    const hookEnd = parseFloat(ss.hook?.seconds?.split('-')[1] || '3')
                    const introEnd = parseFloat(ss.intro?.seconds?.split('-')[1] || '7')
                    const bodyEnd = parseFloat(ss.body?.seconds?.split('-')[1] || '40')
                    if (s.start < hookEnd) section = 'HOOK'
                    else if (s.start < introEnd) section = 'INTRO'
                    else if (s.start < bodyEnd) section = 'BODY'
                    else section = 'CTA'
                  }
                }

                const fmtTime = (t: number) => {
                  const m = Math.floor(t / 60)
                  const sec = Math.floor(t % 60)
                  return `${m}:${String(sec).padStart(2, '0')}`
                }

                return (
                  <div key={i} className="sentence-row">
                    <span className="sentence-time">{fmtTime(s.start)}~{fmtTime(s.end)}</span>
                    {section && <span className="section-badge">{section}</span>}
                    <span className="sentence-text">
                      {direction && (
                        <span className="tag-pill tag-pill--bordered" style={{ marginRight: 6 }}>{direction}</span>
                      )}
                      {emoLabel && (
                        <span className="tag-pill tag-pill--bordered" style={{ marginRight: 6 }}>
                          {emoLabel}{emoConf > 0 && ` ${Math.round(emoConf * 100)}%`}
                        </span>
                      )}
                      {s.text}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          {transcript ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div className="eyebrow-label" style={{ marginBottom: 0 }}>전체 대본</div>
                {extra?.sentences && extra.sentences.length > 0 && (
                  <button
                    type="button"
                    className="btn-reveal"
                    aria-expanded={transcriptOpen}
                    onClick={() => setTranscriptOpen(!transcriptOpen)}
                  >{transcriptOpen ? '접기' : '펼치기'}</button>
                )}
              </div>
              {(!(extra?.sentences && extra.sentences.length > 0) || transcriptOpen) && (
                <div className="transcript-box" style={{ maxHeight: 'none' }}>{transcript.transcript}</div>
              )}
            </div>
          ) : (
            <div className="empty-state">대본이 없습니다</div>
          )}
        </div>
      )}
      {/* Edit Modal: sentences·category·script 모두 구조화된 폼 */}
      {editing && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={editing === 'script' ? '대본 구조 수정' : editing === 'sentences' ? '문장 타임라인 수정' : '카테고리 수정'} onClick={() => !saving && setEditing(null)}>
          <div className="modal-panel" style={{ width: editing === 'sentences' ? 820 : 640 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">
              {editing === 'script' ? '대본 구조 수정' : editing === 'sentences' ? `문장 타임라인 수정 (${editSentences.length}개)` : '카테고리 수정'}
            </div>

            {editing === 'sentences' ? (
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 4 }}>
                {(() => {
                  const insertAt = (idx: number) => {
                    const prev = idx > 0 ? editSentences[idx - 1] : null
                    const next = idx < editSentences.length ? editSentences[idx] : null
                    let start: number, end: number
                    if (prev && next) {
                      const mid = (prev.end + next.start) / 2
                      start = Math.max(prev.end, mid - 1)
                      end = Math.min(next.start, mid + 1)
                      if (end <= start) { start = prev.end; end = next.start }
                    } else if (prev) {
                      start = prev.end; end = start + 2
                    } else if (next) {
                      end = next.start; start = Math.max(0, end - 2)
                    } else {
                      start = 0; end = 2
                    }
                    setEditSentences([
                      ...editSentences.slice(0, idx),
                      { start, end, text: '' },
                      ...editSentences.slice(idx),
                    ])
                  }
                  const InsertBtn = ({ idx }: { idx: number }) => (
                    <button onClick={() => insertAt(idx)} title="여기에 문장 추가" style={{
                      alignSelf: 'center', padding: '2px 12px', fontSize: 11, fontWeight: 600,
                      border: '1px dashed var(--accent)', borderRadius: 12,
                      background: 'transparent', color: 'var(--accent)', cursor: 'pointer',
                      opacity: 0.5, transition: 'opacity 0.15s',
                    }} onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                       onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}>+ 여기 추가</button>
                  )
                  return (
                    <>
                      <InsertBtn idx={0} />
                      {editSentences.map((s, i) => (
                        <Fragment key={i}>
                          <div style={{
                            display: 'grid', gridTemplateColumns: '60px 60px 70px 1fr auto', gap: 8, alignItems: 'center',
                            background: 'var(--bg-base)', padding: 8, borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border)',
                          }}>
                            <input type="number" step="0.1" value={s.start}
                              onChange={e => { const v = parseFloat(e.target.value) || 0; setEditSentences(prev => prev.map((p, idx) => idx === i ? { ...p, start: v } : p)) }}
                              style={{ padding: '4px 6px', fontSize: 11, fontFamily: 'monospace', border: '1px solid var(--border)', borderRadius: 4, textAlign: 'center' }} />
                            <input type="number" step="0.1" value={s.end}
                              onChange={e => { const v = parseFloat(e.target.value) || 0; setEditSentences(prev => prev.map((p, idx) => idx === i ? { ...p, end: v } : p)) }}
                              style={{ padding: '4px 6px', fontSize: 11, fontFamily: 'monospace', border: '1px solid var(--border)', borderRadius: 4, textAlign: 'center' }} />
                            <select value={s.section || ''}
                              onChange={e => setEditSentences(prev => prev.map((p, idx) => idx === i ? { ...p, section: e.target.value || undefined } : p))}
                              title="섹션 (비워두면 시간 범위로 자동 결정)"
                              style={{ padding: '4px 4px', fontSize: 11, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-surface)' }}>
                              <option value="">자동</option>
                              <option value="hook">HOOK</option>
                              <option value="intro">INTRO</option>
                              <option value="body">BODY</option>
                              <option value="cta">CTA</option>
                            </select>
                            <input type="text" value={s.text}
                              onChange={e => setEditSentences(prev => prev.map((p, idx) => idx === i ? { ...p, text: e.target.value } : p))}
                              placeholder="문장 텍스트"
                              style={{ padding: '6px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 4 }} />
                            <button onClick={() => setEditSentences(prev => prev.filter((_, idx) => idx !== i))}
                              style={{ padding: '4px 10px', fontSize: 11, color: 'var(--error)', border: '1px solid var(--error)', background: 'transparent', borderRadius: 4, cursor: 'pointer' }}>삭제</button>
                          </div>
                          <InsertBtn idx={i + 1} />
                        </Fragment>
                      ))}
                    </>
                  )
                })()}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  ※ 시작·종료는 초 단위. 섹션 "자동"이면 시간 범위로 자동 결정. emotion·direction·delivery는 자동 보존됩니다.
                </div>
              </div>
            ) : editing === 'category' && editForm ? (
              <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
                <div className="form-row-pair">
                  <div className="form-row">
                    <label className="form-label">콘텐츠 타입</label>
                    <input className="form-input" value={editForm.content_type || ''}
                      onChange={e => setEditForm({ ...editForm, content_type: e.target.value })} placeholder="예: 광고형" />
                  </div>
                  <div className="form-row">
                    <label className="form-label">콘텐츠 타입 상세</label>
                    <input className="form-input" value={editForm.content_type_detail || ''}
                      onChange={e => setEditForm({ ...editForm, content_type_detail: e.target.value })} />
                  </div>
                </div>
                <div className="form-row-pair" style={{ marginTop: 12 }}>
                  <div className="form-row">
                    <label className="form-label">산업</label>
                    <input className="form-input" value={editForm.industry || ''}
                      onChange={e => setEditForm({ ...editForm, industry: e.target.value })} />
                  </div>
                  <div className="form-row">
                    <label className="form-label">산업 상세</label>
                    <input className="form-input" value={editForm.industry_detail || ''}
                      onChange={e => setEditForm({ ...editForm, industry_detail: e.target.value })} />
                  </div>
                </div>
                <div className="form-row-pair" style={{ marginTop: 12 }}>
                  <div className="form-row">
                    <label className="form-label">주제</label>
                    <input className="form-input" value={editForm.topic || ''}
                      onChange={e => setEditForm({ ...editForm, topic: e.target.value })} />
                  </div>
                  <div className="form-row">
                    <label className="form-label">주제 상세</label>
                    <input className="form-input" value={editForm.topic_detail || ''}
                      onChange={e => setEditForm({ ...editForm, topic_detail: e.target.value })} />
                  </div>
                </div>
                <div className="form-row" style={{ marginTop: 12 }}>
                  <label className="form-label">스타일</label>
                  <input className="form-input" value={editForm.style || ''}
                    onChange={e => setEditForm({ ...editForm, style: e.target.value })} />
                </div>
                <div className="form-row" style={{ marginTop: 12 }}>
                  <label className="form-label">태그</label>
                  <input className="form-input" value={(editForm.tags || []).join(', ')}
                    onChange={e => setEditForm({ ...editForm, tags: e.target.value.split(',').map((t: string) => t.trim()).filter(Boolean) })}
                    placeholder="콤마로 구분 (예: 패션, 가을, 코디)" />
                  <div className="form-hint">콤마로 구분. 공백은 자동 정리됩니다.</div>
                </div>
              </div>
            ) : editing === 'script' && editForm ? (
              <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
                {(['hook', 'intro', 'body', 'cta'] as const).map(k => {
                  const sec = editForm[k] || {}
                  const hasType = k === 'hook' || k === 'cta'
                  const hasKeyPoints = k === 'body'
                  const upd = (patch: any) => setEditForm({ ...editForm, [k]: { ...sec, ...patch } })
                  return (
                    <div key={k} className="form-section">
                      <div className="form-section-title">{k.toUpperCase()}</div>
                      <div className="form-row-pair">
                        <div className="form-row">
                          <label className="form-label">시간 (예: 0-3)</label>
                          <input className="form-input" value={sec.seconds || ''}
                            onChange={e => upd({ seconds: e.target.value })} placeholder="0-3" />
                        </div>
                        {hasType && (
                          <div className="form-row">
                            <label className="form-label">유형</label>
                            <input className="form-input" value={sec.type || ''}
                              onChange={e => upd({ type: e.target.value })} />
                          </div>
                        )}
                      </div>
                      <div className="form-row" style={{ marginTop: 8 }}>
                        <label className="form-label">텍스트</label>
                        <textarea className="form-textarea" value={sec.text || ''}
                          onChange={e => upd({ text: e.target.value })} rows={2} />
                      </div>
                      {hasKeyPoints && (
                        <div className="form-row" style={{ marginTop: 8 }}>
                          <label className="form-label">핵심 포인트 (한 줄에 하나)</label>
                          <textarea className="form-textarea" value={(sec.key_points || []).join('\n')}
                            onChange={e => upd({ key_points: e.target.value.split('\n').map((s: string) => s.trim()).filter(Boolean) })}
                            rows={3} />
                        </div>
                      )}
                      <div className="form-row" style={{ marginTop: 8 }}>
                        <label className="form-label">분석</label>
                        <textarea className="form-textarea" value={sec.analysis || ''}
                          onChange={e => upd({ analysis: e.target.value })} rows={2} />
                      </div>
                    </div>
                  )
                })}
                <div className="form-section">
                  <div className="form-section-title">OVERALL</div>
                  <div className="form-row">
                    <label className="form-label">흐름</label>
                    <textarea className="form-textarea" value={editForm.overall?.flow || ''}
                      onChange={e => setEditForm({ ...editForm, overall: { ...editForm.overall, flow: e.target.value } })} rows={2} />
                  </div>
                  <div className="form-row" style={{ marginTop: 8 }}>
                    <label className="form-label">강점</label>
                    <textarea className="form-textarea" value={editForm.overall?.strength || ''}
                      onChange={e => setEditForm({ ...editForm, overall: { ...editForm.overall, strength: e.target.value } })} rows={2} />
                  </div>
                  <div className="form-row" style={{ marginTop: 8 }}>
                    <label className="form-label">개선점</label>
                    <textarea className="form-textarea" value={editForm.overall?.weakness || ''}
                      onChange={e => setEditForm({ ...editForm, overall: { ...editForm.overall, weakness: e.target.value } })} rows={2} />
                  </div>
                </div>
              </div>
            ) : null}

            {editError && <div style={{ color: 'var(--error)', fontSize: 12, marginTop: 8 }}>{editError}</div>}
            <div className="modal-actions">
              <button className="btn-modal-cancel" onClick={() => setEditing(null)} disabled={saving}>취소</button>
              <button className="btn-modal-confirm" disabled={saving} onClick={async () => {
                setSaving(true)
                setEditError('')
                try {
                  let payload: any
                  if (editing === 'sentences') {
                    // 검증: start < end, 빈 텍스트 제거, 시간순 정렬
                    const invalid = editSentences.find(s => (s.text || '').trim() && s.end <= s.start)
                    if (invalid) {
                      setEditError(`종료 시간이 시작 시간보다 작거나 같은 문장이 있습니다 (${invalid.start}~${invalid.end}). 수정 후 다시 저장하세요.`)
                      setSaving(false)
                      return
                    }
                    const cleaned = editSentences
                      .filter(s => (s.text || '').trim())
                      .sort((a, b) => a.start - b.start)
                    payload = { sentences: cleaned }
                  } else if (editing === 'script') {
                    payload = { script_structure: editForm }
                  } else {
                    payload = { category: editForm }
                  }
                  await api.updateExtra(shortcode!, payload)
                  const d = await api.extra(shortcode!)
                  if (d && Object.keys(d).length) setExtra(d)
                  setEditing(null)
                } catch (e: any) {
                  setEditError(e?.message || '저장 실패. 잠시 후 다시 시도하세요.')
                } finally {
                  setSaving(false)
                }
              }}>{saving ? '저장 중…' : '저장'}</button>
            </div>
          </div>
        </div>
      )}
      {/* TTS Script Modal */}
      {ttsScript !== null && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="TTS 스크립트" onClick={() => { setTtsScript(null); setCopied(false) }}>
          <div className="modal-panel" style={{ width: 720 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div className="modal-title" style={{ marginBottom: 0 }}>TTS 스크립트</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                direction · delivery · 감정+신뢰도 자동 결합
              </div>
            </div>
            <textarea
              value={ttsScript}
              readOnly
              style={{
                flex: 1, minHeight: 360, fontSize: 13, lineHeight: 1.7,
                padding: 14, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-base)', color: 'var(--text-primary)', resize: 'vertical',
                fontFamily: 'Pretendard Variable, sans-serif',
              }}
            />
            <div className="modal-actions">
              <button className="btn-modal-cancel" onClick={() => { setTtsScript(null); setCopied(false) }}>닫기</button>
              <button
                className={`btn-modal-confirm${copied ? ' btn-modal-confirm--success' : ''}`}
                onClick={async () => {
                  try { await navigator.clipboard.writeText(ttsScript); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
                }}>
                {copied ? '복사됨' : '클립보드 복사'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
