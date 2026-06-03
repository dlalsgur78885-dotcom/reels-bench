/**
 * 슬라이드 17 (릴스벤치19) — "프리즈 프레임 적용 시 화면 멈춤이 없고 2~3프레임이
 * 반복됨".
 *
 * The export-side freeze tests (freeze-frame.spec.ts) verify the ffmpeg graph
 * (tpad=clone) but NOT the PREVIEW. This spec guards the preview behaviour that
 * was actually broken: during a freeze HOLD the <video> must stay pinned to a
 * single frame, not creep forward and snap back (a 2-3 frame loop).
 *
 * Root cause (fixed): clipPlaybackRate returned the clip speed (1×) during a
 * freeze plateau, so native playback advanced ~80ms before the per-tick sync
 * snapped currentTime back — a sawtooth. Fix: clipPlaybackRate returns 0 inside
 * a freeze hold (isWithinFreezeHold) + a tight currentTime sync tolerance.
 *
 * Verified by HIGH-FREQUENCY (per-animation-frame) sampling of video.currentTime
 * — coarse polling aliases the ~80ms sawtooth and misses the bug.
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

const FIXTURE = process.env.E2E_FIXTURE_MP4

test.describe('@freeze-preview-hold', () => {
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

  test('slide 17: freeze region holds ONE frame (no 2-3 frame loop) and playback resumes after', async () => {
    test.setTimeout(120_000)
    test.skip(!FIXTURE, 'E2E_FIXTURE_MP4 required')
    const { page } = launched!

    const startMs = await page.evaluate(async (vp) => {
      await window.electron.fs.allowPath(vp)
      const p = await window.electron.media.probe(vp)
      const reels = window.__reelsStore
      const mid = reels.newId()
      reels.addMedia({ id: mid, path: vp, kind: p.kind, durationMs: p.durationMs, width: p.width ?? 320, height: p.height ?? 240, codec: p.codec, importedAt: Date.now(), fileName: 'clip.mp4', fileSizeBytes: 0 })
      const t = reels.state().project.tracks.find((tr) => tr.kind === 'video')!
      const cid = reels.newId()
      const dur = Math.min(5000, p.durationMs)
      reels.addClip({ id: cid, kind: 'media', mediaId: mid, trackId: t.id, startMs: 0, endMs: dur, trimInMs: 0, trimOutMs: dur, speed: 1 })
      // Freeze the source frame at 1000ms, held for 2000ms on the timeline →
      // freeze plateau (clip-relative, speed 1) is [1000, 3000].
      window.__PROJECT_STORE_FOR_TEST__.getState().addFreezeFrame(cid, 1000, 2000)
      const clip = reels.state().project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === cid) as { startMs: number }
      return clip.startMs
    }, FIXTURE!)

    await page.locator('body').click().catch(() => {})
    await page.evaluate((s) => {
      const ui = window.__reelsTimelineUi.getState()
      ui.setPlayheadMs(s + 1500) // middle of the [1000,3000] freeze plateau
      ui.setPlaying(true)
    }, startMs)
    await page.waitForFunction(() => {
      const v = document.querySelector<HTMLVideoElement>('video[data-preview-video-layer]')
      return !!v && v.readyState >= 2 && !v.paused
    }, null, { timeout: 12_000 })

    // High-frequency capture of currentTime for ~1s INSIDE the freeze plateau.
    const hold = await page.evaluate(async () => {
      const v = document.querySelector<HTMLVideoElement>('video[data-preview-video-layer]')!
      const vals: number[] = []
      const end = performance.now() + 1000
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          vals.push(v.currentTime)
          if (performance.now() < end) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
      return { min: Math.min(...vals), max: Math.max(...vals), rate: v.playbackRate, n: vals.length }
    })
    // A held frame ⇒ near-zero range. The bug produced ~0.09s (≈3 frames).
    expect(hold.n, 'captured enough frames').toBeGreaterThan(20)
    expect(hold.max - hold.min, 'currentTime range during freeze hold').toBeLessThan(0.02)

    // Playback must RESUME after the freeze plateau: park the playhead just past
    // the freeze ([1000,3000] → 3000+) and confirm currentTime advances again.
    await page.evaluate((s) => {
      const ui = window.__reelsTimelineUi.getState()
      ui.setPlayheadMs(s + 3300)
    }, startMs)
    await page.waitForTimeout(150)
    const t1 = await page.evaluate(() => document.querySelector<HTMLVideoElement>('video[data-preview-video-layer]')!.currentTime)
    await page.waitForTimeout(500)
    const t2 = await page.evaluate(() => document.querySelector<HTMLVideoElement>('video[data-preview-video-layer]')!.currentTime)
    expect(t2, 'currentTime advances after the freeze plateau').toBeGreaterThan(t1 + 0.1)
  })
})
