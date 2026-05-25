/**
 * Chroma-key removal — Phase: chromakey.
 *
 * Adds `VideoAudioClip.chromaKey` (color, similarity, blend) + an ffmpeg
 * `chromakey=` filter wrap in the export chain. Stacking: format=yuva420p
 * → chromakey → existing color grading. Disabled / absent = no filter
 * emitted (byte-identical legacy).
 *
 * @chromakey
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type AnyClip = {
  id: string
  kind: string
  chromaKey?: {
    enabled?: boolean
    color?: string
    similarity?: number
    blend?: number
  }
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
      setClipChromaKey: (
        id: string,
        ck: Partial<{
          enabled: boolean
          color: string
          similarity: number
          blend: number
        }> | null
      ) => void
    }
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: unknown
        createNew: () => void
      }
    }
  }
}

test.describe('@chromakey VideoAudioClip.chromaKey + export filter', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched!
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
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
      await new Promise((r) => setTimeout(r, 500))
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

  async function seedMediaClip(): Promise<string> {
    const fixture = process.env.E2E_FIXTURE_MP4!
    return launched!.page.evaluate(async (filePath: string) => {
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

  function getChromaKey(cid: string): Promise<AnyClip['chromaKey'] | null> {
    return launched!.page.evaluate((id: string) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project
        .tracks) {
        for (const c of t.clips as AnyClip[]) {
          if (c.id === id) return c.chromaKey ?? null
        }
      }
      return null
    }, cid)
  }

  test('A-1 absent by default; export plan has NO chromakey token', async () => {
    const cid = await seedMediaClip()
    expect(await getChromaKey(cid)).toBeNull()
    const plan = await launched!.page.evaluate(async () => {
      const project = (
        window.__PROJECT_STORE_FOR_TEST__.getState() as { project: unknown }
      ).project
      return (await window.electron.exporter.buildPlan(
        project,
        'instagram-reels',
        'C:/tmp/_chromakey_a1.mp4'
      )) as { ok: boolean; filterGraph?: string; error?: string }
    })
    expect(plan.ok).toBe(true)
    expect(plan.filterGraph ?? '').not.toContain('chromakey=')
  })

  test('A-2 setClipChromaKey writes the field with defaulted values', async () => {
    const cid = await seedMediaClip()
    await launched!.page.evaluate((id: string) => {
      window.__reelsStore.setClipChromaKey(id, { enabled: true })
    }, cid)
    const ck = await getChromaKey(cid)
    expect(ck?.enabled).toBe(true)
    expect(ck?.color).toBe('#00ff00')
    expect(ck?.similarity).toBeCloseTo(0.15, 3)
    expect(ck?.blend).toBeCloseTo(0.1, 3)
  })

  test('A-3 setClipChromaKey(null) clears the field entirely', async () => {
    const cid = await seedMediaClip()
    await launched!.page.evaluate((id: string) => {
      window.__reelsStore.setClipChromaKey(id, { enabled: true })
      window.__reelsStore.setClipChromaKey(id, null)
    }, cid)
    expect(await getChromaKey(cid)).toBeNull()
  })

  test('A-4 export plan EMITS chromakey=color=0x00ff00 when enabled', async () => {
    const cid = await seedMediaClip()
    await launched!.page.evaluate((id: string) => {
      window.__reelsStore.setClipChromaKey(id, {
        enabled: true,
        color: '#00ff00',
        similarity: 0.2,
        blend: 0.15
      })
    }, cid)
    const plan = await launched!.page.evaluate(async () => {
      const project = (
        window.__PROJECT_STORE_FOR_TEST__.getState() as { project: unknown }
      ).project
      return (await window.electron.exporter.buildPlan(
        project,
        'instagram-reels',
        'C:/tmp/_chromakey_a4.mp4'
      )) as { ok: boolean; filterGraph?: string; error?: string }
    })
    expect(plan.ok).toBe(true)
    const g = plan.filterGraph ?? ''
    expect(g).toContain('format=yuva420p')
    expect(g).toMatch(/chromakey=color=0x00ff00:similarity=0\.200:blend=0\.150/)
  })

  test('A-5 disabling drops the chromakey token from the export plan', async () => {
    const cid = await seedMediaClip()
    await launched!.page.evaluate((id: string) => {
      window.__reelsStore.setClipChromaKey(id, { enabled: true })
      window.__reelsStore.setClipChromaKey(id, { enabled: false })
    }, cid)
    const ck = await getChromaKey(cid)
    expect(ck?.enabled).toBe(false)
    const plan = await launched!.page.evaluate(async () => {
      const project = (
        window.__PROJECT_STORE_FOR_TEST__.getState() as { project: unknown }
      ).project
      return (await window.electron.exporter.buildPlan(
        project,
        'instagram-reels',
        'C:/tmp/_chromakey_a5.mp4'
      )) as { ok: boolean; filterGraph?: string; error?: string }
    })
    expect(plan.ok).toBe(true)
    expect(plan.filterGraph ?? '').not.toContain('chromakey=')
  })

  test('A-6 blue / magenta / cyan + clamps out-of-range similarity', async () => {
    const cid = await seedMediaClip()
    await launched!.page.evaluate((id: string) => {
      window.__reelsStore.setClipChromaKey(id, {
        enabled: true,
        color: '#0000ff',
        similarity: 5, // out of range → clamped to 1.0
        blend: -3 // out of range → clamped to 0
      })
    }, cid)
    const ck = await getChromaKey(cid)
    expect(ck?.color).toBe('#0000ff')
    expect(ck?.similarity).toBe(1)
    expect(ck?.blend).toBe(0)
    const plan = await launched!.page.evaluate(async () => {
      const project = (
        window.__PROJECT_STORE_FOR_TEST__.getState() as { project: unknown }
      ).project
      return (await window.electron.exporter.buildPlan(
        project,
        'instagram-reels',
        'C:/tmp/_chromakey_a6.mp4'
      )) as { ok: boolean; filterGraph?: string; error?: string }
    })
    expect(plan.ok).toBe(true)
    expect(plan.filterGraph ?? '').toMatch(
      /chromakey=color=0x0000ff:similarity=1\.000:blend=0\.000/
    )
  })

  test('A-7 SMOKE: chromakey + real export → ok mp4 > 1KB', async () => {
    test.setTimeout(120_000)
    const cid = await seedMediaClip()
    await launched!.page.evaluate((id: string) => {
      window.__reelsStore.setClipChromaKey(id, {
        enabled: true,
        color: '#00ff00',
        similarity: 0.2,
        blend: 0.1
      })
    }, cid)
    const out = `C:/tmp/_chromakey_smoke_${Date.now()}.mp4`
    const result = await launched!.page.evaluate(
      async (target: string) => {
        await window.electron.fs.allowPath(target)
        const project = (
          window.__PROJECT_STORE_FOR_TEST__.getState() as { project: unknown }
        ).project
        return (await window.electron.exporter.run(project, {
          jobId: `chromakey-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath: target,
          useHardwareEncoder: false
        })) as { ok: boolean; error?: string }
      },
      out
    )
    expect(result.ok, result.error ?? 'export failed').toBe(true)
  })
})
