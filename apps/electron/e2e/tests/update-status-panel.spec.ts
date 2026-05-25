/**
 * UpdateStatusPanel — 옵션 popover의 버전 표시 + "업데이트 확인" 버튼.
 *
 * Verifies:
 *   - 버전이 비어있지 않게 표시 (preload getVersion 응답).
 *   - "업데이트 확인" 버튼이 옵션 popover 안에 노출.
 *   - 클릭 → checking → dev-mode error (dev에서 expected) 상태로 흘러감.
 *
 * @update-status-panel
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@update-status-panel manual update check + version display', () => {
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

  test('A-1 옵션 popover 안에 update-status-panel + 버전 + 버튼이 노출', async () => {
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
    const btn = page.locator('[data-testid="update-status-check"]')
    await expect(btn).toBeVisible()
    await expect(btn).toBeEnabled()
  })

  test('A-2 "업데이트 확인" 클릭 → dev 환경에선 dev-mode 에러 상태로 갈림', async () => {
    const { page } = launched!
    await page.locator('[data-testid="topbar-menu-options"]').click()
    await page.waitForSelector('[data-testid="update-status-panel"]', {
      state: 'visible',
      timeout: 5_000
    })
    await page.locator('[data-testid="update-status-check"]').click()
    // Dev / unpackaged builds return 'dev-mode' from checkForUpdateNow →
    // panel sets error status with "개발 모드 — 패키지 빌드에서만 동작".
    const err = page.locator('[data-testid="update-status-error"]')
    await expect(err).toBeVisible({ timeout: 10_000 })
    await expect(err).toContainText('개발 모드')
    // role=alert + aria-live=assertive so SR interrupts (audit #2 same
    // pattern).
    await expect(err).toHaveAttribute('role', 'alert')
    await expect(err).toHaveAttribute('aria-live', 'assertive')
  })
})
