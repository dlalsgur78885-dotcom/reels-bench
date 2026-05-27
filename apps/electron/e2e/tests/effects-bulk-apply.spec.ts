/**
 * Reels 11 슬라이드 20 — 효과 탭 다중 선택 일괄 적용.
 *
 * Contract (4 effect 채널):
 *  (1) 변형(transform.scale) 슬라이더 → 모든 선택 클립에 동일 scale.
 *  (2) 필터 preset 클릭 → 모든 선택 클립에 동일 filterPreset.
 *  (3) 조정(brightness) 슬라이더 → 모든 선택 클립에 동일 colorAdjust.
 *  (4) 속도(speed) 슬라이더 → 모든 선택 클립에 동일 speed.
 *
 * @reels-11-slide-20-effects-bulk-apply
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type Clip = {
  id: string
  startMs: number
  endMs: number
  transform?: { scale: number; rotation: number; opacity: number; x: number; y: number }
  filterPreset?: string
  colorAdjust?: { brightness: number; contrast: number; saturation: number; temperature: number }
  speed?: number
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: { tracks: Array<{ id: string; kind: string; clips: Clip[] }> }
        createNew: () => void
      }
    }
    __reelsStore: {
      state: () => {
        project: { tracks: Array<{ id: string; kind: string; clips: Clip[] }> }
      }
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
    }
    __reelsTimelineUi: {
      setState: (s: {
        selectedClipIds: Set<string>
        selectedAdjustmentLayerId: null
      }) => void
    }
  }
}

test.describe('@reels-11-slide-20-effects-bulk-apply 효과 일괄 적용', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
      await new Promise((r) => setTimeout(r, 700))
    })
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(() => !!window.__reelsStore)
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

  async function seedTwoClipsAndSelect(): Promise<{ id1: string; id2: string }> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const reels = window.__reelsStore
      const t = reels.state().project.tracks.find((x) => x.kind === 'video')!
      const mediaId = reels.newId()
      reels.addMedia({
        id: mediaId,
        path: '/fake/seed.mp4',
        kind: 'video',
        durationMs: 5000,
        width: 1920,
        height: 1080,
        codec: 'h264',
        importedAt: Date.now(),
        fileName: 'seed.mp4',
        fileSizeBytes: 0
      })
      const id1 = reels.newId()
      reels.addClip({
        id: id1,
        kind: 'media',
        mediaId,
        trackId: t.id,
        startMs: 0,
        endMs: 1000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      const id2 = reels.newId()
      reels.addClip({
        id: id2,
        kind: 'media',
        mediaId,
        trackId: t.id,
        startMs: 2000,
        endMs: 3000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      return { id1, id2 }
    })
  }

  async function openEffectsTab(activeClipId: string, tab: string): Promise<void> {
    const { page } = launched!
    await page.locator(`[data-testid="clip-body"][data-clip-id="${activeClipId}"]`).click()
    const toggle = page.locator('[data-testid="toggle-effects-panel"]')
    await toggle.waitFor({ state: 'visible' })
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    await page.locator('[data-testid="effects-panel"]').waitFor({ state: 'visible' })
    await page.locator(`[data-testid="effects-tab-${tab}"]`).click()
  }

  async function multiSelect(ids: string[]): Promise<void> {
    await launched!.page.evaluate((arr) => {
      window.__reelsTimelineUi.setState({
        selectedClipIds: new Set(arr),
        selectedAdjustmentLayerId: null
      })
    }, ids)
    await launched!.page.waitForTimeout(120)
  }

  test('A-1 변형 슬라이더 → 두 클립 모두 같은 transform', async () => {
    const { page } = launched!
    const { id1, id2 } = await seedTwoClipsAndSelect()
    await openEffectsTab(id1, 'transform')
    await multiSelect([id1, id2])
    // 크기 슬라이더 값 변경.
    const input = page.locator('[data-testid="effects-transform-scale-input"]')
    await input.fill('1.5')
    await input.press('Tab')
    await page.waitForTimeout(200)
    const result = await page.evaluate(({ a, b }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      const c1 = clips.find((c) => c.id === a)!
      const c2 = clips.find((c) => c.id === b)!
      return { s1: c1.transform?.scale, s2: c2.transform?.scale }
    }, { a: id1, b: id2 })
    expect(result.s1).toBeCloseTo(1.5, 2)
    expect(result.s2).toBeCloseTo(1.5, 2)
  })

  test('A-2 필터 preset → 두 클립 모두 같은 filterPreset', async () => {
    const { page } = launched!
    const { id1, id2 } = await seedTwoClipsAndSelect()
    await openEffectsTab(id1, 'adjust')
    await multiSelect([id1, id2])
    // sepia preset 클릭.
    const sec = page.locator('[data-testid="section-toggle-filter"]')
    if ((await sec.count()) > 0) {
      const expanded = await sec.getAttribute('aria-expanded')
      if (expanded !== 'true') await sec.click()
    }
    await page.locator('[data-testid="effects-filter-preset-sepia"]').click()
    await page.waitForTimeout(200)
    const result = await page.evaluate(({ a, b }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      const c1 = clips.find((c) => c.id === a)!
      const c2 = clips.find((c) => c.id === b)!
      return { f1: c1.filterPreset, f2: c2.filterPreset }
    }, { a: id1, b: id2 })
    expect(result.f1).toBe('sepia')
    expect(result.f2).toBe('sepia')
  })

  test('A-3 조정 brightness → 두 클립 모두 같은 colorAdjust', async () => {
    const { page } = launched!
    const { id1, id2 } = await seedTwoClipsAndSelect()
    await openEffectsTab(id1, 'adjust')
    await multiSelect([id1, id2])
    // 색보정 섹션이 닫혀 있을 수 있어 열기.
    const sec = page.locator('[data-testid="section-toggle-color-adjust"]')
    if ((await sec.count()) > 0) {
      const expanded = await sec.getAttribute('aria-expanded')
      if (expanded !== 'true') await sec.click()
    }
    const input = page.locator('[data-testid="effects-coloradjust-brightness-input"]')
    await input.fill('20')
    await input.press('Tab')
    await page.waitForTimeout(200)
    const result = await page.evaluate(({ a, b }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      const c1 = clips.find((c) => c.id === a)!
      const c2 = clips.find((c) => c.id === b)!
      return { b1: c1.colorAdjust?.brightness, b2: c2.colorAdjust?.brightness }
    }, { a: id1, b: id2 })
    expect(result.b1).toBe(20)
    expect(result.b2).toBe(20)
  })

  test('A-4 속도 preset → 두 클립 모두 같은 speed', async () => {
    const { page } = launched!
    const { id1, id2 } = await seedTwoClipsAndSelect()
    await openEffectsTab(id1, 'speed')
    await multiSelect([id1, id2])
    // 2× preset.
    await page.locator('[data-testid="effects-speed-preset-2"]').click()
    await page.waitForTimeout(200)
    const result = await page.evaluate(({ a, b }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      const c1 = clips.find((c) => c.id === a)!
      const c2 = clips.find((c) => c.id === b)!
      return { s1: c1.speed, s2: c2.speed }
    }, { a: id1, b: id2 })
    expect(result.s1).toBeCloseTo(2, 2)
    expect(result.s2).toBeCloseTo(2, 2)
  })
})
