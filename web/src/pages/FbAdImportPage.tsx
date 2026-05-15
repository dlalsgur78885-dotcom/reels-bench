import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'

export default function FbAdImportPage() {
  const navigate = useNavigate()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<Array<{ shortcode: string; page_name?: string; url: string; at: number }>>(() => {
    try {
      const raw = localStorage.getItem('fb_ad_import_history')
      return raw ? JSON.parse(raw) : []
    } catch { return [] }
  })

  const submit = async () => {
    setError('')
    if (!url.trim()) {
      setError('URL을 입력하세요')
      return
    }
    setBusy(true)
    try {
      const r = await api.importFbAd(url.trim(), true)
      const entry = { shortcode: r.shortcode, page_name: r.page_name, url: url.trim(), at: Date.now() }
      const next = [entry, ...history.filter(h => h.shortcode !== r.shortcode)].slice(0, 30)
      setHistory(next)
      try { localStorage.setItem('fb_ad_import_history', JSON.stringify(next)) } catch {}
      setUrl('')
      setBusy(false)
    } catch (e: any) {
      setError(e?.message || '실패')
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, marginBottom: 6 }}>📘 FB 광고 단일 import</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
        FB Ads Library URL 한 개를 가져와 영상 fetch + Whisper STT + 분석 파이프라인 실행.
      </p>

      <section style={{
        padding: 18, background: 'var(--bg-surface)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        marginBottom: 20,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>광고 URL</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
          예: <code>https://www.facebook.com/ads/library/?id=1630277984889002</code>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://www.facebook.com/ads/library/?id=..."
            disabled={busy}
            onKeyDown={e => { if (e.key === 'Enter' && !busy && url.trim()) submit() }}
            style={{
              flex: 1, padding: '10px 14px', fontSize: 14,
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
            }}
          />
          <button onClick={submit} disabled={busy || !url.trim()} style={{
            padding: '10px 22px', fontSize: 14, fontWeight: 600,
            background: 'var(--accent)', color: '#fff', border: 'none',
            borderRadius: 'var(--radius-sm)', cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy || !url.trim() ? 0.6 : 1,
          }}>{busy ? 'Import 중…' : 'Import + 분석'}</button>
        </div>
        {error && (
          <div style={{ marginTop: 10, padding: '8px 12px', fontSize: 12,
            background: 'rgba(239,68,68,0.1)', border: '1px solid var(--error)',
            color: 'var(--error)', borderRadius: 'var(--radius-sm)',
          }}>{error}</div>
        )}
      </section>

      {history.length > 0 && (
        <section style={{
          padding: 18, background: 'var(--bg-surface)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>최근 import ({history.length})</div>
            <button onClick={() => {
              if (!confirm('히스토리 비우기?')) return
              setHistory([])
              try { localStorage.removeItem('fb_ad_import_history') } catch {}
            }} style={{
              padding: '4px 10px', fontSize: 11,
              background: 'transparent', color: 'var(--text-muted)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}>비우기</button>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {history.map(h => (
              <div key={h.shortcode} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '8px 12px', background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
                fontSize: 12,
              }}>
                <code style={{ flexShrink: 0, color: 'var(--accent)', fontWeight: 600 }}>{h.shortcode}</code>
                <span style={{ flex: 1, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {h.page_name || '(광고주 미상)'}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>
                  {new Date(h.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <button
                  onClick={() => navigate(`/bench/${h.shortcode}`)}
                  style={{
                    padding: '4px 12px', fontSize: 11, fontWeight: 600,
                    background: 'var(--accent)', color: '#fff', border: 'none',
                    borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                  }}>분석 보기</button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
