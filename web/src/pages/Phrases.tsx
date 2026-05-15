import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, thumbUrl } from '../api'
import type { BenchFilters, PhrasesItem, PhraseHookIntroItem } from '../api'
import { fmtNum } from '../utils'
import Thumb from '../components/Thumb'
import Pagination from '../components/Pagination'
import BenchFilterControls from '../components/BenchFilterControls'

const PAGE_SIZE = 30

type Part = 'hook_intro' | 'cta'

function isHookIntro(item: PhrasesItem): item is PhraseHookIntroItem {
  return 'hook_text' in item
}

export default function Phrases() {
  const [items, setItems] = useState<PhrasesItem[]>([])
  const [total, setTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [params, setParams] = useState<BenchFilters>({ sort: 'plays' })
  const [part, setPart] = useState<Part>('hook_intro')
  const [loading, setLoading] = useState(false)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const navigate = useNavigate()

  const load = useCallback(async (page: number, p: BenchFilters, pt: Part) => {
    setLoading(true)
    try {
      const res = await api.phrases(pt, { ...p, page, limit: PAGE_SIZE })
      setItems(res.items)
      setTotal(res.total)
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [])

  useEffect(() => {
    setCurrentPage(1)
    load(1, params, part)
  }, [params, part, load])

  const goPage = (p: number) => {
    if (p < 1 || p > totalPages || p === currentPage) return
    setCurrentPage(p)
    load(p, params, part)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const setParamsIfChanged = useCallback((next: BenchFilters) => {
    setParams(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
  }, [])

  return (
    <>
      <div className="page-header">
        <h1>문구별 보기</h1>
        <p>{loading ? '불러오는 중…' : `${fmtNum(total)}개 분석된 릴스`}</p>
      </div>

      <BenchFilterControls onChange={setParamsIfChanged} />

      <div
        className="segment-group"
        role="radiogroup"
        aria-label="문구 종류"
        style={{ marginBottom: 16, marginTop: 4 }}
      >
        {([['hook_intro', 'Hook + Intro'], ['cta', 'CTA']] as const).map(([k, l]) => (
          <button
            key={k}
            type="button"
            className={`btn-segment${part === k ? ' active' : ''}`}
            role="radio"
            aria-checked={part === k}
            onClick={() => setPart(k)}
          >{l}</button>
        ))}
      </div>

      {loading && (
        <div className="empty-state" role="status" aria-live="polite">불러오는 중…</div>
      )}
      {!loading && items.length === 0 && (
        <div className="empty-state">조건에 맞는 문구가 없습니다</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map(it => (
          <button
            key={it.shortcode}
            type="button"
            onClick={() => navigate(`/bench/${it.shortcode}`)}
            className="phrase-card"
            aria-label={`@${it.author || '?'} 분석 상세 보기`}
            style={{
              display: 'grid',
              gridTemplateColumns: '64px 1fr auto',
              gap: 14,
              alignItems: 'flex-start',
              padding: 14,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              textAlign: 'left',
              cursor: 'pointer',
              font: 'inherit',
              color: 'inherit',
              width: '100%',
            }}
          >
            <Thumb
              src={thumbUrl(it.shortcode)}
              shortcode={it.shortcode}
              style={{
                width: 64, height: 80, objectFit: 'cover',
                borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)',
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  @{it.author || '?'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{it.shortcode}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigator.clipboard.writeText(it.shortcode).then(() => {
                      const btn = e.currentTarget as HTMLButtonElement
                      const orig = btn.textContent
                      btn.textContent = '✓ 복사됨'
                      setTimeout(() => { btn.textContent = orig }, 1200)
                    }).catch(() => {})
                  }}
                  title={`shortcode 복사: ${it.shortcode}`}
                  style={{
                    padding: '2px 8px', fontSize: 10, fontWeight: 600,
                    background: 'var(--bg-elevated)', color: 'var(--text-muted)',
                    border: '1px solid var(--border)', borderRadius: 4,
                    cursor: 'pointer', font: 'inherit',
                  }}
                >📋 복사</button>
              </div>

              {isHookIntro(it) ? (
                <>
                  {it.hook_text && (
                    <PhraseRow
                      eyebrow={`HOOK${it.hook_type ? ' · ' + it.hook_type : ''}${it.hook_seconds ? ' · ' + it.hook_seconds : ''}`}
                      text={it.hook_text}
                    />
                  )}
                  {it.intro_text && (
                    <PhraseRow
                      eyebrow={`INTRO${it.intro_seconds ? ' · ' + it.intro_seconds : ''}`}
                      text={it.intro_text}
                      muted
                    />
                  )}
                </>
              ) : (
                <PhraseRow
                  eyebrow={`CTA${it.cta_type ? ' · ' + it.cta_type : ''}${it.cta_seconds ? ' · ' + it.cta_seconds : ''}`}
                  text={it.cta_text}
                />
              )}
            </div>
            <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, lineHeight: 1.5 }}>
              <div>{fmtNum(it.play_count)}</div>
              <div>♥ {fmtNum(it.like_count)}</div>
            </div>
          </button>
        ))}
      </div>

      {!loading && items.length > 0 && totalPages > 1 && (
        <div style={{ marginTop: 16 }}>
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            total={total}
            onChange={goPage}
          />
        </div>
      )}
    </>
  )
}

function PhraseRow({ eyebrow, text, muted = false }: { eyebrow: string; text: string; muted?: boolean }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div className="eyebrow-label" style={{ marginBottom: 2 }}>{eyebrow}</div>
      <div style={{
        fontSize: muted ? 13 : 14,
        lineHeight: 1.55,
        color: muted ? 'var(--text-secondary)' : 'var(--text-primary)',
      }}>{text}</div>
    </div>
  )
}
