/**
 * Phase 3.54 — keyframe easing (linear / ease-in / ease-out / ease-in-out).
 *
 * Layer A (pure): `easeFraction` curve values at known input points +
 * `easingToFfmpegFExpr` byte-identical-for-linear / known-string-for-curves
 * (so preview === export).
 *
 * Layer B (UI): EffectsPanel keyframe-easing row renders only when the clip
 * has a keyframe track, the select reflects + writes the active keyframe's
 * outgoing easing, and the underlying store action is invoked.
 *
 * @phase-3-54-keyframe-easing
 */
import { expect, test } from '@playwright/test'
import {
  EASING_KINDS,
  EASING_LABELS,
  easeFraction,
  easingToFfmpegFExpr,
  type EasingKind
} from '../../src/shared/easing'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ===========================================================================
// LAYER A — pure (no Electron)
// ===========================================================================
test.describe('@phase-3-54-keyframe-easing Layer A — pure', () => {
  test('A-1 EASING_KINDS contains 4 kinds (linear/ease-in/ease-out/ease-in-out) with labels', () => {
    expect(EASING_KINDS.length).toBe(4)
    for (const k of EASING_KINDS) {
      expect(EASING_LABELS[k]).toBeTruthy()
    }
    expect(EASING_KINDS).toContain('linear')
    expect(EASING_KINDS).toContain('ease-in')
    expect(EASING_KINDS).toContain('ease-out')
    expect(EASING_KINDS).toContain('ease-in-out')
  })

  test('A-2 easeFraction linear identity for all inputs', () => {
    for (const f of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      expect(easeFraction(f, 'linear')).toBe(f)
      expect(easeFraction(f, undefined)).toBe(f)
    }
  })

  test('A-3 easeFraction boundary 0 / 1 invariant across all kinds', () => {
    for (const k of EASING_KINDS) {
      expect(easeFraction(0, k)).toBeCloseTo(0, 6)
      expect(easeFraction(1, k)).toBeCloseTo(1, 6)
    }
  })

  test('A-4 easeFraction ease-in @ 0.5 = 0.125 (cubic slow start)', () => {
    expect(easeFraction(0.5, 'ease-in')).toBeCloseTo(0.125, 6)
  })

  test('A-5 easeFraction ease-out @ 0.5 = 0.875 (cubic slow end)', () => {
    expect(easeFraction(0.5, 'ease-out')).toBeCloseTo(0.875, 6)
  })

  test('A-6 easeFraction ease-in-out @ 0.25 = 0.0625 (slow-start branch); @ 0.5 = 0.5; @ 0.75 = 0.9375', () => {
    expect(easeFraction(0.25, 'ease-in-out')).toBeCloseTo(0.0625, 6)
    expect(easeFraction(0.5, 'ease-in-out')).toBeCloseTo(0.5, 6)
    expect(easeFraction(0.75, 'ease-in-out')).toBeCloseTo(0.9375, 6)
  })

  test('A-7 easeFraction clamps out-of-range f → 0 / 1 (defensive)', () => {
    expect(easeFraction(-0.5, 'ease-in')).toBe(0)
    expect(easeFraction(1.5, 'ease-out')).toBe(1)
    expect(easeFraction(-1, 'ease-in-out')).toBe(0)
  })

  test('A-8 easingToFfmpegFExpr linear is byte-identical (pre-3.54 export untouched)', () => {
    const raw = '(t-1.0000)/0.5000'
    expect(easingToFfmpegFExpr('linear', raw)).toBe(raw)
    expect(easingToFfmpegFExpr(undefined, raw)).toBe(raw)
  })

  test('A-9 easingToFfmpegFExpr produces ffmpeg-valid expressions for each curve', () => {
    const f = 'F'
    expect(easingToFfmpegFExpr('ease-in', f)).toBe('pow(F,3)')
    expect(easingToFfmpegFExpr('ease-out', f)).toBe('(1-pow(1-F,3))')
    expect(easingToFfmpegFExpr('ease-in-out', f)).toBe(
      'if(lt(F,0.5),4*pow(F,3),1-pow(-2*F+2,3)/2)'
    )
  })
})

// ===========================================================================
// LAYER B — UI (Electron launched)
// ===========================================================================
type ProjectStoreState = {
  project: {
    tracks: Array<{
      id: string
      kind: string
      clips: Array<Record<string, unknown>>
    }>
    media: Record<string, unknown>
  }
  addTransformKeyframe: (
    clipId: string,
    atMs: number,
    transform?: Partial<{
      x: number
      y: number
      scale: number
      rotation: number
      opacity: number
    }>
  ) => void
  updateTransformKeyframe: (
    clipId: string,
    kfIndex: number,
    partial: {
      atMs?: number
      transform?: Partial<{ x: number; y: number; scale: number }>
      easing?: EasingKind | null
    }
  ) => void
  createNew: () => void
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => ProjectStoreState
    }
    __reelsStore: {
      state: () => ProjectStoreState
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      addTransformKeyframe: (
        id: string,
        atMs: number,
        partial?: unknown
      ) => void
      updateTransformKeyframe: (
        id: string,
        kfIndex: number,
        partial: unknown
      ) => void
      newId: () => string
    }
    __reelsTimelineUi: {
      getState: () => {
        setPlayheadMs: (ms: number) => void
        selectClip: (id: string) => void
      }
    }
  }
}

