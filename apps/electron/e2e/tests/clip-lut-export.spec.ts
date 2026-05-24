/**
 * Phase 3.79 — LUT export integration.
 *
 * Phase 3.75 added `clip.lutPath` data + store action. This phase wires
 * the export pipeline so `lut3d='<path>'` lands in the filter graph
 * between the filter preset and the manual color-adjust chain. UI for
 * the file picker is a follow-up — the underlying `fs.pickFile` IPC
 * already accepts `{name, extensions: ['cube']}` filters.
 *
 * @phase-3-79-clip-lut-export
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import type { ClipColorId } from '../../src/shared/project'

type AnyClip = {
  id: string
  lutPath?: string
  color?: ClipColorId
  [k: string]: unknown
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
      setClipLutPath: (id: string, path: string | null) => void
    }
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: unknown
        createNew: () => void
      }
    }
  }
}

test.describe('@phase-3-79-clip-lut-export buildPlan lut3d integration', () => {
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

  async function buildPlan(): Promise<{
    ok: boolean
    filterGraph?: string
    error?: string
  }> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(async () => {
      const project = (
        window.__PROJECT_STORE_FOR_TEST__.getState() as { project: unknown }
      ).project
      const r = (await window.electron.exporter.buildPlan(
        project,
        'instagram-reels',
        'C:/tmp/lut-plan.mp4'
      )) as { ok: boolean; filterGraph?: string; error?: string }
      return r
    })
  }

  test('A-1 no lutPath → filterGraph contains NO lut3d (byte-identical)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    await seedClip()
    const plan = await buildPlan()
    expect(plan.ok).toBe(true)
    expect(plan.filterGraph ?? '').not.toContain('lut3d=')
  })

  test('A-2 valid .cube lutPath → filterGraph contains lut3d with forward slashes', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip()
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipLutPath(id, 'C:\\\\luts\\\\my-look.cube')
    }, cid)
    const plan = await buildPlan()
    expect(plan.ok).toBe(true)
    const fg = plan.filterGraph ?? ''
    // Path was Windows-style; export normalises to forward slashes.
    expect(fg).toContain("lut3d='C:/luts/my-look.cube'")
  })

  test('A-3 lut3d lands AFTER the filter preset and BEFORE colorAdjust', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip()
    await launched.page.evaluate((id: string) => {
      window.__PROJECT_STORE_FOR_TEST__
        .getState()
        // @ts-expect-error testBridge: setClipFilter
        .setClipFilter(id, 'cinematic')
      window.__PROJECT_STORE_FOR_TEST__
        .getState()
        // @ts-expect-error testBridge: setClipColorAdjust
        .setClipColorAdjust(id, { brightness: 20 })
      window.__reelsStore.setClipLutPath(id, '/luts/A.cube')
    }, cid)
    const plan = await buildPlan()
    const fg = plan.filterGraph ?? ''
    const presetIdx = fg.indexOf('eq=contrast=')
    const lutIdx = fg.indexOf('lut3d=')
    const caIdx = fg.indexOf('eq=brightness=')
    // All three present.
    expect(presetIdx).toBeGreaterThan(-1)
    expect(lutIdx).toBeGreaterThan(-1)
    expect(caIdx).toBeGreaterThan(-1)
    // Order: preset → lut3d → colorAdjust.
    expect(presetIdx).toBeLessThan(lutIdx)
    expect(lutIdx).toBeLessThan(caIdx)
  })

  test('A-4 lutPath cleared → lut3d disappears (BC-safe round trip)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip()
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipLutPath(id, '/x.cube')
      window.__reelsStore.setClipLutPath(id, null)
    }, cid)
    const plan = await buildPlan()
    expect(plan.filterGraph ?? '').not.toContain('lut3d=')
  })
})
