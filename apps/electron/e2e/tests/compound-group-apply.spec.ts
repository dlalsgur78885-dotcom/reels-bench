/**
 * Phase 3.61 — compound clip / group batch apply.
 *
 * `applyToGroup(groupId, patch)` is the "compound clip" lever: a single
 * call propagates a uniform colorAdjust / filterPreset / transform across
 * every clip that shares a groupId. Locked members are silently skipped;
 * caption clips in the group are ignored (no matching fields).
 *
 * Layer A (store):
 *   A-1 filterPreset patch → every video member gets the preset.
 *   A-2 colorAdjust merge → every member's slider updates without losing
 *       unspecified fields.
 *   A-3 transform patch (scale only) → every member's transform.scale set.
 *   A-4 invalid groupId / empty patch → 0 modified (no-op).
 *   A-5 locked member is skipped; unlocked siblings still get the patch.
 *
 * @phase-3-61-compound-group-apply
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type AnyClip = Record<string, unknown> & {
  id: string
  kind: string
  groupId?: string
  filterPreset?: string
  colorAdjust?: {
    brightness: number
    contrast: number
    saturation: number
    temperature: number
  }
  transform?: {
    x: number
    y: number
    scale: number
    rotation: number
    opacity: number
  }
  locked?: boolean
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: {
          tracks: Array<{ id: string; kind: string; clips: AnyClip[] }>
        }
        createNew: () => void
      }
    }
    __reelsStore: {
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
      state: () => {
        project: {
          tracks: Array<{ id: string; kind: string; clips: AnyClip[] }>
        }
      }
      groupClips: (ids: string[]) => string | null
      setClipLocked: (id: string, locked: boolean) => void
      applyToGroup: (
        groupId: string,
        patch: {
          colorAdjust?: Partial<{
            brightness: number
            contrast: number
            saturation: number
            temperature: number
          }>
          filterPreset?: string
          filterIntensity?: number
          transform?: Partial<{
            x: number
            y: number
            scale: number
            rotation: number
            opacity: number
          }>
        }
      ) => number
    }
  }
}

test.describe('@phase-3-61-compound-group-apply applyToGroup', () => {
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

  /**
   * Seed N adjacent media clips and group them. Returns the groupId and the
   * member ids in order.
   */
  async function seedGroup(
    n: number,
    clipMs = 800
  ): Promise<{ groupId: string; clipIds: string[] }> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4!
    return launched.page.evaluate(
      async (args: { fixture: string; n: number; clipMs: number }) => {
        await window.electron.fs.allowPath(args.fixture)
        const probe = await window.electron.media.probe(args.fixture)
        const fileName = args.fixture.split(/[/\\]/).pop() ?? args.fixture
        const reels = window.__reelsStore
        const mid = reels.newId()
        reels.addMedia({
          id: mid,
          path: args.fixture,
          kind: probe.kind,
          durationMs: Math.max(args.n * args.clipMs, probe.durationMs),
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
        const ids: string[] = []
        for (let i = 0; i < args.n; i++) {
          const cid = reels.newId()
          reels.addClip({
            id: cid,
            kind: 'media',
            mediaId: mid,
            trackId: track.id,
            startMs: i * args.clipMs,
            endMs: (i + 1) * args.clipMs,
            trimInMs: 0,
            trimOutMs: args.clipMs,
            speed: 1
          })
          ids.push(cid)
        }
        const groupId = reels.groupClips(ids)!
        return { groupId, clipIds: ids }
      },
      { fixture, n, clipMs }
    )
  }

  async function getClips(): Promise<AnyClip[]> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const tr = window.__PROJECT_STORE_FOR_TEST__
        .getState()
        .project.tracks.find((t) => t.kind === 'video')
      return (tr?.clips as AnyClip[]) ?? []
    })
  }

  test('A-1 filterPreset patch propagates to every group member', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { groupId, clipIds } = await seedGroup(3)
    const modified = await launched.page.evaluate((gid: string) => {
      return window.__reelsStore.applyToGroup(gid, {
        filterPreset: 'cinematic'
      })
    }, groupId)
    expect(modified).toBe(3)
    const clips = await getClips()
    for (const id of clipIds) {
      const c = clips.find((x) => x.id === id)!
      expect(c.filterPreset).toBe('cinematic')
    }
  })

  test('A-2 colorAdjust partial merge — unspecified sliders stay neutral, brightness lifts', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { groupId, clipIds } = await seedGroup(2)
    const modified = await launched.page.evaluate((gid: string) => {
      return window.__reelsStore.applyToGroup(gid, {
        colorAdjust: { brightness: 30 }
      })
    }, groupId)
    expect(modified).toBe(2)
    const clips = await getClips()
    for (const id of clipIds) {
      const c = clips.find((x) => x.id === id)!
      expect(c.colorAdjust?.brightness).toBe(30)
      expect(c.colorAdjust?.contrast).toBe(0)
      expect(c.colorAdjust?.saturation).toBe(0)
      expect(c.colorAdjust?.temperature).toBe(0)
    }
  })

  test('A-3 transform patch (scale 1.5) propagates to every member', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { groupId, clipIds } = await seedGroup(2)
    const modified = await launched.page.evaluate((gid: string) => {
      return window.__reelsStore.applyToGroup(gid, {
        transform: { scale: 1.5 }
      })
    }, groupId)
    expect(modified).toBe(2)
    const clips = await getClips()
    for (const id of clipIds) {
      const c = clips.find((x) => x.id === id)!
      expect(c.transform?.scale).toBeCloseTo(1.5, 4)
    }
  })

  test('A-4 invalid groupId / empty patch → 0 modified (no-op)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { groupId } = await seedGroup(2)
    const modifiedUnknown = await launched.page.evaluate(() => {
      return window.__reelsStore.applyToGroup('no-such-group', {
        filterPreset: 'cinematic'
      })
    })
    expect(modifiedUnknown).toBe(0)
    const modifiedEmpty = await launched.page.evaluate((gid: string) => {
      return window.__reelsStore.applyToGroup(gid, {})
    }, groupId)
    expect(modifiedEmpty).toBe(0)
  })

  test('A-5 locked member is skipped; unlocked sibling still gets the patch', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { groupId, clipIds } = await seedGroup(2)
    const [first, second] = clipIds
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setClipLocked(id, true)
    }, first)
    const modified = await launched.page.evaluate((gid: string) => {
      return window.__reelsStore.applyToGroup(gid, {
        filterPreset: 'vibrant'
      })
    }, groupId)
    expect(modified).toBe(1)
    const clips = await getClips()
    const a = clips.find((x) => x.id === first)!
    const b = clips.find((x) => x.id === second)!
    // Locked clip kept its (absent) filterPreset.
    expect(a.filterPreset).toBeUndefined()
    expect(b.filterPreset).toBe('vibrant')
  })
})
