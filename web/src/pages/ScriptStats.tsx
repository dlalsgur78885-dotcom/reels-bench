import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'

export default function ScriptStats() {
  const [days, setDays] = useState(30)
  const [metric, setMetric] = useState<'saved' | 'completed'>('saved')
  const [data, setData] = useState<Awaited<ReturnType<typeof api.adminScriptStats>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true); setError('')
    api.adminScriptStats(days, metric)
      .then(setData)
      .catch(e => setError(e.message || '불러오기 실패'))
      .finally(() => setLoading(false))
  }, [days, metric])

  const maxCount = useMemo(() => {
    if (!data) return 0
    let m = 0
    for (const u of data.users)
      for (const k of Object.keys(u.by_date || {}))
        m = Math.max(m, u.by_date[k])
    return m
  }, [data])

  const cellColor = (n: number) => {
    if (!n) return 'var(--bg-elevated)'
    const ratio = Math.min(1, n / Math.max(1, maxCount))
    // 연한 초록 → 진한 초록
    const alpha = 0.15 + ratio * 0.7
    return `rgba(34, 197, 94, ${alpha.toFixed(2)})`
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 16, fontWeight: 700 }}>📊 대본 통계 (사용자 × 날짜)</h3>
        {/* metric 토글 */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
          {(['saved', 'completed'] as const).map(m => (
            <button key={m} onClick={() => setMetric(m)}
              style={{
                padding: '4px 10px', fontSize: 12, fontWeight: metric === m ? 700 : 500,
                background: metric === m ? 'var(--accent)' : 'var(--bg-surface)',
                color: metric === m ? '#fff' : 'var(--text-body)',
                border: 'none', cursor: 'pointer',
              }}>
              {m === 'saved' ? '💾 저장됨' : '✅ 생성 완료'}
            </button>
          ))}
        </div>
        <select value={days} onChange={e => setDays(Number(e.target.value))}
          style={{ padding: '4px 8px', fontSize: 12, borderRadius: 4,
            border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-body)' }}>
          <option value={7}>최근 7일</option>
          <option value={14}>최근 14일</option>
          <option value={30}>최근 30일</option>
          <option value={60}>최근 60일</option>
          <option value={90}>최근 90일</option>
        </select>
      </div>

      {loading && <div style={{ color: 'var(--text-muted)' }}>불러오는 중…</div>}
      {error && <div style={{ color: 'var(--error)' }}>{error}</div>}

      {!loading && data && (
        <>
          {data.users.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', padding: 30, textAlign: 'center',
              background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border)' }}>
              해당 기간 저장된 대본 없음.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', background: 'var(--bg-surface)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 12 }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', left: 0, background: 'var(--bg-surface)',
                      textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--border)',
                      fontWeight: 700, color: 'var(--text-secondary)', minWidth: 140, zIndex: 1 }}>
                      사용자
                    </th>
                    <th style={{ position: 'sticky', left: 140, background: 'var(--bg-surface)',
                      textAlign: 'right', padding: '6px 10px', borderBottom: '1px solid var(--border)',
                      fontWeight: 700, color: 'var(--text-secondary)', minWidth: 50, zIndex: 1 }}>
                      합계
                    </th>
                    {data.date_range.map(d => {
                      const [, m, dd] = d.split('-')
                      return (
                        <th key={d} title={d} style={{
                          padding: '6px 4px', borderBottom: '1px solid var(--border)',
                          fontWeight: 600, color: 'var(--text-muted)', minWidth: 26,
                          fontSize: 9, writingMode: 'horizontal-tb',
                        }}>
                          {m}/{dd}
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {data.users.map(u => (
                    <tr key={u.user_id}>
                      <td style={{ position: 'sticky', left: 0, background: 'var(--bg-surface)',
                        padding: '6px 10px', fontWeight: 600, color: 'var(--text-primary)',
                        borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap', zIndex: 1 }}>
                        {u.display_name || u.email || u.user_id.substring(0, 8)}
                        {u.display_name && u.email && (
                          <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400 }}>{u.email}</div>
                        )}
                      </td>
                      <td style={{ position: 'sticky', left: 140, background: 'var(--bg-surface)',
                        padding: '6px 10px', textAlign: 'right', fontWeight: 700,
                        color: 'var(--accent)', borderBottom: '1px solid var(--border-subtle)', zIndex: 1 }}>
                        {u.total}
                      </td>
                      {data.date_range.map(d => {
                        const n = (u.by_date || {})[d] || 0
                        return (
                          <td key={d} title={`${d}: ${n}건`} style={{
                            padding: 0, textAlign: 'center',
                            background: cellColor(n),
                            borderBottom: '1px solid var(--border-subtle)',
                            color: n ? '#000' : 'transparent', fontWeight: 700, fontSize: 10,
                            width: 26, height: 22,
                          }}>
                            {n || ''}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-muted)' }}>
                {metric === 'saved'
                  ? '· 합계: 해당 기간 저장된 대본 수 · 삭제된(archived) 대본 제외'
                  : '· 합계: 해당 기간 성공한 생성 횟수 (저장 안 해도 포함) · 실패한 generation 제외'}
                {' · 색 농도 = 해당일 건수 · 기준시간: KST'}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
