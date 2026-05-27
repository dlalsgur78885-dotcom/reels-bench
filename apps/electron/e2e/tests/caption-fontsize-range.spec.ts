/**
 * pptx12 슬라이드 12 — 자막 폰트 크기 max 96 → 500 확장 + 숫자 입력.
 *
 * Contract:
 *  (1) caption-fontsize-slider max=500.
 *  (2) 슬라이더 500 으로 set → caption.style.fontSize=500.
 *  (3) caption-fontsize-input (숫자) 도 노출 + clamp [16,500].
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

async function openCaptionEditorWithCaption(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.locator('[data-testid="open-editor-button"]').click()
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
    null,
    { timeout: 5_000 }
  )
  await page.keyboard.press('c')
  await page.waitForTimeout(250)
  await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible({
    timeout: 5_000
  })
}

async function captionFontSize(launched: LaunchedApp): Promise<number | null> {
  return launched.page.evaluate(() => {
    const reels = (
      window as unknown as {
        __reelsStore: {
          state: () => {
            project: {
              tracks: Array<{
                clips: Array<{ kind: string; style?: { fontSize?: number } }>
              }>
            }
          }
        }
      }
    ).__reelsStore
    for (const t of reels.state().project.tracks)
      for (const c of t.clips)
        if (c.kind === 'caption') return c.style?.fontSize ?? null
    return null
  })
}

test.describe('@phase-caption-fontsize-range 자막 폰트 크기 max 500', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: { getState: () => { createNew: () => void } }
        }
      ).__PROJECT_STORE_FOR_TEST__
      store.getState().createNew()
      await new Promise((r) => setTimeout(r, 400))
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

  test('slider max attribute is 500', async () => {
    if (!launched) throw new Error('launch failed')
    await openCaptionEditorWithCaption(launched)
    const slider = launched.page.locator('[data-testid="caption-fontsize-slider"]')
    await expect(slider).toHaveAttribute('max', '500')
    await expect(slider).toHaveAttribute('min', '16')
  })

  test('slider 500 → caption.style.fontSize 500', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openCaptionEditorWithCaption(launched)
    const slider = page.locator('[data-testid="caption-fontsize-slider"]')
    await slider.fill('500')
    // range input fill dispatches input event — wait for store update.
    await page.waitForTimeout(150)
    expect(await captionFontSize(launched)).toBe(500)
  })

  test('number input clamps to [16, 500]', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openCaptionEditorWithCaption(launched)
    const num = page.locator('[data-testid="caption-fontsize-input"]')
    await expect(num).toBeVisible()
    // 1000 입력 → 500 으로 clamp.
    await num.fill('1000')
    await num.blur()
    await page.waitForTimeout(150)
    expect(await captionFontSize(launched)).toBe(500)
    // 5 입력 → 16 으로 clamp.
    await num.fill('5')
    await num.blur()
    await page.waitForTimeout(150)
    expect(await captionFontSize(launched)).toBe(16)
    // 240 정상 — clamp 안 됨.
    await num.fill('240')
    await num.blur()
    await page.waitForTimeout(150)
    expect(await captionFontSize(launched)).toBe(240)
  })
})
