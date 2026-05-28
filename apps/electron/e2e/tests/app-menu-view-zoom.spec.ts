/**
 * pptx13 slide 10 — View 탭 Zoom In 단축키 회귀 테스트.
 *
 * 사용자 보고:
 * - Ctrl + - 인터페이스 축소는 동작
 * - Ctrl + + 인터페이스 확대는 버튼을 눌러야만 동작
 *
 * Electron 기본 role accelerator 에 의존하지 않고, View 메뉴의 Zoom In/Out
 * click handler 와 실제 keypress 모두 BrowserWindow zoomFactor 를 변경하는지
 * 확인한다.
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-view-zoom-shortcut application menu View zoom shortcuts', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    await launched.page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
    })
  })

  test.afterEach(async () => {
    if (launched) {
      try {
        await launched.app.close()
      } catch {
        /* ignore */
      }
      launched = null
    }
  })

  async function getZoomFactor(): Promise<number> {
    if (!launched) throw new Error('launch failed')
    return launched.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getFocusedWindow()
        ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win) throw new Error('no BrowserWindow')
      return win.webContents.getZoomFactor()
    })
  }

  async function resetZoomFactor(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getFocusedWindow()
        ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win) throw new Error('no BrowserWindow')
      win.webContents.setZoomFactor(1)
    })
  }

  test('View menu exposes explicit zoom handlers and accelerators', async () => {
    if (!launched) throw new Error('launch failed')
    const items = await launched.app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      const view = menu?.items.find((i) => i.label === 'View')
      return view?.submenu?.items.map((i) => ({
        label: i.label,
        accelerator: i.accelerator ?? null,
        hasClick: typeof i.click === 'function',
        visible: i.visible,
        role: i.role ?? null,
        type: i.type ?? null
      })) ?? []
    })

    const zoomInItems = items.filter((i) => i.label === 'Zoom In')
    expect(zoomInItems.some((i) => i.accelerator === 'CmdOrCtrl+=')).toBe(true)
    expect(zoomInItems.some((i) => i.accelerator === 'CmdOrCtrl+Plus')).toBe(true)

    for (const label of ['Actual Size', 'Zoom In', 'Zoom Out']) {
      const matching = items.filter((i) => i.label === label)
      expect(matching.length).toBeGreaterThan(0)
      for (const item of matching) expect(item.hasClick).toBe(true)
    }
  })

  test('clicking View Zoom In/Out changes BrowserWindow zoomFactor', async () => {
    if (!launched) throw new Error('launch failed')
    await resetZoomFactor()
    expect(await getZoomFactor()).toBeCloseTo(1, 4)

    await launched.app.evaluate(({ Menu, BrowserWindow }) => {
      const menu = Menu.getApplicationMenu()
      const view = menu?.items.find((i) => i.label === 'View')
      const zoomIn = view?.submenu?.items.find(
        (i) => i.label === 'Zoom In' && i.accelerator === 'CmdOrCtrl+='
      )
      const focused = BrowserWindow.getFocusedWindow()
        ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        ?? undefined
      if (!zoomIn) throw new Error('no Zoom In item')
      zoomIn.click(undefined, focused, focused?.webContents)
    })
    expect(await getZoomFactor()).toBeGreaterThan(1)

    await launched.app.evaluate(({ Menu, BrowserWindow }) => {
      const menu = Menu.getApplicationMenu()
      const view = menu?.items.find((i) => i.label === 'View')
      const zoomOut = view?.submenu?.items.find((i) => i.label === 'Zoom Out')
      const focused = BrowserWindow.getFocusedWindow()
        ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        ?? undefined
      if (!zoomOut) throw new Error('no Zoom Out item')
      zoomOut.click(undefined, focused, focused?.webContents)
    })
    expect(await getZoomFactor()).toBeCloseTo(1, 4)
  })

  test('Ctrl plus/equal and Ctrl minus keypresses change interface zoom', async () => {
    if (!launched) throw new Error('launch failed')
    await resetZoomFactor()
    await launched.page.bringToFront()

    await launched.page.keyboard.press('Control+=')
    await launched.page.waitForTimeout(120)
    const zoomedIn = await getZoomFactor()
    expect(zoomedIn).toBeGreaterThan(1)

    await launched.page.keyboard.press('Control+-')
    await launched.page.waitForTimeout(120)
    expect(await getZoomFactor()).toBeCloseTo(1, 4)
  })
})
