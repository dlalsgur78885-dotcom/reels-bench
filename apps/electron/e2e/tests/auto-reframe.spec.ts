/**
 * Phase 3.52 — Auto-Reframe (face tracking → transform keyframes).
 *
 * Layer A — pure math (no DOM): `window.__reelsAutoReframeMath.computeReframeTransform`.
 * Layer B — orchestrator e2e: `window.__reelsAutoReframeMockDetector` lets us
 *           swap MediaPipe for a deterministic JS mock. The real model fetch
 *           (~230 KB from googleapis) is NOT exercised here — too slow / too
 *           flaky in CI.
 *
 * @phase-3-52-auto-reframe
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Type bridges
// ---------------------------------------------------------------------------
type ClipTransform = {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
}
type TransformKeyframe = { atMs: number; transform: ClipTransform }

type FaceBox = {
  xFrac: number
  yFrac: number
  areaFrac: number
  score: number
}

type ReelsStore = {
  state: () => {
    project: {
      width: number
      height: number
      tracks: Array<{
        id: string
        kind: string
        clips: Array<Record<string, unknown>>
      }>
    }
  }
  addMedia: (a: unknown) => void
  addClip: (c: unknown) => void
  setClipLocked: (id: string, locked: boolean) => void
  addTransformKeyframe: (
    id: string,
    atMs: number,
    transform: Partial<ClipTransform>
  ) => void
  applyAutoReframeKeyframes: (id: string, kfs: TransformKeyframe[]) => void
  newId: () => string
}

declare global {
  interface Window {
    __reelsStore: ReelsStore
    __reelsAutoReframeMath: {
      computeReframeTransform: (
        source: { width: number; height: number },
        canvas: { width: number; height: number },
        face: { xFrac: number; yFrac: number },
        target?: { x: number; y: number }
      ) => ClipTransform
    }
    __reelsAutoReframeMockDetector?: (
      frame: ImageData,
      atMs: number
    ) => Promise<FaceBox[]>
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
// Shared helpers
// ---------------------------------------------------------------------------

async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
    null,
    { timeout: 8_000 }
  )
  await page.waitForFunction(
    () =>
      !!(window as unknown as { __reelsAutoReframeMath?: unknown })
        .__reelsAutoReframeMath,
    null,
    { timeout: 8_000 }
  )
}

async function resetProject(launched: LaunchedApp): Promise<void> {
  await launched.page.evaluate(async () => {
    window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
    await new Promise((r) => setTimeout(r, 700))
  })
}

async function getPastStatesCount(launched: LaunchedApp): Promise<number> {
  return launched.page.evaluate(() => {
    return window.__reelsUndoRedo.getState().pastStates.length
  })
}

interface SeededClip {
  mediaId: string
  clipId: string
  trackId: string
  durationMs: number
}

async function seedFixtureClip(
  launched: LaunchedApp,
  opts: { startMs?: number; durationMs?: number; trackIndex?: number } = {}
): Promise<SeededClip> {
  const fixture = process.env.E2E_FIXTURE_MP4
  if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
  const { page } = launched
  return page.evaluate(
    async (args: {
      filePath: string
      startMs: number
      durationMs: number | null
      trackIndex: number
    }) => {
      await window.electron.fs.allowPath(args.filePath)
      const probe = await window.electron.media.probe(args.filePath)
      const fileName = args.filePath.split(/[/\\]/).pop() ?? args.filePath
      const reels = window.__reelsStore
      const mid = reels.newId()
      const dur = args.durationMs ?? probe.durationMs
      reels.addMedia({
        id: mid,
        path: args.filePath,
        kind: probe.kind,
        durationMs: dur,
        width: probe.width ?? 320,
        height: probe.height ?? 240,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      const tracks = reels
        .state()
        .project.tracks.filter((t) => t.kind === 'video')
      const track = tracks[args.trackIndex] ?? tracks[0]
      if (!track) throw new Error('no video track')
      const cid = reels.newId()
      reels.addClip({
        id: cid,
        kind: 'media',
        mediaId: mid,
        trackId: track.id,
        startMs: args.startMs,
        endMs: args.startMs + dur,
        trimInMs: 0,
        trimOutMs: dur,
        speed: 1
      })
      return { mediaId: mid, clipId: cid, trackId: track.id, durationMs: dur }
    },
    {
      filePath: fixture,
      startMs: opts.startMs ?? 0,
      durationMs: opts.durationMs ?? null,
      trackIndex: opts.trackIndex ?? 0
    }
  )
}

async function getClip(
  launched: LaunchedApp,
  clipId: string
): Promise<Record<string, unknown> | null> {
  return launched.page.evaluate((cid) => {
    const reels = window.__reelsStore
    for (const t of reels.state().project.tracks)
      for (const c of t.clips) if ((c as { id: string }).id === cid) return c
    return null
  }, clipId)
}

/**
 * Force the project canvas to a specific (width, height) for the orchestrator
 * tests. Uses the test-only `__PROJECT_STORE_FOR_TEST__` directly because
 * `setAspectRatio` only accepts the named-ratio enum.
 */
