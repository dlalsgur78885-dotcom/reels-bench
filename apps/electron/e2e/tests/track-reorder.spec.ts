/**
 * Reels 11 슬라이드 10 — 트랙 stack 임의 인덱스로 이동(특히 자막을 맨 위로).
 *
 * Contract:
 *  (1) moveTrack — newIndex 가 clamp 범위[0, tracks.length-1] 로.
 *  (2) moveTrack — caption 을 인덱스 0 으로 이동 가능 (slide 10 핵심).
 *  (3) moveTrack — no-op (불명 trackId / 같은 인덱스).
 *  (4) UI — track context menu 의 "맨 위로 이동" 클릭 시 트랙이 0번 인덱스로.
 *
 * @reels-11-slide-10-track-reorder
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: {
          tracks: Array<{ id: string; kind: string; name: string }>
        }
        createNew: () => void
      }
    }
    __reelsStore: {
      state: () => {
        project: {
          tracks: Array<{ id: string; kind: string; name: string }>
        }
      }
      moveTrack: (trackId: string, newIndex: number) => void
    }
  }
}

test.describe('@reels-11-slide-10-track-reorder 트랙 stack reorder', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 400))
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
      await new Promise((r) => setTimeout(r, 700))
    })
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(() => !!window.__reelsStore, null, { timeout: 5_000 })
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

  test('A-1 caption 트랙을 인덱스 0 으로 이동', async () => {
    const { page } = launched!
    const before = await page.evaluate(() =>
      window.__reelsStore.state().project.tracks.map((t) => ({ id: t.id, kind: t.kind }))
    )
    const captionTrack = before.find((t) => t.kind === 'caption')!
    expect(before.findIndex((t) => t.id === captionTrack.id)).toBeGreaterThan(0)
    await page.evaluate((tid) => window.__reelsStore.moveTrack(tid, 0), captionTrack.id)
    const after = await page.evaluate(() =>
      window.__reelsStore.state().project.tracks.map((t) => ({ id: t.id, kind: t.kind }))
    )
    expect(after[0].id).toBe(captionTrack.id)
    expect(after[0].kind).toBe('caption')
    // 다른 트랙들의 상대 순서 보존.
    const beforeRest = before.filter((t) => t.id !== captionTrack.id).map((t) => t.id)
    const afterRest = after.slice(1).map((t) => t.id)
    expect(afterRest).toEqual(beforeRest)
  })

  test('A-2 newIndex clamp', async () => {
    const { page } = launched!
    const tracks = await page.evaluate(() =>
      window.__reelsStore.state().project.tracks.map((t) => t.id)
    )
    const lastId = tracks[tracks.length - 1]
    // 음수 → 0 으로 clamp.
    await page.evaluate((tid) => window.__reelsStore.moveTrack(tid, -100), lastId)
    let after = await page.evaluate(() =>
      window.__reelsStore.state().project.tracks.map((t) => t.id)
    )
    expect(after[0]).toBe(lastId)
    // 거대수 → 끝(tracks.length - 1) 로 clamp.
    await page.evaluate((tid) => window.__reelsStore.moveTrack(tid, 999), lastId)
    after = await page.evaluate(() =>
      window.__reelsStore.state().project.tracks.map((t) => t.id)
    )
    expect(after[after.length - 1]).toBe(lastId)
  })

  test('A-3 같은 인덱스 / 불명 id no-op', async () => {
    const { page } = launched!
    const before = await page.evaluate(() =>
      window.__reelsStore.state().project.tracks.map((t) => t.id)
    )
    // same-index
    await page.evaluate((tid) => window.__reelsStore.moveTrack(tid, 0), before[0])
    // unknown id
    await page.evaluate(() => window.__reelsStore.moveTrack('does-not-exist', 0))
    const after = await page.evaluate(() =>
      window.__reelsStore.state().project.tracks.map((t) => t.id)
    )
    expect(after).toEqual(before)
  })

  test('A-4 UI — "맨 위로 이동" 컨텍스트 메뉴 동작', async () => {
    const { page } = launched!
    // caption 트랙 헤더 우클릭.
    const captionHeader = page.locator('[data-testid="track-header-caption"]').first()
    await expect(captionHeader).toBeVisible()
    await captionHeader.click({ button: 'right' })
    const menu = page.locator('[data-testid="track-context-menu"]')
    await expect(menu).toBeVisible()
    await page.locator('[data-testid="track-menu-move-top"]').click()
    const after = await page.evaluate(() =>
      window.__reelsStore.state().project.tracks.map((t) => t.kind)
    )
    expect(after[0]).toBe('caption')
  })
})
