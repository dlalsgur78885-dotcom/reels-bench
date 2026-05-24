/**
 * Phase 3.87 — current project info card on Home.
 *
 * Single-store architecture — the "recent projects list" collapses to one
 * project. Card shows name + aspectRatio + clip / caption count + last-
 * modified relative time, plus a "Editor로 계속" button that routes in.
 *
 * @phase-3-87-current-project-card
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-3-87-current-project-card Home current-project card', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
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

  test('A-1 current-project-card renders on Home with project name', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    // The card subscribes to the project store on mount; give the
    // dynamic import + subscribe one tick to land.
    const card = page.locator('[data-testid="current-project-card"]')
    await expect(card).toBeVisible({ timeout: 5_000 })
    const text = await card.textContent()
    expect(text).toMatch(/📁/)
  })

  test('A-2 continue button routes to editor', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await expect(
      page.locator('[data-testid="continue-current-project"]')
    ).toBeVisible({ timeout: 5_000 })
    await page.locator('[data-testid="continue-current-project"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible({
      timeout: 30_000
    })
  })

  test('A-3 card shows aspect ratio + clip / caption count tokens', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const card = page.locator('[data-testid="current-project-card"]')
    await expect(card).toBeVisible({ timeout: 5_000 })
    const text = (await card.textContent()) ?? ''
    expect(text).toMatch(/(9:16|1:1|16:9|4:5)/)
    expect(text).toContain('클립')
    expect(text).toContain('자막')
  })
})
