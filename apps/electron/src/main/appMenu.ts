/**
 * pptx10 슬라이드 17 — 상단 Edit 메뉴 (Undo/Redo/Cut/Copy/Paste/Delete/
 * Select All) 가 timeline clip 에서 동작하게 customize.
 *
 * Default Electron menu 의 Edit role 들은 textfield/contenteditable 안에서만
 * 작동 (browser native). 우리 timeline 의 custom UI clip 에서는 안 먹힘 →
 * 사용자 보고 "안 먹힘". 여기서 click handler 를 우리 renderer 로 보내
 * (`webContents.send('app-menu:action', ...)`) timeline store action 으로
 * dispatch.
 *
 * Cut / Copy / Paste 는 selected clip 들이 대상. clipboard 는 renderer 내부
 * (`pendingImport.ts` 와 비슷한 모듈) 가 관리하므로 main 은 신호만 보냄.
 */
import { Menu, MenuItemConstructorOptions, BrowserWindow } from 'electron'

export type AppMenuAction =
  | 'undo' | 'redo'
  | 'cut' | 'copy' | 'paste' | 'delete'
  | 'selectAll' | 'duplicate'
  | 'split'

function send(win: BrowserWindow | null, action: AppMenuAction): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('app-menu:action', action)
}

function dispatch(action: AppMenuAction): void {
  const focused = BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    ?? null
  send(focused, action)
}

export function installAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: 'Reels Studio',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: 'File',
    submenu: [
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  })

  template.push({
    label: 'Edit',
    submenu: [
      {
        label: 'Undo',
        accelerator: 'CmdOrCtrl+Z',
        click: () => dispatch('undo')
      },
      {
        label: 'Redo',
        accelerator: isMac ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y',
        click: () => dispatch('redo')
      },
      { type: 'separator' },
      {
        label: 'Cut',
        accelerator: 'CmdOrCtrl+X',
        click: () => dispatch('cut')
      },
      {
        label: 'Copy',
        accelerator: 'CmdOrCtrl+C',
        click: () => dispatch('copy')
      },
      {
        label: 'Paste',
        accelerator: 'CmdOrCtrl+V',
        click: () => dispatch('paste')
      },
      {
        label: 'Delete',
        accelerator: 'Delete',
        click: () => dispatch('delete')
      },
      { type: 'separator' },
      {
        label: 'Duplicate',
        accelerator: 'CmdOrCtrl+D',
        click: () => dispatch('duplicate')
      },
      {
        label: 'Split at Playhead',
        // 'S' 단독은 너무 광범위 + 우리 timeline 의 selected-clip 단축키와
        // 충돌해서 menu accelerator 에는 Ctrl+B (캡컷 동일) 사용. timeline
        // 내부 'S' 단축키는 그대로 살아있음 (Editor 의 keydown 핸들러).
        accelerator: 'CmdOrCtrl+B',
        click: () => dispatch('split')
      },
      { type: 'separator' },
      {
        label: 'Select All',
        accelerator: 'CmdOrCtrl+A',
        click: () => dispatch('selectAll')
      }
    ]
  })

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  })

  template.push({
    label: 'Window',
    role: 'windowMenu'
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
