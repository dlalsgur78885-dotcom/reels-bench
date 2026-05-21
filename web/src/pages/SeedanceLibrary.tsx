import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, authedFetch } from '../api'
import type { MyProduct, CharacterGroup } from '../api'
import { useMe } from '../auth'
import SeedanceShareModal from '../components/SeedanceShareModal'
import SeedanceGroupShareModal from '../components/SeedanceGroupShareModal'
import UspTagPicker, { type UspLink } from '../components/UspTagPicker'
import CharacterGroupModal from '../components/CharacterGroupModal'

type Video = {
  id: string
  name: string | null
  prompt: string | null
  video_url: string
  source_blog_url: string | null
  start_image_url: string | null
  end_image_url: string | null
  resolution: string | null
  duration: string | null
  aspect_ratio: string | null
  generate_audio: boolean | null
  created_at: string
  created_by?: string
  meta: any
  usp_links?: UspLink[]
  _shared?: boolean
  _permission?: 'view' | 'edit'
  _creator_name?: string
  _creator_email?: string
}

const UNCLASSIFIED = '__unclassified__'

export default function SeedanceLibrary() {
  const navigate = useNavigate()
  const me = useMe()
  const [videos, setVideos] = useState<Video[]>([])
  const [products, setProducts] = useState<MyProduct[]>([])
  const [charGroups, setCharGroups] = useState<CharacterGroup[]>([])
  const [characters, setCharacters] = useState<Array<{ id: string; name: string | null; image_url: string | null }>>([])
  // 인물 그룹 필터: null=전체, '__none__'=미지정, 그 외 = character_group id
  const [charGroupFilter, setCharGroupFilter] = useState<string | null>(null)
  // 인물 그룹 생성/수정 모달 — null=닫힘, {}=신규, {id..}=수정
  const [charGroupModal, setCharGroupModal] = useState<
    { id: string; name: string; character_id: string | null } | 'new' | null>(null)
  const [shareModalFor, setShareModalFor] = useState<Video | null>(null)
  const [groupShareModalFor, setGroupShareModalFor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Video | null>(null)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  // 그룹 필터: null = 전체, '__unclassified__' = 미분류, 그 외 = 그룹명
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  // 새로 생성했지만 아직 어떤 영상에도 할당되지 않은 그룹 (만들자마자 chip으로 보이도록 임시 유지)
  const [pendingGroups, setPendingGroups] = useState<string[]>([])
  // 그룹 picker가 열린 카드 id
  const [groupPickerVid, setGroupPickerVid] = useState<string | null>(null)
  // 카드의 overflow:hidden을 피하기 위해 viewport 기준 좌표로 picker 표시
  const [pickerCoords, setPickerCoords] = useState<{ top: number; left: number } | null>(null)
  // 상세 패널의 "변경" picker 열림 상태
  const [detailPickerOpen, setDetailPickerOpen] = useState(false)
  const [newGroupInput, setNewGroupInput] = useState('')
  const [savingMetaId, setSavingMetaId] = useState<string | null>(null)
  const pickerCloseRef = useRef<(() => void) | null>(null)

  useEffect(() => { load() }, [])
  useEffect(() => { api.listMyProducts().then(setProducts).catch(() => {}) }, [])
  useEffect(() => {
    api.listCharacterGroups().then(setCharGroups).catch(() => {})
    api.listSeedanceCharacters().then(setCharacters).catch(() => {})
  }, [])

  const loadCharGroups = () => api.listCharacterGroups().then(setCharGroups).catch(() => {})

  const getCharGroupId = (v: Video): string => ((v.meta?.character_group_id || '') as string).trim()
  const charGroupName = (id: string): string =>
    charGroups.find(g => g.id === id)?.name || '(삭제된 그룹)'

  const updateVideoCharGroup = async (v: Video, character_group_id: string) => {
    setSavingMetaId(v.id)
    try {
      const r = await authedFetch(`/api/seedance/videos/${v.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_group_id }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const newMeta = { ...(v.meta || {}) }
      if (character_group_id) newMeta.character_group_id = character_group_id
      else delete newMeta.character_group_id
      setVideos(prev => prev.map(x => x.id === v.id ? { ...x, meta: newMeta } : x))
      if (selected?.id === v.id) setSelected({ ...selected, meta: newMeta })
    } catch (e: any) {
      alert('인물 그룹 변경 실패: ' + (e?.message || e))
    } finally {
      setSavingMetaId(null)
    }
  }

  const deleteCharGroup = async (g: CharacterGroup) => {
    if (!confirm(`"${g.name}" 인물 그룹을 삭제할까요? (영상은 미지정으로 바뀜)`)) return
    try {
      await api.deleteCharacterGroup(g.id)
      setCharGroups(prev => prev.filter(x => x.id !== g.id))
      if (charGroupFilter === g.id) setCharGroupFilter(null)
    } catch (e: any) {
      alert('삭제 실패: ' + (e?.message || e))
    }
  }

  // USP 링크 이름 해석 — "상품명 · USP명"
  const uspLinkLabel = (l: UspLink): string => {
    const p = products.find(x => x.id === l.product_id)
    const u = p?.usps?.[l.usp_index - 1]
    return u?.usp || `USP#${l.usp_index}`
  }

  const saveUspLinks = async (v: Video, links: UspLink[]) => {
    await api.setVideoUspLinks(v.id, links)
    setVideos(prev => prev.map(x => x.id === v.id ? { ...x, usp_links: links } : x))
    if (selected?.id === v.id) setSelected({ ...selected, usp_links: links })
  }

  // picker 열려있을 때 document 클릭/스크롤/리사이즈로 닫기 (스크롤 시 좌표가 어긋나므로 닫음)
  useEffect(() => {
    if (!groupPickerVid) return
    const t = setTimeout(() => {
      const close = () => { setGroupPickerVid(null); setPickerCoords(null) }
      document.addEventListener('click', close)
      window.addEventListener('scroll', close, true)
      window.addEventListener('resize', close)
      pickerCloseRef.current = () => {
        document.removeEventListener('click', close)
        window.removeEventListener('scroll', close, true)
        window.removeEventListener('resize', close)
      }
    }, 0)
    return () => {
      clearTimeout(t)
      pickerCloseRef.current?.()
      pickerCloseRef.current = null
    }
  }, [groupPickerVid])

  // 상세 패널 picker는 카드 picker와 별도로 document 클릭으로 닫기
  useEffect(() => {
    if (!detailPickerOpen) return
    let close: (() => void) | null = null
    const t = setTimeout(() => {
      close = () => setDetailPickerOpen(false)
      document.addEventListener('click', close)
    }, 0)
    return () => {
      clearTimeout(t)
      if (close) document.removeEventListener('click', close)
    }
  }, [detailPickerOpen])

  // 선택 영상 바뀌면 picker 닫기
  useEffect(() => { setDetailPickerOpen(false) }, [selected?.id])

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const r = await authedFetch('/api/seedance/videos')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setVideos(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const getGroup = (v: Video): string => ((v.meta?.group_name || '') as string).trim()

  const userGroups = useMemo(() => {
    const s = new Set<string>()
    videos.forEach(v => { const g = getGroup(v); if (g) s.add(g) })
    pendingGroups.forEach(g => s.add(g))
    return Array.from(s).sort()
  }, [videos, pendingGroups])

  const unclassifiedCount = useMemo(
    () => videos.filter(v => !getGroup(v)).length, [videos]
  )
  const groupCount = (g: string) => videos.filter(v => getGroup(v) === g).length

  const filtered = useMemo(() => {
    return videos.filter(v => {
      // 자유 그룹 필터
      if (groupFilter !== null) {
        if (groupFilter === UNCLASSIFIED && getGroup(v)) return false
        if (groupFilter !== UNCLASSIFIED && getGroup(v) !== groupFilter) return false
      }
      // 인물 그룹 필터
      if (charGroupFilter !== null) {
        if (charGroupFilter === '__none__' && getCharGroupId(v)) return false
        if (charGroupFilter !== '__none__' && getCharGroupId(v) !== charGroupFilter) return false
      }
      return true
    })
  }, [videos, groupFilter, charGroupFilter, charGroups])

  const updateGroup = async (v: Video, group_name: string) => {
    setSavingMetaId(v.id)
    try {
      const r = await authedFetch(`/api/seedance/videos/${v.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_name }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const newMeta = { ...(v.meta || {}) }
      const gn = group_name.trim()
      if (gn) newMeta.group_name = gn
      else delete newMeta.group_name
      setVideos(prev => prev.map(x => x.id === v.id ? { ...x, meta: newMeta } : x))
      if (selected?.id === v.id) setSelected({ ...selected, meta: newMeta })
      // 할당된 그룹은 이제 실제 데이터로 존재하므로 pending에서 제거
      if (gn) setPendingGroups(prev => prev.filter(g => g !== gn))
    } catch (e: any) {
      alert('그룹 변경 실패: ' + (e?.message || e))
    } finally {
      setSavingMetaId(null)
    }
  }

  const remove = async (v: Video) => {
    if (!confirm(`"${v.name || v.prompt?.slice(0, 30) || '영상'}" 삭제할까요?`)) return
    try {
      const r = await authedFetch(`/api/seedance/videos/${v.id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setVideos(prev => prev.filter(x => x.id !== v.id))
      if (selected?.id === v.id) setSelected(null)
    } catch (e: any) {
      alert('삭제 실패: ' + (e?.message || e))
    }
  }

  const saveName = async (v: Video) => {
    try {
      const r = await authedFetch(`/api/seedance/videos/${v.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameDraft }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setVideos(prev => prev.map(x => x.id === v.id ? { ...x, name: nameDraft.trim() || null } : x))
      if (selected?.id === v.id) setSelected({ ...selected, name: nameDraft.trim() || null })
      setEditingName(null)
    } catch (e: any) {
      alert('이름 변경 실패: ' + (e?.message || e))
    }
  }

  return (
    <div style={{ maxWidth: 1300, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>영상 라이브러리</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Seedance로 생성·저장한 영상 모음. {videos.length}개 보유 · 현재 보기 {filtered.length}개.
          </p>
        </div>
        <button onClick={() => navigate('/seedance')}
          style={{ padding: '8px 14px', fontSize: 12, fontWeight: 700,
            background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6,
            cursor: 'pointer' }}>
          + 새 영상 생성
        </button>
      </div>

      {/* 그룹 필터 — 칩이 많으면 줄바꿈, 그래도 안 맞으면 가로 스크롤 fallback */}
      {videos.length > 0 && (
        <div style={{
          display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center',
          maxWidth: '100%', overflowX: 'auto',
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginRight: 4, flexShrink: 0 }}>그룹:</span>
          <FilterBtn active={groupFilter === null} onClick={() => setGroupFilter(null)}>
            전체 ({videos.length})
          </FilterBtn>
          <FilterBtn active={groupFilter === UNCLASSIFIED} dashed
            onClick={() => setGroupFilter(UNCLASSIFIED)}>
            미분류 ({unclassifiedCount})
          </FilterBtn>
          {userGroups.map(g => (
            <FilterBtn key={g} active={groupFilter === g}
              onClick={() => setGroupFilter(groupFilter === g ? null : g)}>
              {g} ({groupCount(g)})
            </FilterBtn>
          ))}
          <button type="button"
            onClick={() => {
              const name = prompt('새 그룹 이름:')?.trim()
              if (!name) return
              // 즉시 chip으로 노출, 필터는 자동으로 켜지 않음(빈 그룹이라 혼란스러움).
              // 어느 영상에든 실제 할당되면 pendingGroups에서 자동 제거됨.
              setPendingGroups(prev => prev.includes(name) ? prev : [...prev, name])
            }}
            style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              borderRadius: 6, border: '1px dashed var(--accent)',
              background: 'transparent', color: 'var(--accent)',
              flexShrink: 0, whiteSpace: 'nowrap' }}>
            + 그룹 만들기
          </button>
          {groupFilter && groupFilter !== UNCLASSIFIED && userGroups.includes(groupFilter) && (
            <button type="button"
              onClick={() => setGroupShareModalFor(groupFilter)}
              title={`"${groupFilter}" 그룹 전체를 한 번에 공유 — 이후 추가되는 영상도 자동 inherit`}
              style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                borderRadius: 6, border: '1px solid var(--accent)',
                background: 'var(--accent)', color: '#fff',
                flexShrink: 0, whiteSpace: 'nowrap', marginLeft: 4 }}>
              👥 이 그룹 공유
            </button>
          )}
        </div>
      )}

      {/* 인물 그룹 필터 — 배우 일관성용 (USP 그룹과 별개 축) */}
      {videos.length > 0 && (
        <div style={{
          display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center',
          maxWidth: '100%', overflowX: 'auto',
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginRight: 4, flexShrink: 0 }}>
            인물 그룹:
          </span>
          <FilterBtn active={charGroupFilter === null} onClick={() => setCharGroupFilter(null)}>
            전체
          </FilterBtn>
          <FilterBtn active={charGroupFilter === '__none__'} dashed
            onClick={() => setCharGroupFilter('__none__')}>
            미지정
          </FilterBtn>
          {charGroups.map(g => {
            const active = charGroupFilter === g.id
            const n = videos.filter(v => getCharGroupId(v) === g.id).length
            return (
              <div key={g.id} style={{
                display: 'inline-flex', alignItems: 'stretch', flexShrink: 0,
                borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden',
                background: active ? 'var(--accent)' : 'var(--bg-surface)',
              }}>
                <button type="button"
                  onClick={() => setCharGroupFilter(active ? null : g.id)}
                  title={g.character_name ? `인물: ${g.character_name}` : '인물 미지정'}
                  style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                    border: 'none', background: 'transparent',
                    color: active ? '#fff' : 'var(--text-body)', whiteSpace: 'nowrap' }}>
                  {g.character_image && (
                    <img src={g.character_image} alt=""
                      style={{ width: 14, height: 14, borderRadius: '50%', objectFit: 'cover',
                        verticalAlign: 'middle', marginRight: 4 }} />
                  )}
                  {g.name}{g.character_name ? ` · ${g.character_name}` : ''} ({n})
                </button>
                <button type="button" title="수정"
                  onClick={() => setCharGroupModal({ id: g.id, name: g.name, character_id: g.character_id })}
                  style={{ padding: '4px 6px', fontSize: 10, cursor: 'pointer', border: 'none',
                    borderLeft: '1px solid var(--border)', background: 'transparent',
                    color: active ? '#fff' : 'var(--text-muted)' }}>✎</button>
                <button type="button" title="삭제"
                  onClick={() => deleteCharGroup(g)}
                  style={{ padding: '4px 6px', fontSize: 10, cursor: 'pointer', border: 'none',
                    borderLeft: '1px solid var(--border)', background: 'transparent',
                    color: active ? '#fff' : 'var(--text-muted)' }}>✕</button>
              </div>
            )
          })}
          <button type="button" onClick={() => setCharGroupModal('new')}
            style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              borderRadius: 6, border: '1px dashed var(--accent)',
              background: 'transparent', color: 'var(--accent)',
              flexShrink: 0, whiteSpace: 'nowrap' }}>
            + 인물 그룹
          </button>
        </div>
      )}

      {loading && <div style={{ color: 'var(--text-muted)' }}>불러오는 중…</div>}
      {error && <div style={{ color: 'var(--error)' }}>오류: {error}</div>}
      {!loading && videos.length === 0 && !error && (
        <div style={{ padding: 50, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)',
          background: 'var(--bg-surface)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          저장된 영상이 없습니다. 생성 페이지에서 영상 만든 뒤 "라이브러리에 저장" 하세요.
        </div>
      )}
      {!loading && videos.length > 0 && filtered.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)',
          background: 'var(--bg-surface)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          이 필터에 해당하는 영상이 없습니다.
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: selected ? '1fr 1.4fr' : '1fr', gap: 16,
      }}>
        {filtered.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: selected ? 'repeat(auto-fill, minmax(160px, 1fr))' : 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 10,
          }}>
            {filtered.map(v => {
              const g = getGroup(v)
              const isOpen = groupPickerVid === v.id
              return (
                <div key={v.id}
                  style={{
                    background: 'var(--bg-surface)',
                    border: `1.5px solid ${selected?.id === v.id ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 8, overflow: 'hidden',
                  }}>
                  <video src={v.video_url} muted loop
                    onClick={() => setSelected(v)}
                    onMouseEnter={e => (e.currentTarget as HTMLVideoElement).play().catch(() => {})}
                    onMouseLeave={e => { const el = e.currentTarget as HTMLVideoElement; el.pause(); el.currentTime = 0 }}
                    style={{ width: '100%', aspectRatio: aspectStyle(v.aspect_ratio), background: '#000',
                      display: 'block', objectFit: 'cover', cursor: 'pointer' }}
                    preload="metadata" />
                  <div style={{ padding: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.3, flex: 1,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        cursor: 'pointer' }}
                        onClick={() => setSelected(v)}>
                        {v.name || v.prompt?.slice(0, 40) || '제목 없음'}
                      </div>
                      {(v.usp_links || []).length > 0 && (
                        <span title={`USP ${(v.usp_links || []).length}개 연결`}
                          style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, padding: '1px 5px',
                            borderRadius: 3, background: 'var(--accent)', color: '#fff' }}>
                          USP {(v.usp_links || []).length}
                        </span>
                      )}
                    </div>
                    {getCharGroupId(v) && (
                      <div style={{ marginTop: 3 }}>
                        <span title="인물 그룹"
                          style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px',
                            borderRadius: 3, background: 'var(--accent-light)', color: 'var(--accent)' }}>
                          🎭 {charGroupName(getCharGroupId(v))}
                        </span>
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, marginBottom: 6,
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                      <span>{v.resolution || '?'} · {v.duration || '?'}s · {v.aspect_ratio || ''}</span>
                      {v._shared && (
                        <span title={`${v._creator_name || v._creator_email || ''} 공유`}
                          style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                            background: 'var(--accent-light)', color: 'var(--accent)',
                            border: '1px solid var(--accent)' }}>
                          공유받음
                        </span>
                      )}
                    </div>
                    {/* 그룹 picker — 카드의 overflow:hidden 회피 위해 position:fixed로 viewport 기준 표시.
                        공유받은 영상(_shared)은 그룹 변경 불가 — 그룹은 owner의 분류이고 받는 쪽이 변경하면
                        group share inherit 효과가 깨짐. 따라서 읽기 전용 표시. */}
                    <div>
                      {v._shared ? (
                        g ? (
                          <span title="공유받은 영상의 그룹은 변경할 수 없습니다 (소유자의 분류)"
                            style={{
                              display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '2px 8px',
                              background: 'var(--accent-light)', color: 'var(--accent)',
                              border: '1px solid var(--border)', borderRadius: 4,
                            }}>{g}</span>
                        ) : null
                      ) : (
                        <button type="button"
                          disabled={savingMetaId === v.id}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (isOpen) {
                              setGroupPickerVid(null)
                              setPickerCoords(null)
                            } else {
                              const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                              setPickerCoords({ top: r.bottom + 4, left: r.left })
                              setGroupPickerVid(v.id)
                              setNewGroupInput('')
                            }
                          }}
                          style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 8px',
                            background: g ? 'var(--accent-light)' : 'transparent',
                            color: g ? 'var(--accent)' : 'var(--text-muted)',
                            border: `1px ${g ? 'solid' : 'dashed'} var(--border)`,
                            borderRadius: 4, cursor: 'pointer',
                            opacity: savingMetaId === v.id ? 0.5 : 1,
                          }}>
                          {g || '+ 그룹'}
                        </button>
                      )}
                      {isOpen && pickerCoords && (
                        <div onClick={e => e.stopPropagation()}
                          style={{
                            position: 'fixed', top: pickerCoords.top, left: pickerCoords.left,
                            minWidth: 200, zIndex: 1000,
                            background: 'var(--bg-surface)', border: '1px solid var(--border)',
                            borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.16)',
                            padding: 6,
                          }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
                            padding: '4px 8px' }}>그룹 선택</div>
                          <button type="button"
                            onClick={() => { updateGroup(v, ''); setGroupPickerVid(null) }}
                            style={pickerItemSt(!g)}>미분류</button>
                          {userGroups.map(gn => (
                            <button key={gn} type="button"
                              onClick={() => { updateGroup(v, gn); setGroupPickerVid(null) }}
                              style={pickerItemSt(g === gn)}>{gn}</button>
                          ))}
                          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input type="text"
                                value={newGroupInput}
                                onChange={e => setNewGroupInput(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    const val = newGroupInput.trim()
                                    if (val) { updateGroup(v, val); setGroupPickerVid(null) }
                                  }
                                }}
                                placeholder="새 그룹 이름"
                                style={{ flex: 1, padding: '4px 6px', fontSize: 11,
                                  border: '1px solid var(--border)', borderRadius: 4,
                                  background: 'var(--bg-base)', color: 'var(--text-body)' }} />
                              <button type="button"
                                disabled={!newGroupInput.trim()}
                                onClick={() => {
                                  const val = newGroupInput.trim()
                                  if (val) { updateGroup(v, val); setGroupPickerVid(null) }
                                }}
                                style={{
                                  padding: '4px 10px', fontSize: 11, fontWeight: 600,
                                  background: 'var(--accent)', color: '#fff', border: 'none',
                                  borderRadius: 4, cursor: newGroupInput.trim() ? 'pointer' : 'not-allowed',
                                  opacity: newGroupInput.trim() ? 1 : 0.5,
                                }}>+</button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {selected && (
          <div style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 14, alignSelf: 'start',
            position: 'sticky', top: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              {editingName === selected.id ? (
                <div style={{ display: 'flex', gap: 6, flex: 1, marginRight: 8 }}>
                  <input value={nameDraft} onChange={e => setNameDraft(e.target.value)} autoFocus
                    onKeyDown={e => { if (e.key === 'Enter') saveName(selected) }}
                    style={{ flex: 1, padding: '4px 8px', fontSize: 13, fontWeight: 700,
                      border: '1px solid var(--accent)', borderRadius: 4,
                      background: 'var(--bg-base)', color: 'var(--text-primary)' }} />
                  <button onClick={() => saveName(selected)} style={smBtn}>저장</button>
                  <button onClick={() => setEditingName(null)} style={smBtnGhost}>취소</button>
                </div>
              ) : (
                <strong style={{ fontSize: 14, flex: 1 }}>
                  {selected.name || selected.prompt?.slice(0, 50) || '제목 없음'}
                  <button onClick={() => { setEditingName(selected.id); setNameDraft(selected.name || '') }}
                    style={{ marginLeft: 8, fontSize: 10, color: 'var(--accent)', background: 'none',
                      border: 'none', cursor: 'pointer' }}>✎</button>
                </strong>
              )}
              <button onClick={() => setSelected(null)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--text-muted)', fontSize: 18 }}>×</button>
            </div>

            <video src={selected.video_url} controls autoPlay loop
              style={{ width: '100%', borderRadius: 8, background: '#000', marginBottom: 10 }} />

            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
              {selected.resolution || '?'} · {selected.duration || '?'}s · {selected.aspect_ratio || ''} ·
              {selected.generate_audio ? ' 오디오 O' : ' 오디오 X'} · {new Date(selected.created_at).toLocaleString('ko-KR')}
            </div>

            <div style={{ marginBottom: 10 }}>
              <Label>그룹</Label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', position: 'relative' }}>
                <span style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4,
                  background: getGroup(selected) ? 'var(--accent-light)' : 'transparent',
                  color: getGroup(selected) ? 'var(--accent)' : 'var(--text-muted)',
                  border: `1px ${getGroup(selected) ? 'solid' : 'dashed'} var(--border)` }}>
                  {getGroup(selected) || '미분류'}
                </span>
                {!selected._shared && (
                  <button onClick={(e) => {
                    e.stopPropagation()
                    setDetailPickerOpen(v => !v)
                    setNewGroupInput('')
                  }}
                    style={{ ...smBtnGhost, padding: '4px 10px' }}>변경</button>
                )}
                {selected._shared && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}
                    title="공유받은 영상의 그룹은 변경할 수 없습니다 (소유자의 분류)">
                    🔒 소유자만 변경
                  </span>
                )}
                {!selected._shared && detailPickerOpen && (
                  <div onClick={e => e.stopPropagation()}
                    style={{
                      position: 'absolute', top: '100%', left: 0, marginTop: 4,
                      minWidth: 220, zIndex: 100,
                      background: 'var(--bg-surface)', border: '1px solid var(--border)',
                      borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.16)',
                      padding: 6,
                    }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', padding: '4px 8px' }}>
                      그룹 선택
                    </div>
                    <button type="button"
                      onClick={() => { updateGroup(selected, ''); setDetailPickerOpen(false) }}
                      style={pickerItemSt(!getGroup(selected))}>미분류</button>
                    {userGroups.map(gn => (
                      <button key={gn} type="button"
                        onClick={() => { updateGroup(selected, gn); setDetailPickerOpen(false) }}
                        style={pickerItemSt(getGroup(selected) === gn)}>{gn}</button>
                    ))}
                    <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input type="text"
                          value={newGroupInput}
                          onChange={e => setNewGroupInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              const val = newGroupInput.trim()
                              if (val) { updateGroup(selected, val); setDetailPickerOpen(false) }
                            }
                          }}
                          placeholder="새 그룹 이름"
                          style={{ flex: 1, padding: '4px 6px', fontSize: 11,
                            border: '1px solid var(--border)', borderRadius: 4,
                            background: 'var(--bg-base)', color: 'var(--text-body)' }} />
                        <button type="button"
                          disabled={!newGroupInput.trim()}
                          onClick={() => {
                            const val = newGroupInput.trim()
                            if (val) { updateGroup(selected, val); setDetailPickerOpen(false) }
                          }}
                          style={{
                            padding: '4px 10px', fontSize: 11, fontWeight: 600,
                            background: 'var(--accent)', color: '#fff', border: 'none',
                            borderRadius: 4, cursor: newGroupInput.trim() ? 'pointer' : 'not-allowed',
                            opacity: newGroupInput.trim() ? 1 : 0.5,
                          }}>+</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <Label>인물 그룹</Label>
              {selected._shared ? (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {getCharGroupId(selected) ? charGroupName(getCharGroupId(selected)) : '미지정'}
                </span>
              ) : (
                <select
                  value={getCharGroupId(selected)}
                  onChange={e => updateVideoCharGroup(selected, e.target.value)}
                  disabled={savingMetaId === selected.id}
                  style={{ width: '100%', padding: '6px 8px', fontSize: 12,
                    border: '1px solid var(--border)', borderRadius: 6,
                    background: 'var(--bg-base)', color: 'var(--text-body)' }}>
                  <option value="">— 미지정 —</option>
                  {charGroups.map(g => (
                    <option key={g.id} value={g.id}>
                      {g.name}{g.character_name ? ` · ${g.character_name}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div style={{ marginBottom: 10 }}>
              <Label>연결된 USP</Label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {(selected.usp_links || []).length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>연결된 USP 없음</span>
                ) : (
                  (selected.usp_links || []).map((l, i) => (
                    <span key={i}
                      style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 10,
                        background: 'var(--accent-light)', color: 'var(--accent)' }}>
                      {uspLinkLabel(l)}
                    </span>
                  ))
                )}
                {!selected._shared && (
                  <UspTagPicker
                    links={selected.usp_links || []}
                    products={products}
                    label="USP 편집"
                    onSave={(links) => saveUspLinks(selected, links)}
                  />
                )}
              </div>
            </div>

            {selected.prompt && (
              <div style={{ marginBottom: 10 }}>
                <Label>프롬프트</Label>
                <div style={metaBox}>{selected.prompt}</div>
              </div>
            )}

            {selected.source_blog_url && (
              <div style={{ marginBottom: 10 }}>
                <Label>원본 블로그</Label>
                <a href={selected.source_blog_url} target="_blank" rel="noopener noreferrer"
                  style={{ ...metaBox, color: 'var(--accent)', display: 'block', textDecoration: 'none',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selected.source_blog_url}
                </a>
              </div>
            )}

            {(selected.start_image_url || selected.end_image_url) && (
              <div style={{ marginBottom: 10 }}>
                <Label>입력 이미지</Label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {selected.start_image_url && (
                    <img src={selected.start_image_url} alt="start"
                      style={{ width: '50%', aspectRatio: '1', objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }} />
                  )}
                  {selected.end_image_url && (
                    <img src={selected.end_image_url} alt="end"
                      style={{ width: '50%', aspectRatio: '1', objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }} />
                  )}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <a href={selected.video_url} download target="_blank" rel="noopener noreferrer"
                style={{ ...smBtn, textDecoration: 'none' }}>↓ 다운로드</a>
              <button onClick={() => { navigator.clipboard.writeText(selected.video_url); alert('URL 복사됨') }}
                style={smBtnGhost}>URL 복사</button>
              {!selected._shared && me && selected.created_by === me.id && (
                <button onClick={() => setShareModalFor(selected)} style={smBtnGhost}>👥 공유</button>
              )}
              {!selected._shared && (
                <button onClick={() => remove(selected)}
                  style={{ ...smBtnGhost, color: 'var(--error)', borderColor: 'var(--error)' }}>
                  삭제
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {shareModalFor && (
        <SeedanceShareModal
          resourceType="videos"
          resourceId={shareModalFor.id}
          resourceLabel={shareModalFor.name || shareModalFor.prompt?.slice(0, 40) || '제목 없음'}
          onClose={() => setShareModalFor(null)}
        />
      )}

      {groupShareModalFor && (
        <SeedanceGroupShareModal
          groupName={groupShareModalFor}
          videoCount={videos.filter(v => ((v.meta?.group_name || '') as string).trim() === groupShareModalFor).length}
          onClose={() => setGroupShareModalFor(null)}
        />
      )}

      {charGroupModal && (
        <CharacterGroupModal
          initial={charGroupModal === 'new' ? null : charGroupModal}
          characters={characters}
          onClose={() => setCharGroupModal(null)}
          onSave={async (name, characterId) => {
            if (charGroupModal === 'new') {
              await api.createCharacterGroup(name, characterId)
            } else {
              await api.updateCharacterGroup(charGroupModal.id, name, characterId)
            }
            await loadCharGroups()
          }}
        />
      )}
    </div>
  )
}

function aspectStyle(ar: string | null): string {
  if (!ar || ar === 'auto') return '16/9'
  const m = ar.match(/^(\d+):(\d+)$/)
  if (m) return `${m[1]}/${m[2]}`
  return '16/9'
}

function pickerItemSt(active: boolean): React.CSSProperties {
  return {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '6px 8px', fontSize: 11, fontWeight: active ? 700 : 500,
    background: active ? 'var(--accent-light)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-body)',
    border: 'none', borderRadius: 4, cursor: 'pointer',
  }
}

const smBtn: React.CSSProperties = {
  padding: '6px 12px', fontSize: 11, fontWeight: 700,
  background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4,
  cursor: 'pointer',
}
const smBtnGhost: React.CSSProperties = {
  padding: '6px 12px', fontSize: 11, fontWeight: 600,
  background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
}
const metaBox: React.CSSProperties = {
  padding: '6px 10px', fontSize: 12, lineHeight: 1.5,
  background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 4,
  color: 'var(--text-body)',
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)',
      marginBottom: 4, letterSpacing: '0.02em' }}>{children}</div>
  )
}

function FilterBtn({ children, active, onClick, dashed }: {
  children: React.ReactNode; active: boolean; onClick: () => void; dashed?: boolean;
}) {
  return (
    <button type="button" onClick={onClick}
      style={{
        padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
        borderRadius: 6, flexShrink: 0, whiteSpace: 'nowrap',
        border: `1px ${dashed ? 'dashed' : 'solid'} var(--border)`,
        background: active ? 'var(--accent)' : 'var(--bg-surface)',
        color: active ? '#fff' : 'var(--text-body)',
      }}>{children}</button>
  )
}
