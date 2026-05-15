import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, thumbUrl } from '../api'
import type { Channel, UserAnalysis } from '../api'
import { engagementRate, fmtNum } from '../utils'
import Thumb from '../components/Thumb'

function parseInstagramUser(value: string) {
  const raw = value.trim()
  if (!raw) return ''
  const withoutQuery = raw.split('?')[0].split('#')[0].replace(/\/+$/, '')
  const parts = withoutQuery.split('/').filter(Boolean)
  const last = parts[parts.length - 1] || withoutQuery
  const username = last.replace(/^@/, '').replace(/[^A-Za-z0-9._]/g, '')
  return ['reel', 'p', 'stories', 'explore'].includes(username.toLowerCase()) ? '' : username
}

const CHANNELS_CACHE = 'channels_list_cache'
const ANALYSIS_CACHE_PREFIX = 'channels_analysis_cache:'
function loadCh(): Channel[] | null {
  try {
    const raw = sessionStorage.getItem(CHANNELS_CACHE)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function saveCh(v: Channel[]) {
  try { sessionStorage.setItem(CHANNELS_CACHE, JSON.stringify(v)) } catch {}
}
function loadAn(u: string): UserAnalysis | null {
  try {
    const raw = sessionStorage.getItem(ANALYSIS_CACHE_PREFIX + u)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function saveAn(u: string, v: UserAnalysis) {
  try { sessionStorage.setItem(ANALYSIS_CACHE_PREFIX + u, JSON.stringify(v)) } catch {}
}

export default function Channels() {
  const cachedCh = loadCh()
  const [channels, setChannels] = useState<Channel[]>(cachedCh || [])
  const [input, setInput] = useState('')
  const [selected, setSelected] = useState('')
  const [analysis, setAnalysis] = useState<UserAnalysis | null>(null)
  const [analysisError, setAnalysisError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState('')
  const [msg, setMsg] = useState('')
  const navigate = useNavigate()

  const username = useMemo(() => parseInstagramUser(input), [input])
  const active = channels.filter(c => c.is_active)

  const loadChannels = () => {
    api.channels().then(list => { setChannels(list); saveCh(list) }).catch(() => {})
  }

  const loadAnalysis = async (name: string) => {
    const user = parseInstagramUser(name)
    if (!user) return
    setSelected(user)
    setMsg('')
    setAnalysisError('')
    // 캐시가 있으면 즉시 표시 + 백그라운드 갱신
    const cached = loadAn(user)
    if (cached) {
      setAnalysis(cached)
      setLoading(false)
    } else {
      setLoading(true)
    }
    try {
      const res = await api.userAnalysis(user, 36)
      setAnalysis(res)
      saveAn(user, res)
    } catch {
      const message = '분석 결과를 불러오지 못했습니다.'
      setAnalysisError(message)
      if (!cached) setMsg(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadChannels()
  }, [])

  useEffect(() => {
    if (selected || !active[0]?.username) return
    const name = active[0].username
    if (loadAn(name)) {
      loadAnalysis(name)
      return
    }
    const timer = window.setTimeout(() => loadAnalysis(name), 500)
    return () => window.clearTimeout(timer)
  }, [channels, selected])

  const handleSubmit = async () => {
    if (!username) return
    setSaving(true)
    setMsg('')
    try {
      await api.addChannel(username)
      await loadAnalysis(username)
      setInput('')
      loadChannels()
      setMsg(`@${username} 계정을 분석 목록에 추가했습니다.`)
    } catch {
      setMsg('계정 추가에 실패했습니다.')
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (ch: Channel) => {
    await api.updateChannel(ch.username, { is_active: !ch.is_active })
    loadChannels()
  }

  const handleDelete = async (ch: Channel) => {
    const name = ch.username
    if (!confirm(`@${name}을 삭제하시겠습니까?`)) return
    setDeleting(String(ch.id))
    setMsg('')
    try {
      const res = await api.deleteChannelById(ch.id)
      if (res.error) {
        alert(`삭제 실패: ${res.error}`)
        return
      }
      if (selected === name) {
        setSelected('')
        setAnalysis(null)
      }
      loadChannels()
      setMsg(`@${name} 계정을 삭제했습니다.`)
    } catch (e) {
      alert('삭제 도중 오류가 발생했습니다.')
    } finally {
      setDeleting('')
    }
  }

  const stats = analysis?.stats

  return (
    <div className="channel-workspace">
      <div className="page-header">
        <h1>유저별 인스타 분석</h1>
        <p>인스타 프로필 링크나 @username을 넣으면 해당 계정의 수집된 릴스와 분석 결과를 계정 단위로 보여줍니다.</p>
      </div>

      <section className="user-lookup">
        <div className="lookup-copy">
          <div className="eyebrow">Instagram Profile</div>
          <h2>계정 링크를 붙여넣고 바로 확인</h2>
          <p>예: https://www.instagram.com/hotelseol 또는 hotelseol</p>
        </div>
        <div className="lookup-form">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="인스타 계정 URL 또는 username"
          />
          <button onClick={handleSubmit} disabled={saving || loading || !username}>
            {saving ? '추가 중' : '분석 보기'}
          </button>
        </div>
      </section>

      {msg && <div className="inline-message">{msg}</div>}

      <div className="channel-grid">
        <aside className="channel-panel">
          <div className="panel-title">저장된 계정</div>
          <div className="channel-list">
            {channels.map(ch => (
              <div key={ch.username} className={`channel-row${selected === ch.username ? ' selected' : ''}`}>
                <button className="channel-select" onClick={() => loadAnalysis(ch.username)}>
                  <span>
                    <strong>@{ch.username}</strong>
                    <small>{ch.reel_count || 0}개 릴스</small>
                  </span>
                  <em>{ch.is_active ? '활성' : '비활성'}</em>
                </button>
                <button
                  className="channel-delete"
                  onClick={() => handleDelete(ch)}
                  disabled={deleting === String(ch.id)}
                  aria-label={`@${ch.username} 삭제`}
                >
                  {deleting === String(ch.id) ? '삭제 중' : '삭제'}
                </button>
              </div>
            ))}
            {!channels.length && <div className="empty-note">아직 저장된 계정이 없습니다.</div>}
          </div>
        </aside>

        <main className="user-result">
          {loading && <div className="result-empty">분석 결과를 불러오는 중...</div>}

          {!loading && analysisError && !analysis && (
            <div className="result-empty error">
              <div>{analysisError}</div>
              {selected && <button onClick={() => loadAnalysis(selected)}>다시 시도</button>}
            </div>
          )}

          {!loading && !analysis && !analysisError && (
            <div className="result-empty">상단에 인스타 링크를 입력하면 유저별 분석 결과가 여기에 표시됩니다.</div>
          )}

          {!loading && analysis && (
            <>
              <div className="user-summary">
                <div>
                  <div className="eyebrow">Selected User</div>
                  <h2>@{analysis.username}</h2>
                  <p>{analysis.insights.summary}</p>
                </div>
                <a href={`https://www.instagram.com/${analysis.username}/`} target="_blank" rel="noopener">
                  Instagram
                </a>
              </div>

              <div className="kpi-row compact">
                <div className="kpi-card">
                  <div className="kpi-label">수집 릴스</div>
                  <div className="kpi-value">{fmtNum(stats?.total_reels)}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">분석 완료</div>
                  <div className="kpi-value">{fmtNum(stats?.analyzed_count)}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">총 조회수</div>
                  <div className="kpi-value">{fmtNum(stats?.total_plays)}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">평균 ER</div>
                  <div className="kpi-value">{stats?.avg_er || 0}%</div>
                </div>
              </div>

              {analysis.insights.top_tags.length > 0 && (
                <div className="tag-strip">
                  {analysis.insights.top_tags.map(t => (
                    <span key={t.tag}>#{t.tag} <b>{t.count}</b></span>
                  ))}
                </div>
              )}

              <div className="result-toolbar">
                <h3>릴스별 분석 결과</h3>
                <span>{analysis.items.length}개 표시</span>
              </div>

              <div className="user-reel-list">
                {analysis.items.map(item => {
                  const er = engagementRate(item.like_count, item.play_count)
                  return (
                    <article key={item.shortcode} className="user-reel-card">
                      <Thumb
                        src={thumbUrl(item.shortcode)}
                        shortcode={item.shortcode}
                      />
                      <div className="reel-analysis-body">
                        <div className="reel-analysis-head">
                          <button onClick={() => navigate(`/bench/${item.shortcode}`)}>{item.shortcode}</button>
                          <span className={item.analyzed ? 'status-ok' : 'status-wait'}>
                            {item.analyzed ? '분석 완료' : '분석 대기'}
                          </span>
                        </div>
                        <div className="metric-line">
                          <span>조회 {fmtNum(item.play_count)}</span>
                          <span>좋아요 {fmtNum(item.like_count)}</span>
                          <span>댓글 {fmtNum(item.comment_count)}</span>
                          {er > 0 && <span>ER {er}%</span>}
                        </div>
                        {item.analysis_excerpt ? (
                          <p>{item.analysis_excerpt}</p>
                        ) : (
                          <p className="muted">아직 분석 요약이 없습니다. 상세 화면에서 릴스 분석을 실행하세요.</p>
                        )}
                        <div className="card-actions">
                          <button onClick={() => navigate(`/bench/${item.shortcode}`)}>상세 보기</button>
                          <a href={item.url} target="_blank" rel="noopener">원본 열기</a>
                        </div>
                      </div>
                    </article>
                  )
                })}
                {!analysis.items.length && (
                  <div className="result-empty">수집된 릴스가 없습니다. 계정은 저장됐고, 수집 작업 이후 결과가 표시됩니다.</div>
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {channels.length > 0 && (
        <div className="manage-list">
          <div className="panel-title">계정 관리</div>
          {channels.map(ch => (
            <div key={ch.username} className="manage-row">
              <span>@{ch.username}</span>
              <small>마지막 수집: {ch.last_collected_at ? new Date(ch.last_collected_at).toLocaleDateString('ko-KR') : '없음'}</small>
              <button onClick={() => toggleActive(ch)}>{ch.is_active ? '비활성화' : '활성화'}</button>
              <button className="danger" onClick={() => handleDelete(ch)} disabled={deleting === String(ch.id)}>
                {deleting === String(ch.id) ? '삭제 중' : '삭제'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
