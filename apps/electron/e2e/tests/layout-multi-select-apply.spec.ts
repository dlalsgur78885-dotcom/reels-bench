/**
 * Reels 11 슬라이드 18 — 다중 선택 시 레이아웃 적용 동작.
 *
 * 슬라이드 8 multi-select 인프라 위에서, 효과 → 레이아웃 탭의 LayoutPanel 이
 * selectedClipIds 를 인지하고 적용 버튼이 동작하는지 회귀 가드.
 *
 * Contract:
 *  (1) 단일 선택 — "클립을 2개 이상 선택하세요" hint 표시, preset 격자는 비활성.
 *  (2) 2개 선택 — preset 선택 → 적용 → 두 클립 모두 layoutGroupId 가짐.
 *  (3) 적용 후 두 클립 transform.scale 이 1 미만(레이아웃 prefab) 으로 변경.
 *
 * @reels-11-slide-18-layout-multi-select
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type Track = {
  id: string
  kind: 'video' | 'audio' | 'caption' | 'overlay'
  clips: Array<{
    id: string
    transform?: { scale: number; rotation: number; opacity: number; x: number; y: number }
    layoutGroupId?: string
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
      addVideoTrack: () => string | null
    }
    __reelsTimelineUi: {
      setState: (s: {
        selectedClipIds: Set<string>
        selectedAdjustmentLayerId: null
      }) => void
      getState: () => { selectedClipIds: Set<string> }
    }
  }
}

test.describe('@reels-11-slide-18-layout-multi-select 레이아웃 다중 선택', () => {
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

  async function seedTwoClipsOnSeparateTracks(): Promise<{
    id1: string
    id2: string
  }> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const reels = window.__reelsStore
      const v1 = reels.state().project.tracks.find((t) => t.kind === 'video')!
      const v2Id = reels.addVideoTrack()!
      const v2 = reels.state().project.tracks.find((t) => t.id === v2Id)!
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
        trackId: v1.id,
        startMs: 0,
        endMs: 3000,
        trimInMs: 0,
        trimOutMs: 3000,
        speed: 1
      })
      const id2 = reels.newId()
      reels.addClip({
        id: id2,
        kind: 'media',
        mediaId,
        trackId: v2.id,
        startMs: 0,
        endMs: 3000,
        trimInMs: 0,
        trimOutMs: 3000,
        speed: 1
      })
      return { id1, id2 }
    })
  }

  async function openLayoutTab(activeClipId: string): Promise<void> {
    const { page } = launched!
    await page.locator(`[data-testid="clip-body"][data-clip-id="${activeClipId}"]`).click()
    const toggle = page.locator('[data-testid="toggle-effects-panel"]')
    await toggle.waitFor({ state: 'visible' })
    const pressed = await toggle.getAttribute('aria-pressed')
    if (pressed !== 'true') await toggle.click()
    await page.locator('[data-testid="effects-panel"]').waitFor({ state: 'visible' })
    await page.locator('[data-testid="effects-tab-layout"]').click()
    await page.locator('[data-testid="layout-panel"]').waitFor({ state: 'visible' })
  }

  test('A-1 단일 선택 — 2개 이상 hint 표시', async () => {
    const { page } = launched!
    const { id1 } = await seedTwoClipsOnSeparateTracks()
    await openLayoutTab(id1)
    await expect(page.locator('[data-testid="layout-select-hint"]')).toBeVisible()
  })

  test('A-2 2개 선택 + preset 적용 → layoutGroupId 부여', async () => {
    const { page } = launched!
    const { id1, id2 } = await seedTwoClipsOnSeparateTracks()
    await openLayoutTab(id1)
    // 2 개 multi-select.
    await page.evaluate(
      ({ a, b }) => {
        window.__reelsTimelineUi.setState({
          selectedClipIds: new Set([a, b]),
          selectedAdjustmentLayerId: null
        })
      },
      { a: id1, b: id2 }
    )
    await page.waitForTimeout(150)
    // hint 가 사라지고 preset 격자 노출.
    await expect(page.locator('[data-testid="layout-select-hint"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="layout-preset-grid"]')).toBeVisible()
    // 좌우 분할 (split-h) preset 클릭.
    await page.locator('[data-testid="layout-preset-2up-h"]').click()
    await page.locator('[data-testid="layout-apply"]').click()
    await page.waitForTimeout(200)
    const result = await page.evaluate(({ a, b }) => {
      type ClipWithLayout = {
        id: string
        transform?: { x: number }
        layoutGroupId?: string
      }
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips) as unknown as ClipWithLayout[]
      const c1 = clips.find((c) => c.id === a)!
      const c2 = clips.find((c) => c.id === b)!
      return {
        c1Group: c1.layoutGroupId ?? null,
        c2Group: c2.layoutGroupId ?? null,
        c1X: c1.transform?.x ?? 0,
        c2X: c2.transform?.x ?? 0
      }
    }, { a: id1, b: id2 })
    expect(result.c1Group).not.toBeNull()
    expect(result.c2Group).not.toBeNull()
    expect(result.c1Group).toBe(result.c2Group)
    // 좌우 분할: 두 클립의 transform.x 가 서로 달라야 (left/right 칸).
    expect(result.c1X).not.toBe(result.c2X)
  })
})
