/**
 * 슬라이드 12 (릴스벤치19) — "프리뷰 모니터 플랫폼 미리보기, 실제 사이즈와 다름".
 *
 * Root cause (was): SocialPreviewOverlay rendered the platform chrome in a FIXED
 * 1080×1920 (9:16) coordinate space and stretched it onto the project's fitted
 * rect with a NON-UNIFORM transform scale(fittedW/1080, fittedH/1920). That is
 * only uniform at 9:16; for 4:5 / 1:1 / 16:9 the chrome was horizontally
 * stretched (measured distortion 1.42 / 1.78 / 3.16).
 *
 * Fix (PreviewCanvas): Instagram Reels / TikTok / Shorts are inherently 9:16, so
 * when a platform preview is active the preview now draws a true 9:16 platform
 * FRAME and letterboxes the project content into it (matching how the real apps
 * fit non-9:16 uploads). The chrome is anchored to that 9:16 frame, so it always
 * scales uniformly — distortion ≈ 1.0 at every aspect ratio.
 *
 * This spec asserts that invariant across all supported aspect ratios and logs
 * the geometry table for reference.
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

const HD = process.env.E2E_FIXTURE_MP4_HD
const RATIOS = ['9:16', '4:5', '1:1', '16:9'] as const

interface RatioGeom {
  ratio: string
  projAspect: number
  scaleX: number
  scaleY: number
  distortion: number
}

test.describe('@social-preview-aspect', () => {
  let launched: LaunchedApp | null = null
  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', { state: 'attached', timeout: 45_000 })
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 8_000 }
    )
  })
  test.afterEach(async () => {
    if (launched) {
      try {
        await launched.app.close()
      } catch {
        /* */
      }
      launched = null
    }
  })

  async function collectGeometry(): Promise<RatioGeom[]> {
    const { page } = launched!
    await page.evaluate(async (videoPath) => {
      await window.electron.fs.allowPath(videoPath)
      const probe = await window.electron.media.probe(videoPath)
      const reels = window.__reelsStore
      const id = reels.newId()
      reels.addMedia({
        id,
        path: videoPath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width ?? 1080,
        height: probe.height ?? 1920,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName: 'hd.mp4',
        fileSizeBytes: 0
      })
      const t = reels.state().project.tracks.find((tr) => tr.kind === 'video')!
      const dur = Math.min(5000, probe.durationMs)
      reels.addClip({ id: reels.newId(), kind: 'media', mediaId: id, trackId: t.id, startMs: 0, endMs: dur, trimInMs: 0, trimOutMs: dur, speed: 1 })
      ;(window as unknown as { __TIMELINE_UI_FOR_TEST__: { getState: () => { setSocialPreviewPlatform: (p: string) => void } } })
        .__TIMELINE_UI_FOR_TEST__.getState()
        .setSocialPreviewPlatform('instagram')
    }, HD!)
    await page.waitForTimeout(400)

    const out: RatioGeom[] = []
    for (const ratio of RATIOS) {
      await page.evaluate((r) => window.__reelsStore.setAspectRatio(r as '9:16'), ratio)
      await page.waitForTimeout(500)
      const m = await page.evaluate(() => {
        const proj = window.__PROJECT_STORE_FOR_TEST__.getState().project
        const coordEl = document.querySelector('[data-testid="social-preview-coordinate-space"]')
        const coord = coordEl ? coordEl.getBoundingClientRect() : null
        const sx = coord ? coord.width / 1080 : 0
        const sy = coord ? coord.height / 1920 : 0
        return {
          projAspect: +(proj.width / proj.height).toFixed(4),
          scaleX: +sx.toFixed(4),
          scaleY: +sy.toFixed(4),
          distortion: sy > 0 ? +(sx / sy).toFixed(4) : 0
        }
      })
      out.push({ ratio, ...m })
      // eslint-disable-next-line no-console
      console.log(`IGRATIO[${ratio}] ` + JSON.stringify(m))
    }
    return out
  }

  test('instagram overlay must not distort at any aspect ratio', async () => {
    test.setTimeout(120_000)
    test.skip(!HD, 'E2E_FIXTURE_MP4_HD required')
    const geo = await collectGeometry()
    // eslint-disable-next-line no-console
    console.log('\n=== SLIDE 12 INSTAGRAM OVERLAY DISTORTION PER ASPECT RATIO ===')
    for (const g of geo) {
      // eslint-disable-next-line no-console
      console.log(`${g.ratio.padEnd(5)} aspect=${g.projAspect}  scaleX=${g.scaleX}  scaleY=${g.scaleY}  distortion=${g.distortion}`)
    }
    // eslint-disable-next-line no-console
    console.log('==============================================================\n')
    // After the fix the chrome is anchored to a uniform 9:16 platform frame, so
    // the coordinate-space scale must be uniform (distortion ≈ 1) everywhere.
    for (const g of geo) {
      expect(Math.abs(g.distortion - 1), `${g.ratio} overlay distortion`).toBeLessThan(0.05)
    }
  })
})
