/**
 * Phase 4.7 — auto-update wiring.
 *
 * Background flow:
 *   1) `initAutoUpdate(getMainWindow)` runs once at app boot.
 *   2) After a 5-minute delay (so the editor boots cleanly first), the
 *      updater queries the configured generic-provider URL for `latest.yml`.
 *   3) If a newer version is published, electron-updater downloads it in
 *      the background. We forward progress + completion events to the
 *      renderer via `webContents.send`, which displays a non-intrusive
 *      banner with "지금 재시작" / "나중에" actions.
 *   4) If the user chooses "나중에", electron-updater installs the update
 *      on the next app quit (autoInstallOnAppQuit = true).
 *
 * Dev mode (`!app.isPackaged`) is a hard no-op — `initAutoUpdate` returns
 * before touching `electron-updater`, and `installUpdate` returns false.
 * This is important because electron-updater throws hard if asked to run
 * against an unpackaged tree.
 */
import { app, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC_CHANNELS } from '../shared/ipc'
import type {
  UpdateDownloadedPayload,
  UpdateDownloadProgressPayload
} from '../shared/ipc'

const BOOT_DELAY_MS = 5 * 60 * 1000

/** True once we've wired the listeners — guards against double-init. */
let initialized = false

/**
 * Surface the electron-updater log lines through the standard main-process
 * console. electron-updater calls `.info/.warn/.error/.debug` on whatever
 * we hand it. We deliberately avoid pulling in `electron-log` to keep the
 * dependency footprint small for the first cut.
 */
const updaterLogger = {
  info: (...args: unknown[]): void => console.log('[updater]', ...args),
  warn: (...args: unknown[]): void => console.warn('[updater]', ...args),
  error: (...args: unknown[]): void => console.error('[updater]', ...args),
  debug: (..._args: unknown[]): void => {
    /* noisy — drop */
  }
}

function sendToRenderer<T>(
  getMainWindow: () => BrowserWindow | null,
  channel: string,
  payload: T
): void {
  try {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  } catch (err) {
    console.warn('[updater] failed to forward event:', err)
  }
}

export function initAutoUpdate(
  getMainWindow: () => BrowserWindow | null
): void {
  if (initialized) return
  initialized = true

  // Dev / unpackaged builds: electron-updater would throw "dev-app-update.yml
  // not found" and pollute logs. Skip wholesale.
  if (!app.isPackaged) {
    console.log('[updater] skipped (app is not packaged)')
    return
  }

  autoUpdater.logger = updaterLogger
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for update...')
  })

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info.version)
  })

  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] update not available; current:', info.version)
  })

  autoUpdater.on('error', (err) => {
    console.warn('[updater] error:', err?.message ?? err)
  })

  autoUpdater.on('download-progress', (progress) => {
    const payload: UpdateDownloadProgressPayload = {
      percent: Number(progress.percent) || 0,
      transferred: Number(progress.transferred) || 0,
      total: Number(progress.total) || 0,
      bytesPerSecond: Number(progress.bytesPerSecond) || 0
    }
    sendToRenderer(getMainWindow, IPC_CHANNELS.updater.downloadProgress, payload)
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update downloaded:', info.version)
    const payload: UpdateDownloadedPayload = {
      version: info.version,
      releaseNotes:
        typeof info.releaseNotes === 'string'
          ? info.releaseNotes
          : undefined,
      releaseDate: info.releaseDate
    }
    sendToRenderer(getMainWindow, IPC_CHANNELS.updater.downloaded, payload)
  })

  // 5-minute boot delay so the app starts cleanly first. `checkForUpdates`
  // (not the *AndNotify variant) avoids the OS-level toast electron-updater
  // would otherwise pop up — we render our own in-app banner.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[updater] initial check failed:', err?.message ?? err)
    })
  }, BOOT_DELAY_MS)
}

/**
 * Renderer-driven "지금 재시작" handler.
 *
 * Returns false in dev / unpackaged so the renderer can hide the banner
 * without waiting on a quit that will never come. In production this calls
 * `autoUpdater.quitAndInstall()` and returns true; the actual quit fires
 * once the IPC reply has flushed.
 */
export function installUpdate(): boolean {
  if (!app.isPackaged) {
    console.log('[updater] installUpdate ignored (app is not packaged)')
    return false
  }
  // isUpdaterActive=true, isSilent=true so we don't pop a native dialog —
  // forceRunAfter=true so the app restarts after install instead of just
  // closing. These match the documented sensible defaults for "user clicked
  // restart now".
  try {
    autoUpdater.quitAndInstall(true, true)
    return true
  } catch (err) {
    console.error('[updater] quitAndInstall failed:', err)
    return false
  }
}
