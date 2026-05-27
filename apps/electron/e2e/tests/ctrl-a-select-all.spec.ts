/**
 * pptx11 slide 15 follow-up — 사용자 보고: 최신 빌드에서 Ctrl+A 를 눌러도
 * 타임라인 클립이 전부 선택되지 않음.
 *
 * 가설: `appMenu.ts` 의 'CmdOrCtrl+A' accelerator 가 OS / browser 가 먼저
 * 잡아가는 일이 있거나, accelerator 가 fire 해도 Editor.tsx 의 IPC
 * 핸들러가 마운트되지 않은 다른 화면에 focus 가 있어서 안 닿을 수 있음.
 *
 * 이 테스트는 실제 키 입력 (page.keyboard.press) 로 검증해서 IPC manual
 * trigger 와 차이가 나는지 본다. 차이가 나면 가설 확정.
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-ctrl-a-select-all real keypress Select All', () => {
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

  async function openEditorWithTwoClips(): Promise<void> {
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
    await page.evaluate(async (filePath: string) => {
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
      const v = reels.state().project.tracks.find((t) => t.kind === 'video')
      if (!v) throw new Error('no video track')
      for (let i = 0; i < 2; i++) {
        reels.addClip({
          id: reels.newId(),
          kind: 'media',
          mediaId: mid,
          trackId: v.id,
          startMs: i * 1000,
          endMs: i * 1000 + 500,
          trimInMs: 0,
          trimOutMs: 500,
          speed: 1
        })
      }
    }, fixture)
  }

  async function selectedCount(): Promise<number> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { selectedClipIds: Set<string> }
          }
        }
      ).__reelsTimelineUi
      return ui.getState().selectedClipIds.size
    })
  }

  test('Ctrl+A keypress while timeline has focus selects all clips', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditorWithTwoClips()
    // 타임라인 영역에 focus — 일반 사용자가 클립을 마주한 상태.
    const timeline = launched.page.locator('[data-testid="timeline-root"]').first()
    await timeline.click({ position: { x: 200, y: 100 } }).catch(() => {})
    await launched.page.waitForTimeout(120)
    expect(await selectedCount()).toBeLessThanOrEqual(1)

    await launched.page.keyboard.press('Control+a')
    await launched.page.waitForTimeout(300)

    // 두 개 클립이 모두 선택되어야 함.
    expect(await selectedCount()).toBe(2)
  })
})
