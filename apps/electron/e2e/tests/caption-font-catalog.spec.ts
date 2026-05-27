/**
 * pptx12 슬라이드 13 — 자막 폰트 카탈로그 확장. 사용자 보고 "폰트 얼마
 * 없음 / 추가 기능 있었음 좋겠음". 기존 8개에서 한글 6 / 영문 6 = 12 추가
 * 해서 총 20개로.
 *
 * Contract: CaptionEditor 의 폰트 selector option 수가 ≥18 이고 기존 8 +
 * 신규 한글 6 + 신규 영문 6 id 가 모두 노출.
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
  // 자막 추가는 'C' 키. (Editor.tsx 의 handleAddCaption 단축키)
  await page.keyboard.press('c')
  await page.waitForTimeout(250)
  await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible({
    timeout: 5_000
  })
}

test.describe('@phase-caption-font-catalog 자막 폰트 카탈로그 확장', () => {
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

  test('font selector ≥18 options + 기존 8 + 신규 한글 6 + 영문 6 id 모두 노출', async () => {
    if (!launched) throw new Error('launch failed')
    await openCaptionEditorWithCaption(launched)
    const select = launched.page.locator(
      '[data-testid="caption-fontfamily-select"]'
    )
    await expect(select).toBeVisible({ timeout: 5_000 })
    const optionValues = await select
      .locator('option')
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value))
    expect(optionValues.length).toBeGreaterThanOrEqual(18)
    const ids = new Set(optionValues)
    for (const id of [
      // 기존 8.
      'pretendard',
      'malgun',
      'apple-sd',
      'noto-sans-kr',
      'arial',
      'impact',
      'georgia',
      'courier',
      // 신규 한글 6.
      'nanum-gothic',
      'nanum-myeongjo',
      'nanum-square',
      'nanum-pen',
      'noto-serif-kr',
      'gmarket-sans',
      // 신규 영문 6.
      'helvetica',
      'times',
      'verdana',
      'tahoma',
      'trebuchet',
      'comic'
    ]) {
      expect(ids.has(id)).toBe(true)
    }
  })

  test('신규 폰트 선택 시 caption.style.fontFamilyId 가 그 값으로 저장', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openCaptionEditorWithCaption(launched)
    const select = page.locator('[data-testid="caption-fontfamily-select"]')
    await select.selectOption('verdana')
    await page.waitForTimeout(150)
    const stored = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  clips: Array<{
                    kind: string
                    style?: { fontFamilyId?: string }
                  }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips)
          if (c.kind === 'caption') return c.style?.fontFamilyId
      return null
    })
    expect(stored).toBe('verdana')
  })
})
