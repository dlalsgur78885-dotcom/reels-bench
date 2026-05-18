import { app, BrowserWindow, session } from 'electron'
import { createMainWindow } from './window'
import { registerIpcHandlers } from './ipc'
import {
  registerMediaProtocolHandler,
  registerMediaSchemePrivileges
} from './mediaProtocol'

app.setName('Reels Studio')

// Must run BEFORE app.whenReady() — registers the `media://` scheme as
// standard/secure so the renderer can use it for <video>/<audio> srcs.
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
