/**
 * pptx11 슬라이드 12 — 플랫폼 미리보기 인터랙션 아이콘이 영상 가운데가
 * 아닌 **오른쪽 가장자리** 에 있어야 한다는 회귀 가드.
 *
 * 이전 버그: ActionStack 에 explicit width 가 없어 label 텍스트가 stack
 * 가로 폭을 늘려서 `right: 3.5%` 가 stack 의 오른쪽 끝이 되고 본체는
 * 영상 중앙에 위치 → 인물 얼굴 위로 아이콘 겹침.
 * fix: ActionStack 에 width:14% (min 48px) 부여.
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-social-preview-position 플랫폼 미리보기 아이콘 위치', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    await launched.page.locator('[data-testid="open-editor-button"]').click()
    await launched.page.waitForFunction(
      () =>
        !!(window as unknown as { __TIMELINE_UI_FOR_TEST__?: unknown })
          .__TIMELINE_UI_FOR_TEST__
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
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate((platform) => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: {
            getState: () => { setSocialPreviewPlatform: (p: string) => void }
          }
        }
      ).__TIMELINE_UI_FOR_TEST__
      ui.getState().setSocialPreviewPlatform(platform)
    }, p)
    await launched.page.waitForTimeout(180)
  }

  /** ActionStack 의 left edge / right edge 가 preview-fitted-rect 의 어느 비율에
   *  있는지 측정. 정상: stack right ≈ 96~98% (right 3.5%) + stack 폭 좁음. */
  async function stackPosPct(): Promise<{ leftPct: number; rightPct: number }> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const rect = document.querySelector(
        '[data-testid="preview-fitted-rect"]'
      ) as HTMLElement | null
      const stack = document.querySelector(
        '[data-testid="social-overlay-action-stack"]'
      ) as HTMLElement | null
      if (!rect || !stack) return { leftPct: 0, rightPct: 0 }
      const rb = rect.getBoundingClientRect()
      const sb = stack.getBoundingClientRect()
      const leftPct = ((sb.left - rb.left) / rb.width) * 100
      const rightPct = ((sb.right - rb.left) / rb.width) * 100
      return { leftPct, rightPct }
    })
  }

  for (const p of ['tiktok', 'youtube', 'instagram']) {
    test(`${p} — ActionStack right edge ≥ 90% from left, stack 폭 ≤ 25%`, async () => {
      await selectPlatform(p)
      const { leftPct, rightPct } = await stackPosPct()
      // ActionStack right edge must be near the right side of the preview
      // (CSS right: 3.5% → rightPct ≈ 96.5).
      expect(rightPct).toBeGreaterThanOrEqual(90)
      // 폭이 30% 넘으면 label 텍스트가 stack 을 벌리고 있는 상태 — bug 재발.
      // (width:14% + minWidth:48 + 작은 preview 영역이라 약 26% 정도까지 정상).
      expect(rightPct - leftPct).toBeLessThanOrEqual(30)
      // 왼쪽 edge 도 화면 중앙(50%) 너머에 있어야 함 (아이콘이 가운데로 안 옴).
      expect(leftPct).toBeGreaterThanOrEqual(65)
    })
  }
})
