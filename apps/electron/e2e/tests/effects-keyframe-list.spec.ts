/**
 * Reels 11 슬라이드 19 — 변형 키프레임 디테일 리스트 편집 패널.
 *
 * Contract:
 *  (1) 키프레임이 있으면 [effects-keyframe-list] 가 노출, 키프레임 수만큼 행.
 *  (2) 행의 시간 ms 입력을 변경하면 transformKeyframe.atMs 가 갱신.
 *  (3) 행의 × 버튼 → 그 키프레임이 사라짐.
 *  (4) 행 클릭 → playhead 가 그 키프레임 절대 ms 위치로.
 *
 * @reels-11-slide-19-keyframe-list
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type Clip = {
  id: string
  startMs: number
  endMs: number
  transformKeyframes?: Array<{ atMs: number; transform: Record<string, number> }>
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
      addTransformKeyframe: (id: string, atMs: number, partial?: Record<string, number>) => void
      newId: () => string
    }
    __reelsTimelineUi: {
      getState: () => {
        playheadMs: number
        setPlayheadMs: (ms: number) => void
      }
    }
  }
}

test.describe('@reels-11-slide-19-keyframe-list 키프레임 리스트 패널', () => {
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

  async function seedClipWithKeyframes(): Promise<string> {
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
      const id = reels.newId()
      reels.addClip({
        id,
        kind: 'media',
        mediaId,
        trackId: t.id,
        startMs: 0,
        endMs: 4000,
        trimInMs: 0,
        trimOutMs: 4000,
        speed: 1
      })
      // seed 두 키프레임 (1000 + 2500).
      reels.addTransformKeyframe(id, 1000, { scale: 1.2 })
      reels.addTransformKeyframe(id, 2500, { scale: 0.8 })
      return id
    })
  }

  async function openAnimationTab(clipId: string): Promise<void> {
    const { page } = launched!
    await page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`).click()
    const toggle = page.locator('[data-testid="toggle-effects-panel"]')
    await toggle.waitFor({ state: 'visible' })
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    await page.locator('[data-testid="effects-panel"]').waitFor({ state: 'visible' })
    await page.locator('[data-testid="effects-tab-animation"]').click()
    // 변형 키프레임 섹션이 닫혀 있다면 열기.
    const sec = page.locator('[data-testid="section-toggle-transform-keyframes"]')
    if ((await sec.count()) > 0) {
      const expanded = await sec.getAttribute('aria-expanded')
      if (expanded !== 'true') await sec.click()
    }
  }

  test('A-1 리스트 행 수 = 키프레임 수', async () => {
    const { page } = launched!
    const clipId = await seedClipWithKeyframes()
    await openAnimationTab(clipId)
    await expect(page.locator('[data-testid="effects-keyframe-list"]')).toBeVisible()
    // store seed 가 base + 2 인 경우 3 행. 우리 시드는 1000 + 2500 + (앞에 0ms base seed).
    const rows = page.locator(
      '[data-testid="effects-keyframe-list"] [data-testid^="effects-keyframe-row-"]'
    )
    const count = await rows.count()
    expect(count).toBeGreaterThanOrEqual(2)
    const kfCount = await page.evaluate((id) => {
      const c = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
        .find((cc) => cc.id === id)
      return c?.transformKeyframes?.length ?? 0
    }, clipId)
    expect(count).toBe(kfCount)
  })

  test('A-2 시간 ms 입력 변경 → atMs 갱신', async () => {
    const { page } = launched!
    const clipId = await seedClipWithKeyframes()
    await openAnimationTab(clipId)
    // 가장 마지막 행의 시간을 3500 으로 변경.
    const lastIdx = await page
      .locator('[data-testid="effects-keyframe-list"] [data-testid^="effects-keyframe-row-"]')
      .count() - 1
    const input = page.locator(`[data-testid="effects-keyframe-time-${lastIdx}"]`)
    await input.fill('3500')
    await input.press('Tab')
    await page.waitForTimeout(150)
    const kfs = await page.evaluate((id) => {
      const c = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
        .find((cc) => cc.id === id)
      return c?.transformKeyframes?.map((k) => k.atMs) ?? []
    }, clipId)
    expect(kfs).toContain(3500)
  })

  test('A-3 × 버튼 → 키프레임 제거', async () => {
    const { page } = launched!
    const clipId = await seedClipWithKeyframes()
    await openAnimationTab(clipId)
    const before = await page.evaluate((id) => {
      const c = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
        .find((cc) => cc.id === id)
      return c?.transformKeyframes?.length ?? 0
    }, clipId)
    // 마지막 키프레임 삭제.
    const lastIdx = before - 1
    await page.locator(`[data-testid="effects-keyframe-remove-${lastIdx}"]`).click()
    await page.waitForTimeout(150)
    const after = await page.evaluate((id) => {
      const c = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
        .find((cc) => cc.id === id)
      return c?.transformKeyframes?.length ?? 0
    }, clipId)
    expect(after).toBe(before - 1)
  })

  test('A-4 행 클릭 → playhead 점프', async () => {
    const { page } = launched!
    const clipId = await seedClipWithKeyframes()
    await openAnimationTab(clipId)
    // 첫 번째 행(보통 0ms seed) 클릭 후 playhead 가 clip.startMs+0 위치.
    const targetAt = await page.evaluate((id) => {
      const c = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
        .find((cc) => cc.id === id)!
      return { startMs: c.startMs, kfAtMs: c.transformKeyframes?.[1]?.atMs ?? 0 }
    }, clipId)
    await page.locator(`[data-testid="effects-keyframe-row-1"]`).click()
    await page.waitForTimeout(120)
    const ph = await page.evaluate(() => window.__reelsTimelineUi.getState().playheadMs)
    expect(ph).toBe(targetAt.startMs + targetAt.kfAtMs)
  })
})
