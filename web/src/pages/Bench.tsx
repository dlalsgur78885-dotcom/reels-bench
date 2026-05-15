import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, thumbUrl } from '../api'
import type { BenchItem, BenchFilters } from '../api'
import { fmtNum, engagementRate } from '../utils'
import Thumb from '../components/Thumb'
import Pagination from '../components/Pagination'
import BenchFilterControls from '../components/BenchFilterControls'
import { useMe } from '../auth'

const PAGE_SIZE = 50
const prefetchedDetails = new Set<string>()
const prefetchTimers = new Map<string, number>()
let benchDetailChunkPrefetched = false

function prefetchBenchDetailChunk() {
  if (benchDetailChunkPrefetched) return
  benchDetailChunkPrefetched = true
  import('./BenchDetail').catch(() => {})
}

export default function Bench() {
  const [items, setItems] = useState<BenchItem[]>([])
  const [stats, setStats] = useState<{ total_reels: number; total_plays: number; total_likes: number; analyzed_count: number } | null>(null)
  const [total, setTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [params, setParams] = useState<BenchFilters>({ sort: 'plays' })
  const [loading, setLoading] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const me = useMe()
  const canDelete = !!me && (me.role === 'admin' || me.can_delete_reels)
  const navigate = useNavigate()

  const load = useCallback(async (page: number, p: BenchFilters) => {
    setLoading(true)
    try {
      const res = await api.bench({ ...p, page, limit: PAGE_SIZE })
      setItems(res.items)
      setStats(res.stats)
      setTotal(res.total)
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [])

  useEffect(() => {
    setCurrentPage(1)
    load(1, params)
  }, [params, load])

  useEffect(() => {
    const timer = window.setTimeout(prefetchBenchDetailChunk, 500)
    return () => window.clearTimeout(timer)
  }, [])

  const goPage = (p: number) => {
    if (p < 1 || p > totalPages || p === currentPage) return
    setCurrentPage(p)
    load(p, params)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const toggleSelect = (sc: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(sc)) next.delete(sc); else next.add(sc)
      return next
    })
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

  const allOnPageSelected = useMemo(
    () => items.length > 0 && items.every(i => selected.has(i.shortcode)),
    [items, selected],
  )
  const togglePageAll = () => {
    setSelected(prev => {
      const next = new Set(prev)
      if (allOnPageSelected) {
        items.forEach(i => next.delete(i.shortcode))
      } else {
        items.forEach(i => next.add(i.shortcode))
      }
      return next
    })
  }

  const onCardClick = (r: BenchItem) => {
    if (selectMode) toggleSelect(r.shortcode)
    else navigate(`/bench/${r.shortcode}`)
  }
  const setParamsIfChanged = useCallback((next: BenchFilters) => {
    setParams(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
  }, [])
  const prefetchDetail = (sc: string) => {
    if (selectMode || !sc) return
    prefetchBenchDetailChunk()
    if (prefetchedDetails.has(sc)) return
    prefetchedDetails.add(sc)
    api.detail(sc).catch(() => {})
  }
  const schedulePrefetchDetail = (sc: string) => {
    if (selectMode || !sc || prefetchedDetails.has(sc) || prefetchTimers.has(sc)) return
    const timer = window.setTimeout(() => {
      prefetchTimers.delete(sc)
      prefetchDetail(sc)
    }, 220)
    prefetchTimers.set(sc, timer)
  }
  const cancelPrefetchDetail = (sc: string) => {
    const timer = prefetchTimers.get(sc)
    if (!timer) return
    window.clearTimeout(timer)
    prefetchTimers.delete(sc)
  }

  const bulkDelete = async () => {
    if (selected.size === 0 || deleting) return
    if (!confirm(`선택한 ${selected.size}개 릴스를 DB에서 완전히 삭제할까요?\n분석·댓글·메타데이터·자막 모두 사라집니다.`)) return
    setDeleting(true)
    try {
      const scs = Array.from(selected)
      const res = await api.bulkDeleteReels(scs)
      const msg = res.failed_count > 0
        ? `${res.deleted_count}개 삭제 완료. ${res.failed_count}개 실패.`
        : `${res.deleted_count}개 삭제 완료.`
      alert(msg)
      exitSelectMode()
      load(currentPage, params)
    } catch (e: any) {
      alert(e.message || '삭제 실패')
    }
    setDeleting(false)
  }

  const subtitleParts: string[] = []
  if (stats) {
    subtitleParts.push(`${fmtNum(stats.total_reels)}개`)
    subtitleParts.push(`분석 ${fmtNum(stats.analyzed_count)}`)
    if (total !== stats.total_reels) subtitleParts.push(`필터 ${fmtNum(total)}`)
  }

  return (
    <>
      <div className="page-header">
        <h1>벤치마크</h1>
        <p>{stats ? subtitleParts.join(' · ') : '불러오는 중…'}</p>
      </div>

      <BenchFilterControls onChange={setParamsIfChanged} />

      {canDelete && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap',
        }}>
          {!selectMode ? (
            <button
              type="button"
              onClick={() => setSelectMode(true)}
              style={{
                padding: '6px 12px', fontSize: 12, fontWeight: 600,
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer',
              }}
            >선택</button>
          ) : (
            <>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                {selected.size}개 선택
              </span>
              <button type="button" onClick={togglePageAll} style={{
                padding: '6px 12px', fontSize: 12, border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)',
                color: 'var(--text-secondary)', cursor: 'pointer',
              }}>{allOnPageSelected ? '이 페이지 해제' : '이 페이지 전체'}</button>
              <button
                type="button"
                onClick={bulkDelete}
                disabled={selected.size === 0 || deleting}
                style={{
                  padding: '6px 12px', fontSize: 12, fontWeight: 600,
                  border: '1px solid var(--error)', borderRadius: 'var(--radius-sm)',
                  background: selected.size > 0 ? 'var(--error)' : 'transparent',
                  color: selected.size > 0 ? '#fff' : 'var(--error)',
                  cursor: selected.size > 0 ? 'pointer' : 'not-allowed',
                  opacity: deleting ? 0.5 : 1,
                }}
              >{deleting ? '삭제 중...' : `삭제 (${selected.size})`}</button>
              <button type="button" onClick={exitSelectMode} disabled={deleting} style={{
                padding: '6px 12px', fontSize: 12, border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)',
                color: 'var(--text-secondary)', cursor: 'pointer',
              }}>취소</button>
            </>
          )}
        </div>
      )}

      <div className="reel-grid">
        {items.map(r => {
          const er = engagementRate(r.like_count, r.play_count)
          const checked = selected.has(r.shortcode)
          return (
            <button
              key={r.shortcode}
              type="button"
              className="reel-card"
              onClick={() => onCardClick(r)}
              onMouseEnter={() => schedulePrefetchDetail(r.shortcode)}
              onMouseLeave={() => cancelPrefetchDetail(r.shortcode)}
              onFocus={e => {
                if (e.currentTarget.matches(':focus-visible')) schedulePrefetchDetail(r.shortcode)
              }}
              aria-label={selectMode
                ? `@${r.author || '알 수 없음'} ${checked ? '선택 해제' : '선택'}`
                : `@${r.author || '알 수 없음'} 릴스 분석 보기`}
              aria-pressed={selectMode ? checked : undefined}
              style={selectMode && checked ? {
                outline: '2px solid var(--accent)',
                outlineOffset: -2,
              } : undefined}
            >
              <div style={{ position: 'relative' }}>
                <Thumb
                  src={r.shortcode ? thumbUrl(r.shortcode) : undefined}
                  shortcode={r.shortcode}
                  style={{ width: '100%', aspectRatio: '4/5', objectFit: 'cover', display: 'block', background: 'var(--bg-elevated)' }}
                />
                {r.ad_suitability && (
                  <span className="reel-overlay-tl">{r.ad_suitability}</span>
                )}
                {r.analyzed && (
                  <span className="reel-overlay-tr">분석완료</span>
                )}
                {selectMode && (
                  <span aria-hidden="true" style={{
                    position: 'absolute', top: 8, right: 8,
                    width: 22, height: 22, borderRadius: '50%',
                    border: `2px solid ${checked ? 'var(--accent)' : 'rgba(255,255,255,0.85)'}`,
                    background: checked ? 'var(--accent)' : 'rgba(0,0,0,0.35)',
                    color: '#fff', fontSize: 13, fontWeight: 700, lineHeight: '18px',
                    textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                  }}>{checked ? '✓' : ''}</span>
                )}
              </div>
              <div className="card-info">
                <div className="card-author">@{r.author || '?'}</div>
                <div className="card-stats">
                  <span className="stat-pill">{fmtNum(r.play_count)}</span>
                  <span className="stat-pill">&#9829; {fmtNum(r.like_count)}</span>
                  {er > 0 && <span className="stat-pill">{er}%</span>}
                </div>
                {((r as any).topic || (r as any).ad_format) && (() => {
                  const fc: Record<string, string> = {
                    '광고형': '#10b981', '후기형': '#3b82f6', '정보형': '#a855f7',
                    '브랜딩형': '#ec4899', '유머형': '#f59e0b', '일상형': '#ef4444',
                  }
                  const tc: Record<string, string> = {
                    '패션': '#3b82f6', '여행/숙박': '#0ea5e9', '뷰티': '#ec4899',
                    '푸드': '#f97316', '사업/창업': '#a855f7', '교육/자기계발': '#eab308',
                    '직장/커리어': '#64748b', '반려동물': '#10b981', '부동산': '#92400e',
                  }
                  const fmt = (r as any).ad_format
                  const fmtColor = fmt ? (fc[fmt] || '#6b7280') : '#9ca3af'
                  const topic = (r as any).topic
                  const topicColor = topic ? (tc[topic] || '#6b7280') : '#9ca3af'
                  return (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                      {topic && (
                        <span className="tag-pill tag-pill--small" style={{ background: topicColor, color: '#fff', borderColor: topicColor }}>
                          {topic}{(r as any).topic_detail ? `·${(r as any).topic_detail}` : ''}
                        </span>
                      )}
                      {fmt ? (
                        <span className="tag-pill tag-pill--small" style={{ background: fmtColor, color: '#fff', borderColor: fmtColor }}>
                          {fmt}{(r as any).ad_suitability_score != null ? ` ${(r as any).ad_suitability_score}` : ''}
                        </span>
                      ) : (
                        <span className="tag-pill tag-pill--small" style={{ background: 'transparent', color: '#9ca3af', borderColor: '#9ca3af', borderStyle: 'dashed' }}>
                          분석필요
                        </span>
                      )}
                    </div>
                  )
                })()}
              </div>
            </button>
          )
        })}
      </div>

      {loading && (
        <div className="empty-state" role="status" aria-live="polite">불러오는 중…</div>
      )}
      {!loading && items.length === 0 && (
        <div className="empty-state">필터 조건에 맞는 릴스가 없습니다</div>
      )}

      {!loading && items.length > 0 && totalPages > 1 && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          total={total}
          onChange={goPage}
        />
      )}
    </>
  )
}
