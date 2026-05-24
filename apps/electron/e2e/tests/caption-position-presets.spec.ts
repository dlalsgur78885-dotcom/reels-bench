/**
 * Phase 3.82 — caption add at top / center / bottom presets.
 *
 * @phase-3-82-caption-position-presets
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import { openCaptionsMenu } from '../helpers/topbar'

type AnyCaption = { id: string; kind: string; style?: { yPosition?: number } }

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: {
          tracks: Array<{ kind: string; clips: AnyCaption[] }>
        }
        createNew: () => void
      }
    }
  }
}

test.describe('@phase-3-82-caption-position-presets quick top/center/bottom add', () => {
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
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
      await new Promise((r) => setTimeout(r, 700))
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

  async function getLastCaption(): Promise<AnyCaption | null> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const tr = window.__PROJECT_STORE_FOR_TEST__
        .getState()
        .project.tracks.find((t) => t.kind === 'caption')
      return (tr?.clips[tr.clips.length - 1] as AnyCaption) ?? null
    })
  }

  test('A-1 add-caption-top → caption with style.yPosition = 0.15', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openCaptionsMenu(page)
    await page.locator('[data-testid="add-caption-top"]').click()
    await page.waitForTimeout(200)
    const c = await getLastCaption()
    expect(c?.style?.yPosition).toBeCloseTo(0.15, 3)
  })

  test('A-2 add-caption-center → 0.5', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openCaptionsMenu(page)
    await page.locator('[data-testid="add-caption-center"]').click()
    await page.waitForTimeout(200)
    const c = await getLastCaption()
    expect(c?.style?.yPosition).toBeCloseTo(0.5, 3)
  })

  test('A-3 add-caption-bottom → 0.85', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openCaptionsMenu(page)
    await page.locator('[data-testid="add-caption-bottom"]').click()
    await page.waitForTimeout(200)
    const c = await getLastCaption()
    expect(c?.style?.yPosition).toBeCloseTo(0.85, 3)
  })
})
