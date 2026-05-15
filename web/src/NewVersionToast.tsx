import { useEffect, useState } from 'react'

declare const __BUILD_ID__: string

export function NewVersionToast() {
  const [hasNew, setHasNew] = useState(false)

  useEffect(() => {
    let stopped = false
    const myBuild = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : ''
    if (!myBuild) return

    const check = async () => {
      try {
        const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
        if (!r.ok) return
        const j = await r.json()
        if (j.build_id && j.build_id !== myBuild) {
          setHasNew(true)
        }
      } catch {}
    }

    // 첫 5초 후 + 60초마다
    const t1 = setTimeout(check, 5_000)
    const t2 = setInterval(() => { if (!stopped) check() }, 60_000)
    // 탭 활성화 시에도 즉시 체크
    const onVis = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      stopped = true
      clearTimeout(t1); clearInterval(t2)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  if (!hasNew) return null

  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      background: 'var(--bg-surface)', border: '1px solid var(--accent)',
      borderRadius: 'var(--radius-md)', padding: '14px 18px',
      boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
      display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 320,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
        ✨ 새 버전이 배포됐어요
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        새로고침해서 최신 버전으로 업데이트하세요. (진행 중인 작업은 저장 후 누르세요)
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => window.location.reload()}
          style={{
            flex: 1, padding: '6px 12px', fontSize: 12, fontWeight: 600,
            background: 'var(--accent)', color: '#fff', border: 'none',
            borderRadius: 4, cursor: 'pointer',
          }}>새로고침</button>
        <button onClick={() => setHasNew(false)}
          style={{
            padding: '6px 12px', fontSize: 12,
            background: 'transparent', color: 'var(--text-muted)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
          }}>나중에</button>
      </div>
    </div>
  )
}
