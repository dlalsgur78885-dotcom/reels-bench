/**
 * pptx11 슬라이드 15 follow-up 2 — 실제 키 입력으로 Edit 메뉴의 모든 단축키가
 * 동작하는지 검증. Ctrl+A 버그와 동일한 패턴 (appMenu accelerator 만 있고
 * renderer 핸들러 부재 → focus 위치에 따라 OS/browser 가 가로채면 안 먹힘)
 * 이 Cut/Copy/Paste 에도 있는지 확인.
 *
 * 키 입력 → store 변화로 판정. fail 하면 renderer keydown fallback 추가
 * 필요.
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-edit-shortcuts-keypress real keypress for Edit shortcuts', () => {
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
        endMs: 1000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      return cid
    }, fixture)

    return { clipId }
  }

  async function selectClip(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate((id) => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            setState: (s: unknown) => void
          }
        }
      ).__reelsTimelineUi
      ui.setState({ selectedClipIds: new Set([id]) })
    }, clipId)
    await launched.page.waitForTimeout(80)
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

  async function focusTimeline(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    // timeline ruler 영역 클릭 — input 같은 native 요소가 아닌 일반 div 라
    // 가 keydown 이 window 까지 bubble 함.
    await launched.page
      .locator('[data-testid="timeline-root"]')
      .first()
      .click({ position: { x: 200, y: 100 } })
      .catch(() => {})
    await launched.page.waitForTimeout(120)
  }

  test('Ctrl+X keypress: cuts selected clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { clipId } = await openEditorWithClip()
    await selectClip(clipId)
    await focusTimeline()
    await selectClip(clipId)
    expect(await clipCount()).toBe(1)
    await launched.page.keyboard.press('Control+x')
    await launched.page.waitForTimeout(250)
    expect(await clipCount()).toBe(0)
  })

  test('Ctrl+C + Ctrl+V keypress: copies selected clip and pastes it', async () => {
    if (!launched) throw new Error('launch failed')
    const { clipId } = await openEditorWithClip()
    await selectClip(clipId)
    await focusTimeline()
    await selectClip(clipId)
    expect(await clipCount()).toBe(1)
    await launched.page.keyboard.press('Control+c')
    await launched.page.waitForTimeout(150)
    // playhead 를 클립 끝 너머로 옮겨 paste 결과의 startMs 가 분리되도록.
    await launched.page.evaluate(() => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { setPlayheadMs: (n: number) => void }
          }
        }
      ).__reelsTimelineUi
      ui.getState().setPlayheadMs(2000)
    })
    await launched.page.waitForTimeout(80)
    await launched.page.keyboard.press('Control+v')
    await launched.page.waitForTimeout(250)
    expect(await clipCount()).toBe(2)
  })
})
