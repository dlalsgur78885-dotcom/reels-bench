import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ttsAuthedFetch, TTS_BASE } from '../api'

interface Phrase {
  text: string;
  direction?: string;  // 자유 텍스트 (Gemini → tag 변환)
  tag?: string;         // 명시적 tag (프리셋 — Gemini 안 거침)
}
interface InputSentence {
  start: number; end: number; text: string;
  direction?: string;
  phrases?: Phrase[]  // 어절 모드 (선택) — 있으면 백엔드가 inline tag로 합성
}

// 프리셋 — 클릭 한 번으로 phrase.tag 직접 셋팅 (Gemini 호출 없음)
const PHRASE_PRESETS: { emoji: string; label: string; tag: string }[] = [
  { emoji: '💪', label: '강조',   tag: '[emphatic]' },
  { emoji: '🔥', label: '격앙',   tag: '[shouting][passionate]' },
  { emoji: '😱', label: '놀람',   tag: '[surprised]' },
  { emoji: '😨', label: '충격',   tag: '[gasping][surprised]' },
  { emoji: '🤫', label: '속삭임', tag: '[whispers]' },
  { emoji: '😌', label: '차분',   tag: '[calm]' },
  { emoji: '🧐', label: '진지',   tag: '[serious][confident]' },
  { emoji: '😊', label: '신남',   tag: '[excited][happy]' },
]

interface VoicePreset { value: string; label: string; accepts?: 'male' | 'female' | 'any' }

interface SegmentMeta {
  start: number
  end: number
  text: string
  direction: string
  tag: string
  strength_level: number  // -2 ~ +2
  phrases?: { text: string; direction: string; tag: string }[]  // 어절 모드 결과
}

interface JobState {
  job_id: string
  voice_name: string
  model_id: string
  sentences: SegmentMeta[]
  tag_variants: string[][]
  strength_labels: string[]
  tempos?: number[]
  total_duration: number
  char_count: number
  segment_count: number
  final_url: string  // Supabase Storage URL (절대) 또는 /api/tts/files/... (상대)
  is_supabase: boolean
  expires_in_sec: number
  created_at: number
}

function resolveAudioUrl(url: string, bust: number): string {
  const sep = url.includes('?') ? '&' : '?'
  const withBust = `${url}${sep}t=${bust}`
  return /^https?:\/\//i.test(url) ? withBust : `${TTS_BASE}${withBust}`
}

const LEVELS = [-2, -1, 0, 1, 2] as const
const DEFAULT_LABELS = ['매우약', '약', '기본', '강', '매우강']

const labelSt: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-muted)', marginBottom: 8,
}
const cardSt: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)', padding: 18, marginBottom: 14,
}
const primaryBtnSt: React.CSSProperties = {
  width: '100%', padding: '12px 16px', fontSize: 14, fontWeight: 600,
  background: 'var(--accent)', color: '#fff', border: 'none',
  borderRadius: 'var(--radius-md)', cursor: 'pointer',
}

