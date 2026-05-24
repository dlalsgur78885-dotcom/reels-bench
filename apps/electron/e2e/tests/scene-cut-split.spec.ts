/**
 * Phase 3.60 — scene-cut multi-split.
 *
 * The ffmpeg `scdet` IPC that yields actual scene-change timestamps lives
 * in a follow-up phase; this phase ships the receiving end — a store
 * action that splits a single clip at MANY timeline offsets atomically
 * (left→right ordering of result, descending-pass semantics, out-of-range
 * offsets silently dropped).
 *
 * Layer A (store):
 *   A-1 splitClipAtMany on three valid mid-clip offsets → 3 new ids, all
 *       four resulting clips back-to-back covering the original window.
 *   A-2 unsorted input is normalized; returned ids are left→right.
 *   A-3 out-of-range / NaN / duplicates are silently skipped.
 *   A-4 empty offsets list → [] no-op; clip count unchanged.
 *
 * @phase-3-60-scene-cut-split
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type Clip = {
  id: string
  startMs: number
  endMs: number
  trimInMs: number
  trimOutMs: number
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: {
          tracks: Array<{ id: string; kind: string; clips: Clip[] }>
          media: Record<string, { durationMs?: number }>
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
          tracks: Array<{ id: string; kind: string; clips: Clip[] }>
        }
      }
      splitClipAtMany: (id: string, atMsList: number[]) => string[]
    }
  }
}

test.describe('@phase-3-60-scene-cut-split splitClipAtMany', () => {
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

  async function seedClip(durationMs: number): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4!
    return launched.page.evaluate(
      async (args: { fixture: string; durationMs: number }) => {
        await window.electron.fs.allowPath(args.fixture)
        const probe = await window.electron.media.probe(args.fixture)
        const fileName = args.fixture.split(/[/\\]/).pop() ?? args.fixture
        const reels = window.__reelsStore
        const mid = reels.newId()
        reels.addMedia({
          id: mid,
          path: args.fixture,
          kind: probe.kind,
          durationMs: Math.max(args.durationMs, probe.durationMs),
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
          endMs: args.durationMs,
          trimInMs: 0,
          trimOutMs: args.durationMs,
          speed: 1
        })
        return cid
      },
      { fixture, durationMs }
    )
  }

  async function getTrackClips(): Promise<Clip[]> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const tr = window.__PROJECT_STORE_FOR_TEST__
        .getState()
        .project.tracks.find((t) => t.kind === 'video')
      return (tr?.clips as Clip[]) ?? []
    })
  }

  test('A-1 splits at three valid offsets → 3 new clips, all four span the original window', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip(4000)
    const newIds: string[] = await launched.page.evaluate((id: string) => {
      return window.__reelsStore.splitClipAtMany(id, [1000, 2000, 3000])
    }, cid)
    expect(newIds.length).toBe(3)
    const clips = await getTrackClips()
    expect(clips.length).toBe(4)
    const ordered = [...clips].sort((a, b) => a.startMs - b.startMs)
    expect(ordered[0].startMs).toBe(0)
    expect(ordered[0].endMs).toBe(1000)
    expect(ordered[1].startMs).toBe(1000)
    expect(ordered[1].endMs).toBe(2000)
    expect(ordered[2].startMs).toBe(2000)
    expect(ordered[2].endMs).toBe(3000)
    expect(ordered[3].startMs).toBe(3000)
    expect(ordered[3].endMs).toBe(4000)
  })

  test('A-2 unsorted offsets → result ids in left→right timeline order', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip(4000)
    const newIds: string[] = await launched.page.evaluate((id: string) => {
      return window.__reelsStore.splitClipAtMany(id, [3000, 1000, 2000])
    }, cid)
    expect(newIds.length).toBe(3)
    const clips = await getTrackClips()
    const idStart = new Map<string, number>()
    for (const c of clips) idStart.set(c.id, c.startMs)
    // ids in returned order — startMs should be ascending.
    const starts = newIds.map((id) => idStart.get(id) ?? -1)
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1])
    }
  })

  test('A-3 invalid / out-of-range / duplicate offsets are silently dropped', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip(4000)
    const newIds: string[] = await launched.page.evaluate((id: string) => {
      // -100 (out), 5000 (out), NaN, 1500 (valid), 1500 (duplicate — second
      // call on a clip starting at 1500 would be out of range), 2500 (valid)
      return window.__reelsStore.splitClipAtMany(id, [
        -100,
        5000,
        Number.NaN,
        1500,
        1500,
        2500
      ])
    }, cid)
    // Two unique valid offsets (1500, 2500) should produce 2 ids
    // (the second 1500 attempt operates on a fragment that no longer
    // contains 1500 once the first 1500-split happened — silently drops).
    expect(newIds.length).toBe(2)
    const clips = await getTrackClips()
    // 3 fragments total.
    expect(clips.length).toBe(3)
  })

  test('A-4 empty offsets list → no-op (zero ids returned, clip count unchanged)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const cid = await seedClip(2000)
    const beforeCount = (await getTrackClips()).length
    const newIds: string[] = await launched.page.evaluate((id: string) => {
      return window.__reelsStore.splitClipAtMany(id, [])
    }, cid)
    expect(newIds).toEqual([])
    const afterCount = (await getTrackClips()).length
    expect(afterCount).toBe(beforeCount)
  })
})