async function setCanvas(
  launched: LaunchedApp,
  width: number,
  height: number
): Promise<void> {
  await launched.page.evaluate(
    ({ w, h }) => {
      const store = window.__PROJECT_STORE_FOR_TEST__
      const cur = store.getState().project
      store.setState({ project: { ...cur, width: w, height: h } })
    },
    { w: width, h: height }
  )
}

/**
 * Install a mock face detector on the page. The fn receives (frame, atMs)
 * and returns FaceBox[] in source-fraction coordinates.
 *
 * Since the mock can't be serialised across the page boundary, we accept a
 * STRING expression that evaluates to the function on the page side.
 */
async function installMockDetector(
  launched: LaunchedApp,
  fnSource: string
): Promise<void> {
  await launched.page.evaluate((src: string) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${src})`)()
    ;(window as unknown as {
      __reelsAutoReframeMockDetector: (
        frame: ImageData,
        atMs: number
      ) => Promise<FaceBox[]>
    }).__reelsAutoReframeMockDetector = fn
  }, fnSource)
}

async function clearMockDetector(launched: LaunchedApp): Promise<void> {
  await launched.page.evaluate(() => {
    delete (window as unknown as { __reelsAutoReframeMockDetector?: unknown })
      .__reelsAutoReframeMockDetector
  })
}

// ===========================================================================
// LAYER A — pure math
// ===========================================================================

test.describe('@phase-3-52-auto-reframe Layer A — pure math', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
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

  test('A-1 identity: 1080x1920 → 1080x1920, face center → scale=1, x=0, y=0', async () => {
    if (!launched) throw new Error('launch failed')
    const r = await launched.page.evaluate(() => {
      return window.__reelsAutoReframeMath.computeReframeTransform(
        { width: 1080, height: 1920 },
        { width: 1080, height: 1920 },
        { xFrac: 0.5, yFrac: 0.5 }
      )
    })
    expect(r.scale).toBeCloseTo(1, 5)
    expect(r.x).toBeCloseTo(0, 5)
    expect(r.y).toBeCloseTo(0, 5)
    expect(r.rotation).toBe(0)
    expect(r.opacity).toBe(1)
  })

  test('A-2 16:9 → 9:16 face center → scale ≈ 3.16, x≈0, y=0', async () => {
    if (!launched) throw new Error('launch failed')
    const r = await launched.page.evaluate(() => {
      return window.__reelsAutoReframeMath.computeReframeTransform(
        { width: 1920, height: 1080 },
        { width: 1080, height: 1920 },
        { xFrac: 0.5, yFrac: 0.5 }
      )
    })
    expect(r.scale).toBeCloseTo(3.16, 1)
    expect(r.x).toBeCloseTo(0, 5)
    expect(r.y).toBeCloseTo(0, 5)
  })

  test('A-3 16:9 → 9:16 face (0.7, 0.5) → x ≈ -0.632', async () => {
    if (!launched) throw new Error('launch failed')
    const r = await launched.page.evaluate(() => {
      return window.__reelsAutoReframeMath.computeReframeTransform(
        { width: 1920, height: 1080 },
        { width: 1080, height: 1920 },
        { xFrac: 0.7, yFrac: 0.5 }
      )
    })
    expect(r.x).toBeCloseTo(-0.632, 2)
  })

  test('A-4 16:9 → 9:16 face (0.95, 0.5) → x clamped to -xSlack', async () => {
    if (!launched) throw new Error('launch failed')
    const r = await launched.page.evaluate(() => {
      const Sw = 1920
      const Sh = 1080
      const Cw = 1080
      const Ch = 1920
      const coverK = Math.max(Cw / Sw, Ch / Sh)
      const SwCov = Sw * coverK
      const xSlack = (SwCov - Cw) / (2 * Cw)
      const t = window.__reelsAutoReframeMath.computeReframeTransform(
        { width: Sw, height: Sh },
        { width: Cw, height: Ch },
        { xFrac: 0.95, yFrac: 0.5 }
      )
      return { x: t.x, xSlack }
    })
    expect(r.x).toBeCloseTo(-r.xSlack, 4)
  })

  test('A-5 16:9 → 1:1 face (0.5, 0.2) → y stays 0 (locked axis)', async () => {
    if (!launched) throw new Error('launch failed')
    const r = await launched.page.evaluate(() => {
      return window.__reelsAutoReframeMath.computeReframeTransform(
        { width: 1920, height: 1080 },
        { width: 1080, height: 1080 },
        { xFrac: 0.5, yFrac: 0.2 }
      )
    })
    expect(r.y).toBeCloseTo(0, 5)
  })

  test('A-6 rule-of-thirds upper target (0.5, 0.4) shifts y on 9:16 → 16:9', async () => {
    if (!launched) throw new Error('launch failed')
    // Source taller than canvas → Y axis has slack, so the target shift bites.
    const r = await launched.page.evaluate(() => {
      return window.__reelsAutoReframeMath.computeReframeTransform(
        { width: 1080, height: 1920 },
        { width: 1920, height: 1080 },
        { xFrac: 0.5, yFrac: 0.5 },
        { x: 0.5, y: 0.4 }
      )
    })
    // target.y=0.4 → -0.1 shift, well within ~1.08 slack.
    expect(r.y).toBeCloseTo(-0.1, 5)
  })
})

// ===========================================================================
// LAYER B — orchestrator with mock detector
// ===========================================================================

test.describe('@phase-3-52-auto-reframe Layer B — orchestrator (mock detector)', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    await resetProject(launched)
  })
  test.afterEach(async () => {
    if (launched) {
      try {
        await clearMockDetector(launched)
      } catch {
        /* ignore */
      }
      try {
        await launched.app.close()
      } catch {
        /* ignore */
      }
      launched = null
    }
  })

  // -----------------------------------------------------------------------
  // B-1 — Happy path: 2 clips, mock face at (0.7, 0.5) → both reframed.
  // -----------------------------------------------------------------------
  test('B-1 happy path — 2 clips, face (0.7, 0.5) → reframed with x ≈ -0.632', async () => {
    if (!launched) throw new Error('launch failed')
    await setCanvas(launched, 1080, 1920)
    // Pretend the media is 1920x1080 (16:9) by overriding the addMedia w/h.
    const fixture = process.env.E2E_FIXTURE_MP4!
    const seeded = await launched.page.evaluate(async (filePath: string) => {
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
        // Force 16:9 source so cover-fit has X slack on a 9:16 canvas.
        width: 1920,
        height: 1080,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      const track = reels
        .state()
        .project.tracks.find((t) => t.kind === 'video')
      if (!track) throw new Error('no video track')
      const ids: string[] = []
      for (let i = 0; i < 2; i++) {
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: track.id,
          startMs: i * probe.durationMs,
          endMs: (i + 1) * probe.durationMs,
          trimInMs: 0,
          trimOutMs: probe.durationMs,
          speed: 1
        })
        ids.push(cid)
      }
      return { clipIds: ids, trackId: track.id, mediaId: mid }
    }, fixture)

    await installMockDetector(
      launched,
      `async (_frame, atMs) => [{ xFrac: 0.7, yFrac: 0.5, areaFrac: 0.1, score: 0.9 }]`
    )

    await launched.page.locator('[data-testid="topbar-menu-ai"]').click()
    await launched.page
      .locator('[data-testid="open-autoreframe-dialog"]')
      .click()
    await expect(
      launched.page.locator('[data-testid="autoreframe-dialog"]')
    ).toBeVisible()
    await launched.page.locator('[data-testid="autoreframe-start"]').click()

    // Wait for the run to finish.
    await launched.page.waitForFunction(
      () => {
        const txt = document.querySelector(
          '[data-testid="autoreframe-phase"]'
        )?.textContent
        return txt === '완료'
      },
      null,
      { timeout: 30_000 }
    )

    // Both clips must have >=2 keyframes and first kf x ≈ -0.632.
    for (const cid of seeded.clipIds) {
      const clip = (await getClip(launched, cid)) as {
        transformKeyframes?: TransformKeyframe[]
      } | null
      expect(clip).not.toBeNull()
      expect(Array.isArray(clip!.transformKeyframes)).toBe(true)
      expect((clip!.transformKeyframes as TransformKeyframe[]).length).toBeGreaterThanOrEqual(
        2
      )
      const first = (clip!.transformKeyframes as TransformKeyframe[])[0]
      expect(first.transform.x).toBeCloseTo(-0.632, 2)
    }
  })

  // -----------------------------------------------------------------------
  // B-2 — No-face: mock returns [] → clip has no transformKeyframes.
  // -----------------------------------------------------------------------
  test('B-2 no-face clip — mock returns [] → no keyframes, clipsNoFace = 1', async () => {
    if (!launched) throw new Error('launch failed')
    await setCanvas(launched, 1080, 1920)
    const seeded = await seedFixtureClip(launched)
    await installMockDetector(launched, `async () => []`)

    await launched.page.locator('[data-testid="topbar-menu-ai"]').click()
    await launched.page
      .locator('[data-testid="open-autoreframe-dialog"]')
      .click()
    await launched.page.locator('[data-testid="autoreframe-start"]').click()
    await launched.page.waitForFunction(
      () =>
        document.querySelector('[data-testid="autoreframe-phase"]')
          ?.textContent === '완료',
      null,
      { timeout: 30_000 }
    )

    const clip = (await getClip(launched, seeded.clipId)) as {
      transformKeyframes?: unknown
    } | null
    expect(clip).not.toBeNull()
    expect(clip!.transformKeyframes).toBeUndefined()

    // Verify summary via the summary box.
    const summaryText = await launched.page
      .locator('[data-testid="autoreframe-summary"]')
      .textContent()
    expect(summaryText).toContain('얼굴 없음 1개')
  })

  // -----------------------------------------------------------------------
  // B-3 — preserveExisting=true (default) skips clips with manual keyframes.
  // -----------------------------------------------------------------------
  test('B-3 preserveExisting — pre-seeded keyframes are not overwritten', async () => {
    if (!launched) throw new Error('launch failed')
    await setCanvas(launched, 1080, 1920)
    const seeded = await seedFixtureClip(launched)
    // Pre-seed manual keyframes via addTransformKeyframe (creates >=2).
    await launched.page.evaluate((cid: string) => {
      const reels = window.__reelsStore
      reels.addTransformKeyframe(cid, 0, { scale: 1.2 })
    }, seeded.clipId)
    // Snapshot pre-run keyframes so we can verify they're unchanged.
    const before = (await getClip(launched, seeded.clipId)) as {
      transformKeyframes?: TransformKeyframe[]
    }
    const beforeKfs = JSON.stringify(before.transformKeyframes ?? [])

    await installMockDetector(
      launched,
      `async () => [{ xFrac: 0.8, yFrac: 0.5, areaFrac: 0.1, score: 0.9 }]`
    )

    await launched.page.locator('[data-testid="topbar-menu-ai"]').click()
    await launched.page
      .locator('[data-testid="open-autoreframe-dialog"]')
      .click()
    // Leave the overwrite checkbox unchecked = preserveExisting true.
    await launched.page.locator('[data-testid="autoreframe-start"]').click()
    await launched.page.waitForFunction(
      () =>
        document.querySelector('[data-testid="autoreframe-phase"]')
          ?.textContent === '완료',
      null,
      { timeout: 30_000 }
    )

    const after = (await getClip(launched, seeded.clipId)) as {
      transformKeyframes?: TransformKeyframe[]
    }
    expect(JSON.stringify(after.transformKeyframes ?? [])).toBe(beforeKfs)

    const summaryText = await launched.page
      .locator('[data-testid="autoreframe-summary"]')
      .textContent()
    expect(summaryText).toContain('보존 1개')
  })

  // -----------------------------------------------------------------------
  // B-4 — ONE undo step.
  // -----------------------------------------------------------------------
  test('B-4 one undo step — pastStates +1; Ctrl+Z restores', async () => {
    if (!launched) throw new Error('launch failed')
    await setCanvas(launched, 1080, 1920)
    const seeded = await launched.page.evaluate(async (filePath: string) => {
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
        width: 1920,
        height: 1080,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      const track = reels
        .state()
        .project.tracks.find((t) => t.kind === 'video')
      if (!track) throw new Error('no video track')
      const ids: string[] = []
      for (let i = 0; i < 2; i++) {
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: track.id,
          startMs: i * probe.durationMs,
          endMs: (i + 1) * probe.durationMs,
          trimInMs: 0,
          trimOutMs: probe.durationMs,
          speed: 1
        })
        ids.push(cid)
      }
      return { clipIds: ids }
    }, process.env.E2E_FIXTURE_MP4!)

    await installMockDetector(
      launched,
      `async () => [{ xFrac: 0.7, yFrac: 0.5, areaFrac: 0.1, score: 0.9 }]`
    )

    // Let any pending zundo-throttled commits settle.
    await launched.page.waitForTimeout(300)

    const pastBefore = await getPastStatesCount(launched)

    await launched.page.locator('[data-testid="topbar-menu-ai"]').click()
    await launched.page
      .locator('[data-testid="open-autoreframe-dialog"]')
      .click()
    await launched.page.locator('[data-testid="autoreframe-start"]').click()
    await launched.page.waitForFunction(
      () =>
        document.querySelector('[data-testid="autoreframe-phase"]')
          ?.textContent === '완료',
      null,
      { timeout: 30_000 }
    )

    const pastAfter = await getPastStatesCount(launched)
    expect(pastAfter - pastBefore).toBe(1)

    // Undo restores the pre-run kfs (i.e., undefined).
    await launched.page.evaluate(() => {
      window.__reelsUndoRedo.getState().undo()
    })
    for (const cid of seeded.clipIds) {
      const clip = (await getClip(launched, cid)) as {
        transformKeyframes?: unknown
      }
      expect(clip.transformKeyframes).toBeUndefined()
    }
  })

  // -----------------------------------------------------------------------
  // B-5 — Cancel mid-run after first clip finishes.
  // -----------------------------------------------------------------------
  test('B-5 cancel mid-run — first clip done, run ends in cancelled', async () => {
    if (!launched) throw new Error('launch failed')
    await setCanvas(launched, 1080, 1920)
    // Two clips. Mock detector blocks the SECOND call until cancel arrives.
    await launched.page.evaluate(async (filePath: string) => {
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
        width: 1920,
        height: 1080,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      const track = reels
        .state()
        .project.tracks.find((t) => t.kind === 'video')!
      for (let i = 0; i < 2; i++) {
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: track.id,
          startMs: i * probe.durationMs,
          endMs: (i + 1) * probe.durationMs,
          trimInMs: 0,
          trimOutMs: probe.durationMs,
          speed: 1
        })
      }
    }, process.env.E2E_FIXTURE_MP4!)

    // Mock detector counts calls; after a certain number it stalls indefinitely
    // so we have time to click cancel.
    await installMockDetector(
      launched,
      `(() => {
         let callCount = 0
         const FRAMES_PER_CLIP = 8
         return async (_frame, _atMs) => {
           callCount += 1
           // Last frame of clip 1 is at call 8. After that, stall the clip-2
           // calls so the test can click cancel.
           if (callCount > FRAMES_PER_CLIP) {
             await new Promise((r) => setTimeout(r, 20_000))
           }
           return [{ xFrac: 0.7, yFrac: 0.5, areaFrac: 0.1, score: 0.9 }]
         }
       })()`
    )

    await launched.page.locator('[data-testid="topbar-menu-ai"]').click()
    await launched.page
      .locator('[data-testid="open-autoreframe-dialog"]')
      .click()
    await launched.page.locator('[data-testid="autoreframe-start"]').click()

    // Wait until clip 1 is in the can (progress shows "1 / 2 ...").
    await launched.page.waitForFunction(
      () => {
        const t = document.querySelector(
          '[data-testid="autoreframe-progress"]'
        )?.textContent
        return t != null && /^1\s*\/\s*2/.test(t)
      },
      null,
      { timeout: 30_000 }
    )

    // Cancel mid-run.
    await launched.page.locator('[data-testid="autoreframe-cancel"]').click()
    await launched.page.waitForFunction(
      () =>
        document.querySelector('[data-testid="autoreframe-phase"]')
          ?.textContent === '취소됨',
      null,
      { timeout: 30_000 }
    )

    const summaryText = await launched.page
      .locator('[data-testid="autoreframe-summary"]')
      .textContent()
    expect(summaryText).toContain('리프레임 1개')
  })

  // -----------------------------------------------------------------------
  // B-6 — Byte-identical regression: empty project → pastStates unchanged.
  // -----------------------------------------------------------------------
  test('B-6 empty project — pastStates unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    // No clips seeded.
    await installMockDetector(
      launched,
      `async () => [{ xFrac: 0.5, yFrac: 0.5, areaFrac: 0.1, score: 0.9 }]`
    )
    // Settle pending throttled commits.
    await launched.page.waitForTimeout(300)
    const pastBefore = await getPastStatesCount(launched)

    await launched.page.locator('[data-testid="topbar-menu-ai"]').click()
    await launched.page
      .locator('[data-testid="open-autoreframe-dialog"]')
      .click()
    await launched.page.locator('[data-testid="autoreframe-start"]').click()
    await launched.page.waitForFunction(
      () =>
        document.querySelector('[data-testid="autoreframe-phase"]')
          ?.textContent === '완료',
      null,
      { timeout: 15_000 }
    )

    const pastAfter = await getPastStatesCount(launched)
    expect(pastAfter).toBe(pastBefore)
  })

  // -----------------------------------------------------------------------
  // B-7 — Error path: detector throws → error phase, no partial writes.
  // -----------------------------------------------------------------------
  test('B-7 error path — detector throws → error phase, pastStates unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    await setCanvas(launched, 1080, 1920)
    const seeded = await seedFixtureClip(launched)

    await installMockDetector(
      launched,
      `async () => { throw new Error('mock detect blew up') }`
    )

    await launched.page.waitForTimeout(300)
    const pastBefore = await getPastStatesCount(launched)

    await launched.page.locator('[data-testid="topbar-menu-ai"]').click()
    await launched.page
      .locator('[data-testid="open-autoreframe-dialog"]')
      .click()
    await launched.page.locator('[data-testid="autoreframe-start"]').click()

    // Phase will swap to 'error' (with the error banner visible).
    await expect(
      launched.page.locator('[data-testid="autoreframe-error"]')
    ).toBeVisible({ timeout: 30_000 })

    const pastAfter = await getPastStatesCount(launched)
    expect(pastAfter).toBe(pastBefore)

    // Clip must have NO partial keyframes.
    const clip = (await getClip(launched, seeded.clipId)) as {
      transformKeyframes?: unknown
    }
    expect(clip.transformKeyframes).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // B-8 — Same-aspect near-no-op: 1080x1920 → 1080x1920, slightly off-center
  //       → kfs collapse to identity → no transformKeyframes written.
  // -----------------------------------------------------------------------
  test('B-8 same-aspect near-no-op — face slightly off-center → no keyframes', async () => {
    if (!launched) throw new Error('launch failed')
    await setCanvas(launched, 1080, 1920)
    // Seed with media probed as 1080x1920 (vertical) to match canvas.
    const fixture = process.env.E2E_FIXTURE_MP4!
    const seeded = await launched.page.evaluate(async (filePath: string) => {
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
        // Force same aspect as canvas (9:16).
        width: 1080,
        height: 1920,
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
      return { clipId: cid }
    }, fixture)

    await installMockDetector(
      launched,
      `async () => [{ xFrac: 0.55, yFrac: 0.45, areaFrac: 0.1, score: 0.9 }]`
    )

    await launched.page.locator('[data-testid="topbar-menu-ai"]').click()
    await launched.page
      .locator('[data-testid="open-autoreframe-dialog"]')
      .click()
    await launched.page.locator('[data-testid="autoreframe-start"]').click()
    await launched.page.waitForFunction(
      () =>
        document.querySelector('[data-testid="autoreframe-phase"]')
          ?.textContent === '완료',
      null,
      { timeout: 30_000 }
    )

    const clip = (await getClip(launched, seeded.clipId)) as {
      transformKeyframes?: unknown
    }
    expect(clip.transformKeyframes).toBeUndefined()
    const summaryText = await launched.page
      .locator('[data-testid="autoreframe-summary"]')
      .textContent()
    expect(summaryText).toContain('리프레임 0개')
    expect(summaryText).toContain('얼굴 없음 1개')
  })
})
