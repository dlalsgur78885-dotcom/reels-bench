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

/**
 * pptx10 슬라이드 13 (확장) — 진짜 별도 BrowserWindow 에 PreviewCanvas
 * 만 띄움. main window 밖, 다른 모니터로도 이동 가능. URL 에
 * `?previewOnly=1` query 부착 → renderer 가 그 mode 면 PreviewCanvas
 * 전용 화면 render. 두 window 의 zustand store 는 BroadcastChannel
 * (`app://` 같은 origin) 으로 양방향 sync.
 */
let detachedPreviewWin: BrowserWindow | null = null

export function getDetachedPreviewWindow(): BrowserWindow | null {
  return detachedPreviewWin && !detachedPreviewWin.isDestroyed()
    ? detachedPreviewWin
    : null
}

export function openDetachedPreviewWindow(): BrowserWindow {
  if (detachedPreviewWin && !detachedPreviewWin.isDestroyed()) {
    detachedPreviewWin.focus()
    return detachedPreviewWin
  }
  const preloadPath = join(__dirname, '../preload/index.js')
  const win = new BrowserWindow({
    width: 480,
    height: 854,
    minWidth: 200,
    minHeight: 200,
    show: false,
    backgroundColor: '#000000',
    title: '플레이어 — 분리됨',
    parent: BrowserWindow.getFocusedWindow() ?? undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: true
    }
  })
  win.removeMenu()
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { detachedPreviewWin = null })

  const url = process.env.ELECTRON_RENDERER_URL ?? getRendererLoadUrl()
  const sep = url.includes('?') ? '&' : '?'
  void win.loadURL(`${url}${sep}previewOnly=1`)

  detachedPreviewWin = win
  return win
}

export function closeDetachedPreviewWindow(): void {
  if (detachedPreviewWin && !detachedPreviewWin.isDestroyed()) {
    detachedPreviewWin.close()
  }
  detachedPreviewWin = null
}
