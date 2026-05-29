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
    ).toHaveValue('0.5')

    // 클립 변형 탭과 동일한 raw 값 (scale 배율, y/opacity 0..1).
    await page.locator('[data-testid="adjustment-transform-scale-input"]').fill('0.65')
    await page.locator('[data-testid="adjustment-transform-y-input"]').fill('-0.25')
    await page.locator('[data-testid="adjustment-transform-opacity-input"]').fill('0.7')
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

  test('속도/레이아웃 탭은 안내문 노출', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    // 애니메이션 탭은 이제 실제 변형 키프레임 UI(릴스벤치14 슬라이드 6)라
    // 안내문 전용이 아님 — 별도 테스트에서 다룸.
    for (const tab of ['speed', 'layout']) {
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

  // 릴스벤치14 슬라이드 6 — 영상 클립과 동일한 변형 키프레임.
  test('변형 ◇ 클릭 시 키프레임 트랙 생성 + 애니메이션 탭 리스트', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    // 재생헤드 0 으로 이동.
    await page.evaluate(() =>
      (
        window as unknown as {
          __reelsTimelineUi: { getState: () => { setPlayheadMs: (n: number) => void } }
        }
      ).__reelsTimelineUi.getState().setPlayheadMs(0)
    )
    await page.locator('[data-testid="adjustment-effects-tab-transform"]').click()
    await page.waitForTimeout(60)

    // 5개 필드 모두 ◇ 버튼 노출 (클립 변형 탭과 동일).
    for (const f of ['scale', 'rotation', 'opacity', 'x', 'y']) {
      await expect(
        page.locator(`[data-testid="adjustment-transform-${f}-kf"]`)
      ).toBeVisible()
    }

    const editorBox = await page
      .locator('[data-testid="adjustment-layer-editor"]')
      .boundingBox()
    expect(editorBox).not.toBeNull()
    for (const f of ['scale', 'rotation', 'opacity', 'x', 'y']) {
      const buttonBox = await page
        .locator(`[data-testid="adjustment-transform-${f}-kf"]`)
        .boundingBox()
      expect(buttonBox).not.toBeNull()
      expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(
        editorBox!.x + editorBox!.width + 1
      )
    }

    const scaleKf = page.locator('[data-testid="adjustment-transform-scale-kf"]')
    await expect(scaleKf).toHaveAttribute('data-kf-active', 'false')

    await scaleKf.click()
    await page.waitForTimeout(120)

    const kfCount = await page.evaluate(() => {
      const p = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                adjustmentLayers?: Array<{ transformKeyframes?: unknown[] }>
              }
            }
          }
        }
      ).__reelsStore.state().project
      return p.adjustmentLayers?.[0]?.transformKeyframes?.length ?? 0
    })
    expect(kfCount).toBeGreaterThanOrEqual(2)
    // 재생헤드 0 은 첫 키프레임 위 → ◇ active.
    await expect(scaleKf).toHaveAttribute('data-kf-active', 'true')
    for (const f of ['rotation', 'opacity', 'x', 'y']) {
      await expect(
        page.locator(`[data-testid="adjustment-transform-${f}-kf"]`)
      ).toHaveAttribute('data-kf-active', 'true')
    }

    // 애니메이션 탭 — 카운트 배지 + 키프레임 리스트.
    await page.locator('[data-testid="adjustment-effects-tab-animation"]').click()
    await page.waitForTimeout(60)
    await expect(
      page.locator('[data-testid="adjustment-keyframe-count"]')
    ).toHaveText(String(kfCount))
    await expect(
      page.locator('[data-testid="adjustment-keyframe-row-0"]')
    ).toBeVisible()
  })

  test('키프레임 보간이 프리뷰 영역 transform 에 반영', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => { project: { adjustmentLayers: Array<{ id: string }> } }
            setAdjustmentLayerColorAdjust: (id: string, p: Record<string, number>) => void
            addAdjustmentLayerTransformKeyframe: (
              id: string,
              atMs: number,
              t?: Record<string, number>
            ) => void
          }
        }
      ).__reelsStore
      const id = reels.state().project.adjustmentLayers[0].id
      // grade 를 줘서 영역이 확실히 렌더되게.
      reels.setAdjustmentLayerColorAdjust(id, { brightness: 30 })
      reels.addAdjustmentLayerTransformKeyframe(id, 0, { scale: 0.5 })
      reels.addAdjustmentLayerTransformKeyframe(id, 2000, { scale: 2.0 })
    })

    const scaleAt = async (ms: number): Promise<number> => {
      await page.evaluate(
        (m) =>
          (
            window as unknown as {
              __reelsTimelineUi: {
                getState: () => { setPlayheadMs: (n: number) => void }
              }
            }
          ).__reelsTimelineUi.getState().setPlayheadMs(m),
        ms
      )
      await page.waitForTimeout(120)
      const style = await page
        .locator('[data-testid="preview-adjustment-region"]')
        .first()
        .getAttribute('style')
      const m = /[^X]scale\(([-0-9.]+)\)/.exec(` ${style ?? ''}`)
      return m ? parseFloat(m[1]) : NaN
    }

    const s0 = await scaleAt(0)
    const s1000 = await scaleAt(1000)
    const s2000 = await scaleAt(2000)

    expect(s0).toBeCloseTo(0.5, 1)
    expect(s2000).toBeCloseTo(2.0, 1)
    // 중간 시점은 두 끝 사이 — 보간이 프리뷰까지 전달됨.
    expect(s1000).toBeGreaterThan(s0)
    expect(s1000).toBeLessThan(s2000)
  })
})
