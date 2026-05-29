/**
 * Slide 6 / 0.2.7 verification — 두 클립 연속 시나리오에서
 * 두 번째 클립으로 swap된 직후 자동 재생되는지 확인.
 * @clip-swap-play
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@clip-swap-play', () => {
  let launched: LaunchedApp | null = null
  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', {
      state: 'attached', timeout: 45_000
    })
    await page.waitForFunction(() => !!(window as unknown as {__reelsStore?:unknown}).__reelsStore, null, { timeout: 8_000 })
  })
  test.afterEach(async () => {
    if (launched) {
      try { await launched.app.close() } catch { /* */ }
      launched = null
    }
  })

  test('두 클립 연속 + 재생 → 첫 클립 끝나면 두 번째가 자동 재생됨', async () => {
    test.setTimeout(60_000)
    const { page } = launched!
    const fixture = process.env.E2E_FIXTURE_MP4!
    // 2 clip on same Video track, back-to-back.
    await page.evaluate(async (fp: string) => {
      await window.electron.fs.allowPath(fp)
      const probe = await window.electron.media.probe(fp)
      const reels = window.__reelsStore
      const mid1 = reels.newId()
      const mid2 = reels.newId()
      // Two distinct media ids → different src → triggers src swap path.
      reels.addMedia({ id: mid1, path: fp, kind: probe.kind, durationMs: probe.durationMs,
        width: probe.width ?? 720, height: probe.height ?? 1280, codec: probe.codec,
        importedAt: Date.now(), fileName: 'a.mp4', fileSizeBytes: 0 })
      reels.addMedia({ id: mid2, path: fp, kind: probe.kind, durationMs: probe.durationMs,
        width: probe.width ?? 720, height: probe.height ?? 1280, codec: probe.codec,
        importedAt: Date.now(), fileName: 'b.mp4', fileSizeBytes: 0 })
      const t = reels.state().project.tracks.find((t) => t.kind === 'video')!
      reels.addClip({ id: reels.newId(), kind: 'media', mediaId: mid1, trackId: t.id,
        startMs: 0, endMs: 2000, trimInMs: 0, trimOutMs: 2000, speed: 1 })
      reels.addClip({ id: reels.newId(), kind: 'media', mediaId: mid2, trackId: t.id,
        startMs: 2000, endMs: 4000, trimInMs: 0, trimOutMs: 2000, speed: 1 })
    }, fixture)
    await page.waitForTimeout(800)

    // 1) Trigger a real user gesture so chromium autoplay policy passes.
    //    Without this, `v.play()` returns a rejected promise and the
    //    <video> stays paused — false-positive failure for our fix.
    await page.locator('body').click().catch(() => {})

    // 2) Drive playhead into clip 1, set playing=true, wait a few ticks.
    await page.evaluate(() => {
      const ui = (window as unknown as { __reelsTimelineUi: { getState: () => { setPlaying: (b: boolean) => void; setPlayheadMs: (n: number) => void } } }).__reelsTimelineUi
      ui.getState().setPlayheadMs(500)
      ui.getState().setPlaying(true)
    })
    await page.waitForTimeout(1500)
    const stateClip1 = await page.evaluate(() => {
      const vids = Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]'))
      return vids.map((v) => ({ paused: v.paused, src: v.src.slice(-30) }))
    })
    console.log('CLIP1_STATE', JSON.stringify(stateClip1))

    // 3) Jump to JUST AFTER clip boundary (2050ms — well inside clip 2).
    //    Critical: we KEEP playing=true. Old code (pre-0.2.7) would src-swap
    //    + load() and leave the new <video> paused. 0.2.7 fix calls play()
    //    inside the swap effect when playing===true.
    await page.evaluate(() => {
      const ui = (window as unknown as { __reelsTimelineUi: { getState: () => { setPlayheadMs: (n: number) => void } } }).__reelsTimelineUi
      ui.getState().setPlayheadMs(2050)
    })
    await page.waitForTimeout(1500)

    const status = await page.evaluate(() => {
      const vids = Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]'))
      return vids.map((v) => ({
        src: (v.src || '').slice(-40),
        paused: v.paused,
        currentTime: v.currentTime,
        readyState: v.readyState,
        ended: v.ended
      }))
    })
    console.log('CLIP2_STATE', JSON.stringify(status, null, 2))
    expect(status.length).toBeGreaterThanOrEqual(1)
    expect(status.some((v) => !v.paused)).toBe(true)
  })

  test('재생 중 preview video가 멈춰도 watchdog이 다시 재생시킴', async () => {
    test.setTimeout(60_000)
    const { page } = launched!
    const fixture = process.env.E2E_FIXTURE_MP4!

    await page.evaluate(async (fp: string) => {
      await window.electron.fs.allowPath(fp)
      const probe = await window.electron.media.probe(fp)
      const reels = window.__reelsStore
      const mediaId = reels.newId()
      reels.addMedia({
        id: mediaId,
        path: fp,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width ?? 720,
        height: probe.height ?? 1280,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName: 'watchdog.mp4',
        fileSizeBytes: 0
      })
      const track = reels.state().project.tracks.find((t) => t.kind === 'video')!
      reels.addClip({
        id: reels.newId(),
        kind: 'media',
        mediaId,
        trackId: track.id,
        startMs: 0,
        endMs: 3000,
        trimInMs: 0,
        trimOutMs: 3000,
        speed: 1
      })
    }, fixture)

    await page.locator('body').click().catch(() => {})
    await page.evaluate(() => {
      const ui = (window as unknown as {
        __reelsTimelineUi: {
          getState: () => {
            setPlaying: (b: boolean) => void
            setPlayheadMs: (n: number) => void
          }
        }
      }).__reelsTimelineUi
      ui.getState().setPlayheadMs(500)
      ui.getState().setPlaying(true)
    })

    await page.waitForFunction(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      return videos.some((v) => !v.paused && v.readyState >= 2)
    }, null, { timeout: 8_000 })

    await page.evaluate(() => {
      for (const v of document.querySelectorAll<HTMLVideoElement>(
        'video[data-preview-video-layer]'
      )) {
        v.pause()
      }
    })

    await page.waitForFunction(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      return videos.some((v) => !v.paused)
    }, null, { timeout: 4_000 })

    const recovered = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      ).map((v) => ({
        paused: v.paused,
        currentTime: v.currentTime,
        readyState: v.readyState
      }))
    )
    expect(recovered.some((v) => !v.paused)).toBe(true)
  })
})
