/**
 * Phase 3.74 — clip color label (UI metadata).
 *
 * v1 ships the data model + store action. The Timeline accent-strip
 * render is a fast-follow (CSS-only change inside ClipBlock).
 *
 * @phase-3-74-clip-color-label
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import {
  CLIP_COLOR_HEX,
  CLIP_COLOR_IDS,
  type ClipColorId
} from '../../src/shared/project'

type AnyClip = { id: string; color?: ClipColorId; [k: string]: unknown }

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
      setClipColor: (id: string, color: ClipColorId | null) => void
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

test.describe('@phase-3-74-clip-color-label setClipColor', () => {
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

  async function getColor(clipId: string): Promise<ClipColorId | undefined> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate((cid: string) => {
      const tr = window.__PROJECT_STORE_FOR_TEST__
        .getState()
        .project.tracks.find((t) => t.kind === 'video')
      const c = tr?.clips.find((cc) => cc.id === cid)
      return c?.color
    }, clipId)
  }

  test('A-1 catalog: 9 color ids (incl. none) and a hex for each', () => {
    expect(CLIP_COLOR_IDS.length).toBe(9)
    for (const id of CLIP_COLOR_IDS) {
      expect(CLIP_COLOR_HEX[id]).toBeTruthy()
    }
  })

  test('A-2 setClipColor("blue") writes color="blue"', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip()
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipColor(id, 'blue')
    }, cid)
    expect(await getColor(cid)).toBe('blue')
  })

  test('A-3 setClipColor("none") clears the field (BC-clean JSON)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip()
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipColor(id, 'red')
      window.__reelsStore.setClipColor(id, 'none')
    }, cid)
    expect(await getColor(cid)).toBeUndefined()
  })

  test('A-4 setClipColor(null) is identical to "none" — clears the field', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip()
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipColor(id, 'green')
      window.__reelsStore.setClipColor(id, null)
    }, cid)
    expect(await getColor(cid)).toBeUndefined()
  })

  test('A-5 unknown color id is rejected (no-op)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip()
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipColor(id, 'red')
      ;(window.__reelsStore.setClipColor as unknown as (
        id: string,
        color: unknown
      ) => void)(id, 'magenta')
    }, cid)
    expect(await getColor(cid)).toBe('red')
  })

  test('A-6 setClipColor on a missing clip is a no-op (no throw)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    await launched.page.evaluate(() => {
      window.__reelsStore.setClipColor('no-such', 'blue')
    })
    // Just expect no exception — the await above would throw otherwise.
    expect(true).toBe(true)
  })
})
