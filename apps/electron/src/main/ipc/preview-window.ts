/**
 * pptx10 슬라이드 13 (확장) — 진짜 별도 BrowserWindow 분리 IPC.
 *
 * - `preview:openDetached`  새 BrowserWindow 띄움 (`?previewOnly=1`)
 * - `preview:closeDetached` 분리 window 닫음
 * - `preview:isDetached`    현재 분리 여부
 * - `preview-sync:broadcast` 한 window 의 state 변경을 다른 window 들에
 *   forward. 두 renderer 의 zustand store 양방향 동기화 hub.
 */
import { BrowserWindow, ipcMain } from 'electron'
import {
  openDetachedPreviewWindow,
  closeDetachedPreviewWindow,
  getDetachedPreviewWindow
} from '../window'

export function registerPreviewWindowHandlers(): void {
  ipcMain.handle('preview:openDetached', () => {
    openDetachedPreviewWindow()
    return true
  })
  ipcMain.handle('preview:closeDetached', () => {
    closeDetachedPreviewWindow()
    return true
  })
  ipcMain.handle('preview:isDetached', () => {
    return getDetachedPreviewWindow() !== null
  })

  // Reels 11 슬라이드 13 — 분리 윈도우 OS-level 컨트롤.
  ipcMain.handle('preview:setAlwaysOnTop', (_evt, flag: unknown) => {
    const win = getDetachedPreviewWindow()
    if (!win) return false
    const next = Boolean(flag)
    win.setAlwaysOnTop(next)
    return next
  })
  ipcMain.handle('preview:minimize', () => {
    const win = getDetachedPreviewWindow()
    if (!win) return false
    win.minimize()
    return true
  })
  ipcMain.handle('preview:isAlwaysOnTop', () => {
    const win = getDetachedPreviewWindow()
    if (!win) return false
    return win.isAlwaysOnTop()
  })

  // State sync hub — sender 가 보낸 payload 를 그 외 모든 active window 로
  // forward. zustand setState 직접 broadcast 패턴.
  ipcMain.on('preview-sync:broadcast', (event, payload: unknown) => {
    const sender = event.sender
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      if (w.webContents.id === sender.id) continue
      w.webContents.send('preview-sync:apply', payload)
    }
  })
}
