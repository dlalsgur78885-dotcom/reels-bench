import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, thumbUrl } from '../api'
import type { ReelAddResult } from '../api'
import Thumb from '../components/Thumb'

const LS_KEY = 'reel_intake_recent'
const MAX_RECENT = 20

interface RecentItem {
  shortcode: string
  url: string
  addedAt: number
  status?: 'pending' | 'done'
}

function loadRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}
function saveRecent(list: RecentItem[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)) } catch {}
}

function parseShortcode(value: string) {
  const raw = value.trim()
  if (!raw) return ''
  const clean = raw.split('?')[0].split('#')[0].replace(/\/+$/, '')
  const match = clean.match(/instagram\.com\/(?:reel|p|tv)\/([^/?#]+)/i)
  const candidate = match?.[1] || clean.split('/').filter(Boolean).pop() || clean
  return candidate.replace(/[^A-Za-z0-9_-]/g, '')
}

type Phase = 'idle' | 'submitting' | 'analyzing' | 'done' | 'error'

interface BatchItem {
  shortcode: string
  url: string
  status: 'pending' | 'adding' | 'added' | 'analyzing' | 'done' | 'error'
  error?: string
}

export default function ReelIntake() {
  const [input, setInput] = useState('')
  const [result, setResult] = useState<ReelAddResult | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [recent, setRecent] = useState<RecentItem[]>([])
  const [batch, setBatch] = useState<BatchItem[]>([])
  const navigate = useNavigate()
  // 텍스트영역에서 여러 줄 URL 파싱
  const parsedShortcodes = useMemo(() => {
    const lines = input.split(/[\n,]+/).map(l => l.trim()).filter(Boolean)
    const codes = lines.map(parseShortcode).filter(Boolean)
    // 중복 제거
    return [...new Set(codes)]
  }, [input])
  const isBatch = parsedShortcodes.length > 1
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
  }

  useEffect(() => stopPolling, [])

  // 마운트 시 localStorage 로드 + 각 항목 분석 상태 조회
  useEffect(() => {
    const list = loadRecent()
    setRecent(list)
    Promise.all(list.map(async item => {
      try {
        await api.analysis(item.shortcode)
        return { ...item, status: 'done' as const }
      } catch {
        return { ...item, status: 'pending' as const }
      }
    })).then(updated => {
      setRecent(updated)
      saveRecent(updated)
    })
  }, [])

  const addToRecent = (item: ReelAddResult) => {
    const next: RecentItem = {
      shortcode: item.shortcode, url: item.url, addedAt: Date.now(), status: 'pending',
    }
    setRecent(prev => {
      const filtered = prev.filter(r => r.shortcode !== item.shortcode)
      const updated = [next, ...filtered].slice(0, MAX_RECENT)
      saveRecent(updated)
      return updated
    })
  }

  const markDone = (sc: string) => {
    setRecent(prev => {
      const updated = prev.map(r => r.shortcode === sc ? { ...r, status: 'done' as const } : r)
      saveRecent(updated)
      return updated
    })
  }

  const removeRecent = (sc: string) => {
    setRecent(prev => {
      const updated = prev.filter(r => r.shortcode !== sc)
      saveRecent(updated)
      return updated
    })
  }

  const submit = async () => {
    if (!parsedShortcodes.length) return
    stopPolling()
    setError('')
    setResult(null)
    setElapsed(0)

    // 배치 모드 (2개 이상) — 여러 개 동시 추가
    if (isBatch) {
      const init: BatchItem[] = parsedShortcodes.map(sc => ({
        shortcode: sc,
        url: `https://www.instagram.com/reel/${sc}/`,
        status: 'pending',
      }))
      setBatch(init)
      setPhase('submitting')
      // 병렬로 4개씩 처리
      const queue = [...parsedShortcodes]
      const concurrency = 4
      const runOne = async (sc: string) => {
        setBatch(prev => prev.map(b => b.shortcode === sc ? { ...b, status: 'adding' } : b))
        try {
          const res = await api.addReel(`https://www.instagram.com/reel/${sc}/`, true)
          addToRecent(res)
          setBatch(prev => prev.map(b => b.shortcode === sc ? { ...b, status: 'added' } : b))
          return res
        } catch (e: any) {
          setBatch(prev => prev.map(b => b.shortcode === sc ? { ...b, status: 'error', error: e?.message || 'fail' } : b))
          return null
        }
      }
      const workers = Array.from({ length: concurrency }, async () => {
        while (queue.length) {
          const sc = queue.shift()
          if (sc) await runOne(sc)
        }
      })
      await Promise.all(workers)
      setPhase('done')
      // 분석 polling (each)
      pollRef.current = setInterval(() => {
        setBatch(prev => {
          let changed = false
          const next = prev.map(b => {
            if (b.status !== 'added' && b.status !== 'analyzing') return b
            return b
          })
          // 각 added/analyzing 항목에 대해 분석 결과 체크 (백그라운드)
          prev.forEach(b => {
            if (b.status === 'added' || b.status === 'analyzing') {
              api.analysis(b.shortcode).then(() => {
                setBatch(p => p.map(x => x.shortcode === b.shortcode ? { ...x, status: 'done' } : x))
                markDone(b.shortcode)
              }).catch(() => {})
            }
          })
          return changed ? next : prev
        })
      }, 8000)
      return
    }

    // 단일 모드
    setPhase('submitting')
    try {
      const res = await api.addReel(input, true)
      setResult(res)
      setPhase('analyzing')
      addToRecent(res)
      tickRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
      pollRef.current = setInterval(async () => {
        try {
          await api.analysis(res.shortcode)
          stopPolling()
          setPhase('done')
          markDone(res.shortcode)
        } catch {}
      }, 5000)
    } catch {
      setError('릴스를 추가하지 못했습니다. URL 형식을 확인하거나 잠시 후 다시 시도하세요.')
      setPhase('error')
    }
  }

  const cliCmd = 'python auto_analyze.py --limit 1'
  const copyCmd = () => navigator.clipboard?.writeText(cliCmd).catch(() => {})
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  return (
    <div className="intake-page">
      <div className="page-header">
        <h1>릴스 추가</h1>
        <p>URL 등록 후 PC CLI 명령으로 분석을 트리거합니다.</p>
      </div>

      <section className="reel-intake-hero">
        <div className="intake-main">
          <div className="eyebrow">{isBatch ? `Batch (${parsedShortcodes.length}개)` : 'Single Reel'}</div>
          <h2>릴스 URL — 한 줄에 하나씩 (여러 개 가능)</h2>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={'https://www.instagram.com/reel/SHORTCODE/\nhttps://www.instagram.com/reel/ANOTHER/\n... (한 줄에 하나)'}
            disabled={phase === 'submitting' || phase === 'analyzing'}
            rows={6}
            autoFocus
            style={{
              width: '100%', padding: 12, fontSize: 14, fontFamily: 'inherit',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-base)', color: 'var(--text-primary)', resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center' }}>
            <button onClick={submit} disabled={!parsedShortcodes.length || phase === 'submitting' || phase === 'analyzing'}
              style={{ padding: '10px 20px', fontSize: 14, fontWeight: 600 }}>
              {phase === 'submitting' ? `추가 중 (${batch.filter(b => b.status === 'added' || b.status === 'done').length}/${parsedShortcodes.length})` : phase === 'analyzing' ? '분석 중' : isBatch ? `${parsedShortcodes.length}개 추가하기` : '분석하기'}
            </button>
            {parsedShortcodes.length > 0 && phase === 'idle' && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                인식된 shortcode {parsedShortcodes.length}개: {parsedShortcodes.slice(0, 3).join(', ')}{parsedShortcodes.length > 3 && '...'}
              </span>
            )}
          </div>
        </div>

        <aside className="intake-side">
          <div className="panel-title">처리 흐름</div>
          <ol>
            <li>URL에서 shortcode 추출 + DB 등록 (병렬 4개)</li>
            <li>PC 터미널에서 CLI 분석 실행</li>
            <li>분석 완료 시 자동 감지 → 상세 화면</li>
          </ol>
        </aside>
      </section>

      {/* 배치 진행 상황 */}
      {batch.length > 0 && (
        <section style={{ marginTop: 16, padding: 16, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <strong style={{ fontSize: 14 }}>배치 진행 ({batch.length}개)</strong>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              완료 {batch.filter(b => b.status === 'done').length} · 추가됨 {batch.filter(b => b.status === 'added').length} · 처리중 {batch.filter(b => b.status === 'adding').length} · 오류 {batch.filter(b => b.status === 'error').length}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
            {batch.map(b => {
              const colors = {
                pending: 'var(--text-muted)',
                adding: 'var(--accent)',
                added: '#3B82F6',
                analyzing: '#8B5CF6',
                done: 'var(--success)',
                error: 'var(--error)',
              }[b.status]
              return (
                <div key={b.shortcode} style={{
                  padding: '8px 12px', fontSize: 12, border: `1px solid ${colors}`,
                  borderLeft: `4px solid ${colors}`, borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-base)', cursor: 'pointer',
                }} onClick={() => navigate(`/bench/${b.shortcode}`)}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{b.shortcode}</div>
                  <div style={{ color: colors, fontSize: 11, fontWeight: 600 }}>{b.status}</div>
                  {b.error && <div style={{ fontSize: 10, color: 'var(--error)' }}>{b.error}</div>}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {error && <div className="intake-alert error">{error}</div>}

      {result && phase === 'analyzing' && (
        <section className="intake-result" style={{ borderLeft: '4px solid var(--accent)' }}>
          <div>
            <div className="eyebrow" style={{ color: 'var(--accent)' }}>
              <span className="pulse-dot" />&nbsp;분석 중 · {fmtTime(elapsed)}
            </div>
            <h3>{result.shortcode}</h3>
            <p>아직 PC에서 분석 명령을 실행하지 않았다면 지금 터미널에서 실행하세요.</p>
            <div style={{
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', padding: '10px 14px',
              fontFamily: 'ui-monospace, SF Mono, monospace', fontSize: 13,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginTop: 10,
            }}>
              <code>{cliCmd}</code>
              <button onClick={copyCmd} style={{
                fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                border: '1px solid var(--border)', borderRadius: 4,
                background: 'var(--bg-surface)', color: 'var(--text-secondary)',
              }}>복사</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              5초마다 분석 완료를 자동 확인합니다. 분석은 보통 1~2분 걸립니다.
            </p>
          </div>
          <div className="intake-actions">
            <button onClick={() => navigate(`/bench/${result.shortcode}`)}>상세 화면에서 진행 보기</button>
            <a href={result.url} target="_blank" rel="noopener">Instagram 열기</a>
          </div>
        </section>
      )}

      {result && phase === 'done' && (
        <section className="intake-result">
          <div>
            <div className="eyebrow" style={{ color: 'var(--success)' }}>분석 완료</div>
            <h3>{result.shortcode}</h3>
            <p>분석 결과가 DB에 저장됐습니다. 상세 화면에서 결과를 확인하세요.</p>
          </div>
          <div className="intake-actions">
            <button onClick={() => navigate(`/bench/${result.shortcode}`)}>상세 분석 보기</button>
            <button onClick={() => navigate('/bench')}>벤치마크 보기</button>
            <a href={result.url} target="_blank" rel="noopener">Instagram 열기</a>
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>내가 추가한 릴스</h3>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {recent.length}개 (이 브라우저에 저장)
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
            {recent.map(item => (
              <div key={item.shortcode}
                   style={{
                     position: 'relative',
                     border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                     overflow: 'hidden', background: 'var(--bg-surface)',
                     cursor: 'pointer', transition: 'transform 0.15s',
                   }}
                   onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-2px)')}
                   onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
                   onClick={() => navigate(`/bench/${item.shortcode}`)}>
                <Thumb src={thumbUrl(item.shortcode)} shortcode={item.shortcode}
                     style={{ width: '100%', aspectRatio: '4/5', objectFit: 'cover',
                              display: 'block', background: 'var(--bg-elevated)' }} />
                <span style={{
                  position: 'absolute', top: 8, left: 8,
                  fontSize: 10, fontWeight: 700, padding: '2px 8px',
                  borderRadius: 999,
                  background: item.status === 'done' ? 'rgba(34,197,94,0.95)' : 'rgba(255,255,255,0.95)',
                  color: item.status === 'done' ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}>
                  {item.status === 'done' ? '분석완료' : '분석대기'}
                </span>
                <button onClick={e => { e.stopPropagation(); removeRecent(item.shortcode) }}
                        style={{
                          position: 'absolute', top: 6, right: 6,
                          width: 22, height: 22, borderRadius: '50%',
                          border: 'none', background: 'rgba(0,0,0,0.5)', color: '#fff',
                          fontSize: 12, lineHeight: '20px', cursor: 'pointer',
                        }}
                        title="목록에서 제거 (DB에는 남음)">×</button>
                <div style={{ padding: '8px 10px', fontSize: 12 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.shortcode}
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>
                    {new Date(item.addedAt).toLocaleString('ko-KR', {
                      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <style>{`
        .pulse-dot {
          display: inline-block; width: 8px; height: 8px; border-radius: 50%;
          background: var(--accent); animation: pulse 1.4s infinite;
          vertical-align: middle;
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.85); }
          50%      { opacity: 1;   transform: scale(1.15); }
        }
      `}</style>
    </div>
  )
}
