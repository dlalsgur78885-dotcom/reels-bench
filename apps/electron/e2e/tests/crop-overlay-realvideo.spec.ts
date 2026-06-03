/**
 * 슬라이드 14 (릴스벤치19) — "영상 위에 크롭한 영상 올렸는데 사라짐".
 *
 * REAL-VIDEO, PIXEL-LEVEL verification of the z-order fix. Builds the exact
 * user scenario — a CROPPED clip on the TOP timeline track over a plain
 * full-frame clip on a LOWER track — then proves, by sampling preview pixels,
 * that the cropped overlay actually composites IN FRONT:
 *   1. with the crop clip present, sample the preview CENTER (inside the crop
 *      region) and a CORNER (outside it);
 *   2. remove the crop clip and sample the same spots again;
 *   3. assert the CENTER changed materially (the overlay was visible there) while
 *      the CORNER stayed ~the same (base unchanged outside the crop).
 *
 * Uses two REAL downloaded clips (different scenes) so the overlay's content is
 * visually distinct from the base. The files live outside the repo, so the test
 * SKIPS when they're absent (e.g. CI); the DOM-level guard for the same fix is
 * transform-layers.spec.ts "slide 11". To run locally, place two distinct mp4s
 * at the paths below (any real footage works).
 */
import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import sharp from 'sharp'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

const BASE_VIDEO = 'C:\\tmp\\real_a.mp4' // plain full-frame base (lower track)
const CROP_VIDEO = 'C:\\tmp\\real_b.mp4' // cropped overlay (top track)
const HAVE_REAL = existsSync(BASE_VIDEO) && existsSync(CROP_VIDEO)

/** Mean [r,g,b] of a small square region of a PNG screenshot buffer. */
async function regionMean(
  pngPath: string,
  cxFrac: number,
  cyFrac: number
): Promise<[number, number, number]> {
  const meta = await sharp(pngPath).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  const side = Math.max(8, Math.floor(Math.min(W, H) * 0.06))
  const left = Math.min(W - side, Math.max(0, Math.floor(cxFrac * W - side / 2)))
  const top = Math.min(H - side, Math.max(0, Math.floor(cyFrac * H - side / 2)))
  // NOTE: `.extract(...).stats()` does NOT apply the crop in this sharp build —
  // stats() reports whole-image channels. Materialize the cropped region to a
  // buffer first, then take stats on that.
  const region = await sharp(pngPath)
    .extract({ left, top, width: side, height: side })
    .png()
    .toBuffer()
  const stats = await sharp(region).stats()
  return [stats.channels[0].mean, stats.channels[1].mean, stats.channels[2].mean]
}

const dist = (a: [number, number, number], b: [number, number, number]): number =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)

