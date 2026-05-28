/**
 * UpdateStatusPanel — 현재 설치된 앱 버전 표시.
 *
 * Auto-update is intentionally disabled. Users download the latest installer
 * from the web `/editor` page when they want to upgrade, so this panel only
 * answers "which version is currently installed?"
 *
 * Mounted inside the topbar 옵션 popover so it's discoverable but not
 * always on screen.
 */
import { useEffect, useState } from 'react'
import { font, space, text } from '../theme/tokens'

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  padding: `${space[2]}px 0`,
  fontFamily: font.family,
  fontSize: font.size.sm,
  color: text.secondary
}
const noteStyle: React.CSSProperties = {
  fontSize: font.size.xs,
  color: text.muted,
  lineHeight: 1.5
}

export function UpdateStatusPanel(): JSX.Element {
  const [version, setVersion] = useState<string>('—')

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
      </div>
      <div style={noteStyle} data-testid="update-status-manual-note">
        새 버전은 웹 다운로드 페이지에서 설치 파일을 다시 받아 설치합니다.
      </div>
    </div>
  )
}
