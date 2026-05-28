/**
 * UpdateStatusPanel — 옵션 popover의 현재 설치 버전 표시.
 *
 * Verifies:
 *   - 버전이 비어있지 않게 표시 (preload getVersion 응답).
 *   - 자동업데이트 버튼 없이 수동 재설치 안내가 노출.
 *
 * @update-status-panel
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@update-status-panel installed version display', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched!
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', {
      state: 'attached',
      timeout: 45_000
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

  test('A-1 옵션 popover 안에 update-status-panel + 버전 + 수동 설치 안내가 노출', async () => {
    const { page } = launched!
    // Open the options popover (the ToolbarMenu trigger).
    const menuTrigger = page.locator('[data-testid="topbar-menu-options"]')
    await expect(menuTrigger).toBeAttached({ timeout: 5_000 })
    await menuTrigger.click()
    // Panel mounts inside.
    const panel = page.locator('[data-testid="update-status-panel"]')
    await expect(panel).toBeVisible({ timeout: 5_000 })
    const ver = page.locator('[data-testid="update-status-version"]')
    await expect(ver).toBeVisible()
    const v = (await ver.textContent()) || ''
    // Must look like a real semver-ish value (digits + dots), not the
    // "—" placeholder. 0.2.0 / 0.2.1 / etc.
    expect(v).toMatch(/^\d+\.\d+\.\d+/)
    await expect(page.locator('[data-testid="update-status-check"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="update-status-manual-note"]')).toContainText(
      '웹 다운로드 페이지'
    )
  })
})
