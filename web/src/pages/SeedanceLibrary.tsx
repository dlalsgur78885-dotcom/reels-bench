import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authedFetch } from '../api'

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
  meta: any
}

export default function SeedanceLibrary() {
  const navigate = useNavigate()
  const [videos, setVideos] = useState<Video[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Video | null>(null)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')

  useEffect(() => {
    load()
  }, [])

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>영상 라이브러리</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Seedance로 생성·저장한 영상 모음. {videos.length}개 보유.
          </p>
        </div>
        <button onClick={() => navigate('/seedance')}
          style={{ padding: '8px 14px', fontSize: 12, fontWeight: 700,
            background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6,
            cursor: 'pointer' }}>
          + 새 영상 생성
        </button>
      </div>

      {loading && <div style={{ color: 'var(--text-muted)' }}>불러오는 중…</div>}
      {error && <div style={{ color: 'var(--error)' }}>오류: {error}</div>}
      {!loading && videos.length === 0 && !error && (
        <div style={{ padding: 50, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)',
          background: 'var(--bg-surface)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          저장된 영상이 없습니다. 생성 페이지에서 영상 만든 뒤 "라이브러리에 저장" 하세요.
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: selected ? '1fr 1.4fr' : '1fr', gap: 16,
      }}>
        {videos.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: selected ? 'repeat(auto-fill, minmax(160px, 1fr))' : 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 10,
          }}>
            {videos.map(v => (
              <div key={v.id}
                onClick={() => setSelected(v)}
                style={{
                  background: 'var(--bg-surface)',
                  border: `1.5px solid ${selected?.id === v.id ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 8, overflow: 'hidden', cursor: 'pointer',
                }}>
                <video src={v.video_url} muted loop
                  onMouseEnter={e => (e.currentTarget as HTMLVideoElement).play().catch(() => {})}
                  onMouseLeave={e => { const el = e.currentTarget as HTMLVideoElement; el.pause(); el.currentTime = 0 }}
                  style={{ width: '100%', aspectRatio: aspectStyle(v.aspect_ratio), background: '#000',
                    display: 'block', objectFit: 'cover' }}
                  preload="metadata" />
                <div style={{ padding: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.3,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {v.name || v.prompt?.slice(0, 40) || '제목 없음'}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {v.resolution || '?'} · {v.duration || '?'}s · {v.aspect_ratio || ''}
                  </div>
                </div>
              </div>
            ))}
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
              <button onClick={() => remove(selected)}
                style={{ ...smBtnGhost, color: 'var(--error)', borderColor: 'var(--error)' }}>
                삭제
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function aspectStyle(ar: string | null): string {
  if (!ar || ar === 'auto') return '16/9'
  const m = ar.match(/^(\d+):(\d+)$/)
  if (m) return `${m[1]}/${m[2]}`
  return '16/9'
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
