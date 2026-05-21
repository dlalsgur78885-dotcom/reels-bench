import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ttsAuthedFetch, authedFetch, TTS_BASE } from '../api'
import { buildSrt, downloadTextFile, safeFileName } from '../lib/srt'

interface Phrase {
  text: string;
  direction?: string;  // 자유 텍스트 (Gemini → tag 변환)
  tag?: string;         // 명시적 tag (프리셋 — Gemini 안 거침)
}
interface InputSentence {
  start: number; end: number; text: string;
  direction?: string;
  sentence_emotion?: string  // 전체감정 — sentence 맨 앞에 prepend (LLM 자동/사용자 수동)
  speed_factor?: number      // 이 sentence만 배속 조절 (0.5~2.0, 기본 1.0)
  phrases?: Phrase[]  // 어절 모드 (선택) — 있으면 백엔드가 inline tag로 합성
}

// 프리셋 — 클릭 한 번으로 phrase.tag 직접 셋팅 (Gemini 호출 없음)
const PHRASE_PRESETS: { emoji: string; label: string; tag: string }[] = [
  { emoji: '💪', label: '강조',   tag: '(당당하게)' },
  { emoji: '🔥', label: '격앙',   tag: '(격앙되게)' },
  { emoji: '😱', label: '놀람',   tag: '(놀라며)' },
  { emoji: '😨', label: '충격',   tag: '(충격받은 듯)' },
  { emoji: '🤫', label: '속삭임', tag: '(비밀스럽게)' },
  { emoji: '😌', label: '차분',   tag: '(차분하게)' },
  { emoji: '🧐', label: '진지',   tag: '(진지하게)' },
  { emoji: '😊', label: '신남',   tag: '(밝게)' },
  { emoji: '✨', label: '발랄',   tag: '(발랄하게)' },
  { emoji: '🙂', label: '웃음',   tag: '(웃으며)' },
]

interface VoicePreset { value: string; label: string; accepts?: 'male' | 'female' | 'any' }

interface SegmentMeta {
  start: number
  end: number
  ref_start?: number  // REF (원본) start (Whisper alignment 전 보존)
  ref_end?: number
  text: string
  direction: string
  tag: string
  strength_level: number  // -2 ~ +2
  speed_factor?: number    // post-synth 문장별 속도 (1.0 기본)
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
  // ElevenLabs API 호출 디버그 표시
  persona_cue?: string | null
  prompt_text?: string
  voice_settings?: { stability: number; similarity_boost: number; style: number; use_speaker_boost: boolean }
  voice_id?: string
}

function resolveAudioUrl(url: string, bust: number): string {
  const sep = url.includes('?') ? '&' : '?'
  const withBust = `${url}${sep}t=${bust}`
  return /^https?:\/\//i.test(url) ? withBust : `${TTS_BASE}${withBust}`
}

// 대본 문장이 저장된 TTS 입력과 달라졌는지 (문장 추가·삭제·텍스트 변경)
function scriptTextChanged(
  scriptSents: InputSentence[],
  savedSents?: InputSentence[],
): boolean {
  if (!savedSents) return false
  if (scriptSents.length !== savedSents.length) return true
  const norm = (t?: string) => (t || '').replace(/\s+/g, ' ').trim()
  return scriptSents.some((s, i) => norm(s.text) !== norm(savedSents[i]?.text))
}

