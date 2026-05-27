/**
 * Home project preservation.
 *
 * Creating a new project must not make the previous edit disappear. The
 * renderer archives the current project before switching to a fresh one, and
 * Home lists archived projects so they can be reopened.
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: {
          id: string
          name: string
        }
        setName: (name: string) => void
      }
    }
  }
}

test.describe('@project-preservation saved projects', () => {
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

  test('new project archives the previous edit and can reopen it', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible({
      timeout: 30_000
    })
    await page.waitForFunction(
      () => !!window.__PROJECT_STORE_FOR_TEST__,
      null,
      { timeout: 8_000 }
    )

    const oldProject = await page.evaluate(() => {
      const store = window.__PROJECT_STORE_FOR_TEST__.getState()
      const name = `보존 테스트 ${Date.now()}`
      store.setName(name)
      return { id: store.project.id, name }
    })

    await page.locator('[data-testid="editor-back-button"]').click()
    await expect(page.locator('[data-testid="start-preset-square"]')).toBeVisible({
      timeout: 10_000
    })
    await page.locator('[data-testid="start-preset-square"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible({
      timeout: 30_000
    })

    const newProjectId = await page.evaluate(
      () => window.__PROJECT_STORE_FOR_TEST__.getState().project.id
    )
    expect(newProjectId).not.toBe(oldProject.id)

    await page.locator('[data-testid="editor-back-button"]').click()
    await expect(page.locator('[data-testid="saved-project-list"]')).toBeVisible({
      timeout: 10_000
    })
    await expect(page.locator('[data-testid="saved-project-list"]')).toContainText(
      oldProject.name
    )

    await page
      .locator('[data-testid="saved-project-card"]')
      .filter({ hasText: oldProject.name })
      .locator('[data-testid="open-saved-project"]')
      .click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible({
      timeout: 30_000
    })

    const reopened = await page.evaluate(
      () => window.__PROJECT_STORE_FOR_TEST__.getState().project
    )
    expect(reopened.id).toBe(oldProject.id)
    expect(reopened.name).toBe(oldProject.name)
  })
})
