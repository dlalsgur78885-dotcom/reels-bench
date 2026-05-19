import { app, BrowserWindow, session } from 'electron'
import { createMainWindow } from './window'
import { registerIpcHandlers } from './ipc'
import { probeFfmpegVersion } from './ffmpeg/binary'
import {
  registerMediaProtocolHandler,
  registerMediaSchemePrivileges
} from './mediaProtocol'
import {
  registerAppProtocolHandler,
  registerAppSchemePrivileges
} from './appProtocol'
import { initAutoUpdate } from './auto-update'

app.setName('Reels Studio')

// Windows: set the App User Model ID so taskbar grouping, jump lists, and
// toast notifications attribute to "Reels Studio" rather than electron.exe.
// Must run before `app.whenReady()`. Matches `appId` in electron-builder.json.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.reelsbench.reelsstudio')
}

// Register custom `media://` scheme BEFORE app.whenReady(). Required so that
// renderer-side <video>/<audio> elements with src="media://..." work under
// sandbox:true + contextIsolation:true.
registerMediaSchemePrivileges()
// Register `app://` scheme so the production renderer loads from a non-`file://`
// origin. `file://` triggers Chromium's media-element URL safety check which
// rejects `media://` video/audio sources.
registerAppSchemePrivileges()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

function applySessionHardening(): void {
  const ses = session.defaultSession

  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'X-Content-Type-Options': ['nosniff']
      }
    })
  })
}

app.whenReady().then(() => {
  applySessionHardening()
  registerMediaProtocolHandler()
  registerAppProtocolHandler()
  registerIpcHandlers()
  const mainWin = createMainWindow()

  // Phase 4.7 — kick off background auto-update check. No-op in dev.
  // The getter walks BrowserWindow.getAllWindows() as a fallback so the
  // banner still arrives if the original window was closed/recreated.
  initAutoUpdate(() => {
    if (mainWin && !mainWin.isDestroyed()) return mainWin
    const wins = BrowserWindow.getAllWindows()
    return wins.find((w) => !w.isDestroyed()) ?? null
  })

  // Best-effort: surface the bundled ffmpeg version in main-process logs so
  // future debugging immediately shows which build the app is using. Doesn't
  // block startup — fires & forgets.
  probeFfmpegVersion()
    .then((line) => {
      console.log(`[ffmpeg] bundled: ${line}`)
    })
    .catch((err) => {
      console.warn('[ffmpeg] version probe failed:', err)
    })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault())
})