// 대본에서 "오디오 수정" 진입 시 — 현재 대본 문장(텍스트 최신)에 저장된 TTS의 감정/어절
// 설정을 입힌다. 텍스트가 정확히 일치하는 문장만 감정 승계, 수정·추가된 문장은 텍스트만.
function mergeScriptWithSavedTts(
  scriptSents: InputSentence[],
  savedSents: InputSentence[],
): InputSentence[] {
  const norm = (t?: string) => (t || '').replace(/\s+/g, ' ').trim()
  const byText = new Map<string, InputSentence>()
  for (const s of savedSents) {
    const k = norm(s.text)
    if (k && !byText.has(k)) byText.set(k, s)
  }
  return scriptSents.map((cur, i) => {
    const k = norm(cur.text)
    const idxMatch = savedSents[i] && norm(savedSents[i].text) === k ? savedSents[i] : null
    const matched = byText.get(k) || idxMatch
    if (matched) {
      // 텍스트 동일 → 저장된 감정·어절(phrases) 승계, timing은 대본 기준
      return { ...matched, start: cur.start ?? matched.start, end: cur.end ?? matched.end, text: cur.text }
    }
    // 수정/추가된 문장 → 대본 문구 그대로 (감정 미설정)
    return { start: cur.start ?? 0, end: cur.end ?? 0, text: cur.text }
  })
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
  const { state } = useLocation() as { state?: { sentences?: InputSentence[]; title?: string; voice?: string; personaGender?: 'male' | 'female' | 'unknown'; persona?: any; from?: { path: string; label: string }; scriptId?: string; productId?: number; savedTts?: any; scriptSentences?: InputSentence[] } }
  const navigate = useNavigate()
  // 대본에서 "오디오 수정"으로 진입한 경우 — 저장된 TTS 작업 복원.
  // inputSentences 우선: job.sentences(SegmentMeta)에는 sentence_emotion(전체 감정)이
  // 빠져 있으므로, 저장 시 함께 담아둔 편집 sentences를 복원에 사용.
  const saved = state?.savedTts
  const savedSents: InputSentence[] | undefined =
    (saved?.inputSentences as InputSentence[]) || (saved?.job?.sentences as InputSentence[])
  const scriptSents = state?.scriptSentences
  // 저장 후 대본이 수정됐는지 — 수정됐으면 옛 음성(job)은 무효이므로 복원하지 않음
  const scriptChanged = !!(saved && scriptSents && scriptSents.length
    && scriptTextChanged(scriptSents, savedSents))
  const initialSentences: InputSentence[] = (() => {
    // 저장 후 대본이 수정됐을 수 있음 — 텍스트는 최신 대본, 감정은 저장본에서 머지
    if (saved && scriptSents && scriptSents.length) {
      return savedSents ? mergeScriptWithSavedTts(scriptSents, savedSents) : scriptSents
    }
    return savedSents || state?.sentences || []
  })()
  const title = state?.title || ''
  const from = state?.from
  // 대본 귀속 — 있으면 "이 대본에 음성 저장" 가능
  const scriptId: string | undefined = state?.scriptId
  const productId: number | undefined = state?.productId
  // 페르소나에서 voice 전달받으면 그걸 기본값 (없으면 joonpark)
  const initialVoice = saved?.voice || state?.voice || 'joonpark'
  // 페르소나 성별 — dropdown 필터링용 (male/female만 필터, unknown은 전부 표시)
  const personaGender = state?.personaGender
  // 페르소나 dict — 합성 시 인라인 cue로 변환됨 (백엔드)
  const persona = saved?.persona ?? state?.persona

  const [sentences, setSentences] = useState<InputSentence[]>(initialSentences)
  const [savedSentences, setSavedSentences] = useState<InputSentence[] | null>(null)
  const [presets, setPresets] = useState<VoicePreset[]>([])
  const [voice, setVoice] = useState(initialVoice)
  const [synthLoading, setSynthLoading] = useState(false)
  const [autoEmotionLoading, setAutoEmotionLoading] = useState(false)
  const [autoEmotionIntensity, setAutoEmotionIntensity] = useState<'low' | 'medium' | 'high'>(saved?.autoEmotionIntensity || 'low')
  // 대본에 음성 저장 — 복원 진입이면 이미 저장된 상태 (대본 수정 후면 재합성·재저장 필요)
  const [savingToScript, setSavingToScript] = useState(false)
  const [savedToScript, setSavedToScript] = useState(!!saved && !scriptChanged)
  // job이 새로 갱신되면(재합성/속도적용 등) "저장됨" 표시 해제. 첫 렌더(복원 포함)는 스킵.
  const firstJobRef = useRef(true)
  const [error, setError] = useState('')
  // 마지막 합성 시점 sentences snapshot — 합성 후 변경 감지용
  const [lastSynthSnapshot, setLastSynthSnapshot] = useState<string>('')
  // 속도 모드:
  // 'natural' — 자연 속도(1.0x)
  // 'match_ref' — 전체 길이만 REF에 맞춤 (1.5x clamp atempo)
  // 'segment_match' — 문장별 atempo로 REF 정밀 매칭 (음질 트레이드오프)
  // '1.2' / '1.4' — 고정 가속
  const [speedMode, setSpeedMode] = useState<'natural' | 'match_ref' | 'segment_match' | '1.2' | '1.4'>(saved?.speedMode || 'match_ref')
  // 대본 수정 후 진입이면 옛 음성 무효 → job 미복원 (재합성 유도)
  const [job, setJob] = useState<JobState | null>(scriptChanged ? null : (saved?.job || null))
  // 문장별 임시 선택 강도 (재생성 누르기 전)
  const [draftLevels, setDraftLevels] = useState<Record<number, number>>(saved?.draftLevels || {})
  // post-synth 문장별 속도 draft (변경 후 'speed 적용' 버튼으로 한 번에 ffmpeg 적용)
  const [speedDrafts, setSpeedDrafts] = useState<Record<number, number>>(saved?.speedDrafts || {})
  const [applyingSpeeds, setApplyingSpeeds] = useState(false)
  // post-synth persona cue 편집 — 변경 시 전체 재합성 필요 (ElevenLabs 비용)
  const [editingCue, setEditingCue] = useState(false)
  const [cueDraft, setCueDraft] = useState('')
  const [updatingCue, setUpdatingCue] = useState(false)
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
  useEffect(() => {
    if (firstJobRef.current) { firstJobRef.current = false; return }
    setSavedToScript(false)
  }, [job])

  const saveToScript = async () => {
    if (!job || !scriptId || !productId || savingToScript) return
    setSavingToScript(true)
    try {
      const ttsPayload = {
        job,
        // 재합성 입력 — sentence_emotion(전체 감정)은 job.sentences에 없으므로
        // 편집 중인 sentences를 그대로 저장해 복원 시 전체 감정까지 살린다.
        inputSentences: sentences,
        voice,
        speedMode,
        persona: persona || null,
        draftLevels,
        speedDrafts,
        autoEmotionIntensity,
        saved_at: Date.now(),
      }
      const r = await authedFetch(`/api/my-products/${productId}/scripts/${scriptId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tts: ttsPayload }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      setSavedToScript(true)
    } catch (e: any) {
      alert('대본에 음성 저장 실패: ' + (e?.message || e))
    } finally {
      setSavingToScript(false)
    }
  }

  const runAutoEmotion = async () => {
    if (!sentences.length) return
    const hasExistingPhrases = sentences.some(s => s.phrases?.length)
    if (hasExistingPhrases) {
      if (!confirm('이미 어절 설정된 문장이 있어요. 자동 분석 결과로 덮어쓸까요?')) return
    }
    setAutoEmotionLoading(true); setError('')
    try {
      const r = await ttsAuthedFetch('/api/tts/auto-emotion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentences, intensity: autoEmotionIntensity }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.detail || `API ${r.status}`)
      }
      const data = await r.json()
      if (Array.isArray(data.sentences)) {
        setSentences(data.sentences)
      }
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setAutoEmotionLoading(false)
    }
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
    setSynthLoading(true); setError(''); setJob(null); setDraftLevels({}); setSpeedDrafts({})
    try {
      // 속도 옵션 변환 → speed_factor / target_duration / segment_match
      let speedBody: { speed_factor?: number; target_duration?: number; segment_match?: boolean } = {}
      if (speedMode === 'match_ref') {
        const refDur = useSentences.length ? useSentences[useSentences.length - 1].end : 0
        if (refDur > 0) speedBody.target_duration = refDur
      } else if (speedMode === 'segment_match') {
        speedBody.segment_match = true
      } else if (speedMode === '1.2') {
        speedBody.speed_factor = 1.2
      } else if (speedMode === '1.4') {
        speedBody.speed_factor = 1.4
      }
      const r = await ttsAuthedFetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentences: useSentences, voice_name: voice, persona, ...speedBody }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data.detail || `API ${r.status}`)
      }
      const data: JobState = await r.json()
      setJob(data)
      setAudioBust(Date.now())
      // 합성 시점 snapshot — 이후 변경 감지용
      setLastSynthSnapshot(JSON.stringify(useSentences))
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setSynthLoading(false)
    }
  }

  // 합성 이후 sentences 변경 여부
  const dirtyAfterSynth = !!(job && lastSynthSnapshot && JSON.stringify(sentences) !== lastSynthSnapshot)

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

  // persona cue 변경 → 전체 재합성 (ElevenLabs 비용)
  const updatePersonaCue = async () => {
    if (!job) return
    if (!confirm(`전체 음성을 새 cue로 재합성합니다 (~30s, ElevenLabs 비용 발생). 계속할까요?\n\n새 cue: ${cueDraft}`)) return
    setUpdatingCue(true); setError('')
    try {
      const r = await ttsAuthedFetch('/api/tts/update-persona-cue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.job_id, persona_cue: cueDraft }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.detail || `API ${r.status}`)
      }
      const data: JobState = await r.json()
      setJob(data)
      setEditingCue(false)
      setSpeedDrafts({})  // 재합성으로 timing 변동, draft reset
      setAudioBust(Date.now())
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setUpdatingCue(false)
    }
  }

  // post-synth 문장별 속도 일괄 적용 — 재합성 X, ffmpeg atempo만
  const applyAllSpeeds = async () => {
    if (!job) return
    // 현재 job sentences의 speed + draft override 머지
    const speeds: Record<string, number> = {}
    job.sentences.forEach((s, i) => {
      const v = speedDrafts[i] ?? s.speed_factor ?? 1.0
      if (Math.abs(v - 1.0) > 0.01) speeds[String(i)] = v
    })
    setApplyingSpeeds(true); setError('')
    try {
      const r = await ttsAuthedFetch('/api/tts/apply-speeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.job_id, speeds }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.detail || `API ${r.status}`)
      }
      const data: JobState = await r.json()
      setJob(data)
      setSpeedDrafts({})
      setAudioBust(Date.now())
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setApplyingSpeeds(false)
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
                const canEdit = !synthLoading  // 합성 후에도 편집 가능 (재합성 버튼으로 반영)
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
                  {/* sentence_emotion (전체감정) picker — 문장 전체 톤 */}
                  {inPhraseMode && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>🎬 전체 감정:</span>
                      <select
                        value={s.sentence_emotion || ''}
                        onChange={e => updateSentence(i, { sentence_emotion: e.target.value || undefined })}
                        disabled={!canEdit}
                        style={{
                          fontSize: 12, padding: '3px 8px',
                          background: s.sentence_emotion ? 'rgba(99,102,241,0.12)' : 'var(--bg-base)',
                          color: s.sentence_emotion ? 'var(--accent)' : 'var(--text-body)',
                          border: '1px solid', borderColor: s.sentence_emotion ? 'var(--accent)' : 'var(--border)',
                          borderRadius: 4, fontWeight: 600, cursor: canEdit ? 'pointer' : 'not-allowed',
                        }}>
                        <option value="">(없음)</option>
                        {PHRASE_PRESETS.map(pr => (
                          <option key={pr.tag} value={pr.tag}>{pr.emoji} {pr.label} {pr.tag}</option>
                        ))}
                      </select>
                      {s.sentence_emotion && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          ← 문장 맨 앞에 prepend (v3 전체 톤 지배)
                        </span>
                      )}
                    </div>
                  )}
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
                  {/* sentence 끝 표시 — 마지막은 안 표시 (마침표만) */}
                  {i < sentences.length - 1 && (
                    <div style={{
                      marginTop: 6, fontSize: 10, color: 'var(--text-muted)',
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      <span style={{
                        display: 'inline-block', padding: '1px 6px', borderRadius: 8,
                        background: 'rgba(99,102,241,0.06)', color: 'var(--accent)', fontWeight: 600,
                      }}>⏸ 짧은 호흡 (~150ms)</span>
                    </div>
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
            {/* 페르소나 cue 미리보기 (실제 합성 시 첫 문장 앞에 인라인 prepend됨) */}
            {persona?.name && (() => {
              const cleanName = (persona.name as string).replace(/\s*#\d+\s*$/, '').trim()
              const g = (persona.gender || '').toLowerCase()
              const cue = g === 'female' ? `(${cleanName}, 여성)`
                : g === 'male' ? `(${cleanName}, 남성)`
                : `(${cleanName})`
              return (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                  🎭 페르소나 cue (voice 톤 가이드): <span style={{ color: 'var(--accent)', fontFamily: 'monospace' }}>{cue}</span>
                </div>
              )
            })()}
            {/* 속도 모드 — ElevenLabs v3 자연 속도는 6~7자/초로 느린 편. REF 인플루언서는 보통 10+자/초.  */}
            <label style={{ marginTop: 10, fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
              발화 속도 {sentences.length > 0 && (
                <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--accent)', marginLeft: 6 }}>
                  · REF 길이 {sentences[sentences.length - 1].end?.toFixed(1)}초
                </span>
              )}
            </label>
            <select value={speedMode} onChange={e => setSpeedMode(e.target.value as any)} disabled={synthLoading}
              style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-base)' }}>
              <option value="match_ref">🎯 REF 길이 자동 매칭 (권장 — 전체 길이만)</option>
              <option value="segment_match">🎯🎯 문장별 정밀 매칭 (자막 sync용, 음질 약간↓)</option>
              <option value="natural">🐢 자연 속도 (v3 기본, 늘어질 수 있음)</option>
              <option value="1.2">🚶 1.2x 가속</option>
              <option value="1.4">🏃 1.4x 가속</option>
            </select>
          </div>

          {/* 대본 수정 후 "오디오 수정"으로 진입 — 옛 음성 무효, 재합성 안내 */}
          {scriptChanged && !job && (
            <div style={{
              ...cardSt, padding: 12, marginBottom: 12, fontSize: 12, lineHeight: 1.6,
              background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e',
            }}>
              📝 <strong>대본이 수정되어 음성을 다시 생성해야 합니다.</strong> 수정된 문구가
              입력 스크립트에 반영됐고, 바뀌지 않은 문장의 감정 설정은 그대로 유지됐습니다.
              아래 "🎙 음성 생성"을 눌러 재합성하세요.
            </div>
          )}

          {/* 🪄 자동 감정 분석 — 클릭 한 번으로 어절 분리 + 강조 자동 적용 */}
          {!job && !synthLoading && (
            <div style={{ ...cardSt, padding: 12, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 auto', minWidth: 200 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-body)' }}>🪄 자동 감정 분석</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  Gemini가 어절 분리 + 강조 포인트 자동 할당 (~3초)
                </div>
              </div>
              <select value={autoEmotionIntensity} onChange={e => setAutoEmotionIntensity(e.target.value as any)}
                disabled={autoEmotionLoading}
                style={{ fontSize: 12, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-base)' }}>
                <option value="low">강도: 약 (포인트만)</option>
                <option value="medium">강도: 보통</option>
                <option value="high">강도: 강 (풍부하게)</option>
              </select>
              <button onClick={runAutoEmotion} disabled={autoEmotionLoading || !sentences.length}
                style={{
                  padding: '8px 14px', fontSize: 12, fontWeight: 700,
                  background: autoEmotionLoading ? 'var(--bg-elevated)' : 'var(--accent)',
                  color: autoEmotionLoading ? 'var(--text-muted)' : '#fff',
                  border: '1px solid var(--accent)', borderRadius: 6,
                  cursor: autoEmotionLoading ? 'wait' : 'pointer',
                }}>
                {autoEmotionLoading ? '분석 중…' : '🪄 자동 분석'}
              </button>
            </div>
          )}

          <button onClick={synthAll} disabled={synthLoading || !sentences.length} style={{
            ...primaryBtnSt,
            background: synthLoading ? 'var(--bg-elevated)'
              : dirtyAfterSynth ? '#16a34a'  // 변경됨 → 녹색 강조
              : 'var(--accent)',
            color: synthLoading ? 'var(--text-muted)' : '#fff',
            cursor: synthLoading ? 'wait' : 'pointer', marginBottom: 14,
          }}>
            {synthLoading ? '생성 중… (수십초)'
              : dirtyAfterSynth ? '🔄 변경 사항 재합성 (감정 수정됨)'
              : (job ? '🔄 다시 생성 (전체)' : '🎙 음성 생성')}
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
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <a
                    href={resolveAudioUrl(job.final_url, audioBust)}
                    download={`${safeFileName(title, job.job_id)}.mp3`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      padding: '10px 18px', fontSize: 13, fontWeight: 600, lineHeight: 1,
                      background: 'var(--accent)', color: '#fff',
                      border: '1px solid var(--accent)', borderRadius: 6, textDecoration: 'none',
                    }}
                  >⬇ MP3 다운로드</a>
                  <button
                    type="button"
                    onClick={() => {
                      const srt = buildSrt(job.sentences, job.total_duration)
                      downloadTextFile(`${safeFileName(title, job.job_id)}.srt`, srt, 'application/x-subrip')
                    }}
                    disabled={!job.sentences?.length}
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      padding: '10px 18px', fontSize: 13, fontWeight: 600, lineHeight: 1,
                      background: '#16a34a', color: '#fff',
                      border: '1px solid #16a34a', borderRadius: 6,
                      cursor: job.sentences?.length ? 'pointer' : 'not-allowed',
                      opacity: job.sentences?.length ? 1 : 0.5,
                    }}
                    title="현재 final.mp3 timing 기준 (Whisper 정렬)"
                  >⬇ SRT 다운로드</button>
                </div>
                {scriptId && productId && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                    <button
                      type="button"
                      onClick={saveToScript}
                      disabled={savingToScript || savedToScript}
                      style={{
                        width: '100%', padding: '11px 18px', fontSize: 13, fontWeight: 700,
                        background: savedToScript ? 'var(--bg-elevated)' : '#7c3aed',
                        color: savedToScript ? 'var(--text-muted)' : '#fff',
                        border: `1px solid ${savedToScript ? 'var(--border)' : '#7c3aed'}`,
                        borderRadius: 6,
                        cursor: (savingToScript || savedToScript) ? 'default' : 'pointer',
                      }}
                      title="스크립트·감정 태그·voice 설정과 음성 결과를 대본에 저장 — 나중에 같은 톤으로 재합성">
                      {savingToScript ? '저장 중…'
                        : savedToScript ? '✓ 대본에 저장됨'
                        : '💾 이 대본에 음성 저장'}
                    </button>
                    {savedToScript && from && (
                      <button
                        type="button"
                        onClick={() => navigate(from.path)}
                        style={{
                          width: '100%', marginTop: 6, padding: '8px 16px', fontSize: 12, fontWeight: 600,
                          background: 'transparent', color: 'var(--accent)',
                          border: '1px solid var(--accent)', borderRadius: 6, cursor: 'pointer',
                        }}>
                        ← {from.label}(으)로 돌아가기
                      </button>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                      스크립트·감정 태그·voice 설정이 함께 저장돼, 나중에 대본에서 "오디오 수정"으로
                      같은 톤 그대로 불러와 일부만 고쳐 재합성할 수 있습니다.
                    </div>
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                  {job.is_supabase
                    ? <>☁ Supabase Storage 저장 — 영구 URL ({job.job_id})</>
                    : <>⏱ 약 {Math.floor(job.expires_in_sec / 60)}분 후 자동 삭제 ({job.job_id})</>}
                </div>
              </div>

              {(job.prompt_text || job.persona_cue || job.voice_settings) && (
                <details style={cardSt}>
                  <summary style={{ fontSize: 13, fontWeight: 700, cursor: 'pointer', color: 'var(--text-primary)' }}>
                    🔍 ElevenLabs API 호출 정보 (debug)
                  </summary>
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {job.persona_cue && (
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span>PERSONA CUE (맨 앞에 prepend — 전체 톤 지배)</span>
                          {!editingCue && (
                            <button
                              onClick={() => { setCueDraft(job.persona_cue || ''); setEditingCue(true) }}
                              disabled={updatingCue}
                              style={{
                                fontSize: 10, padding: '2px 8px',
                                background: 'transparent', color: 'var(--accent)',
                                border: '1px solid var(--accent)', borderRadius: 4,
                                cursor: updatingCue ? 'wait' : 'pointer',
                              }}>✏ 편집</button>
                          )}
                        </div>
                        {editingCue ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <input
                              type="text"
                              value={cueDraft}
                              onChange={e => setCueDraft(e.target.value)}
                              placeholder="(20대 후반 직장인 여성 목소리로)"
                              disabled={updatingCue}
                              style={{
                                fontSize: 13, padding: '6px 10px',
                                background: 'var(--bg-base)', color: 'var(--accent)',
                                border: '1px solid var(--accent)', borderRadius: 4,
                                fontFamily: 'monospace',
                              }}
                            />
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                onClick={updatePersonaCue}
                                disabled={updatingCue || !cueDraft.trim() || cueDraft === job.persona_cue}
                                style={{
                                  padding: '5px 12px', fontSize: 11, fontWeight: 700,
                                  background: updatingCue || !cueDraft.trim() || cueDraft === job.persona_cue
                                    ? 'var(--bg-elevated)' : 'var(--accent)',
                                  color: updatingCue || !cueDraft.trim() || cueDraft === job.persona_cue
                                    ? 'var(--text-muted)' : '#fff',
                                  border: 'none', borderRadius: 4,
                                  cursor: updatingCue ? 'wait' : 'pointer',
                                }}>
                                {updatingCue ? '재합성 중… (~30s)' : '🔄 적용 (전체 재합성)'}
                              </button>
                              <button
                                onClick={() => { setEditingCue(false); setCueDraft('') }}
                                disabled={updatingCue}
                                style={{
                                  padding: '5px 12px', fontSize: 11,
                                  background: 'transparent', color: 'var(--text-muted)',
                                  border: '1px solid var(--border)', borderRadius: 4,
                                  cursor: updatingCue ? 'wait' : 'pointer',
                                }}>취소</button>
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', alignSelf: 'center' }}>
                                ⚠ ElevenLabs 비용 발생 (재합성)
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div style={{ fontSize: 13, padding: '6px 10px', background: 'var(--bg-elevated)',
                            borderRadius: 4, fontFamily: 'monospace', color: 'var(--accent)' }}>
                            {job.persona_cue}
                          </div>
                        )}
                      </div>
                    )}
                    {job.prompt_text && (
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4 }}>
                          PROMPT TEXT (실제 ElevenLabs로 보낸 전체 텍스트, {job.prompt_text.length}자)
                        </div>
                        <div style={{ fontSize: 12, padding: '8px 12px', background: 'var(--bg-elevated)',
                          borderRadius: 4, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                          maxHeight: 240, overflowY: 'auto', fontFamily: 'monospace' }}>
                          {job.prompt_text}
                        </div>
                      </div>
                    )}
                    {job.voice_settings && (
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4 }}>
                          REQUEST BODY
                        </div>
                        <pre style={{ fontSize: 11, padding: '8px 12px', background: 'var(--bg-elevated)',
                          borderRadius: 4, margin: 0, overflowX: 'auto' }}>
{`POST https://api.elevenlabs.io/v1/text-to-speech/${job.voice_id || ''}
Content-Type: application/json
xi-api-key: ***

${JSON.stringify({
  text: (job.prompt_text || '').slice(0, 80) + ((job.prompt_text || '').length > 80 ? '...' : ''),
  model_id: job.model_id,
  voice_settings: job.voice_settings,
}, null, 2)}`}
                        </pre>
                      </div>
                    )}
                  </div>
                </details>
              )}

              <div style={cardSt}>
                <div style={labelSt}>문장별 감정 단어</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  강도 단계 변경 → "재생성"으로 그 문장만 새 단어로 재합성 · 속도 변경 → 아래 "속도 적용" 버튼 (재합성 없이 ffmpeg만)
                </div>
                {/* 🌐 전체 속도 — 모든 sentence speedDraft에 일괄 반영 */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
                  padding: '8px 12px', borderRadius: 6, background: 'var(--bg-elevated)',
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>🌐 전체 속도:</span>
                  <select
                    value="placeholder"
                    onChange={e => {
                      const v = parseFloat(e.target.value)
                      if (!isFinite(v)) return
                      const all: Record<number, number> = {}
                      job.sentences.forEach((_s, i) => { all[i] = v })
                      setSpeedDrafts(all)
                      // select 값을 즉시 reset (다음 선택도 onChange 발화되도록)
                      e.target.value = 'placeholder'
                    }}
                    disabled={applyingSpeeds}
                    style={{
                      fontSize: 12, padding: '4px 10px',
                      background: 'var(--bg-base)', color: 'var(--text-body)',
                      border: '1px solid var(--border)', borderRadius: 4, fontWeight: 600,
                      cursor: applyingSpeeds ? 'wait' : 'pointer',
                    }}>
                    <option value="placeholder" disabled>(선택)</option>
                    <option value="0.5">0.5× 매우 느림</option>
                    <option value="0.65">0.65×</option>
                    <option value="0.75">0.75×</option>
                    <option value="0.85">0.85×</option>
                    <option value="0.9">0.9×</option>
                    <option value="1">1.0× 원본</option>
                    <option value="1.1">1.1×</option>
                    <option value="1.2">1.2×</option>
                    <option value="1.3">1.3×</option>
                    <option value="1.5">1.5×</option>
                    <option value="1.75">1.75×</option>
                    <option value="2">2.0× 매우 빠름</option>
                  </select>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    → 모든 문장에 적용 (개별 조정도 가능) → 아래 "속도 적용" 클릭
                  </span>
                </div>
                {/* 속도 draft가 있으면 일괄 적용 버튼 */}
                {(() => {
                  const changedCount = job.sentences.reduce((acc, s, i) => {
                    const v = speedDrafts[i] ?? s.speed_factor ?? 1.0
                    const cur = s.speed_factor ?? 1.0
                    return acc + (Math.abs(v - cur) > 0.01 ? 1 : 0)
                  }, 0)
                  if (changedCount === 0) return null
                  return (
                    <div style={{
                      marginBottom: 12, padding: '8px 12px', borderRadius: 6,
                      background: 'rgba(245,158,11,0.08)', border: '1px solid #f59e0b',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                    }}>
                      <span style={{ fontSize: 12, color: '#a16207', fontWeight: 600 }}>
                        ⏱ {changedCount}개 문장 속도 변경 대기 중 (재합성 없이 ffmpeg만, 빠름)
                      </span>
                      <button
                        onClick={applyAllSpeeds}
                        disabled={applyingSpeeds}
                        style={{
                          padding: '6px 14px', fontSize: 12, fontWeight: 700,
                          background: applyingSpeeds ? 'var(--bg-elevated)' : '#f59e0b',
                          color: applyingSpeeds ? 'var(--text-muted)' : '#fff',
                          border: 'none', borderRadius: 4,
                          cursor: applyingSpeeds ? 'wait' : 'pointer',
                        }}>
                        {applyingSpeeds ? '적용 중…' : '⏱ 속도 적용'}
                      </button>
                    </div>
                  )
                })()}
                {/* 합성 후에도 위 입력 영역에서 어절/감정 수정 가능 → '🔄 변경 사항 재합성' 버튼으로 적용 */}
                <div style={{
                  fontSize: 11, color: 'var(--accent)',
                  padding: '8px 10px', marginBottom: 12, borderRadius: 6,
                  background: 'rgba(99,102,241,0.06)', border: '1px dashed var(--accent)',
                }}>
                  💡 음성 결과 듣고 어절/감정 바꾸고 싶으면 <strong>위 입력 영역</strong>에서 chip 클릭 →
                  아래 <strong>"🔄 변경 사항 재합성"</strong> 녹색 버튼으로 적용
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
                      {(() => {
                        const actualDur = s.end - s.start
                        const hasRef = s.ref_start !== undefined && s.ref_end !== undefined
                        const refDur = hasRef ? (s.ref_end! - s.ref_start!) : 0
                        const diff = hasRef ? actualDur - refDur : 0
                        const drift = Math.abs(diff)
                        const isMisaligned = drift >= 0.5  // ±0.5s 이상 차이
                        const diffColor = drift < 0.3 ? '#16a34a'  // 녹: 정확
                          : drift < 0.5 ? '#a16207'                // 노: 약간
                          : '#dc2626'                              // 빨: 큰 차이
                        return (
                          <div style={{ fontSize: 12, marginBottom: 8 }}>
                            <span style={{
                              color: isMisaligned ? diffColor : 'var(--text-muted)',
                              marginRight: 6, fontWeight: isMisaligned ? 700 : 400,
                              fontFamily: 'monospace',
                            }}>
                              [{s.start.toFixed(1)}–{s.end.toFixed(1)}s]
                            </span>
                            {hasRef && (
                              <span style={{
                                fontSize: 10, marginRight: 8, color: diffColor,
                                fontFamily: 'monospace',
                              }}>
                                REF {refDur.toFixed(1)}s vs 합성 {actualDur.toFixed(1)}s
                                <span style={{ marginLeft: 4, fontWeight: 700 }}>
                                  ({diff >= 0 ? '+' : ''}{diff.toFixed(1)}s)
                                </span>
                              </span>
                            )}
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
                        )
                      })()}

                      {/* speed picker — post-synth ffmpeg atempo (재합성 없음) */}
                      {(() => {
                        const curSpeed = s.speed_factor ?? 1.0
                        const draftSpeed = speedDrafts[i] ?? curSpeed
                        const speedDirty = Math.abs(draftSpeed - curSpeed) > 0.01
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 8px' }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>⏱ 속도:</span>
                            <select
                              value={String(draftSpeed)}
                              onChange={e => {
                                const v = parseFloat(e.target.value)
                                setSpeedDrafts(d => ({ ...d, [i]: v }))
                              }}
                              disabled={applyingSpeeds}
                              style={{
                                fontSize: 11, padding: '2px 6px',
                                background: speedDirty ? 'rgba(245,158,11,0.15)' :
                                  (draftSpeed !== 1.0 ? 'rgba(245,158,11,0.08)' : 'var(--bg-base)'),
                                color: speedDirty || draftSpeed !== 1.0 ? '#a16207' : 'var(--text-body)',
                                border: '1px solid',
                                borderColor: speedDirty ? '#f59e0b' :
                                  (draftSpeed !== 1.0 ? '#f59e0b' : 'var(--border)'),
                                borderRadius: 4, fontWeight: 600,
                              }}>
                              <option value="0.5">0.5× 매우 느림</option>
                              <option value="0.65">0.65×</option>
                              <option value="0.75">0.75×</option>
                              <option value="0.85">0.85×</option>
                              <option value="0.9">0.9×</option>
                              <option value="1">1.0× 원본</option>
                              <option value="1.1">1.1×</option>
                              <option value="1.2">1.2×</option>
                              <option value="1.3">1.3×</option>
                              <option value="1.5">1.5×</option>
                              <option value="1.75">1.75×</option>
                              <option value="2">2.0× 매우 빠름</option>
                            </select>
                            {speedDirty && (
                              <span style={{ fontSize: 10, color: '#a16207', fontWeight: 600 }}>
                                미적용 · 위 "속도 적용" 버튼
                              </span>
                            )}
                          </div>
                        )
                      })()}

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
