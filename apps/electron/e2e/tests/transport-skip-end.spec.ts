/**
 * pptx11 슬라이드 7 — Transport "끝" 버튼 / End 키 bug fix.
 *
 * 버그: BGM/자막 트랙이 비디오보다 길면 끝 버튼이 비디오 클립 너머로
 * playhead 를 보내서 검은 화면이 됨 (영상 1개일 땐 보통 비디오가 max 라
 * 정상). fix 는 "끝" 의 의미를 "마지막 비디오 프레임" 으로 변경.
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-transport-skip-end skip-end goes to last visual frame', () => {
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

  async function openEditorWithVideo(durationMs = 3000): Promise<string> {
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
    const clipId = await page.evaluate(
      async ({ path, dur }) => {
        await window.electron.fs.allowPath(path)
        const probe = await window.electron.media.probe(path)
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
          path,
          kind: probe.kind,
          durationMs: probe.durationMs,
          width: probe.width,
          height: probe.height,
          codec: probe.codec,
          importedAt: Date.now(),
          fileName: 'sample.mp4',
          fileSizeBytes: 0
        })
        const vt = reels.state().project.tracks.find((t) => t.kind === 'video')
        if (!vt) throw new Error('no video track')
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: vt.id,
          startMs: 0,
          endMs: dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        return cid
      },
      { path: fixture, dur: durationMs }
    )
    return clipId
  }

  async function addCaption(startMs: number, endMs: number): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(
      ({ s, e }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              state: () => {
                project: { tracks: Array<{ id: string; kind: string }> }
              }
              addCaption: (c: unknown) => void
              newId: () => string
            }
          }
        ).__reelsStore
        const ct = reels.state().project.tracks.find((t) => t.kind === 'caption')
        if (!ct) throw new Error('no caption track')
        reels.addCaption({
          id: reels.newId(),
          kind: 'caption',
          trackId: ct.id,
          startMs: s,
          endMs: e,
          spans: [{ text: 'long caption beyond video' }],
          style: {
            preset: 'block-bold',
            fontSize: 40,
            align: 'center',
            yPosition: 0.85,
            background: 'none'
          }
        })
      },
      { s: startMs, e: endMs }
    )
  }

  async function playheadMs(): Promise<number> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { playheadMs: number }
          }
        }
      ).__reelsTimelineUi
      return ui.getState().playheadMs
    })
  }

  test('with one video clip — skip-end lands at last video frame (regression OK)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditorWithVideo(3000)
    await launched.page.locator('[data-testid="transport-skip-end"]').click()
    await launched.page.waitForTimeout(150)
    // 비디오 endMs=3000, half-open 라 2999 (last frame).
    expect(await playheadMs()).toBe(2999)
  })

  test('caption longer than video — skip-end stays on last video frame (no black screen)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditorWithVideo(3000)
    // 자막을 비디오 너머로 추가 (5초). 이전 동작: end 가 4999로 가서 검은 화면.
    await addCaption(0, 5000)
    await launched.page.locator('[data-testid="transport-skip-end"]').click()
    await launched.page.waitForTimeout(150)
    // 새 동작: 비디오 마지막 프레임 (2999) 에 머무름.
    const ph = await playheadMs()
    expect(ph).toBeLessThan(3000)
    expect(ph).toBeGreaterThanOrEqual(2500) // 비디오 안에 있음
  })

  test('End key — same semantics as skip-end button', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditorWithVideo(3000)
    await addCaption(0, 6000)
    // 타임라인에 focus.
    await launched.page
      .locator('[data-testid="timeline-root"]')
      .first()
      .click({ position: { x: 200, y: 100 } })
      .catch(() => {})
    await launched.page.waitForTimeout(100)
    await launched.page.keyboard.press('End')
    await launched.page.waitForTimeout(200)
    const ph = await playheadMs()
    expect(ph).toBeLessThan(3000)
    expect(ph).toBeGreaterThanOrEqual(2500)
  })
})
