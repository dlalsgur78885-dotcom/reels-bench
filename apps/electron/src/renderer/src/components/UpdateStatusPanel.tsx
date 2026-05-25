/**
 * UpdateStatusPanel — 현재 버전 + "업데이트 확인" 버튼 + 상태 줄.
 *
 * The auto-update background loop already runs (5분 후 자동 체크) and the
 * UpdateBanner pops up when a download completes. This panel adds:
 *   - the current app version (so "이거 어느 버전?"이 답 됨),
 *   - a manual "지금 확인" button so the user doesn't wait 5분,
 *   - a small status line: 최신입니다 / 다운로드 중 / 에러 메시지.
 *
 * Mounted inside the topbar 옵션 popover so it's discoverable but not
 * always on screen.
 */
import { useEffect, useState } from 'react'
import { accent, font, radius, space, surface, text } from '../theme/tokens'

type CheckStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version?: string }
  | { kind: 'not-available'; current?: string }
  | { kind: 'error'; message: string }

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  padding: `${space[2]}px 0`,
  fontFamily: font.family,
  fontSize: font.size.sm,
  color: text.secondary
}
const btnStyle: React.CSSProperties = {
  background: surface[1],
  color: text.primary,
  border: `1px solid ${surface.borderStrong}`,
  borderRadius: radius.md,
  padding: '4px 10px',
  fontSize: font.size.sm,
  cursor: 'pointer',
  fontFamily: font.family
}
const statusStyle = (color: string): React.CSSProperties => ({
  fontSize: font.size.xs,
  color
})

export function UpdateStatusPanel(): JSX.Element {
  const [version, setVersion] = useState<string>('—')
  const [status, setStatus] = useState<CheckStatus>({ kind: 'idle' })

  // Fetch the app version once on mount. Dev mode still returns package.json
  // version so users always see something.
  useEffect(() => {
    const updater = window.electron?.updater
    if (!updater?.getVersion) return
    updater
      .getVersion()
      .then((v) => setVersion(v || '—'))
      .catch(() => setVersion('—'))
  }, [])

  // Subscribe to updater events so the panel reflects background activity
  // even when the user didn't click "지금 확인".
  useEffect(() => {
    const updater = window.electron?.updater
    if (!updater) return
    const offNa = updater.onNotAvailable?.((current) =>
      setStatus({ kind: 'not-available', current })
    )
    const offErr = updater.onError?.((message) =>
      setStatus({ kind: 'error', message })
    )
    const offProg = updater.onDownloadProgress?.(() =>
      setStatus({ kind: 'available' })
    )
    return () => {
      offNa?.()
      offErr?.()
      offProg?.()
    }
  }, [])

  const handleCheck = async (): Promise<void> => {
    const updater = window.electron?.updater
    if (!updater?.checkNow) return
    setStatus({ kind: 'checking' })
    try {
      const result = await updater.checkNow()
      if (result === 'available') setStatus({ kind: 'available' })
      else if (result === 'not-available') setStatus({ kind: 'not-available' })
      else if (result === 'error') setStatus({ kind: 'error', message: '확인 중 오류' })
      else if (result === 'dev-mode')
        setStatus({ kind: 'error', message: '개발 모드 — 패키지 빌드에서만 동작' })
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return (
    <div data-testid="update-status-panel">
      <div style={rowStyle}>
        <span style={{ color: text.muted }}>버전</span>
        <span
          style={{ color: text.primary, fontVariantNumeric: 'tabular-nums' }}
          data-testid="update-status-version"
        >
          {version}
        </span>
        <button
          type="button"
          style={btnStyle}
          onClick={() => void handleCheck()}
          disabled={status.kind === 'checking'}
          data-testid="update-status-check"
        >
          {status.kind === 'checking' ? '확인 중…' : '업데이트 확인'}
        </button>
      </div>
      {status.kind === 'not-available' && (
        <div
          style={statusStyle(accent.green)}
          data-testid="update-status-not-available"
          role="status"
        >
          ✓ 최신 버전입니다
        </div>
      )}
      {status.kind === 'available' && (
        <div
          style={statusStyle(accent.blue)}
          data-testid="update-status-available"
          role="status"
        >
          새 버전 다운로드 중 — 완료 시 알림이 표시됩니다
        </div>
      )}
      {status.kind === 'error' && (
        <div
          style={statusStyle(accent.amber)}
          data-testid="update-status-error"
          role="alert"
          aria-live="assertive"
        >
          ⚠ {status.message}
        </div>
      )}
    </div>
  )
}
