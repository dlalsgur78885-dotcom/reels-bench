/**
 * Phase 3.57 — advanced trim modes: ripple / rolling / slip / slide.
 *
 * Store-level coverage (UI menu surface deferred to a follow-up so this
 * phase ships the actual behavior + harness gate first):
 *   A-1 rippleTrim out → clip shrinks; later clips translate by -delta.
 *   A-2 rippleTrim in  → clip shrinks (start shifts); later clips translate.
 *   A-3 rollingTrim out → boundary slides; combined timeline length preserved.
 *   A-4 rollingTrim in  → boundary slides the other way (this clip vs. prev).
 *   A-5 slipClip → trimIn/trimOut shift together; timeline window unchanged.
 *   A-6 slideClip → this clip moves; prev grows; next shrinks.
 *   A-7 ripple out delta that pushes trimOut < 0 → no-op.
 *   A-8 slip delta that pushes trimIn out of [0, media.durationMs] → no-op.
 *
 * @phase-3-57-advanced-trim
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type Clip = {
  id: string
  kind: string
  startMs: number
  endMs: number
  trimInMs: number
  trimOutMs: number
}

type ProjectStoreState = {
  project: {
    tracks: Array<{ id: string; kind: string; clips: Clip[] }>
    media: Record<string, { durationMs?: number }>
  }
  createNew: () => void
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStoreState }
    __reelsStore: {
      state: () => ProjectStoreState
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
      rippleTrim: (id: string, side: 'in' | 'out', delta: number) => void
      rollingTrim: (id: string, side: 'in' | 'out', delta: number) => void
      slipClip: (id: string, delta: number) => void
      slideClip: (id: string, delta: number) => void
    }
  }
}

test.describe('@phase-3-57-advanced-trim ripple/rolling/slip/slide', () => {
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
   * Seed N adjacent media clips of length `clipMs` each, starting at 0,
   * back-to-back on the first video track. Returns clip ids in order.
   */
  async function seedAdjacentClips(
    n: number,
    clipMs: number
  ): Promise<{ clipIds: string[]; mediaDurationMs: number }> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4!
    return launched.page.evaluate(
      async (args: { fixture: string; n: number; clipMs: number }) => {
        await window.electron.fs.allowPath(args.fixture)
        const probe = await window.electron.media.probe(args.fixture)
        const fileName = args.fixture.split(/[/\\]/).pop() ?? args.fixture
        const reels = window.__reelsStore
        const mid = reels.newId()
        const sourceDur = Math.max(args.clipMs * args.n, probe.durationMs)
        reels.addMedia({
          id: mid,
          path: args.fixture,
          kind: probe.kind,
          durationMs: sourceDur,
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
            trimInMs: i * args.clipMs,
            trimOutMs: (i + 1) * args.clipMs,
            speed: 1
          })
          ids.push(cid)
        }
        return { clipIds: ids, mediaDurationMs: sourceDur }
      },
      { fixture, n, clipMs }
    )
  }

  async function getClip(clipId: string): Promise<Clip | null> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate((cid: string) => {
      const tracks =
        window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks
      for (const t of tracks) {
        for (const c of t.clips) {
          if (c.id === cid) return c
        }
      }
      return null
    }, clipId)
  }

  test('A-1 rippleTrim out shrinks clip + shifts later clips by -delta', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { clipIds } = await seedAdjacentClips(3, 1000)
    const [c1, c2, c3] = clipIds
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.rippleTrim(id, 'out', 300)
    }, c1)
    const a = await getClip(c1)
    const b = await getClip(c2)
    const c = await getClip(c3)
    expect(a!.endMs).toBe(700)
    expect(a!.trimOutMs).toBe(700)
    expect(b!.startMs).toBe(700)
    expect(b!.endMs).toBe(1700)
    expect(c!.startMs).toBe(1700)
    expect(c!.endMs).toBe(2700)
  })

  test('A-2 rippleTrim in shifts clip start + later clips translate', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { clipIds } = await seedAdjacentClips(3, 1000)
    const [, c2, c3] = clipIds
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.rippleTrim(id, 'in', 200)
    }, c2)
    const b = await getClip(c2)
    const c = await getClip(c3)
    // c2 start moves +200 (shrinks), trimIn += 200, end unchanged.
    expect(b!.startMs).toBe(1200)
    expect(b!.endMs).toBe(2000)
    expect(b!.trimInMs).toBe(1200)
    // c3 translates by -200 (since c2 shrunk by 200).
    expect(c!.startMs).toBe(1800)
    expect(c!.endMs).toBe(2800)
  })

  test('A-3 rollingTrim out slides shared boundary; combined length preserved', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { clipIds } = await seedAdjacentClips(2, 1000)
    const [c1, c2] = clipIds
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.rollingTrim(id, 'out', 250)
    }, c1)
    const a = await getClip(c1)
    const b = await getClip(c2)
    expect(a!.endMs).toBe(1250)
    expect(a!.trimOutMs).toBe(1250)
    expect(b!.startMs).toBe(1250)
    expect(b!.endMs).toBe(2000)
    expect(b!.trimInMs).toBe(1250)
    // Combined timeline length: was 2000, still 2000.
    expect(b!.endMs - a!.startMs).toBe(2000)
  })

  test('A-4 rollingTrim in slides boundary the other way', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { clipIds } = await seedAdjacentClips(2, 1000)
    const [c1, c2] = clipIds
    await launched.page.evaluate((id: string) => {
      // From c2's perspective: rolling 'in' moves the c1/c2 boundary by -250.
      window.__reelsStore.rollingTrim(id, 'in', -250)
    }, c2)
    const a = await getClip(c1)
    const b = await getClip(c2)
    expect(a!.endMs).toBe(750)
    expect(a!.trimOutMs).toBe(750)
    expect(b!.startMs).toBe(750)
    expect(b!.endMs).toBe(2000)
    expect(b!.trimInMs).toBe(750)
  })

  test('A-5 slipClip shifts trimIn/trimOut but leaves timeline window untouched', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { clipIds } = await seedAdjacentClips(2, 1000)
    const [c1, c2] = clipIds
    const beforeC1 = await getClip(c1)
    const beforeC2 = await getClip(c2)
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.slipClip(id, 150)
    }, c1)
    const a = await getClip(c1)
    expect(a!.startMs).toBe(beforeC1!.startMs)
    expect(a!.endMs).toBe(beforeC1!.endMs)
    expect(a!.trimInMs).toBe(beforeC1!.trimInMs + 150)
    expect(a!.trimOutMs).toBe(beforeC1!.trimOutMs + 150)
    // c2 untouched.
    const b = await getClip(c2)
    expect(b!.startMs).toBe(beforeC2!.startMs)
    expect(b!.endMs).toBe(beforeC2!.endMs)
  })

  test('A-6 slideClip moves clip; prev extends; next shrinks', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { clipIds } = await seedAdjacentClips(3, 1000)
    const [c1, c2, c3] = clipIds
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.slideClip(id, 200)
    }, c2)
    const a = await getClip(c1)
    const b = await getClip(c2)
    const c = await getClip(c3)
    // prev (c1) extends by +200 at its trimOut end.
    expect(a!.endMs).toBe(1200)
    expect(a!.trimOutMs).toBe(1200)
    // c2 moves by +200 (start + end).
    expect(b!.startMs).toBe(1200)
    expect(b!.endMs).toBe(2200)
    expect(b!.trimInMs).toBe(1000) // unchanged
    // next (c3) shrinks: start moves +200, trimIn += 200.
    expect(c!.startMs).toBe(2200)
    expect(c!.endMs).toBe(3000)
    expect(c!.trimInMs).toBe(2200)
  })

  test('A-7 rippleTrim out: delta that would push trimOut < 0 → no-op', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { clipIds } = await seedAdjacentClips(2, 1000)
    const [c1, c2] = clipIds
    const beforeC2 = await getClip(c2)
    // c1.trimOutMs = 1000; delta 2000 would push it to -1000 → must no-op.
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.rippleTrim(id, 'out', 2000)
    }, c1)
    const a = await getClip(c1)
    const b = await getClip(c2)
    expect(a!.endMs).toBe(1000)
    expect(a!.trimOutMs).toBe(1000)
    expect(b!.startMs).toBe(beforeC2!.startMs)
    expect(b!.endMs).toBe(beforeC2!.endMs)
  })

  test('A-8 slipClip: delta that would push trimIn out of [0, media.durationMs] → no-op', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { clipIds } = await seedAdjacentClips(1, 1000)
    const [c1] = clipIds
    const before = await getClip(c1)
    // c1.trimInMs = 0; delta -100 → trimIn would be -100 → no-op.
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.slipClip(id, -100)
    }, c1)
    const a = await getClip(c1)
    expect(a!.trimInMs).toBe(before!.trimInMs)
    expect(a!.trimOutMs).toBe(before!.trimOutMs)
  })
})
