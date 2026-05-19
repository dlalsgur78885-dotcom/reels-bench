import { app, BrowserWindow, session } from 'electron'
import { createMainWindow } from './window'
import { registerIpcHandlers } from './ipc'
import { probeFfmpegVersion } from './ffmpeg/binary'
import {
  registerMediaProtocolHandler,
  registerMediaSchemePrivileges
} from './mediaProtocol'

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
  registerIpcHandlers()
  createMainWindow()

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
