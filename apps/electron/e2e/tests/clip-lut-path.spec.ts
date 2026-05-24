/**
 * Phase 3.75 — per-clip user LUT (.cube) path metadata.
 *
 * v1 ships the data model + store action only. Export filter integration
 * (`lut3d=<path>` in `buildVideoSegmentChain`) + `fs:pickLut` IPC are
 * fast-follows.
 *
 * @phase-3-75-clip-lut-path
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type AnyClip = { id: string; lutPath?: string; [k: string]: unknown }

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
      setClipLutPath: (id: string, path: string | null) => void
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

test.describe('@phase-3-75-clip-lut-path setClipLutPath', () => {
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

  async function getLut(clipId: string): Promise<string | undefined> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate((cid: string) => {
      const tr = window.__PROJECT_STORE_FOR_TEST__
        .getState()
        .project.tracks.find((t) => t.kind === 'video')
      const c = tr?.clips.find((cc) => cc.id === cid)
      return c?.lutPath
    }, clipId)
  }

  test('A-1 setClipLutPath writes .cube path; null clears', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip()
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipLutPath(id, 'C:/luts/example.cube')
    }, cid)
    expect(await getLut(cid)).toBe('C:/luts/example.cube')

    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipLutPath(id, null)
    }, cid)
    expect(await getLut(cid)).toBeUndefined()
  })

  test('A-2 non-.cube extension is rejected (defensive — only LUT files allowed)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip()
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipLutPath(id, 'C:/luts/example.cube')
      window.__reelsStore.setClipLutPath(id, 'C:/totally/different.png')
    }, cid)
    expect(await getLut(cid)).toBe('C:/luts/example.cube')
  })

  test('A-3 empty string clears like null (BC-clean JSON)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip()
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipLutPath(id, 'C:/luts/x.cube')
      window.__reelsStore.setClipLutPath(id, '')
    }, cid)
    expect(await getLut(cid)).toBeUndefined()
  })

  test('A-4 case-insensitive .cube extension check', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip()
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipLutPath(id, 'C:/Some/LUT.CUBE')
    }, cid)
    expect(await getLut(cid)).toBe('C:/Some/LUT.CUBE')
  })
})
