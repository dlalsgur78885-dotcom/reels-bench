/**
 * pptx11 slide 15 regression — 상단 Application Menu의 Edit 항목
 * (Undo/Redo/Cut/Copy/Paste/Delete/Select All/Duplicate/Split) 가
 * 실제로 store 액션을 트리거하는지 검증.
 *
 * Wiring: appMenu.ts click → webContents.send('app-menu:action', action)
 *         → preload `appMenu.onAction` → Editor.tsx switch → store action.
 *
 * playwright 로 native menu 를 클릭할 방법이 없으니 main process 에서
 * 직접 `webContents.send` 를 호출해 같은 채널을 시뮬레이트하고 store 상태
 * 변화를 검증.
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-app-menu-edit application menu Edit actions', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            getState: () => { createNew: () => void }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      store.getState().createNew()
      await new Promise((r) => setTimeout(r, 500))
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

  async function openEditorWithClip(): Promise<{ clipId: string }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')

    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )

    const clipId = await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: { tracks: Array<{ id: string; kind: string }> }
            }
            addMedia: (a: unknown) => void
            addClip: (c: unknown) => void
            newId: () => string
          }
        }
      ).__reelsStore
      const mid = reels.newId()
      reels.addMedia({
        id: mid,
        path: filePath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName: 'sample.mp4',
        fileSizeBytes: 0
      })
      const vTrack = reels.state().project.tracks.find((t) => t.kind === 'video')
      if (!vTrack) throw new Error('no video track')
      const cid = reels.newId()
      reels.addClip({
        id: cid,
        kind: 'media',
        mediaId: mid,
        trackId: vTrack.id,
        startMs: 0,
        endMs: probe.durationMs,
        trimInMs: 0,
        trimOutMs: probe.durationMs,
        speed: 1
      })
      return cid
    }, fixture)

    return { clipId }
  }

  /** main process 에서 webContents.send('app-menu:action', action) 호출. */
  async function fireMenuAction(action: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.app.evaluate(({ BrowserWindow }, a) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win) throw new Error('no window')
      win.webContents.send('app-menu:action', a)
    }, action)
    await launched.page.waitForTimeout(150)
  }

  async function clipCount(): Promise<number> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => { project: { tracks: Array<{ clips: unknown[] }> } }
          }
        }
      ).__reelsStore
      let n = 0
      for (const t of reels.state().project.tracks) n += t.clips.length
      return n
    })
  }

  async function selectClip(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate((id) => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { selectClip: (id: string) => void }
            setState: (s: unknown) => void
          }
        }
      ).__reelsTimelineUi
      // selectedClipIds 는 Set — 직접 set state 해서 멀티셀렉트 충돌 방지.
      ui.setState({ selectedClipIds: new Set([id]) })
    }, clipId)
    await launched.page.waitForTimeout(80)
  }

  test('Undo: app-menu undo reverts the last addClip', async () => {
    const { clipId } = await openEditorWithClip()
    expect(await clipCount()).toBe(1)
    await fireMenuAction('undo')
    // 클립 추가가 undo 되어야 함.
    expect(await clipCount()).toBe(0)
    // sanity: clipId still referenced (just a string).
    expect(typeof clipId).toBe('string')
  })

  test('Delete: removes selected clip', async () => {
    const { clipId } = await openEditorWithClip()
    await selectClip(clipId)
    expect(await clipCount()).toBe(1)
    await fireMenuAction('delete')
    expect(await clipCount()).toBe(0)
  })

  test('Duplicate: clones selected clip', async () => {
    const { clipId } = await openEditorWithClip()
    await selectClip(clipId)
    expect(await clipCount()).toBe(1)
    await fireMenuAction('duplicate')
    expect(await clipCount()).toBe(2)
  })

  test('SelectAll: selects every clip in the project', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditorWithClip()
    await fireMenuAction('selectAll')
    const selectedCount = await launched.page.evaluate(() => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { selectedClipIds: Set<string> }
          }
        }
      ).__reelsTimelineUi
      return ui.getState().selectedClipIds.size
    })
    expect(selectedCount).toBe(1)
  })

  test('Copy + Paste: pastes a clone at the current playhead', async () => {
    if (!launched) throw new Error('launch failed')
    const { clipId } = await openEditorWithClip()
    await selectClip(clipId)
    await fireMenuAction('copy')
    // playhead 를 클립 끝 뒤로 옮겨 paste 결과가 새 startMs 에 들어가도록.
    await launched.page.evaluate(() => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { setPlayheadMs: (n: number) => void }
          }
        }
      ).__reelsTimelineUi
      ui.getState().setPlayheadMs(5000)
    })
    await launched.page.waitForTimeout(80)
    await fireMenuAction('paste')
    expect(await clipCount()).toBe(2)
  })

  test('Cut: removes selected clip and stashes it for paste', async () => {
    const { clipId } = await openEditorWithClip()
    await selectClip(clipId)
    expect(await clipCount()).toBe(1)
    await fireMenuAction('cut')
    expect(await clipCount()).toBe(0)
    // 이어서 paste 가능 (cut 이 clipboard 채움).
    await fireMenuAction('paste')
    expect(await clipCount()).toBe(1)
  })

  /**
   * 실제 ApplicationMenu 트리에 Edit 항목이 존재하고 click handler 가
   * 붙어있는지 검증 — 사용자가 OS chrome 으로 메뉴를 열 때 우리가 빌드한
   * 항목들이 노출되는지 확인하는 안전망.
   */
  test('application menu has Edit submenu with all expected items', async () => {
    if (!launched) throw new Error('launch failed')
    const items = await launched.app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      if (!menu) return null
      const edit = menu.items.find((i) => i.label === 'Edit')
      if (!edit || !edit.submenu) return null
      return edit.submenu.items.map((i) => ({
        label: i.label,
        accelerator: i.accelerator ?? null,
        hasClick: typeof i.click === 'function',
        role: i.role ?? null,
        type: i.type ?? null
      }))
    })
    expect(items).not.toBeNull()
    const labels = items!.map((i) => i.label).filter(Boolean)
    // 사용자가 슬라이드 15 에서 "안 먹힘" 으로 지목한 핵심 항목들.
    for (const expected of [
      'Undo', 'Redo', 'Cut', 'Copy', 'Paste',
      'Delete', 'Duplicate', 'Split at Playhead', 'Select All'
    ]) {
      expect(labels).toContain(expected)
    }
    // 모든 click 항목에 click handler 가 붙어있어야 함 — handler 가 없으면
    // 클릭 무반응 (default Electron role 만 있고 timeline 에선 안 먹힘).
    for (const it of items!) {
      if (it.type !== 'separator') {
        expect(it.hasClick).toBe(true)
      }
    }
  })

  /**
   * MenuItem.click() 을 직접 호출해 (Playwright 가 native chrome 클릭을 흉내
   * 낼 수 없으므로) main → renderer dispatch 경로를 끝까지 통과시킨다.
   */
  test('clicking Undo menu item triggers store undo', async () => {
    if (!launched) throw new Error('launch failed')
    const { clipId } = await openEditorWithClip()
    expect(await clipCount()).toBe(1)
    expect(typeof clipId).toBe('string')
    await launched.app.evaluate(({ Menu, BrowserWindow }) => {
      const menu = Menu.getApplicationMenu()
      if (!menu) throw new Error('no app menu')
      const edit = menu.items.find((i) => i.label === 'Edit')
      const undo = edit?.submenu?.items.find((i) => i.label === 'Undo')
      if (!undo) throw new Error('no Undo item')
      const focused = BrowserWindow.getFocusedWindow()
        ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        ?? undefined
      // MenuItem.click 시그니처 — (event?, focusedWindow?, focusedWebContents?).
      undo.click(undefined, focused, focused?.webContents)
    })
    await launched.page.waitForTimeout(200)
    expect(await clipCount()).toBe(0)
  })
})
