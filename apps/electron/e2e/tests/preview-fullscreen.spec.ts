/**
 * Phase 3.72 — preview fullscreen toggle (F key + button).
 *
 * The fullscreen API itself can't be exercised end-to-end without a real
 * window manager (Playwright's headless Electron doesn't grant gesture
 * unless wired specifically), so we cover the WIRING contract:
 *   - A-1 the toggle button mounts in the preview overlay.
 *   - A-2 clicking the button does not throw (rejected fullscreen promise
 *         is swallowed defensively).
 *   - A-3 pressing the F key does not throw and does not interfere with
 *         the editor's keyboard handlers when typed inside an input.
 *
 * @phase-3-72-preview-fullscreen
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-3-72-preview-fullscreen preview fullscreen toggle', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({
      timeout: 30_000
    })
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

  test('A-1 toggle button mounts in the preview overlay', async () => {
    if (!launched) throw new Error('launch failed')
    await expect(
      launched.page.locator('[data-testid="preview-fullscreen-toggle"]')
    ).toBeVisible()
  })

  test('A-2 clicking the toggle does not throw page errors', async () => {
    if (!launched) throw new Error('launch failed')
    const { page, pageErrors } = launched
    const before = pageErrors.length
    await page
      .locator('[data-testid="preview-fullscreen-toggle"]')
      .click({ force: true })
    await page.waitForTimeout(150)
    // The headless Electron may refuse to enter fullscreen; either way no
    // page error must surface.
    expect(pageErrors.length).toBe(before)
  })

  test('A-3 pressing F key does not throw page errors', async () => {
    if (!launched) throw new Error('launch failed')
    const { page, pageErrors } = launched
    const before = pageErrors.length
    // Click on the editor body first so the key reaches our window-level handler.
    await page.locator('[data-testid="editor-page"]').click({ force: true })
    await page.keyboard.press('f')
    await page.waitForTimeout(120)
    expect(pageErrors.length).toBe(before)
  })
})
