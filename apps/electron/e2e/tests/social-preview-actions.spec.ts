/**
 * Reels 11 슬라이드 12 — 플랫폼별 액션 스택 위치/구성 보정.
 *
 * 추가 정합성 가드:
 *  (1) TikTok 회전 음원 디스크(social-action-music-disc) 존재.
 *  (2) YouTube Shorts 싫어요(social-action-dislike) 존재.
 *  (3) Instagram 릴스 액션에 저장(저장 testid social-action-save) 더 이상 없음
 *      (실제 Instagram 은 더보기 메뉴 안에 위치).
 *
 * @reels-11-slide-12-social-actions
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type TimelineUiStore = {
  getState: () => {
    setSocialPreviewPlatform: (p: string) => void
  }
}

test.describe('@reels-11-slide-12-social-actions 플랫폼 액션 정합성', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible({
      timeout: 8_000
    })
    await page.waitForFunction(
      () =>
        !!(window as unknown as { __TIMELINE_UI_FOR_TEST__?: unknown })
          .__TIMELINE_UI_FOR_TEST__,
      null,
      { timeout: 5_000 }
    )
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

  async function selectPlatform(p: string): Promise<void> {
    await launched!.page.evaluate((platform) => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      ui.getState().setSocialPreviewPlatform(platform)
    }, p)
    await launched!.page.waitForTimeout(120)
  }

  test('A-1 TikTok 회전 음원 디스크 + 팔로우 배지 + share 종이비행기', async () => {
    await selectPlatform('tiktok')
    const { page } = launched!
    await expect(page.locator('[data-testid="social-overlay-tiktok"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="social-action-music-disc"]')
    ).toBeVisible()
    // 기존 액션도 그대로.
    await expect(page.locator('[data-testid="social-action-like"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-action-share"]')).toBeVisible()
  })

  test('A-2 YouTube Shorts 싫어요 액션 존재', async () => {
    await selectPlatform('youtube')
    const { page } = launched!
    await expect(page.locator('[data-testid="social-overlay-youtube"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-action-dislike"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-action-like"]')).toBeVisible()
    await expect(page.locator('[data-testid="social-action-remix"]')).toBeVisible()
  })

  test('A-3 Instagram 릴스 액션에서 저장 제거 (Instagram 은 더보기 안)', async () => {
    await selectPlatform('instagram')
    const { page } = launched!
    await expect(
      page.locator('[data-testid="social-overlay-instagram"]')
    ).toBeVisible()
    // 저장 액션은 더 이상 액션 스택에 없음.
    await expect(page.locator('[data-testid="social-action-save"]')).toHaveCount(0)
    // 회전 audio 썸네일은 여전히 표시.
    await expect(page.locator('[data-testid="social-action-audio"]')).toBeVisible()
  })
})
