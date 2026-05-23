import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { getRendererLoadUrl } from './appProtocol'

const ALLOWED_EXTERNAL_HOSTS = new Set<string>([
  'supabase.co',
  'vercel.app',
  'github.com'
])

function isAllowedExternal(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    return [...ALLOWED_EXTERNAL_HOSTS].some(
      (host) => u.hostname === host || u.hostname.endsWith(`.${host}`)
    )
  } catch {
    return false
  }
}

export function createMainWindow(): BrowserWindow {
  const preloadPath = join(__dirname, '../preload/index.js')

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#111111',
    title: 'Reels Studio',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Internal-use app — DevTools available in packaged builds too so we
      // can diagnose runtime issues in the field. Ctrl+Shift+I to open.
      devTools: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // TEMP DIAG: pipe renderer console messages to the main-process stderr so
  // the bg log captures them. Also auto-open devtools in dev. Revert when fix is in.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // eslint-disable-next-line no-console
    console.log(`[renderer:${level}] ${sourceId}:${line} — ${message}`)
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.webContents.once('did-finish-load', () => win.webContents.openDevTools({ mode: 'detach' }))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('app://')) return
    event.preventDefault()
    if (isAllowedExternal(url)) void shell.openExternal(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    // Production: load via `app://` so the renderer origin is not `file://`.
    // `file://` triggers Chromium's media URL safety check which rejects
    // `media://` video/audio sources.
    void win.loadURL(getRendererLoadUrl())
  }

  return win
}