export default function TtsGen() {
  const { state } = useLocation() as { state?: { sentences?: InputSentence[]; title?: string; voice?: string; personaGender?: 'male' | 'female' | 'unknown'; from?: { path: string; label: string } } }
  const navigate = useNavigate()
  const initialSentences: InputSentence[] = state?.sentences || []
  const title = state?.title || ''
  const from = state?.from
  // 페르소나에서 voice 전달받으면 그걸 기본값 (없으면 joonpark)
  const initialVoice = state?.voice || 'joonpark'
  // 페르소나 성별 — dropdown 필터링용 (male/female만 필터, unknown은 전부 표시)
  const personaGender = state?.personaGender

  const [sentences, setSentences] = useState<InputSentence[]>(initialSentences)
  const [savedSentences, setSavedSentences] = useState<InputSentence[] | null>(null)
  const [presets, setPresets] = useState<VoicePreset[]>([])
  const [voice, setVoice] = useState(initialVoice)
  const [synthLoading, setSynthLoading] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState<JobState | null>(null)
  // 문장별 임시 선택 강도 (재생성 누르기 전)
  const [draftLevels, setDraftLevels] = useState<Record<number, number>>({})
  const [segLoading, setSegLoading] = useState<Record<number, boolean>>({})
  const [audioBust, setAudioBust] = useState(0)

  // 편집 잠금: 저장됐거나 합성 중이면 잠금
  const editLocked = synthLoading || savedSentences !== null
  const dirty = savedSentences !== null
    && JSON.stringify(sentences) !== JSON.stringify(savedSentences)

  const totalChars = useMemo(
    () => sentences.reduce((sum, s) => sum + (s.text || '').length, 0),
    [sentences],
  )
  const totalDuration = useMemo(
    () => sentences.length ? sentences[sentences.length - 1].end : 0,
    [sentences],
  )

  const updateSentence = (idx: number, patch: Partial<InputSentence>) => {
    setSentences(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s))
  }
  const splitToPhrases = (idx: number) => {
    setSentences(prev => prev.map((s, i) => {
      if (i !== idx) return s
      const tokens = (s.text || '').split(/\s+/).filter(t => t.trim())
      if (!tokens.length) return s
      return { ...s, phrases: tokens.map(t => ({ text: t, direction: '' })) }
    }))
  }
  const mergePhrases = (idx: number) => {
    const s = sentences[idx]
    if (!s?.phrases) return
    const hasEmotions = s.phrases.some(p => (p.tag || '').trim() || (p.direction || '').trim())
    if (hasEmotions) {
      if (!confirm('어절 모드를 해제하면 설정한 감정이 모두 사라집니다. 진행할까요?\n\n(감정을 적용하려면 "음성 생성" 버튼을 누르세요)')) return
    }
    setSentences(prev => prev.map((s2, i) => {
      if (i !== idx || !s2.phrases) return s2
      const text = s2.phrases.map(p => p.text).join(' ')
      const { phrases: _drop, ...rest } = s2  // eslint-disable-line @typescript-eslint/no-unused-vars
      return { ...rest, text }
    }))
  }
  const updatePhrase = (sentIdx: number, phraseIdx: number, patch: Partial<Phrase>) => {
    setSentences(prev => prev.map((s, i) => {
      if (i !== sentIdx || !s.phrases) return s
      return { ...s, phrases: s.phrases.map((p, j) => j === phraseIdx ? { ...p, ...patch } : p) }
    }))
  }
  const resetEdits = () => {
    setSentences(initialSentences)
    setSavedSentences(null)
    setJob(null)
    setError('')
  }
  const saveEdits = () => {
    // 스냅샷 저장 → 편집 잠금 + 음성 생성 가능
    setSavedSentences(JSON.parse(JSON.stringify(sentences)))
    setError('')
  }
  const reopenEdits = () => {
    // 다시 편집 모드 (저장본은 유지하되 잠금만 해제 → dirty 비교용)
    setSavedSentences(null)
    setJob(null)  // 결과도 비움 — 새로 합성해야 일관성
  }

  useEffect(() => {
    ttsAuthedFetch('/api/tts/voices')
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setPresets(d.presets || []))
      .catch(() => {})
  }, [])

  const synthAll = async () => {
    const useSentences = savedSentences || sentences
    if (!useSentences.length) { setError('스크립트 데이터 없음'); return }
    setSynthLoading(true); setError(''); setJob(null); setDraftLevels({})
    try {
      const r = await ttsAuthedFetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentences: useSentences, voice_name: voice }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data.detail || `API ${r.status}`)
      }
      const data: JobState = await r.json()
      setJob(data)
      setAudioBust(Date.now())
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setSynthLoading(false)
    }
  }

  const regenSegment = async (idx: number) => {
    if (!job) return
    const newLevel = draftLevels[idx] ?? job.sentences[idx].strength_level
    setSegLoading(s => ({ ...s, [idx]: true })); setError('')
    try {
      const r = await ttsAuthedFetch('/api/tts/segment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.job_id, idx, strength_level: newLevel }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data.detail || `API ${r.status}`)
      }
      const data: JobState = await r.json()
      setJob(data)
      setDraftLevels(s => { const c = { ...s }; delete c[idx]; return c })
      setAudioBust(Date.now())
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setSegLoading(s => ({ ...s, [idx]: false }))
    }
  }

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: '24px 16px' }}>
      <button onClick={() => {
        if (!from?.path || from.path === '__back__') navigate(-1)
        else navigate(from.path)
      }}
        style={{ marginBottom: 14, padding: '6px 12px', fontSize: 12,
          border: '1px solid var(--border)', borderRadius: 6, background: 'transparent',
          color: 'var(--text-body)', cursor: 'pointer' }}>
        ← {from?.label || '뒤로'}
      </button>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>음성 생성</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          ElevenLabs v3 + 슬롯 길이 매칭 • 문장별 5단계 감정 단어 조절
          {title && <> • <span style={{ color: 'var(--text-secondary)' }}>{title}</span></>}
        </p>
      </div>

      {!sentences.length ? (
        <div style={cardSt}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
            스크립트 데이터가 없어요. 스크립트 결과 페이지에서 "🎙 음성 생성" 버튼으로 진입.
          </div>
          <button onClick={() => navigate(-1)} style={{ padding: '6px 12px', fontSize: 11 }}>← 뒤로</button>
        </div>
      ) : (
        <>
          <div style={cardSt}>
            <div style={labelSt}>입력 스크립트</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
              {sentences.length}문장 • 약 {totalChars}자
            </div>
            {!job && !synthLoading && !sentences.some(s => s.phrases?.length) && (
              <div style={{
                fontSize: 11, color: 'var(--text-muted)', marginBottom: 12,
                padding: '6px 10px', background: 'rgba(234,179,8,0.06)',
                border: '1px solid rgba(234,179,8,0.3)', borderRadius: 6,
              }}>
                💡 특정 어절에 감정·강조 원하시면 문장 옆 <strong>"✂ 어절별 감정 추가"</strong> 버튼을 눌러보세요.
              </div>
            )}

            {/* 🎭 감정선 (TTS 안내) — 직접 direction 흐름 시각화 */}
            {sentences.some(s => (s.direction || '').trim()) && (
              <div style={{
                padding: '10px 12px', marginBottom: 14, borderRadius: 6,
                background: 'rgba(99,102,241,0.06)', border: '1px solid var(--accent)',
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.06em', marginBottom: 6 }}>
                  🎭 감정선 (TTS 안내) — 문장별 direction 흐름
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                  {sentences.map((s, i) => {
                    const dir = (s.direction || '').trim() || '—'
                    return (
                      <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span style={{
                          fontSize: 11, fontWeight: 600, padding: '3px 8px',
                          background: 'var(--bg-base)', color: 'var(--text-body)',
                          border: '1px solid var(--border)', borderRadius: 12,
                          whiteSpace: 'nowrap',
                        }} title={`#${i + 1}: ${s.text.slice(0, 40)}…`}>
                          <span style={{ fontSize: 9, color: 'var(--text-muted)', marginRight: 4 }}>#{i + 1}</span>
                          {dir}
                        </span>
                        {i < sentences.length - 1 && (
                          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>→</span>
                        )}
                      </span>
                    )
                  })}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                  ElevenLabs가 각 direction을 audio tag로 변환해 음성에 반영합니다.
                </div>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              {sentences.map((s, i) => {
                const inPhraseMode = !!(s.phrases && s.phrases.length)
                const canEdit = !job && !synthLoading
                return (
                <div key={i} style={{
                  padding: '10px 0',
                  borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    {s.direction && !inPhraseMode && (
                      <div style={{
                        display: 'inline-block', fontSize: 10, fontWeight: 700,
                        color: 'var(--accent)', background: 'rgba(99,102,241,0.10)',
                        padding: '2px 8px', borderRadius: 10,
                      }}>🎭 {s.direction}</div>
                    )}
                    {inPhraseMode && (
                      <div style={{
                        display: 'inline-block', fontSize: 11, fontWeight: 700,
                        color: '#a16207', background: 'rgba(234,179,8,0.12)',
                        padding: '3px 10px', borderRadius: 12,
                      }}>🪄 어절 모드 ({s.phrases!.length}개)</div>
                    )}
                    {canEdit && (
                      <button
                        onClick={() => inPhraseMode ? mergePhrases(i) : splitToPhrases(i)}
                        style={{
                          fontSize: 12, fontWeight: 600, padding: '5px 12px',
                          background: inPhraseMode ? 'var(--bg-elevated)' : 'var(--accent)',
                          color: inPhraseMode ? 'var(--text-muted)' : '#fff',
                          border: '1px solid', borderColor: inPhraseMode ? 'var(--border)' : 'var(--accent)',
                          borderRadius: 6, cursor: 'pointer',
                        }}
                        title={inPhraseMode ? '어절 모드 해제 (감정 설정 사라짐)' : '어절별 감정 적용 가능'}>
                        {inPhraseMode ? '✖ 어절 모드 해제' : '✂ 어절별 감정 추가'}
                      </button>
                    )}
                    {inPhraseMode && s.phrases!.some(p => (p.tag||'').trim() || (p.direction||'').trim()) && (
                      <span style={{
                        fontSize: 10, fontWeight: 600, color: '#16a34a',
                        background: 'rgba(34,197,94,0.10)',
                        padding: '3px 8px', borderRadius: 10,
                      }}>👇 "🎙 음성 생성"으로 적용</span>
                    )}
                  </div>
                  {inPhraseMode ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {s.phrases!.map((p, j) => {
                        const activePreset = PHRASE_PRESETS.find(pr => pr.tag === p.tag)
                        const hasCustom = !!(p.direction && p.direction.trim())
                        const hasEmotion = !!(p.tag || hasCustom)
                        return (
                        <div key={j} style={{
                          display: 'flex', flexDirection: 'column', gap: 4,
                          padding: '6px 8px',
                          border: '2px solid', borderColor: hasEmotion ? 'var(--accent)' : 'var(--border)',
                          borderRadius: 8,
                          background: hasEmotion ? 'rgba(99,102,241,0.06)' : 'var(--bg-base)',
                        }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-body)' }}>{p.text}</div>
                          {/* 프리셋 버튼 row */}
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                            {PHRASE_PRESETS.map(pr => {
                              const active = activePreset?.tag === pr.tag
                              return (
                                <button
                                  key={pr.tag}
                                  onClick={() => {
                                    if (active) updatePhrase(i, j, { tag: undefined })
                                    else updatePhrase(i, j, { tag: pr.tag, direction: undefined })
                                  }}
                                  disabled={!canEdit}
                                  title={`${pr.label} (${pr.tag})`}
                                  style={{
                                    fontSize: 11, padding: '2px 6px',
                                    background: active ? 'var(--accent)' : 'transparent',
                                    color: active ? '#fff' : 'var(--text-body)',
                                    border: '1px solid', borderColor: active ? 'var(--accent)' : 'var(--border)',
                                    borderRadius: 12, cursor: canEdit ? 'pointer' : 'not-allowed',
                                  }}>
                                  {pr.emoji}{active ? ` ${pr.label}` : ''}
                                </button>
                              )
                            })}
                            {/* 커스텀 toggle */}
                            <button
                              onClick={() => {
                                if (hasCustom) updatePhrase(i, j, { direction: undefined })
                                else updatePhrase(i, j, { direction: '', tag: undefined })
                              }}
                              disabled={!canEdit}
                              title="직접 입력"
                              style={{
                                fontSize: 11, padding: '2px 6px',
                                background: hasCustom ? 'var(--accent)' : 'transparent',
                                color: hasCustom ? '#fff' : 'var(--text-body)',
                                border: '1px solid', borderColor: hasCustom ? 'var(--accent)' : 'var(--border)',
                                borderRadius: 12, cursor: canEdit ? 'pointer' : 'not-allowed',
                              }}>✏</button>
                          </div>
                          {/* 직접 입력 활성 시 input */}
                          {hasCustom && (
                            <input
                              type="text"
                              value={p.direction || ''}
                              onChange={e => updatePhrase(i, j, { direction: e.target.value })}
                              placeholder="자유 표현 (예: 약간 떨리는)"
                              disabled={!canEdit}
                              autoFocus
                              style={{
                                fontSize: 11, padding: '3px 6px',
                                border: '1px solid var(--accent)', borderRadius: 4,
                                background: 'var(--bg-base)', color: 'var(--accent)', outline: 'none',
                              }}
                            />
                          )}
                        </div>
                      )})}
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-body)' }}>{s.text}</div>
                  )}
                </div>
              )})}
            </div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
              목소리
              {personaGender && personaGender !== 'unknown' && (
                <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 500, color: 'var(--accent)' }}>
                  · 페르소나 성별({personaGender === 'female' ? '여성' : '남성'})에 맞는 voice만 표시
                </span>
              )}
            </label>
            {(() => {
              const all: VoicePreset[] = presets.length ? presets : [{ value: 'joonpark', label: 'JoonPark (기본)', accepts: 'any' }]
              const filtered = personaGender && personaGender !== 'unknown'
                ? all.filter(p => !p.accepts || p.accepts === 'any' || p.accepts === personaGender)
                : all
              return (
                <select value={voice} onChange={e => setVoice(e.target.value)} disabled={synthLoading}
                  style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-base)' }}>
                  {filtered.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              )
            })()}
          </div>

          <button onClick={synthAll} disabled={synthLoading || !sentences.length} style={{
            ...primaryBtnSt,
            background: synthLoading ? 'var(--bg-elevated)' : 'var(--accent)',
            color: synthLoading ? 'var(--text-muted)' : '#fff',
            cursor: synthLoading ? 'wait' : 'pointer', marginBottom: 14,
          }}>
            {synthLoading ? '생성 중… (수십초)' : (job ? '🔄 다시 생성 (전체)' : '🎙 음성 생성')}
          </button>

          {error && (
            <div style={{ ...cardSt, background: '#fff5f5', border: '1px solid #fcc', color: '#c00', fontSize: 13 }}>{error}</div>
          )}

          {job && (
            <>
              <div style={cardSt}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
                  결과 ({job.total_duration.toFixed(1)}초, {job.char_count}자)
                </div>
                <audio
                  controls
                  src={resolveAudioUrl(job.final_url, audioBust)}
                  style={{ width: '100%', marginBottom: 12 }}
                />
                <a
                  href={resolveAudioUrl(job.final_url, audioBust)}
                  download={`${job.job_id}.mp3`}
                  style={{
                    display: 'inline-block', padding: '8px 16px', fontSize: 13, fontWeight: 600,
                    background: 'var(--accent)', color: '#fff', borderRadius: 6, textDecoration: 'none',
                  }}
                >⬇ 다운로드</a>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                  {job.is_supabase
                    ? <>☁ Supabase Storage 저장 — 영구 URL ({job.job_id})</>
                    : <>⏱ 약 {Math.floor(job.expires_in_sec / 60)}분 후 자동 삭제 ({job.job_id})</>}
                </div>
              </div>

              <div style={cardSt}>
                <div style={labelSt}>문장별 감정 단어</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  강도 단계 변경 → "재생성"으로 그 문장만 새 단어로 재합성
                </div>
                {job.sentences.map((s, i) => {
                  const labels = job.strength_labels?.length === 5 ? job.strength_labels : DEFAULT_LABELS
                  const variants = job.tag_variants?.[i] || []
                  const draft = draftLevels[i]
                  const cur = s.strength_level
                  const sel = draft ?? cur
                  const dirty = draft !== undefined && draft !== cur
                  const loading = !!segLoading[i]
                  const tempo = job.tempos?.[i]
                  const expandedTag = variants[sel + 2] || ''  // 빈 문자열 = lazy 미생성
                  const hasPreview = !!expandedTag
                  const phraseMode = !!(s.phrases && s.phrases.length)
                  return (
                    <div key={i} style={{
                      padding: '12px 0',
                      borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none',
                    }}>
                      <div style={{ fontSize: 12, marginBottom: 8 }}>
                        <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>
                          [{s.start.toFixed(1)}–{s.end.toFixed(1)}s]
                        </span>
                        <span style={{ color: 'var(--text-body)' }}>{s.text}</span>
                        {tempo !== undefined && tempo > 1.001 && (
                          <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text-muted)' }}>
                            (×{tempo.toFixed(2)} 압축)
                          </span>
                        )}
                        {phraseMode && (
                          <span style={{
                            marginLeft: 8, fontSize: 10, fontWeight: 700,
                            color: '#a16207', background: 'rgba(234,179,8,0.10)',
                            padding: '1px 6px', borderRadius: 8,
                          }}>🪄 어절 모드</span>
                        )}
                      </div>

                      {phraseMode ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                          {s.phrases!.map((p, j) => (
                            <span key={j} style={{
                              fontSize: 11, padding: '2px 6px',
                              border: '1px solid', borderColor: p.tag ? 'var(--accent)' : 'var(--border)',
                              background: p.tag ? 'rgba(99,102,241,0.06)' : 'var(--bg-base)',
                              borderRadius: 4,
                            }}>
                              <span style={{ color: 'var(--text-body)' }}>{p.text}</span>
                              {p.tag && <span style={{ color: 'var(--accent)', marginLeft: 4, fontFamily: 'monospace', fontSize: 10 }}>{p.tag}</span>}
                            </span>
                          ))}
                        </div>
                      ) : (<>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                        {LEVELS.map((lv, j) => {
                          const active = sel === lv
                          const isCur = cur === lv
                          return (
                            <button
                              key={lv}
                              onClick={() => setDraftLevels(d => ({ ...d, [i]: lv }))}
                              disabled={loading}
                              style={{
                                padding: '5px 10px', fontSize: 11, fontWeight: active ? 700 : 500,
                                background: active ? 'var(--accent)' : 'var(--bg-elevated)',
                                color: active ? '#fff' : 'var(--text-body)',
                                border: '1px solid',
                                borderColor: active ? 'var(--accent)' : (isCur ? 'var(--text-muted)' : 'var(--border)'),
                                borderRadius: 4, cursor: loading ? 'wait' : 'pointer',
                                position: 'relative',
                              }}
                              title={variants[j] || ''}
                            >
                              {labels[j]}
                              {isCur && !active && <span style={{ marginLeft: 4, fontSize: 9, color: 'var(--text-muted)' }}>•</span>}
                            </button>
                          )
                        })}
                        <button
                          onClick={() => regenSegment(i)}
                          disabled={loading || !dirty}
                          style={{
                            marginLeft: 8, padding: '5px 12px', fontSize: 11, fontWeight: 600,
                            background: dirty && !loading ? 'var(--accent)' : 'var(--bg-surface)',
                            color: dirty && !loading ? '#fff' : 'var(--text-muted)',
                            border: '1px solid',
                            borderColor: dirty && !loading ? 'var(--accent)' : 'var(--border)',
                            borderRadius: 4,
                            cursor: loading ? 'wait' : (dirty ? 'pointer' : 'not-allowed'),
                          }}
                        >{loading ? '...' : '재생성'}</button>
                      </div>

                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, fontFamily: 'monospace' }}>
                        {dirty ? (
                          hasPreview ? (
                            <>
                              <span style={{ textDecoration: 'line-through' }}>{s.tag}</span>
                              {' → '}
                              <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{expandedTag}</span>
                            </>
                          ) : (
                            <span>{s.tag} → <span style={{ color: 'var(--accent)' }}>✨ 재생성 시 새 단어 자동 변환</span></span>
                          )
                        ) : (
                          <span>{s.tag || '(no tag)'}</span>
                        )}
                      </div>
                      </>)}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
