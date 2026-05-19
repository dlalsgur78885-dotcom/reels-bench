/**
 * Phase 4.7 — auto-update notification banner.
 *
 * Listens to two preload-bridge events:
 *   - `updater:download-progress` — optional progress while downloading
 *   - `updater:downloaded`        — final "ready to install" state
 *
 * Behaviour:
 *   - While downloading, show a minimal progress bar (top-right).
 *   - When download completes, show a persistent banner with two actions:
 *       "지금 재시작" → calls preload `updater.installNow()`
 *       "나중에"     → dismisses (electron-updater installs on next quit)
 *   - The banner stays hidden in dev because the main process never fires
 *     the events (`!app.isPackaged` guard in `auto-update.ts`).
 *
 * Test affordance: the component looks for a window-level test bridge
 * `window.__reelsUpdater` and exposes the same shape so Playwright can
 * simulate the event without a real download.
 */
import { useEffect, useState } from 'react'
import type {
  UpdateDownloadedPayload,
  UpdateDownloadProgressPayload
} from '../../../shared/ipc'

type BannerState =
  | { kind: 'idle' }
  | {
      kind: 'downloading'
      progress: UpdateDownloadProgressPayload
    }
  | {
      kind: 'downloaded'
      info: UpdateDownloadedPayload
    }

const containerSt: React.CSSProperties = {
  position: 'fixed',
  top: 16,
  right: 16,
  zIndex: 9998, // just below Toast (9999)
  minWidth: 320,
  maxWidth: 420,
  padding: '14px 16px',
  borderRadius: 10,
  background: '#0f1f3a',
  border: '1px solid #1e3a8a',
  color: '#e0e7ff',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontSize: 13,
  lineHeight: 1.45,
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
}

const headlineSt: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 6
}

const subSt: React.CSSProperties = {
  fontSize: 12,
  color: '#a5b4fc',
  marginBottom: 12
}

const btnRowSt: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end'
}

const primaryBtnSt: React.CSSProperties = {
  background: '#2563eb',
  color: '#ffffff',
  border: '1px solid #1d4ed8',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer'
}

const secondaryBtnSt: React.CSSProperties = {
  background: 'transparent',
  color: '#cbd5e1',
  border: '1px solid #334155',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 13,
  cursor: 'pointer'
}

const progressOuterSt: React.CSSProperties = {
  marginTop: 8,
  height: 4,
  background: '#1e293b',
  borderRadius: 2,
  overflow: 'hidden'
}

function progressInnerSt(pct: number): React.CSSProperties {
  return {
    width: `${Math.min(100, Math.max(0, pct))}%`,
    height: '100%',
    background: 'linear-gradient(90deg, #60a5fa, #2563eb)',
    transition: 'width 200ms linear'
  }
}

declare global {
  interface Window {
    /**
     * Test bridge — Playwright pokes these to simulate updater events.
     * Production code never needs to touch it.
     */
    __reelsUpdater?: {
      emitProgress: (p: UpdateDownloadProgressPayload) => void
      emitDownloaded: (info: UpdateDownloadedPayload) => void
      reset: () => void
    }
  }
}

export function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<BannerState>({ kind: 'idle' })
  const [dismissed, setDismissed] = useState(false)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    const updater = window.electron?.updater
    if (!updater) return

    const offProgress = updater.onDownloadProgress((p) => {
      setState((prev) => {
        // Don't downgrade from 'downloaded' back to 'downloading' if a
        // stray progress event arrives after the final one.
        if (prev.kind === 'downloaded') return prev
        return { kind: 'downloading', progress: p }
      })
    })

    const offDownloaded = updater.onDownloaded((info) => {
      setState({ kind: 'downloaded', info })
      setDismissed(false) // re-open if user had dismissed a stale banner
    })

    return () => {
      offProgress()
      offDownloaded()
    }
  }, [])

  // Test bridge — lets E2E simulate the events without a real update.
  useEffect(() => {
    window.__reelsUpdater = {
      emitProgress: (p) => setState({ kind: 'downloading', progress: p }),
      emitDownloaded: (info) => {
        setState({ kind: 'downloaded', info })
        setDismissed(false)
      },
      reset: () => {
        setState({ kind: 'idle' })
        setDismissed(false)
        setInstalling(false)
      }
    }
    return () => {
      delete window.__reelsUpdater
    }
  }, [])

  const handleInstallNow = async (): Promise<void> => {
    if (installing) return
    setInstalling(true)
    try {
      const ok = await window.electron?.updater?.installNow()
      // If dev / unpackaged → installNow returns false; hide the banner so
      // the test bridge can re-trigger cleanly.
      if (!ok) {
        setDismissed(true)
        setInstalling(false)
      }
      // On success, the app is about to quit; nothing else to do.
    } catch (err) {
      console.warn('[update-banner] installNow failed', err)
      setInstalling(false)
    }
  }

  const handleLater = (): void => {
    setDismissed(true)
  }

  if (state.kind === 'idle' || dismissed) return null

  if (state.kind === 'downloading') {
    const pct = state.progress.percent
    return (
      <div style={containerSt} data-testid="update-banner-downloading">
        <div style={headlineSt}>새 버전 다운로드 중…</div>
        <div style={subSt}>{pct.toFixed(0)}% 완료</div>
        <div style={progressOuterSt}>
          <div style={progressInnerSt(pct)} />
        </div>
      </div>
    )
  }

  // state.kind === 'downloaded'
  return (
    <div
      style={containerSt}
      data-testid="update-banner-downloaded"
      role="status"
      aria-live="polite"
    >
      <div style={headlineSt}>
        새 버전 {state.info.version} 다운로드 완료
      </div>
      <div style={subSt}>재시작하면 적용됩니다.</div>
      <div style={btnRowSt}>
        <button
          type="button"
          style={secondaryBtnSt}
          onClick={handleLater}
          data-testid="update-banner-later"
          disabled={installing}
        >
          나중에
        </button>
        <button
          type="button"
          style={primaryBtnSt}
          onClick={handleInstallNow}
          data-testid="update-banner-install-now"
          disabled={installing}
        >
          {installing ? '재시작 중…' : '지금 재시작'}
        </button>
      </div>
    </div>
  )
}
