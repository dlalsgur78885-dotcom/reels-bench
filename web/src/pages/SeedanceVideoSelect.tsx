import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, authedFetch } from '../api'
import type { MyProduct } from '../api'
import type { UspLink } from '../components/UspTagPicker'

type Video = {
  id: string
  name: string | null
  prompt: string | null
  video_url: string
  aspect_ratio: string | null
  resolution: string | null
  duration: string | null
  usp_links?: UspLink[]
}
type UspGroup = { id: string; name: string; color: string | null; usp_indexes: number[] }

function aspectStyle(ar: string | null): string {
  if (!ar || ar === 'auto') return '16/9'
  const m = ar.match(/^(\d+):(\d+)$/)
  return m ? `${m[1]}/${m[2]}` : '16/9'
}

// 대본의 USP에 맞춰 영상을 골라 그 대본의 "영상 기획안"으로 저장하는 페이지.
// 진입: /seedance/select?product=<pid>&sid=<scriptId>&usps=<idx,idx>
export default function SeedanceVideoSelect() {
  const navigate = useNavigate()
  const [sp] = useSearchParams()
  const pid = sp.get('product') ? Number(sp.get('product')) : null
  const sid = sp.get('sid') || null
  const uspsParam = (sp.get('usps') || '')
    .split(',').map(s => Number(s.trim())).filter(n => n > 0)

  const [videos, setVideos] = useState<Video[]>([])
  const [products, setProducts] = useState<MyProduct[]>([])
  const [groups, setGroups] = useState<UspGroup[]>([])
  const [scriptTitle, setScriptTitle] = useState('')
  const [uspFilter, setUspFilter] = useState<Set<number>>(new Set(uspsParam))
  const [selected, setSelected] = useState<string[]>([])  // 순서 유지
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const vres = await authedFetch('/api/seedance/videos')
        const vdata = vres.ok ? await vres.json() : []
        setVideos(Array.isArray(vdata) ? vdata : [])
        api.listMyProducts().then(setProducts).catch(() => {})
        if (pid != null) {
          api.listUspGroups(pid).then(setGroups).catch(() => setGroups([]))
        }
        if (pid != null && sid) {
          const cur = await api.getScriptVideos(pid, sid).catch(() => [] as any[])
          setSelected((cur || []).map((v: any) => v.id))
          const scr = await api.getGenScript(pid, sid).catch(() => null)
          if (scr) {
            setScriptTitle(scr.title || '')
            // 쿼리에 usps가 없으면 대본 문장에서 USP index 추출
            if (uspsParam.length === 0) {
              const set = new Set<number>()
              ;(scr.sentences || []).forEach((s: any) => {
                (s.usp_ids || []).forEach((u: number) => { if (u > 0) set.add(u) })
                if (s.primary_usp_id) set.add(s.primary_usp_id)
              })
              setUspFilter(set)
            }
          }
        }
      } catch (e: any) {
        setError(e?.message || String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const product = products.find(p => p.id === pid) || null
  const usps = product?.usps || []

  const uspName = (ui: number) => usps[ui - 1]?.usp || `USP#${ui}`

  const toggleUsp = (ui: number) => setUspFilter(prev => {
    const n = new Set(prev)
    if (n.has(ui)) n.delete(ui); else n.add(ui)
    return n
  })
  const applyGroup = (g: UspGroup) => setUspFilter(prev => {
    if (g.usp_indexes.length === 0) return prev
    const allOn = g.usp_indexes.every(ui => prev.has(ui))
    const n = new Set(prev)
    g.usp_indexes.forEach(ui => { if (allOn) n.delete(ui); else n.add(ui) })
    return n
  })

  const filtered = useMemo(() => {
    if (uspFilter.size === 0) return videos
    return videos.filter(v =>
      (v.usp_links || []).some(l => l.product_id === pid && uspFilter.has(l.usp_index)),
    )
  }, [videos, uspFilter, pid])

  const toggleSelect = (id: string) => setSelected(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  const save = async () => {
    if (pid == null || !sid) return
    setSaving(true)
    try {
      await api.setScriptVideos(pid, sid, selected)
      navigate(`/my-scripts/${pid}/${sid}`)
    } catch (e: any) {
      alert('저장 실패: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  const backTo = pid != null && sid ? `/my-scripts/${pid}/${sid}` : '/seedance/library'

  return (
    <div style={{ maxWidth: 1300, margin: '0 auto', padding: 24 }}>
      <button onClick={() => navigate(backTo)}
        style={{ marginBottom: 12, padding: '5px 12px', fontSize: 12, cursor: 'pointer',
          background: 'transparent', color: 'var(--text-secondary)',
          border: '1px solid var(--border)', borderRadius: 6 }}>
        ← {pid != null && sid ? '대본으로' : '라이브러리로'}
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>영상 선택</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            {scriptTitle ? `대본 "${scriptTitle}"의 ` : ''}영상 기획안 — USP로 필터해 사용할 영상을 고르세요.
            {' '}선택 {selected.length}개 · 보기 {filtered.length}개
          </p>
        </div>
        {pid != null && sid && (
          <button onClick={save} disabled={saving}
            style={{ padding: '8px 16px', fontSize: 13, fontWeight: 700,
              background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6,
              cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? '저장 중…' : `선택 저장 (${selected.length})`}
          </button>
        )}
      </div>

      {/* USP 필터 */}
      {pid != null && (usps.length > 0 || groups.length > 0) && (
        <div style={{ marginBottom: 14, padding: 12, background: 'var(--bg-surface)',
          border: '1px solid var(--border)', borderRadius: 8 }}>
          {groups.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginRight: 6 }}>
                USP 그룹:
              </span>
              {groups.map(g => {
                const allOn = g.usp_indexes.length > 0
                  && g.usp_indexes.every(ui => uspFilter.has(ui))
                return (
                  <button key={g.id} type="button" onClick={() => applyGroup(g)}
                    style={{ marginRight: 6, marginBottom: 4, padding: '3px 10px', fontSize: 11,
                      fontWeight: 700, cursor: 'pointer', borderRadius: 12,
                      border: '1px solid var(--border)',
                      background: allOn ? (g.color || 'var(--accent)') : 'var(--bg-base)',
                      color: allOn ? '#fff' : 'var(--text-body)' }}>
                    {g.name} ({g.usp_indexes.length})
                  </button>
                )
              })}
            </div>
          )}
          <div>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginRight: 6 }}>
              USP:
            </span>
            <button type="button" onClick={() => setUspFilter(new Set())}
              style={{ marginRight: 6, marginBottom: 4, padding: '3px 10px', fontSize: 11,
                fontWeight: 700, cursor: 'pointer', borderRadius: 12,
                border: '1px solid var(--border)',
                background: uspFilter.size === 0 ? 'var(--accent)' : 'var(--bg-base)',
                color: uspFilter.size === 0 ? '#fff' : 'var(--text-body)' }}>
              전체
            </button>
            {usps.map((u, i) => {
              const ui = i + 1
              const on = uspFilter.has(ui)
              return (
                <button key={ui} type="button" onClick={() => toggleUsp(ui)}
                  style={{ marginRight: 6, marginBottom: 4, padding: '3px 10px', fontSize: 11,
                    fontWeight: 700, cursor: 'pointer', borderRadius: 12,
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                    background: on ? 'var(--accent)' : 'var(--bg-base)',
                    color: on ? '#fff' : 'var(--text-body)' }}>
                  {u.usp}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {loading && <div style={{ color: 'var(--text-muted)' }}>불러오는 중…</div>}
      {error && <div style={{ color: 'var(--error)' }}>오류: {error}</div>}
      {!loading && filtered.length === 0 && !error && (
        <div style={{ padding: 40, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)',
          background: 'var(--bg-surface)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          {uspFilter.size > 0
            ? '선택한 USP에 연결된 영상이 없습니다. 영상 라이브러리에서 영상에 USP를 먼저 연결하세요.'
            : '영상이 없습니다.'}
        </div>
      )}

      <div style={{ display: 'grid', gap: 10,
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        {filtered.map(v => {
          const on = selected.includes(v.id)
          const order = selected.indexOf(v.id) + 1
          return (
            <div key={v.id} onClick={() => toggleSelect(v.id)}
              style={{ background: 'var(--bg-surface)', cursor: 'pointer',
                border: `2px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
              <div style={{ position: 'absolute', top: 6, left: 6, zIndex: 2,
                width: 22, height: 22, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700,
                background: on ? 'var(--accent)' : 'rgba(0,0,0,0.5)', color: '#fff' }}>
                {on ? order : ''}
              </div>
              <video src={`${v.video_url}#t=0.1`} muted loop preload="metadata"
                onMouseEnter={e => (e.currentTarget as HTMLVideoElement).play().catch(() => {})}
                onMouseLeave={e => { const el = e.currentTarget as HTMLVideoElement; el.pause(); el.currentTime = 0.1 }}
                style={{ width: '100%', aspectRatio: aspectStyle(v.aspect_ratio),
                  background: '#000', display: 'block', objectFit: 'cover' }} />
              <div style={{ padding: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.3,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {v.name || v.prompt?.slice(0, 40) || '제목 없음'}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  {v.resolution || '?'} · {v.duration || '?'}s
                  {(v.usp_links || []).length > 0 && ` · USP ${(v.usp_links || []).length}`}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
