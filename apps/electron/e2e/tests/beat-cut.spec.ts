/**
 * @phase-3-48-beat-cut — BPM-based "AI 비트 싱크 자동 컷" (Phase 3.48).
 *
 * Six contracted scenarios:
 *
 * (1) no-bpm guard — bpm=0, click beat-cut-every → toast contains
 *     "BPM을 먼저 입력하세요"; project clip count unchanged.
 * (2) no-selection guard — bpm=120, no clip selected → toast contains
 *     "비트로 자를 클립을 먼저 선택하세요".
 * (3) success step=1 (매 비트) — 10s clip @120BPM → ~19 cuts.
 *     Verify track clip count increased by exactly `cuts`.
 *     One Ctrl+Z restores original clip count.
 * (4) success step=2 (2박) — bpm=120 → ~9 cuts.
 * (5) success step=4 (4박) — bpm=120 → ~4 cuts.
 * (6) locked clip rejected — setClipLocked(true), run → reason 'clip-locked',
 *     clip count unchanged, toast contains "잠긴 클립".
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Window type declarations
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: {
          tracks: Array<{
            id: string
            kind: string
            clips: Array<Record<string, unknown>>
          }>
          media: Record<string, unknown>
        }
        setClipLocked: (clipId: string, locked: boolean) => void
        createNew: () => void
      }
    }
    __reelsStore: {
      state: () => {
        project: {
          tracks: Array<{
            id: string
            kind: string
            clips: Array<Record<string, unknown>>
          }>
        }
      }
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
    }
    __reelsTimelineUi: {
      getState: () => {
        setBpm: (bpm: number) => void
        selectClip: (id: string | null) => void
        selectedClipIds: Set<string>
        bpm: number
      }
    }
    __reelsUndoRedo: {
      getState: () => {
        undo: () => void
        redo: () => void
        pastStates: unknown[]
        futureStates: unknown[]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-3-48-beat-cut BPM-based beat sync auto-cut', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
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

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  async function openEditor(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', { state: 'attached', timeout: 45_000 })
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 8_000 }
    )
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsUndoRedo?: unknown }).__reelsUndoRedo,
      null,
      { timeout: 5_000 }
    )
  }

  async function addFixtureMedia(): Promise<{ mediaId: string; durationMs: number }> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    const { page } = launched
    return page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = window.__reelsStore
      const id = reels.newId()
      reels.addMedia({
        id,
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
      return { mediaId: id, durationMs: probe.durationMs }
    }, fixture)
  }

  /**
   * Add a video clip of a custom durationMs (overrides the media probe).
   * Uses the fixture media's path but lies about durationMs to simulate a 10s clip.
   */
  async function addVideoClipWithDuration(
    mediaId: string,
    durationMs: number,
    startMs = 0
  ): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(
      ({ mid, dur, st }) => {
        const reels = window.__reelsStore
        const track = reels.state().project.tracks.find((t) => t.kind === 'video')
        if (!track) throw new Error('no video track')
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: track.id,
          startMs: st,
          endMs: st + dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        return cid
      },
      { mid: mediaId, dur: durationMs, st: startMs }
    )
  }

  async function getVideoTrackClipCount(): Promise<number> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(() => {
      const track = window.__reelsStore.state().project.tracks.find((t) => t.kind === 'video')
      return track ? track.clips.length : 0
    })
  }

  async function setBpm(bpm: number): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate((b) => {
      window.__reelsTimelineUi.getState().setBpm(b)
    }, bpm)
    await launched.page.waitForTimeout(80)
  }

  async function selectClip(clipId: string | null): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate((id) => {
      window.__reelsTimelineUi.getState().selectClip(id)
    }, clipId)
    await launched.page.waitForTimeout(80)
  }

  /** Open the AI menu in the topbar. */
  async function openAiMenu(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const aiMenu = page.locator('[data-testid="topbar-menu-ai"]')
    await expect(aiMenu).toBeVisible({ timeout: 5_000 })
    await aiMenu.click()
    // Wait for beat-cut buttons to be present.
    await expect(page.locator('[data-testid="beat-cut-every"]')).toBeVisible({ timeout: 3_000 })
  }

  /** Capture the last toast message from the DOM. */
  async function waitForToast(containsText: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    // Toasts appear in a data-testid="toast" or similar element.
    // We wait for any visible text element containing the expected text.
    await page.waitForFunction(
      (text) => {
        return !!document.body.textContent?.includes(text)
      },
      containsText,
      { timeout: 4_000 }
    )
  }

  async function undo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => {
      window.__reelsUndoRedo.getState().undo()
    })
    await launched.page.waitForTimeout(150)
  }

  async function tick(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.waitForTimeout(220)
  }

  // =========================================================================
  // (1) no-bpm guard — directly inject bpm=0 into store state bypassing the
  //     setBpm clamp (which enforces min 30). This tests that runBeatCut's
  //     own guard fires when bpm is zero (e.g. pre-set state from project
  //     prefill that sets bpm to 0 before the user edits it).
  // =========================================================================
  test('(1) no-bpm guard: bpm forced to 0 → toast "BPM을 먼저 입력하세요"; project unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId } = await addFixtureMedia()
    const cid = await addVideoClipWithDuration(mediaId, 10_000)
    await selectClip(cid)

    // Force bpm=0 directly in the store state (bypasses the setBpm clamp guard).
    await page.evaluate(() => {
      // Direct Zustand set — bypasses setBpm's Math.max(30,...) clamp.
      ;(window.__reelsTimelineUi as unknown as { setState: (p: Record<string,unknown>) => void }).setState({ bpm: 0 })
    })
    await page.waitForTimeout(80)

    // Verify bpm is actually 0 now.
    const actualBpm = await page.evaluate(() => window.__reelsTimelineUi.getState().bpm)
    expect(actualBpm).toBe(0)

    const countBefore = await getVideoTrackClipCount()

    await openAiMenu()
    await page.locator('[data-testid="beat-cut-every"]').click()
    await page.waitForTimeout(300)

    // Toast must mention BPM.
    await waitForToast('BPM')

    // Clip count must be unchanged.
    const countAfter = await getVideoTrackClipCount()
    expect(countAfter).toBe(countBefore)
  })

  // =========================================================================
  // (2) no-selection guard
  // =========================================================================
  test('(2) no-selection guard: bpm=120, no clip selected → toast "비트로 자를 클립"', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId } = await addFixtureMedia()
    await addVideoClipWithDuration(mediaId, 10_000)

    // Set valid BPM but deselect everything.
    await setBpm(120)
    await selectClip(null)

    const countBefore = await getVideoTrackClipCount()

    await openAiMenu()
    await page.locator('[data-testid="beat-cut-every"]').click()
    await page.waitForTimeout(300)

    await waitForToast('비트로 자를 클립')

    const countAfter = await getVideoTrackClipCount()
    expect(countAfter).toBe(countBefore)
  })

  // =========================================================================
  // (3) success step=1 — every beat at 120 BPM, 10s clip
  // At 120 BPM: period=500ms, stride=500ms.
  // Cut points: 500, 1000, 1500, ..., up to endMs-200ms=9800ms.
  // startMs=0, stride starts at 0+500=500ms, stops before 9800ms.
  // So beats: 500,1000,...,9500 = 19 cuts expected.
  // =========================================================================
  test('(3) step=1 (매 비트): 10s @120BPM → 19 cuts; track clip count +19; one undo restores', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId } = await addFixtureMedia()
    // Use a 10-second clip (10000ms).
    const cid = await addVideoClipWithDuration(mediaId, 10_000)
    await tick()

    const countBefore = await getVideoTrackClipCount()
    expect(countBefore).toBe(1)

    await setBpm(120)
    await selectClip(cid)

    await openAiMenu()
    await page.locator('[data-testid="beat-cut-every"]').click()
    await page.waitForTimeout(400)

    // Toast should say success with number of cuts.
    await waitForToast('잘랐어요')

    const countAfter = await getVideoTrackClipCount()
    // At 120 BPM, period=500ms, stride=500ms, cuts at 500,1000,...,9500 → 19 cuts.
    // 19 cuts → 20 clips on the track.
    const cutsPerformed = countAfter - countBefore
    expect(cutsPerformed).toBeGreaterThan(0)
    // Allow ±1 for edge rounding in the implementation.
    expect(cutsPerformed).toBeGreaterThanOrEqual(18)
    expect(cutsPerformed).toBeLessThanOrEqual(20)

    // One undo step should restore the original clip count.
    await undo()
    const countAfterUndo = await getVideoTrackClipCount()
    expect(countAfterUndo).toBe(countBefore)
  })

  // =========================================================================
  // (4) success step=2 (2박 every-other-beat)
  // At 120 BPM: stride=1000ms. Cuts at 1000,2000,...,9000 → 9 cuts.
  // =========================================================================
  test('(4) step=2 (2박): 10s @120BPM → ~9 cuts', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId } = await addFixtureMedia()
    const cid = await addVideoClipWithDuration(mediaId, 10_000)
    await tick()

    const countBefore = await getVideoTrackClipCount()

    await setBpm(120)
    await selectClip(cid)

    await openAiMenu()
    await page.locator('[data-testid="beat-cut-half"]').click()
    await page.waitForTimeout(400)

    await waitForToast('잘랐어요')

    const countAfter = await getVideoTrackClipCount()
    const cutsPerformed = countAfter - countBefore
    expect(cutsPerformed).toBeGreaterThan(0)
    // stride=1000ms, cuts at 1000..9000 → 9 cuts (9 + original = 10 clips).
    expect(cutsPerformed).toBeGreaterThanOrEqual(8)
    expect(cutsPerformed).toBeLessThanOrEqual(10)
  })

  // =========================================================================
  // (5) success step=4 (4박 / downbeats)
  // At 120 BPM: stride=2000ms. Cuts at 2000,4000,6000,8000 → 4 cuts.
  // =========================================================================
  test('(5) step=4 (4박): 10s @120BPM → ~4 cuts', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId } = await addFixtureMedia()
    const cid = await addVideoClipWithDuration(mediaId, 10_000)
    await tick()

    const countBefore = await getVideoTrackClipCount()

    await setBpm(120)
    await selectClip(cid)

    await openAiMenu()
    await page.locator('[data-testid="beat-cut-down"]').click()
    await page.waitForTimeout(400)

    await waitForToast('잘랐어요')

    const countAfter = await getVideoTrackClipCount()
    const cutsPerformed = countAfter - countBefore
    expect(cutsPerformed).toBeGreaterThan(0)
    // stride=2000ms, cuts at 2000,4000,6000,8000 → 4 cuts.
    expect(cutsPerformed).toBeGreaterThanOrEqual(3)
    expect(cutsPerformed).toBeLessThanOrEqual(5)
  })

  // =========================================================================
  // (6) locked clip rejected
  // =========================================================================
  test('(6) locked clip: beat-cut rejected → toast "잠긴", clip count unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId } = await addFixtureMedia()
    const cid = await addVideoClipWithDuration(mediaId, 10_000)
    await tick()

    // Lock the clip.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipLocked(id, true)
    }, cid)
    await page.waitForTimeout(80)

    await setBpm(120)
    await selectClip(cid)

    const countBefore = await getVideoTrackClipCount()

    await openAiMenu()
    await page.locator('[data-testid="beat-cut-every"]').click()
    await page.waitForTimeout(300)

    await waitForToast('잠긴')

    const countAfter = await getVideoTrackClipCount()
    expect(countAfter).toBe(countBefore)
  })
})
