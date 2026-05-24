/**
 * Phase 3.77 — Timeline ClipBlock left-edge color accent strip.
 *
 * Follow-up to Phase 3.74 (data + store). Now that `clip.color` is set
 * via the store, the Timeline renders a 4px colored stripe on the left
 * edge so users can tell categorised clips apart at a glance.
 *
 * @phase-3-77-clip-color-render
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import { CLIP_COLOR_HEX, type ClipColorId } from '../../src/shared/project'

declare global {
  interface Window {
    __reelsStore: {
      state: () => {
        project: {
          tracks: Array<{
            id: string
            kind: string
            clips: Array<{ id: string; color?: ClipColorId }>
          }>
        }
      }
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
      setClipColor: (id: string, color: ClipColorId | null) => void
    }
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => { createNew: () => void }
    }
  }
}

test.describe('@phase-3-77-clip-color-render Timeline color accent strip', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched!
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
    })
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
      await new Promise((r) => setTimeout(r, 900))
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

  async function openEditor(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({
      timeout: 30_000
    })
    await page.waitForSelector('[data-testid="editor-page"]', {
      state: 'attached',
      timeout: 45_000
    })
    await page.waitForFunction(
      () =>
        !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 8_000 }
    )
  }

  async function seedClip(): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4!
    return launched.page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = window.__reelsStore
      const mid = reels.newId()
      reels.addMedia({
        id: mid,
        path: filePath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width ?? 1080,
        height: probe.height ?? 1920,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      const track = reels
        .state()
        .project.tracks.find((t) => t.kind === 'video')!
      const cid = reels.newId()
      reels.addClip({
        id: cid,
        kind: 'media',
        mediaId: mid,
        trackId: track.id,
        startMs: 0,
        endMs: probe.durationMs,
        trimInMs: 0,
        trimOutMs: probe.durationMs,
        speed: 1
      })
      return cid
    }, fixture)
  }

  test('A-1 color unset → no strip rendered', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const cid = await seedClip()
    await page.waitForTimeout(200)
    const strip = page.locator(
      `[data-testid="clip-color-strip"][data-clip-id="${cid}"]`
    )
    expect(await strip.count()).toBe(0)
  })

  test('A-2 setClipColor("blue") → strip appears, data-clip-color = blue, computed bg matches hex', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const cid = await seedClip()
    await page.evaluate((id: string) => {
      window.__reelsStore.setClipColor(id, 'blue')
    }, cid)
    await page.waitForTimeout(200)
    const strip = page.locator(
      `[data-testid="clip-color-strip"][data-clip-id="${cid}"]`
    )
    await expect(strip).toBeVisible()
    expect(await strip.getAttribute('data-clip-color')).toBe('blue')
    // Computed bgcolor is in rgb() form. Convert the expected hex and compare.
    const hex = CLIP_COLOR_HEX.blue.slice(1)
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const computed = await strip.evaluate(
      (el) => getComputedStyle(el).backgroundColor
    )
    expect(computed).toMatch(
      new RegExp(`rgba?\\(${r},\\s*${g},\\s*${b}(?:,\\s*[0-9.]+)?\\)`)
    )
  })

  test('A-3 strip is pointer-events:none (clicks pass through)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const cid = await seedClip()
    await page.evaluate((id: string) => {
      window.__reelsStore.setClipColor(id, 'red')
    }, cid)
    await page.waitForTimeout(200)
    const strip = page.locator(
      `[data-testid="clip-color-strip"][data-clip-id="${cid}"]`
    )
    const pe = await strip.evaluate(
      (el) => getComputedStyle(el).pointerEvents
    )
    expect(pe).toBe('none')
  })

  test('A-4 clearing color (null) removes the strip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const cid = await seedClip()
    await page.evaluate((id: string) => {
      window.__reelsStore.setClipColor(id, 'green')
    }, cid)
    await page.waitForTimeout(200)
    await expect(
      page.locator(`[data-testid="clip-color-strip"][data-clip-id="${cid}"]`)
    ).toBeVisible()

    await page.evaluate((id: string) => {
      window.__reelsStore.setClipColor(id, null)
    }, cid)
    await page.waitForTimeout(200)
    expect(
      await page
        .locator(`[data-testid="clip-color-strip"][data-clip-id="${cid}"]`)
        .count()
    ).toBe(0)
  })
})
