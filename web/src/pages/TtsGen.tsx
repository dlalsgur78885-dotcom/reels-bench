import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ttsAuthedFetch, TTS_BASE } from '../api'

interface InputSentence { start: number; end: number; text: string; direction?: string }

interface VoicePreset { value: string; label: string }

interface SegmentMeta {
  start: number
  end: number
  text: string
  direction: string
  tag: string
  strength_level: number  // -2 ~ +2
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
  const { state } = useLocation() as { state?: { sentences?: InputSentence[]; title?: string } }
  const navigate = useNavigate()
  const initialSentences: InputSentence[] = state?.sentences || []
  const title = state?.title || ''

  const [sentences, setSentences] = useState<InputSentence[]>(initialSentences)
  const [savedSentences, setSavedSentences] = useState<InputSentence[] | null>(null)
  const [presets, setPresets] = useState<VoicePreset[]>([])
  const [voice, setVoice] = useState('yuna')
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
    if (!savedSentences) { setError('먼저 "저장"을 눌러 편집을 확정하세요'); return }
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
              <div style={labelSt}>
                입력 스크립트 {savedSentences === null ? '(편집 중)' : (synthLoading ? '' : '(저장됨 — 잠금)')}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {savedSentences !== null && !synthLoading && (
                  <button
                    onClick={reopenEdits}
                    style={{ fontSize: 11, padding: '4px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text-body)' }}
                  >✏ 다시 편집</button>
                )}
                {savedSentences === null && JSON.stringify(sentences) !== JSON.stringify(initialSentences) && (
                  <button
                    onClick={resetEdits}
                    style={{ fontSize: 10, padding: '3px 8px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text-muted)' }}
                  >↺ 원본으로</button>
                )}
              </div>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
              {sentences.length}문장 • 약 {totalChars}자 • 원본 {totalDuration.toFixed(1)}초
            </div>
            <div style={{ marginBottom: 14 }}>
              {sentences.map((s, i) => (
                <div key={i} style={{
                  padding: '10px 0',
                  borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none',
                }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, fontFamily: 'monospace' }}>
                    [{s.start.toFixed(1)}–{s.end.toFixed(1)}s]
                  </div>
                  <textarea
                    value={s.text}
                    onChange={e => updateSentence(i, { text: e.target.value })}
                    disabled={editLocked}
                    rows={Math.max(1, Math.ceil(s.text.length / 40))}
                    style={{
                      width: '100%', padding: '8px 10px', fontSize: 13, lineHeight: 1.5,
                      border: '1px solid var(--border)', borderRadius: 6,
                      background: editLocked ? 'var(--bg-elevated)' : 'var(--bg-base)',
                      color: 'var(--text-body)', resize: 'vertical', fontFamily: 'inherit',
                      opacity: editLocked ? 0.7 : 1,
                    }}
                  />
                  <input
                    type="text"
                    value={s.direction || ''}
                    onChange={e => updateSentence(i, { direction: e.target.value })}
                    disabled={editLocked}
                    placeholder="감정 지시 (예: 밝게, 차분하게)"
                    style={{
                      width: '100%', padding: '6px 10px', fontSize: 11, marginTop: 4,
                      border: '1px solid var(--border)', borderRadius: 4,
                      background: editLocked ? 'var(--bg-elevated)' : 'var(--bg-base)',
                      color: 'var(--text-muted)',
                      opacity: editLocked ? 0.7 : 1,
                    }}
                  />
                </div>
              ))}
            </div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>목소리</label>
            <select value={voice} onChange={e => setVoice(e.target.value)} disabled={synthLoading}
              style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-base)' }}>
              {(presets.length ? presets : [{ value: 'yuna', label: 'Yuna (기본)' }]).map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* 1단계: 저장 (편집 확정) */}
          {savedSentences === null && (
            <button onClick={saveEdits} disabled={!sentences.length} style={{
              ...primaryBtnSt,
              background: 'var(--success, #10b981)',
              cursor: 'pointer', marginBottom: 14,
            }}>
              💾 저장 (편집 확정 → 다음 단계)
            </button>
          )}

          {/* 2단계: 음성 생성 (저장된 상태) */}
          {savedSentences !== null && (
            <>
              {dirty && (
                <div style={{
                  ...cardSt, background: 'rgba(245,158,11,0.08)',
                  border: '1px solid #f59e0b', color: '#92400e', fontSize: 12,
                  padding: '10px 14px',
                }}>
                  ⚠ 저장본과 다른 변경이 있어요. "다시 편집" 후 재저장하거나 무시하고 음성 생성.
                </div>
              )}
              <button onClick={synthAll} disabled={synthLoading} style={{
                ...primaryBtnSt,
                background: synthLoading ? 'var(--bg-elevated)' : 'var(--accent)',
                color: synthLoading ? 'var(--text-muted)' : '#fff',
                cursor: synthLoading ? 'wait' : 'pointer', marginBottom: 14,
              }}>
                {synthLoading ? '생성 중… (수십초)' : (job ? '🔄 다시 생성 (전체)' : '🎙 저장본으로 음성 생성')}
              </button>
            </>
          )}

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
                      </div>

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
