/**
 * Countdown / count-up captions — Phase: countdown-captions.
 *
 * `addCountdownCaptions({ startMs, intervalMs, from, to, prefix?, suffix?})`
 * inserts N caption clips (one per interval) carrying the stepping number as
 * static text. Static = renders via PNG path (Korean glyphs + font picker +
 * SVG karaoke all keep working) and preview matches export 1:1.
 *
 * @countdown-captions
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type AnyClip = {
  id: string
  kind: string
  startMs: number
  endMs: number
  spans?: Array<{ text: string }>
  style?: { fontSize?: number; align?: string }
}

declare global {
  interface Window {
    __reelsStore: {
      state: () => {
        project: {
          tracks: Array<{ id: string; kind: string; clips: AnyClip[] }>
        }
      }
      newId: () => string
      addCountdownCaptions: (opts: {
        startMs: number
        intervalMs: number
        from: number
        to: number
        prefix?: string
        suffix?: string
        style?: unknown
        animation?: unknown
      }) => string[]
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

test.describe('@countdown-captions addCountdownCaptions', () => {
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

  function readCaptions(): Promise<AnyClip[]> {
    return launched!.page.evaluate(() => {
      const t = window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks.find(
        (t) => t.kind === 'caption'
      )
      return t ? (t.clips as AnyClip[]) : []
    })
  }

  test('A-1 3 → 0 emits 4 clips with "3" "2" "1" "0" at 1s spacing', async () => {
    const ids = await launched!.page.evaluate(() => {
      return window.__reelsStore.addCountdownCaptions({
        startMs: 0,
        intervalMs: 1000,
        from: 3,
        to: 0
      })
    })
    expect(ids.length).toBe(4)
    const caps = await readCaptions()
    expect(caps.length).toBe(4)
    expect(caps.map((c) => c.spans?.[0]?.text)).toEqual(['3', '2', '1', '0'])
    expect(caps.map((c) => c.startMs)).toEqual([0, 1000, 2000, 3000])
    expect(caps.map((c) => c.endMs)).toEqual([1000, 2000, 3000, 4000])
  })

  test('A-2 count-UP 1 → 5 emits 5 clips ascending', async () => {
    await launched!.page.evaluate(() => {
      window.__reelsStore.addCountdownCaptions({
        startMs: 2000,
        intervalMs: 500,
        from: 1,
        to: 5
      })
    })
    const caps = await readCaptions()
    expect(caps.map((c) => c.spans?.[0]?.text)).toEqual(['1', '2', '3', '4', '5'])
    expect(caps[0].startMs).toBe(2000)
    expect(caps[caps.length - 1].endMs).toBe(2000 + 5 * 500)
  })

  test('A-3 Korean suffix "초" round-trips on every clip', async () => {
    await launched!.page.evaluate(() => {
      window.__reelsStore.addCountdownCaptions({
        startMs: 0,
        intervalMs: 1000,
        from: 3,
        to: 1,
        suffix: '초'
      })
    })
    const caps = await readCaptions()
    expect(caps.map((c) => c.spans?.[0]?.text)).toEqual(['3초', '2초', '1초'])
  })

  test('A-4 prefix + suffix combine ("D-3 일" 패턴)', async () => {
    await launched!.page.evaluate(() => {
      window.__reelsStore.addCountdownCaptions({
        startMs: 0,
        intervalMs: 1000,
        from: 3,
        to: 1,
        prefix: 'D-',
        suffix: ' 일'
      })
    })
    const caps = await readCaptions()
    expect(caps.map((c) => c.spans?.[0]?.text)).toEqual([
      'D-3 일',
      'D-2 일',
      'D-1 일'
    ])
  })

  test('A-5 style override merges with defaults (fontSize/align preserved unless set)', async () => {
    await launched!.page.evaluate(() => {
      window.__reelsStore.addCountdownCaptions({
        startMs: 0,
        intervalMs: 1000,
        from: 1,
        to: 1, // → no-op per spec (from === to)
        style: { fontSize: 200 }
      })
    })
    let caps = await readCaptions()
    expect(caps.length).toBe(0) // no-op guard

    await launched!.page.evaluate(() => {
      window.__reelsStore.addCountdownCaptions({
        startMs: 0,
        intervalMs: 1000,
        from: 2,
        to: 1,
        style: { fontSize: 200, align: 'left' }
      })
    })
    caps = await readCaptions()
    expect(caps[0].style?.fontSize).toBe(200)
    expect(caps[0].style?.align).toBe('left')
  })

  test('A-6 invalid inputs → no-op (no clips added)', async () => {
    await launched!.page.evaluate(() => {
      // intervalMs ≤ 0
      window.__reelsStore.addCountdownCaptions({
        startMs: 0,
        intervalMs: 0,
        from: 3,
        to: 0
      })
      // from === to
      window.__reelsStore.addCountdownCaptions({
        startMs: 0,
        intervalMs: 1000,
        from: 5,
        to: 5
      })
      // negative intervalMs
      window.__reelsStore.addCountdownCaptions({
        startMs: 0,
        intervalMs: -500,
        from: 3,
        to: 0
      })
    })
    expect((await readCaptions()).length).toBe(0)
  })

  test('A-7 count > 999 cap → no-op (guards against accidental millions)', async () => {
    await launched!.page.evaluate(() => {
      window.__reelsStore.addCountdownCaptions({
        startMs: 0,
        intervalMs: 1,
        from: 0,
        to: 9999
      })
    })
    expect((await readCaptions()).length).toBe(0)
  })

  test('A-8 export plan emits N caption overlays from the countdown', async () => {
    const fixture = process.env.E2E_FIXTURE_MP4!
    // Seed a base media clip so the export plan has a video stream to map.
    await launched!.page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const reels = window.__reelsStore as unknown as {
        newId: () => string
        addMedia: (m: unknown) => void
        addClip: (c: unknown) => void
        state: () => {
          project: { tracks: Array<{ id: string; kind: string }> }
        }
      }
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
        fileName: 'test.mp4',
        fileSizeBytes: 0
      })
      const vt = reels
        .state()
        .project.tracks.find((t) => t.kind === 'video')!
      reels.addClip({
        id: reels.newId(),
        kind: 'media',
        mediaId: mid,
        trackId: vt.id,
        startMs: 0,
        endMs: probe.durationMs,
        trimInMs: 0,
        trimOutMs: probe.durationMs,
        speed: 1
      })
    }, fixture)
    await launched!.page.evaluate(() => {
      window.__reelsStore.addCountdownCaptions({
        startMs: 0,
        intervalMs: 1000,
        from: 3,
        to: 1
      })
    })
    const plan = await launched!.page.evaluate(async () => {
      const project = (
        window.__PROJECT_STORE_FOR_TEST__.getState() as { project: unknown }
      ).project
      return (await window.electron.exporter.buildPlan(
        project,
        'instagram-reels',
        'C:/tmp/_countdown.mp4'
      )) as { ok: boolean; filterGraph?: string; error?: string }
    })
    expect(plan.ok, plan.error ?? 'buildPlan failed').toBe(true)
    // Each caption clip becomes an overlay PNG referenced from filterGraph;
    // the overlay enable window mentions between(t,N.000,(N+1).000). Three
    // counts → three between() expressions.
    const g = plan.filterGraph ?? ''
    expect((g.match(/between\(t,/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
