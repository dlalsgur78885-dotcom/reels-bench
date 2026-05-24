/**
 * Phase 3.84 — Timeline fade handles + drag.
 *
 * Two 8px markers on each media-clip block (`fade-handle-left` /
 * `fade-handle-right`). Drag horizontally to set `fadeInMs` / `fadeOutMs`
 * in real time via `setClipFade`.
 *
 * @phase-3-84-fade-handle-drag
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type AnyClip = {
  id: string
  kind: string
  fadeInMs?: number
  fadeOutMs?: number
  startMs: number
  endMs: number
}

declare global {
  interface Window {
    __reelsStore: {
      state: () => {
        project: {
          tracks: Array<{ id: string; kind: string; clips: AnyClip[] }>
        }
      }
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
      setClipFade: (id: string, fin: number, fout: number) => void
    }
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: {
          tracks: Array<{ id: string; kind: string; clips: AnyClip[] }>
        }
        createNew: () => void
      }
    }
  }
}

test.describe('@phase-3-84-fade-handle-drag Timeline fade handles', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched!
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
    })
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
      await new Promise((r) => setTimeout(r, 700))
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

  async function getClip(clipId: string): Promise<AnyClip | null> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate((cid: string) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project
        .tracks) {
        for (const c of t.clips) {
          if (c.id === cid) return c
        }
      }
      return null
    }, clipId)
  }

  test('A-1 both fade handles render on every media clip block', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const cid = await seedClip()
    await page.waitForTimeout(200)
    await expect(
      page.locator(`[data-testid="fade-handle-left"][data-clip-id="${cid}"]`)
    ).toBeVisible()
    await expect(
      page.locator(`[data-testid="fade-handle-right"][data-clip-id="${cid}"]`)
    ).toBeVisible()
  })

  test('A-2 setClipFade updates handle data attributes (smoke)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const cid = await seedClip()
    await page.waitForTimeout(200)
    await page.evaluate((id: string) => {
      window.__reelsStore.setClipFade(id, 500, 300)
    }, cid)
    await page.waitForTimeout(200)
    const left = page.locator(
      `[data-testid="fade-handle-left"][data-clip-id="${cid}"]`
    )
    const right = page.locator(
      `[data-testid="fade-handle-right"][data-clip-id="${cid}"]`
    )
    expect(await left.getAttribute('data-fade-ms')).toBe('500')
    expect(await right.getAttribute('data-fade-ms')).toBe('300')
  })

  test('A-3 dragging the left handle to the right increases fadeInMs', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const cid = await seedClip()
    await page.waitForTimeout(200)
    const handle = page.locator(
      `[data-testid="fade-handle-left"][data-clip-id="${cid}"]`
    )
    const box = await handle.boundingBox()
    if (!box) throw new Error('fade handle has no bounding box')
    // Drag 40px to the right.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, {
      steps: 5
    })
    await page.mouse.up()
    await page.waitForTimeout(200)
    const c = await getClip(cid)
    expect((c?.fadeInMs ?? 0) > 0).toBe(true)
  })

  test('A-4 dragging the right handle to the LEFT increases fadeOutMs', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const cid = await seedClip()
    await page.waitForTimeout(200)
    const handle = page.locator(
      `[data-testid="fade-handle-right"][data-clip-id="${cid}"]`
    )
    const box = await handle.boundingBox()
    if (!box) throw new Error('fade handle has no bounding box')
    // Drag 40px to the LEFT (negative dx) — fadeOut grows with leftward drag.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2, {
      steps: 5
    })
    await page.mouse.up()
    await page.waitForTimeout(200)
    const c = await getClip(cid)
    expect((c?.fadeOutMs ?? 0) > 0).toBe(true)
  })
})
