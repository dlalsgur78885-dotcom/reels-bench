/**
 * Reels 11 슬라이드 17 — 변형 탭의 각 슬라이더 행에 ♦ 키프레임 추가 버튼.
 *
 * Contract:
 *  (1) 5개 슬라이더(크기/회전/불투명/X/Y) 옆에 -kf testid 다이아몬드 5개.
 *  (2) 클립에 키프레임 없을 때 ♦ 클릭 → seed 2개 + 두 번째에 partial 적용.
 *  (3) playhead 가 한 키프레임 위에 있고 그 속성이 있을 때 active=true 표시.
 *
 * @reels-11-slide-17-transform-keyframe-buttons
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type Track = {
  id: string
  kind: 'video' | 'audio' | 'caption' | 'overlay'
  clips: Array<{
    id: string
    transformKeyframes?: Array<{ atMs: number; transform: Record<string, number> }>
  }>
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: { tracks: Track[] }
        createNew: () => void
      }
    }
    __reelsStore: {
      state: () => { project: { tracks: Track[] } }
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
      selectClip: (id: string | null) => void
    }
    __reelsTimelineUi: {
      getState: () => {
        setPlayheadMs: (ms: number) => void
      }
    }
  }
}

test.describe('@reels-11-slide-17-transform-keyframe-buttons 변형 ♦ 버튼', () => {
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

  async function seedClipAndSelect(): Promise<string> {
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
        endMs: 3000,
        trimInMs: 0,
        trimOutMs: 3000,
        speed: 1
      })
      reels.selectClip(id)
      return id
    })
  }

  async function openEffectsTransform(clipId: string): Promise<void> {
    const { page } = launched!
    // 클립 본체 클릭 — Editor 의 local selectedClipId 가 set 돼 효과 패널 활성.
    await page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`).click()
    // 효과 패널 토글(닫혀 있을 수 있음).
    const toggle = page.locator('[data-testid="toggle-effects-panel"]')
    await toggle.waitFor({ state: 'visible' })
    // 클립 선택 후 자동 열림 — 안 열렸으면 클릭.
    const pressed = await toggle.getAttribute('aria-pressed')
    if (pressed !== 'true') await toggle.click()
    await page.locator('[data-testid="effects-panel"]').waitFor({ state: 'visible' })
    // 변형 탭 active.
    const tab = page.locator('[data-testid="effects-tab-transform"]')
    if ((await tab.count()) > 0) await tab.click()
    // 변형 섹션이 닫혀 있다면 열기.
    const sectionToggle = page.locator('[data-testid="section-toggle-transform"]')
    if ((await sectionToggle.count()) > 0) {
      const expanded = await sectionToggle.getAttribute('aria-expanded')
      if (expanded !== 'true') await sectionToggle.click()
    }
  }

  test('A-1 5 다이아몬드 버튼 노출', async () => {
    const { page } = launched!
    const clipId = await seedClipAndSelect()
    await page.waitForTimeout(150)
    await openEffectsTransform(clipId)
    await expect(
      page.locator('[data-testid="effects-transform-scale-kf"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="effects-transform-rotation-kf"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="effects-transform-opacity-kf"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="effects-transform-x-kf"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="effects-transform-y-kf"]')
    ).toBeVisible()
  })

  test('A-2 ♦ scale 클릭 → 키프레임 시드 생성', async () => {
    const { page } = launched!
    const clipId = await seedClipAndSelect()
    await page.waitForTimeout(150)
    await openEffectsTransform(clipId)
    // playhead 를 1000ms 로 옮긴 뒤 클릭.
    await page.evaluate(() => {
      window.__reelsTimelineUi.getState().setPlayheadMs(1000)
    })
    await page.locator('[data-testid="effects-transform-scale-kf"]').click()
    await page.waitForTimeout(150)
    const kfs = await page.evaluate((cid) => {
      const t = window
        .__reelsStore.state()
        .project.tracks.flatMap((x) => x.clips)
        .find((c) => c.id === cid)
      return t?.transformKeyframes ?? []
    }, clipId)
    expect(kfs.length).toBeGreaterThanOrEqual(2)
    // 두 번째 키프레임이 1000ms 근처.
    const second = kfs[kfs.length - 1]
    expect(Math.abs(second.atMs - 1000)).toBeLessThanOrEqual(30)
  })

  test('A-3 키프레임 위에서 다이아몬드 active=true', async () => {
    const { page } = launched!
    const clipId = await seedClipAndSelect()
    await page.waitForTimeout(150)
    await openEffectsTransform(clipId)
    // 1500ms 위치에 scale 키프레임 추가 (시드).
    await page.evaluate(() => {
      window.__reelsTimelineUi.getState().setPlayheadMs(1500)
    })
    await page.locator('[data-testid="effects-transform-scale-kf"]').click()
    await page.waitForTimeout(150)
    // 정확히 그 시점에 다시 head 두고 active 확인 — store 갱신을 위해 ms 재셋.
    await page.evaluate(() => {
      window.__reelsTimelineUi.getState().setPlayheadMs(1500)
    })
    await page.waitForTimeout(120)
    // 키프레임이 박힌 시점에서는 5 개 ♦ 모두 active (store seed 가 base
    // transform 전체를 채우므로 per-속성 구분 무의미).
    for (const key of ['scale', 'rotation', 'opacity', 'x', 'y']) {
      const a = await page
        .locator(`[data-testid="effects-transform-${key}-kf"]`)
        .getAttribute('data-kf-active')
      expect(a).toBe('true')
    }
    // 키프레임 시점에서 50ms 떨어진 곳으로 playhead 이동 — 다이아몬드 inactive.
    await page.evaluate(() => {
      window.__reelsTimelineUi.getState().setPlayheadMs(500)
    })
    await page.waitForTimeout(120)
    const inactive = await page
      .locator('[data-testid="effects-transform-rotation-kf"]')
      .getAttribute('data-kf-active')
    expect(inactive).toBe('false')
    // 확인용 — clip 에 transformKeyframes 가 실제로 들어있는지.
    const kfCount = await page.evaluate((cid) => {
      const c = window
        .__reelsStore.state()
        .project.tracks.flatMap((x) => x.clips)
        .find((cc) => cc.id === cid)
      return c?.transformKeyframes?.length ?? 0
    }, clipId)
    expect(kfCount).toBeGreaterThanOrEqual(2)
  })
})
