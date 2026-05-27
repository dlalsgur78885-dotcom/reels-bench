/**
 * One-shot screenshot harness for the SNS preview overlay.
 *
 * Goal: render TikTok / YouTube Shorts / Instagram 릴스 chrome on top of a
 * loaded vertical clip, then save PNG snapshots so we can compare against
 * the real platforms' UIs.
 *
 * Output: apps/electron/_audits/social-preview/<platform>.png
 */
import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type TimelineUiStore = {
  getState: () => {
    socialPreviewPlatform: 'none' | 'tiktok' | 'youtube' | 'instagram'
    setSocialPreviewPlatform: (
      p: 'none' | 'tiktok' | 'youtube' | 'instagram'
    ) => void
  }
}

const OUT_DIR = path.resolve(__dirname, '..', '..', '_audits', 'social-preview')

test.describe('@social-preview-screenshots', () => {
  let launched: LaunchedApp | null = null

  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
  })

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
    })
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible({
      timeout: 8_000
    })
    await page.waitForFunction(
      () =>
        !!(
          window as unknown as { __TIMELINE_UI_FOR_TEST__?: unknown }
        ).__TIMELINE_UI_FOR_TEST__,
      null,
      { timeout: 5_000 }
    )

    // Seed a vertical clip on the video track so the preview rect has
    // real content underneath the overlay.
    const fixture = process.env.E2E_FIXTURE_MP4!
    await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const reels = (window as unknown as { __reelsStore: any }).__reelsStore
      const mid = reels.newId()
      reels.addMedia({
        id: mid,
        path: filePath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        // Force vertical so the fitted rect matches Reels/Shorts/TikTok.
        width: 1080,
        height: 1920,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName: 'test.mp4',
        fileSizeBytes: 0
      })
      const vt = reels
        .state()
        .project.tracks.find((t: { kind: string }) => t.kind === 'video')!
      const cid = reels.newId()
      reels.addClip({
        id: cid,
        kind: 'media',
        mediaId: mid,
        trackId: vt.id,
        startMs: 0,
        endMs: probe.durationMs,
        trimInMs: 0,
        trimOutMs: probe.durationMs,
        speed: 1
      })
    }, fixture)
    await page.waitForTimeout(500)
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

  for (const platform of ['none', 'tiktok', 'youtube', 'instagram'] as const) {
    test(`screenshot — ${platform}`, async () => {
      if (!launched) throw new Error('launch failed')
      const { page } = launched

      await page.evaluate((p) => {
        const ui = (
          window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
        ).__TIMELINE_UI_FOR_TEST__
        ui.getState().setSocialPreviewPlatform(p)
      }, platform)
      await page.waitForTimeout(300)

      // Tight screenshot of just the preview fitted rect — that's the
      // 9:16 region the chrome paints over.
      const rect = page.locator('[data-testid="preview-fitted-rect"]')
      await expect(rect).toBeVisible({ timeout: 3_000 })
      const out = path.join(OUT_DIR, `${platform}.png`)
      await rect.screenshot({ path: out, omitBackground: false })

      // Also a wider screenshot of the whole preview canvas for context.
      const canvas = page.locator('[data-testid="preview-canvas"]')
      const outCanvas = path.join(OUT_DIR, `${platform}_canvas.png`)
      await canvas.screenshot({ path: outCanvas, omitBackground: false })

      // eslint-disable-next-line no-console
      console.log(`[screenshot] ${platform} -> ${out}`)
    })
  }
})
