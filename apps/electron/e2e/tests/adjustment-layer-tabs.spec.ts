/**
 * pptx12 슬라이드 18 — 조정 레이어 효과 패널이 일반 EffectsPanel 과 동일한
 * 6탭 구조 (변형/속도/애니메이션/조정/전환/레이아웃) 노출.
 *
 * Contract:
 *  (1) 6개 탭 버튼 모두 존재.
 *  (2) 기본 활성 탭 = '조정' (필터/색보정/곡선/HSL UI).
 *  (3) 변형 탭은 영역 X/Y/크기/투명도 컨트롤을 저장.
 *  (4) 속도/애니메이션/레이아웃 탭은 안내 텍스트.
 *  (5) 전환 탭은 fade in/out 슬라이더 (pptx11 슬라이드 23 유지).
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-adjustment-layer-tabs 조정 레이어 6탭 구조', () => {
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
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )
    // 조정 레이어 추가 + select → AdjustmentLayerEditor 가 노출됨.
    await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            addAdjustmentLayer: (a: number, b: number) => string | null
          }
        }
      ).__reelsStore
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => {
              setSelectedAdjustmentLayerId: (id: string | null) => void
            }
          }
        }
      ).__reelsTimelineUi
      const id = reels.addAdjustmentLayer(0, 4000)
      if (!id) throw new Error('addAdjustmentLayer failed')
      ui.getState().setSelectedAdjustmentLayerId(id)
    })
    await page.waitForTimeout(200)
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

  test('6개 탭 버튼 모두 노출 + 라벨 정확', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const labels: Record<string, string> = {
      transform: '변형',
      speed: '속도',
      animation: '애니메이션',
      adjust: '조정',
      transition: '전환',
      layout: '레이아웃'
    }
    for (const [key, label] of Object.entries(labels)) {
      const btn = page.locator(`[data-testid="adjustment-effects-tab-${key}"]`)
      await expect(btn).toBeVisible()
      await expect(btn).toHaveText(label)
    }
  })

  test('기본 활성 탭은 조정 (색보정/필터 콘텐츠)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    // 조정 탭 컨텐츠 노출 — color adjust 슬라이더 한 개라도 보여야.
    await expect(
      page.locator('[data-testid="adjustment-coloradjust-brightness-slider"]')
    ).toBeVisible()
    // 다른 탭 컨텐츠는 안 보임.
    await expect(
      page.locator('[data-testid="adjustment-tab-transform"]')
    ).toHaveCount(0)
  })

  test('변형 탭은 조정 레이어 영역 크기/위치/투명도 저장', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="adjustment-effects-tab-transform"]').click()
    await page.waitForTimeout(80)
    await expect(page.locator('[data-testid="adjustment-tab-transform"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="adjustment-transform-scale-slider"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="adjustment-transform-scale-input"]')
    ).toHaveValue('50')

    await page.locator('[data-testid="adjustment-transform-scale-input"]').fill('65')
    await page.locator('[data-testid="adjustment-transform-y-input"]').fill('-25')
    await page.locator('[data-testid="adjustment-transform-opacity-input"]').fill('70')
    await page.waitForTimeout(120)

    const saved = await page.evaluate(() => {
      const project = window.__reelsStore.state().project as {
        adjustmentLayers?: Array<{
          transform?: { scale?: number; y?: number; opacity?: number }
        }>
      }
      return project.adjustmentLayers?.[0]?.transform
    })
    expect(saved?.scale).toBeCloseTo(0.65, 4)
    expect(saved?.y).toBeCloseTo(-0.25, 4)
    expect(saved?.opacity).toBeCloseTo(0.7, 4)

    await page.evaluate(() => {
      const project = window.__reelsStore.state().project as {
        adjustmentLayers?: Array<{ id: string }>
      }
      const id = project.adjustmentLayers?.[0]?.id
      if (!id) throw new Error('missing adjustment layer')
      window.__reelsStore.setAdjustmentLayerColorAdjust(id, { brightness: 35 })
    })
    await expect(page.locator('[data-testid="preview-adjustment-region"]')).toBeVisible()
    await expect(page.locator('[data-testid="preview-fitted-rect"]')).toHaveAttribute(
      'data-adjustment-active',
      'true'
    )

    await page.locator('[data-testid="adjustment-transform-reset"]').click()
    await page.waitForTimeout(120)
    const reset = await page.evaluate(() => {
      const project = window.__reelsStore.state().project as {
        adjustmentLayers?: Array<{ transform?: { scale?: number; y?: number; opacity?: number } }>
      }
      return project.adjustmentLayers?.[0]?.transform ?? null
    })
    expect(reset?.scale).toBeCloseTo(0.5, 4)
    expect(reset?.y).toBeCloseTo(0, 4)
    expect(reset?.opacity).toBeCloseTo(1, 4)
  })

  test('속도/애니메이션/레이아웃 탭은 안내문 노출', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    for (const tab of ['speed', 'animation', 'layout']) {
      await page.locator(`[data-testid="adjustment-effects-tab-${tab}"]`).click()
      await page.waitForTimeout(80)
      await expect(
        page.locator(`[data-testid="adjustment-tab-${tab}"]`)
      ).toBeVisible()
      // 안내문 안에 키워드 들어가야 함.
      const text = await page
        .locator(`[data-testid="adjustment-tab-${tab}"]`)
        .innerText()
      expect(text.length).toBeGreaterThan(20)
    }
  })

  test('전환 탭 클릭 시 fade in/out 슬라이더 노출', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="adjustment-effects-tab-transition"]').click()
    await page.waitForTimeout(80)
    await expect(page.locator('[data-testid="adjustment-fade-panel"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="adjustment-fade-in-slider"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="adjustment-fade-out-slider"]')
    ).toBeVisible()
  })
})
