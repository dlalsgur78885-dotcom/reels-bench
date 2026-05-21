import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'

type Release = Awaited<ReturnType<typeof api.editorLatest>>

function fmtSize(bytes: number | null): string {
  if (!bytes) return ''
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}
function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('ko-KR')
}

// 영상 편집기(Reels Studio 데스크톱 앱) 다운로드 페이지.
export default function DownloadEditor() {
  const navigate = useNavigate()
  const [rel, setRel] = useState<Release | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api.editorLatest()
      .then(setRel)
      .catch(e => setError(e?.message || '릴리스 정보를 불러오지 못했습니다'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <button onClick={() => navigate('/')}
        style={{ marginBottom: 16, padding: '5px 12px', fontSize: 12, cursor: 'pointer',
          background: 'transparent', color: 'var(--text-secondary)',
          border: '1px solid var(--border)', borderRadius: 6 }}>
        ← 홈으로
      </button>

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 28 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🎬</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px' }}>영상 편집기 — Reels Studio</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 20px', lineHeight: 1.6 }}>
          릴스 제작용 데스크톱 영상 편집기입니다. 설치하면 자막·오디오·컷 편집을
          앱 안에서 바로 할 수 있고, 새 버전이 나오면 자동으로 업데이트됩니다.
        </p>

        {loading && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>릴리스 정보 불러오는 중…</div>}

        {error && (
          <div style={{ padding: 16, background: 'var(--bg-base)', borderRadius: 8,
            border: '1px dashed var(--border)', fontSize: 13, color: 'var(--error)' }}>
            {error}
          </div>
        )}

        {rel && (
          <>
            <a href={rel.download_url}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '12px 24px', fontSize: 15, fontWeight: 700,
                background: 'var(--accent)', color: '#fff', borderRadius: 8,
                textDecoration: 'none' }}>
              ⬇ Windows용 다운로드
              {rel.version && (
                <span style={{ fontSize: 12, fontWeight: 500, opacity: 0.85 }}>
                  v{rel.version}
                </span>
              )}
            </a>

            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12,
              display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {rel.version && <span>버전 {rel.version}</span>}
              {rel.size != null && <span>· {fmtSize(rel.size)}</span>}
              {rel.release_date && <span>· {fmtDate(rel.release_date)} 출시</span>}
              <span>· Windows 64-bit</span>
            </div>

            <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>
                설치 방법
              </div>
              <ol style={{ fontSize: 12, color: 'var(--text-body)', lineHeight: 1.8,
                margin: 0, paddingLeft: 18 }}>
                <li>위 버튼으로 설치 파일(.exe)을 다운로드합니다.</li>
                <li>다운로드한 파일을 실행합니다. (Windows SmartScreen 경고가 뜨면
                  "추가 정보 → 실행"을 누르세요.)</li>
                <li>설치가 끝나면 바탕화면/시작 메뉴의 <b>Reels Studio</b>로 실행합니다.</li>
                <li>이후 새 버전은 앱 실행 시 자동으로 업데이트됩니다.</li>
              </ol>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