test.describe('@phase-3-54-keyframe-easing Layer B — UI', () => {
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
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 8_000 }
    )
  }

  async function addClipFromFixture(): Promise<{
    clipId: string
    durationMs: number
  }> {
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
      return { clipId: cid, durationMs: probe.durationMs }
    }, fixture)
  }

  async function selectClip(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const block = page
      .locator(
        `[data-testid="media-clip-block"][data-clip-id="${clipId}"]`
      )
      .first()
    if ((await block.count()) > 0) {
      await block.click({ force: true })
      await page.waitForTimeout(200)
      return
    }
    await page.evaluate((id) => {
      window.__reelsTimelineUi.getState().selectClip(id)
    }, clipId)
    await page.waitForTimeout(150)
  }

  async function openAnimationTab(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await selectClip(clipId)
    const toggleBtn = page.locator('[data-testid="toggle-effects-panel"]')
    if ((await page.locator('[data-testid="effects-panel"]').count()) === 0) {
      await toggleBtn.click()
      await expect(
        page.locator('[data-testid="effects-panel"]')
      ).toBeVisible({ timeout: 5_000 })
    }
    // transform-keyframes Section lives under the 'animation' tab, not
    // 'transform'. Click into 'animation'.
    const tab = page.locator('[data-testid="effects-tab-animation"]')
    if ((await tab.count()) > 0) {
      const pressed = await tab.getAttribute('aria-pressed')
      if (pressed !== 'true') {
        await tab.click()
        await page.waitForTimeout(150)
      }
    }
    // Phase 3.47 accordion — transform-keyframes section is collapsed by
    // default. Expand so the easing row inside actually mounts.
    const tkToggle = page.locator(
      '[data-testid="section-toggle-transform-keyframes"]'
    )
    if ((await tkToggle.count()) > 0) {
      const expanded = await tkToggle.getAttribute('aria-expanded')
      if (expanded !== 'true') {
        await tkToggle.click()
        await page.waitForTimeout(120)
      }
    }
  }

  async function getClipState(
    clipId: string
  ): Promise<Record<string, unknown> | null> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate((cid: string) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project
        .tracks) {
        for (const c of t.clips) {
          if ((c as Record<string, unknown>).id === cid) return c
        }
      }
      return null
    }, clipId)
  }

  test('B-1 no keyframes → easing row absent', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { clipId } = await addClipFromFixture()
    await openAnimationTab(clipId)
    await expect(
      page.locator('[data-testid="effects-keyframe-easing-row"]')
    ).toHaveCount(0)
  })

  test('B-2 with keyframes → row visible; select default value is 선형 (linear)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { clipId, durationMs } = await addClipFromFixture()
    // Seed 2 keyframes via the test bridge so the track exists.
    await page.evaluate(
      ({ id, dur }: { id: string; dur: number }) => {
        const reels = window.__reelsStore
        reels.addTransformKeyframe(id, 0, { scale: 1 })
        reels.addTransformKeyframe(id, Math.max(60, Math.floor(dur / 2)), {
          scale: 2
        })
      },
      { id: clipId, dur: durationMs }
    )
    await openAnimationTab(clipId)
    await expect(
      page.locator('[data-testid="effects-keyframe-easing-row"]')
    ).toBeVisible()
    const select = page.locator(
      '[data-testid="effects-keyframe-easing-select"]'
    )
    await expect(select).toBeVisible()
    // Default (no playhead on a kf yet) — select falls back to 'linear'.
    expect(await select.inputValue()).toBe('linear')
  })

  test('B-3 setting easing via store writes the field; selecting linear via store CLEARS it (BC-safe)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { clipId, durationMs } = await addClipFromFixture()
    await page.evaluate(
      ({ id, dur }: { id: string; dur: number }) => {
        const reels = window.__reelsStore
        reels.addTransformKeyframe(id, 0, { scale: 1 })
        reels.addTransformKeyframe(id, Math.max(60, Math.floor(dur / 2)), {
          scale: 2
        })
      },
      { id: clipId, dur: durationMs }
    )
    // Set easing on the first keyframe to 'ease-in'.
    await page.evaluate((id: string) => {
      window.__reelsStore.updateTransformKeyframe(id, 0, { easing: 'ease-in' })
    }, clipId)
    let clip = await getClipState(clipId)
    const kfs = (clip as { transformKeyframes?: Array<{ easing?: string }> })
      .transformKeyframes
    expect(kfs?.[0]?.easing).toBe('ease-in')
    // Re-set to 'linear' — store treats this as CLEAR (absent = linear).
    await page.evaluate((id: string) => {
      window.__reelsStore.updateTransformKeyframe(id, 0, { easing: 'linear' })
    }, clipId)
    clip = await getClipState(clipId)
    const kfs2 = (clip as { transformKeyframes?: Array<{ easing?: string }> })
      .transformKeyframes
    expect(kfs2?.[0]?.easing).toBeUndefined()
  })

  test('B-4 invalid easing string → no-op (defensive validation)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { clipId, durationMs } = await addClipFromFixture()
    await page.evaluate(
      ({ id, dur }: { id: string; dur: number }) => {
        const reels = window.__reelsStore
        reels.addTransformKeyframe(id, 0, { scale: 1 })
        reels.addTransformKeyframe(id, Math.max(60, Math.floor(dur / 2)), {
          scale: 2
        })
        reels.updateTransformKeyframe(id, 0, { easing: 'ease-in' })
      },
      { id: clipId, dur: durationMs }
    )
    // Now attempt to overwrite with an unknown kind.
    await page.evaluate((id: string) => {
      window.__reelsStore.updateTransformKeyframe(id, 0, {
        easing: 'wobble' as unknown as never
      })
    }, clipId)
    const clip = await getClipState(clipId)
    const kfs = (clip as { transformKeyframes?: Array<{ easing?: string }> })
      .transformKeyframes
    // ease-in should still be there (the wobble call no-opped).
    expect(kfs?.[0]?.easing).toBe('ease-in')
  })
})