test.describe('@crop-overlay-realvideo', () => {
  let launched: LaunchedApp | null = null
  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', { state: 'attached', timeout: 45_000 })
    await page.waitForFunction(() => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore, null, { timeout: 8_000 })
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

  test('slide 14: cropped clip on the TOP timeline track is visible in front of the base (real video, pixels)', async () => {
    test.setTimeout(120_000)
    test.skip(!HAVE_REAL, 'real test videos not present (place mp4s at C:\\tmp\\real_a.mp4 / real_b.mp4)')
    const { page } = launched!

    const cropClipId = await page.evaluate(
      async ({ base, crop }) => {
        await window.electron.fs.allowPath(base)
        await window.electron.fs.allowPath(crop)
        const pb = await window.electron.media.probe(base)
        const pc = await window.electron.media.probe(crop)
        const reels = window.__reelsStore
        const baseId = reels.newId()
        const cropId = reels.newId()
        reels.addMedia({ id: cropId, path: crop, kind: pc.kind, durationMs: pc.durationMs, width: pc.width ?? 640, height: pc.height ?? 360, codec: pc.codec, importedAt: Date.now(), fileName: 'crop.mp4', fileSizeBytes: 0 })
        reels.addMedia({ id: baseId, path: base, kind: pb.kind, durationMs: pb.durationMs, width: pb.width ?? 640, height: pb.height ?? 360, codec: pb.codec, importedAt: Date.now(), fileName: 'base.mp4', fileSizeBytes: 0 })
        // TOP timeline track = the first (existing) video track. Cropped overlay
        // goes here. A second, lower track holds the plain full-frame base.
        const topTrack = reels.state().project.tracks.find((t) => t.kind === 'video')!
        const bottomTrackId = reels.addTrack('video')!
        const dur = Math.min(8000, pb.durationMs, pc.durationMs)
        const cropClip = reels.newId()
        const baseClip = reels.newId()
        reels.addClip({ id: cropClip, kind: 'media', mediaId: cropId, trackId: topTrack.id, startMs: 0, endMs: dur, trimInMs: 0, trimOutMs: dur, speed: 1 })
        reels.addClip({ id: baseClip, kind: 'media', mediaId: baseId, trackId: bottomTrackId, startMs: 0, endMs: dur, trimInMs: 0, trimOutMs: dur, speed: 1 })
        // Center crop so the overlay covers the preview CENTER but not the corner.
        window.__PROJECT_STORE_FOR_TEST__.getState().setClipCrop(cropClip, { x: 0.3, y: 0.2, w: 0.4, h: 0.5 })
        return cropClip
      },
      { base: BASE_VIDEO, crop: CROP_VIDEO }
    )

    await page.waitForTimeout(500)
    await page.locator('body').click().catch(() => {})
    await page.evaluate(() => {
      const ui = window.__reelsTimelineUi.getState()
      ui.setPlayheadMs(600)
      ui.setPlaying(true)
    })
    await page.waitForFunction(() => {
      const vs = Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]'))
      return vs.length >= 2 && vs.every((v) => v.readyState >= 2)
    }, null, { timeout: 12_000 })
    // pause so the before/after screenshots sample the SAME frame time
    await page.evaluate(() => window.__reelsTimelineUi.getState().setPlaying(false))
    await page.waitForTimeout(300)

    const canvas = page.locator('[data-testid="preview-canvas"]')
    const withPath = 'C:/tmp/s14_with.png'
    const basePath = 'C:/tmp/s14_base.png'
    await canvas.screenshot({ path: withPath })
    const centerWith = await regionMean(withPath, 0.5, 0.42)
    const cornerWith = await regionMean(withPath, 0.08, 0.08)

    // Remove the cropped overlay → only the base remains.
    await page.evaluate((id) => window.__reelsStore.removeClip(id), cropClipId)
    await page.waitForTimeout(400)
    await canvas.screenshot({ path: basePath })
    const centerBase = await regionMean(basePath, 0.5, 0.42)
    const cornerBase = await regionMean(basePath, 0.08, 0.08)

    const centerDelta = dist(centerWith, centerBase)
    const cornerDelta = dist(cornerWith, cornerBase)
    // eslint-disable-next-line no-console
    console.log(
      `SLIDE14_PIXELS centerWith=${centerWith.map((n) => n.toFixed(0))} centerBase=${centerBase.map((n) => n.toFixed(0))} Δcenter=${centerDelta.toFixed(1)} | cornerWith=${cornerWith.map((n) => n.toFixed(0))} cornerBase=${cornerBase.map((n) => n.toFixed(0))} Δcorner=${cornerDelta.toFixed(1)}`
    )

    // The cropped overlay MUST have changed the center (it was visible in front).
    expect(centerDelta).toBeGreaterThan(25)
    // Outside the crop the base is unchanged → corner barely moves, and clearly
    // less than the center (proves the overlay was clipped to its region, not
    // covering the whole frame, and that the center change is the overlay).
    expect(cornerDelta).toBeLessThan(centerDelta * 0.5)
  })
})
