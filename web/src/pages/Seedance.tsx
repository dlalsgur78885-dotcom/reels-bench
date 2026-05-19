import { useEffect, useRef, useState } from 'react'
import { authedFetch } from '../api'

type Status = 'idle' | 'importing' | 'uploading' | 'submitting' | 'queued' | 'in_progress' | 'completed' | 'failed'
type Mode = 'blog' | 'upload'        // 이미지 소스
type GenMode = 'transition' | 'reference'   // 생성 모드
type BlogImage = { url: string; alt: string }
type Slot = 'start' | 'end'

const TRANSITION_PROMPT = '자연스러운 카메라 무빙으로 첫 장면에서 두 번째 장면으로 부드럽게 전환'
const REFERENCE_PROMPT = '@Image1 인물이 @Image2 배경 안에서 자연스럽게 행동하는 모습'

const RESOLUTIONS = ['480p', '720p', '1080p'] as const
const DURATIONS = ['4', '5', '6', '8', '10', '12', '15'] as const
const ASPECTS = ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9', 'auto'] as const

export default function Seedance() {
  const [mode, setMode] = useState<Mode>('blog')
  const [genMode, setGenMode] = useState<GenMode>('transition')

  // 블로그 모드
  const [blogUrl, setBlogUrl] = useState('')
  const [blogImages, setBlogImages] = useState<BlogImage[]>([])
  const [blogExtracting, setBlogExtracting] = useState(false)
  const [blogError, setBlogError] = useState('')
  // 선택된 시작/끝 이미지 (블로그 원본 URL 보관, submit 시 fal로 import)
  const [startSrc, setStartSrc] = useState<string>('')
  const [endSrc, setEndSrc] = useState<string>('')

  // 업로드 모드
  const [startFile, setStartFile] = useState<File | null>(null)
  const [endFile, setEndFile] = useState<File | null>(null)
  const [startPreview, setStartPreview] = useState('')
  const [endPreview, setEndPreview] = useState('')

  // 공통 옵션
  const [prompt, setPrompt] = useState(TRANSITION_PROMPT)
  // genMode 변경 시 prompt 기본값 자동 교체 (사용자가 직접 입력한 경우는 유지)
  const [promptTouched, setPromptTouched] = useState(false)
  useEffect(() => {
    if (promptTouched) return
    setPrompt(genMode === 'reference' ? REFERENCE_PROMPT : TRANSITION_PROMPT)
  }, [genMode, promptTouched])
  const [resolution, setResolution] = useState<typeof RESOLUTIONS[number]>('1080p')
  const [duration, setDuration] = useState<typeof DURATIONS[number]>('5')
  const [aspectRatio, setAspectRatio] = useState<typeof ASPECTS[number]>('9:16')
  const [generateAudio, setGenerateAudio] = useState(false)

  // 진행
  const [status, setStatus] = useState<Status>('idle')
  const [requestId, setRequestId] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [queuePosition, setQueuePosition] = useState<number | null>(null)
  const [videoUrl, setVideoUrl] = useState('')
  const [seed, setSeed] = useState<number | null>(null)
  const [error, setError] = useState('')
  // 저장 상태
  const [saving, setSaving] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [saveName, setSaveName] = useState('')
  // 프롬프트 저장 (sub-dialog)
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [promptSaved, setPromptSaved] = useState(false)
  // 라이브러리에서 가져온 인물 (reference 모드 시작 슬롯에 대입)
  const [pendingCharacterUrls, setPendingCharacterUrls] = useState<string[]>([])
  const pendingCharacterUrl = pendingCharacterUrls[0] || ''
  // 마지막 생성 메타 (저장 시 같이 보냄)
  const lastMetaRef = useRef<{ startUrl: string; endUrl: string }>({ startUrl: '', endUrl: '' })

  const tickerRef = useRef<number | null>(null)
  const pollerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)

  useEffect(() => () => {
    if (tickerRef.current) window.clearInterval(tickerRef.current)
    if (pollerRef.current) window.clearInterval(pollerRef.current)
    if (startPreview) URL.revokeObjectURL(startPreview)
    if (endPreview) URL.revokeObjectURL(endPreview)
  }, [])

  // sessionStorage 에 저장된 pending (라이브러리에서 "사용 →" 누르고 넘어온 경우) 처리
  useEffect(() => {
    const pendingMode = sessionStorage.getItem('seedance_pending_mode') as GenMode | null
    const pendingPrompt = sessionStorage.getItem('seedance_pending_prompt')
    const pendingChar = sessionStorage.getItem('seedance_pending_character')
    if (pendingMode === 'transition' || pendingMode === 'reference') {
      setGenMode(pendingMode)
    }
    if (pendingPrompt) {
      setPrompt(pendingPrompt)
      setPromptTouched(true)
    }
    if (pendingChar) {
      try {
        const obj = JSON.parse(pendingChar)
        const urls: string[] = Array.isArray(obj?.image_urls) && obj.image_urls.length > 0
          ? obj.image_urls
          : (obj?.image_url ? [obj.image_url] : [])
        if (urls.length > 0) {
          setPendingCharacterUrls(urls)
          setGenMode('reference')
        }
      } catch {}
    }
    sessionStorage.removeItem('seedance_pending_mode')
    sessionStorage.removeItem('seedance_pending_prompt')
    sessionStorage.removeItem('seedance_pending_character')
  }, [])

  const onPickFile = (slot: Slot, f: File | null) => {
    if (slot === 'start') {
      if (startPreview) URL.revokeObjectURL(startPreview)
      setStartFile(f)
      setStartPreview(f ? URL.createObjectURL(f) : '')
    } else {
      if (endPreview) URL.revokeObjectURL(endPreview)
      setEndFile(f)
      setEndPreview(f ? URL.createObjectURL(f) : '')
    }
  }

  const extractBlog = async () => {
    setBlogError('')
    setBlogImages([])
    setStartSrc(''); setEndSrc('')
    if (!blogUrl.startsWith('http')) { setBlogError('http(s):// URL 필요'); return }
    setBlogExtracting(true)
    try {
      const r = await authedFetch(`/api/seedance/extract-images?url=${encodeURIComponent(blogUrl)}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const data = await r.json()
      setBlogImages(data.images || [])
      if (!data.images?.length) setBlogError('이미지를 찾지 못했어요')
    } catch (e: any) {
      setBlogError(e?.message || String(e))
    } finally {
      setBlogExtracting(false)
    }
  }

  const toggleBlogImage = (url: string) => {
    if (startSrc === url) { setStartSrc(''); return }
    if (endSrc === url) { setEndSrc(''); return }
    if (!startSrc) setStartSrc(url)
    else if (!endSrc) setEndSrc(url)
    else { setEndSrc(url) }  // 둘 다 차 있으면 end 교체
  }

  const reset = () => {
    setStatus('idle'); setRequestId(''); setElapsed(0)
    setQueuePosition(null); setVideoUrl(''); setError('')
    setSeed(null); setSavedId(null); setSaveName('')
    if (tickerRef.current) { window.clearInterval(tickerRef.current); tickerRef.current = null }
    if (pollerRef.current) { window.clearInterval(pollerRef.current); pollerRef.current = null }
  }
  const startTicker = () => {
    startedAtRef.current = Date.now(); setElapsed(0)
    tickerRef.current = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000))
    }, 1000)
  }
  const stopTicker = () => {
    if (tickerRef.current) { window.clearInterval(tickerRef.current); tickerRef.current = null }
  }

  const uploadLocalFile = async (file: File): Promise<string> => {
    const fd = new FormData()
    fd.append('file', file)
    const r = await authedFetch('/api/seedance/upload', { method: 'POST', body: fd })
    if (!r.ok) throw new Error(`업로드 ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const data = await r.json()
    return data.image_url
  }
  const importRemoteImage = async (url: string): Promise<string> => {
    const r = await authedFetch('/api/seedance/import-image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, referer: blogUrl || null }),
    })
    if (!r.ok) throw new Error(`이미지 import ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const data = await r.json()
    return data.image_url
  }

  const submit = async () => {
    reset()
    if (!prompt.trim()) { setError('프롬프트를 입력하세요'); return }

    let startInput = ''
    let endInput = ''
    // reference 모드에서 라이브러리 인물이 지정돼있으면 그걸 시작(인물)로 강제
    const useLibChar = genMode === 'reference' && !!pendingCharacterUrl
    if (mode === 'blog') {
      if (!useLibChar && !startSrc) { setError(genMode === 'reference' ? '인물 이미지를 선택하세요' : '시작 이미지를 선택하세요'); return }
      startInput = useLibChar ? pendingCharacterUrl : startSrc
      endInput = endSrc
    } else {
      if (!useLibChar && !startFile) { setError(genMode === 'reference' ? '인물 이미지를 업로드하세요' : '시작 이미지를 업로드하세요'); return }
    }
    if (genMode === 'reference') {
      const hasSecond = mode === 'blog' ? !!endSrc : !!endFile
      if (!hasSecond) { setError('배경 이미지도 선택/업로드하세요'); return }
    }

    try {
      startTicker()
      setStatus(mode === 'blog' || useLibChar ? 'importing' : 'uploading')

      // 라이브러리 인물 멀티 — pendingCharacterUrls 전부 import 후 ref 배열로 함께 전달
      let charUrls: string[] = []
      if (useLibChar && pendingCharacterUrls.length > 0) {
        // reference-to-video 는 최대 9장이라 잘림 (8 + 배경 1)
        const slice = pendingCharacterUrls.slice(0, 8)
        for (const u of slice) {
          charUrls.push(await importRemoteImage(u))
        }
      }

      const startUrl = useLibChar
        ? (charUrls[0] || '')
        : (mode === 'blog'
            ? await importRemoteImage(startInput)
            : await uploadLocalFile(startFile!))
      let endUrl = ''
      if (mode === 'blog' && endInput) {
        endUrl = await importRemoteImage(endInput)
      } else if (mode === 'upload' && endFile) {
        endUrl = await uploadLocalFile(endFile)
      }
      lastMetaRef.current = { startUrl, endUrl }

      setStatus('submitting')
      const payload: any = {
        prompt, mode: genMode, resolution, duration,
        aspect_ratio: aspectRatio, generate_audio: generateAudio,
      }
      if (genMode === 'reference') {
        // 라이브러리 인물 N장 (@Image1..@ImageN) + 배경 (@ImageN+1)
        // 라이브러리 미사용이면 [시작(인물), 끝(배경)] 2장
        const refs = useLibChar ? [...charUrls] : [startUrl]
        if (endUrl) refs.push(endUrl)
        payload.reference_image_urls = refs
      } else {
        payload.image_url = startUrl
        if (endUrl) payload.end_image_url = endUrl
      }

      const sr = await authedFetch('/api/seedance/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
            setSeed(typeof ps.seed === 'number' ? ps.seed : null)
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

  const saveVideo = async () => {
    if (!videoUrl || saving || savedId) return
    setSaving(true)
    try {
      const r = await authedFetch('/api/seedance/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_url: videoUrl,
          name: saveName.trim() || null,
          prompt,
          mode: genMode,
          source_blog_url: mode === 'blog' ? blogUrl : null,
          start_image_url: lastMetaRef.current.startUrl,
          end_image_url: lastMetaRef.current.endUrl || null,
          reference_image_urls: genMode === 'reference'
            ? [lastMetaRef.current.startUrl, lastMetaRef.current.endUrl].filter(Boolean)
            : null,
          resolution, duration, aspect_ratio: aspectRatio,
          generate_audio: generateAudio, seed, request_id: requestId,
        }),
      })
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
      const row = await r.json()
      setSavedId(row.id || 'ok')
    } catch (e: any) {
      alert('저장 실패: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  const statusLabel: Record<Status, string> = {
    idle: '대기',
    importing: '이미지 가져오는 중',
    uploading: '이미지 업로드 중',
    submitting: '제출 중',
    queued: queuePosition !== null ? `대기열 #${queuePosition}` : '대기열',
    in_progress: '생성 중',
    completed: '완료',
    failed: '실패',
  }
  const busy = ['importing', 'uploading', 'submitting', 'queued', 'in_progress'].includes(status)

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Seedance 2.0 — 이미지 → 영상</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
          {genMode === 'reference'
            ? '인물 + 배경 합성 — 인물 이미지를 배경 안에 자연스럽게 배치한 영상. 1080p 4초 ≈ 4–5분.'
            : '시작 → 끝 전환 영상 — 이미지 2장을 부드럽게 잇는 영상. 1080p 4초 ≈ 4–5분.'}
        </p>
      </div>

      {/* 라이브러리에서 가져온 인물 배지 */}
      {pendingCharacterUrl && genMode === 'reference' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, marginBottom: 12,
          background: 'rgba(99,102,241,0.10)', border: '1px solid var(--accent)', borderRadius: 6 }}>
          <div style={{ display: 'flex', gap: 2 }}>
            {pendingCharacterUrls.slice(0, 4).map((u, i) => (
              <img key={u + i} src={u} alt=""
                style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4 }} />
            ))}
            {pendingCharacterUrls.length > 4 && (
              <span style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, background: 'var(--bg-base)',
                border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)' }}>
                +{pendingCharacterUrls.length - 4}
              </span>
            )}
          </div>
          <div style={{ flex: 1, fontSize: 12 }}>
            <div style={{ fontWeight: 700, color: 'var(--accent)' }}>
              라이브러리 인물 사용 중 ({pendingCharacterUrls.length}장)
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              인물 reference로 모두 전달, 배경만 아래에서 골라주세요.
            </div>
          </div>
          <button onClick={() => setPendingCharacterUrls([])}
            style={{ padding: '4px 10px', fontSize: 11,
              background: 'transparent', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>해제</button>
        </div>
      )}

      {/* 생성 모드 토글 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {([
          ['transition', '🎬 전환 (시작 + 끝)', '이미지 2장을 자연스럽게 잇는 영상'],
          ['reference', '🧑 합성 (인물 + 배경)', '인물을 배경 장면 안에 배치'],
        ] as const).map(([m, label, sub]) => (
          <button key={m} type="button" onClick={() => !busy && setGenMode(m as GenMode)} disabled={busy}
            title={sub}
            style={{
              flex: 1, padding: '10px 12px', textAlign: 'left',
              borderRadius: 6, cursor: busy ? 'wait' : 'pointer',
              border: `2px solid ${genMode === m ? 'var(--accent)' : 'var(--border)'}`,
              background: genMode === m ? 'var(--accent-light)' : 'var(--bg-surface)',
              color: 'var(--text-body)', opacity: busy ? 0.6 : 1,
            }}>
            <div style={{ fontSize: 13, fontWeight: 700,
              color: genMode === m ? 'var(--accent)' : 'var(--text-primary)' }}>{label}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 18 }}>
        <div style={cardSt}>
          {/* 이미지 소스 모드 (블로그 / 업로드) */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {(['blog', 'upload'] as const).map(m => (
              <button key={m} onClick={() => !busy && setMode(m)} disabled={busy}
                style={{
                  padding: '8px 14px', fontSize: 12, fontWeight: 700,
                  border: '1px solid var(--border)', borderRadius: 6,
                  background: mode === m ? 'var(--accent)' : 'transparent',
                  color: mode === m ? '#fff' : 'var(--text-secondary)',
                  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
                }}>
                {m === 'blog' ? '블로그에서 추출' : '직접 업로드'}
              </button>
            ))}
          </div>

          {mode === 'blog' ? (
            <>
              <Label>블로그 URL (네이버 블로그 권장)</Label>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                <input type="url" value={blogUrl} onChange={e => setBlogUrl(e.target.value)}
                  placeholder="https://blog.naver.com/.../223..." disabled={busy || blogExtracting}
                  onKeyDown={e => { if (e.key === 'Enter') extractBlog() }}
                  style={{ flex: 1, padding: '8px 10px', fontSize: 12,
                    border: '1px solid var(--border)', borderRadius: 6,
                    background: 'var(--bg-base)', color: 'var(--text-body)' }} />
                <button onClick={extractBlog} disabled={busy || blogExtracting || !blogUrl}
                  style={{ padding: '8px 14px', fontSize: 12, fontWeight: 700,
                    background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6,
                    cursor: (busy || blogExtracting || !blogUrl) ? 'wait' : 'pointer',
                    opacity: (busy || blogExtracting || !blogUrl) ? 0.6 : 1 }}>
                  {blogExtracting ? '추출 중…' : '이미지 추출'}
                </button>
              </div>
              {blogError && (
                <div style={{ padding: 8, marginBottom: 10, fontSize: 12,
                  background: 'rgba(239,68,68,0.08)', color: 'var(--error)',
                  border: '1px solid var(--error)', borderRadius: 6 }}>{blogError}</div>
              )}

              {blogImages.length > 0 && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                    <Label>{genMode === 'reference'
                      ? '이미지 클릭으로 선택 (1=인물 / 2=배경)'
                      : '이미지 클릭으로 선택 (1=시작 / 2=끝)'}</Label>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{blogImages.length}장 발견</span>
                  </div>
                  <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
                    gap: 6, maxHeight: 380, overflowY: 'auto', padding: 4,
                    border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-base)',
                  }}>
                    {blogImages.map((img, i) => {
                      const isStart = startSrc === img.url
                      const isEnd = endSrc === img.url
                      const sel = isStart || isEnd
                      return (
                        <div key={i} onClick={() => !busy && toggleBlogImage(img.url)}
                          style={{
                            position: 'relative', cursor: busy ? 'wait' : 'pointer',
                            border: `2px solid ${isStart ? 'var(--success, #10b981)' : isEnd ? 'var(--accent)' : 'transparent'}`,
                            borderRadius: 6, overflow: 'hidden', aspectRatio: '1', background: '#000',
                          }}>
                          <img src={img.url} alt={img.alt}
                            referrerPolicy="no-referrer"
                            style={{ width: '100%', height: '100%', objectFit: 'cover',
                              opacity: sel ? 1 : 0.85 }} />
                          {sel && (
                            <span style={{
                              position: 'absolute', top: 4, left: 4, padding: '2px 6px',
                              fontSize: 10, fontWeight: 700, borderRadius: 3,
                              background: isStart ? 'var(--success, #10b981)' : 'var(--accent)',
                              color: '#fff',
                            }}>{genMode === 'reference'
                              ? (isStart ? '인물' : '배경')
                              : (isStart ? '시작' : '끝')}</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <FileSlot label={genMode === 'reference' ? '인물' : '시작 프레임'} required preview={startPreview}
                  onPick={(f) => onPickFile('start', f)} disabled={busy} />
                <FileSlot label={genMode === 'reference' ? '배경' : '끝 프레임 (선택)'}
                  required={genMode === 'reference'} preview={endPreview}
                  onPick={(f) => onPickFile('end', f)} disabled={busy} />
              </div>
            </>
          )}

          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <Label>프롬프트</Label>
              <button type="button"
                onClick={async () => {
                  if (!prompt.trim() || savingPrompt) return
                  setSavingPrompt(true)
                  try {
                    const r = await authedFetch('/api/seedance/prompts', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ content: prompt, mode: genMode }),
                    })
                    if (!r.ok) throw new Error(await r.text())
                    setPromptSaved(true)
                    setTimeout(() => setPromptSaved(false), 2000)
                  } catch (e: any) {
                    alert('프롬프트 저장 실패: ' + (e?.message || e))
                  } finally { setSavingPrompt(false) }
                }}
                disabled={!prompt.trim() || savingPrompt || busy}
                style={{
                  fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
                  background: promptSaved ? 'rgba(34,197,94,0.15)' : 'transparent',
                  color: promptSaved ? 'var(--success, #10b981)' : 'var(--accent)',
                  border: `1px solid ${promptSaved ? 'var(--success, #10b981)' : 'var(--accent)'}`,
                  cursor: (busy || savingPrompt || !prompt.trim()) ? 'not-allowed' : 'pointer',
                  opacity: (busy || !prompt.trim()) ? 0.5 : 1,
                }}>
                {savingPrompt ? '저장…' : promptSaved ? '✓ 저장됨' : '📝 라이브러리에 저장'}
              </button>
            </div>
            <textarea value={prompt}
              onChange={e => { setPrompt(e.target.value); setPromptTouched(true); setPromptSaved(false) }} disabled={busy}
              rows={3} style={textareaSt} />
          </div>

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
            오디오도 함께 생성
          </label>

          <button onClick={submit} disabled={busy}
            style={{
              marginTop: 16, width: '100%', padding: '10px 14px',
              fontSize: 14, fontWeight: 700,
              background: busy ? 'var(--bg-elevated)' : 'var(--accent)',
              color: busy ? 'var(--text-muted)' : '#fff',
              border: 'none', borderRadius: 6, cursor: busy ? 'wait' : 'pointer',
              opacity: busy ? 0.7 : 1,
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
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <a href={videoUrl} download target="_blank" rel="noopener noreferrer"
                    style={linkBtnSt}>↓ 다운로드</a>
                  <button onClick={() => navigator.clipboard.writeText(videoUrl)}
                    style={linkBtnSt}>URL 복사</button>
                </div>
                {!savedId ? (
                  <div style={{ marginTop: 12, padding: 10, borderRadius: 6,
                    background: 'var(--bg-base)', border: '1px solid var(--border)' }}>
                    <Label>이름 (선택)</Label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input type="text" value={saveName} onChange={e => setSaveName(e.target.value)}
                        placeholder="예: 카페 입구 클로즈업"
                        disabled={saving}
                        onKeyDown={e => { if (e.key === 'Enter') saveVideo() }}
                        style={{ flex: 1, padding: '6px 10px', fontSize: 12,
                          border: '1px solid var(--border)', borderRadius: 4,
                          background: 'var(--bg-surface)', color: 'var(--text-body)' }} />
                      <button onClick={saveVideo} disabled={saving}
                        style={{ padding: '6px 14px', fontSize: 12, fontWeight: 700,
                          background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4,
                          cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1 }}>
                        {saving ? '저장 중…' : '💾 영상 라이브러리에 저장'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: 12, padding: 10, borderRadius: 6,
                    background: 'rgba(34,197,94,0.08)', border: '1px solid var(--success, #10b981)',
                    fontSize: 12, color: 'var(--success, #10b981)', display: 'flex',
                    justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>✓ 라이브러리에 저장됨</span>
                    <a href="/seedance/library" style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 600 }}>
                      라이브러리 열기 →
                    </a>
                  </div>
                )}
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
    </div>
  )
}

function FileSlot({ label, preview, onPick, required, disabled }: {
  label: string; preview: string; onPick: (f: File | null) => void; required?: boolean; disabled?: boolean;
}) {
  const inputId = `seedance-${label.replace(/\s+/g, '-')}`
  return (
    <div>
      <Label>{label}{required && <span style={{ color: 'var(--error)' }}> *</span>}</Label>
      {preview ? (
        <div style={{ position: 'relative' }}>
          <img src={preview} alt={label}
            style={{ width: '100%', maxHeight: 200, objectFit: 'cover',
              borderRadius: 6, border: '1px solid var(--border)', background: '#000' }} />
          <button onClick={() => onPick(null)} disabled={disabled}
            style={{ position: 'absolute', top: 6, right: 6, padding: '3px 8px',
              fontSize: 10, fontWeight: 600, border: 'none', borderRadius: 4,
              background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer' }}>교체</button>
        </div>
      ) : (
        <label htmlFor={inputId}
          style={{ display: 'block', padding: 24, textAlign: 'center', cursor: 'pointer',
            border: '1.5px dashed var(--border)', borderRadius: 6,
            background: 'var(--bg-base)', color: 'var(--text-muted)', fontSize: 12 }}>
          + 클릭
        </label>
      )}
      <input id={inputId} type="file" accept="image/*"
        onChange={e => onPick(e.target.files?.[0] || null)} disabled={disabled}
        style={{ display: 'none' }} />
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
