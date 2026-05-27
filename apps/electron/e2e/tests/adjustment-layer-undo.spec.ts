/**
 * pptx11 슬라이드 22 — 조정 레이어에 효과/색보정 적용 후 Ctrl+Z 가 안 먹힘.
 * 두 시나리오로 분리:
 *  (1) 필터 preset 적용 → undo → preset 'none' 으로 되돌아가는지
 *  (2) 색보정 (밝기/채도) 적용 → undo → colorAdjust 사라지는지
 *
 * 둘 다 store 액션 (setAdjustmentLayerFilterPreset / setAdjustmentLayerColorAdjust)
 * 가 zundo temporal snapshot 을 생성하는지 검증.
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-adjustment-layer-undo adjustment layer undo', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            getState: () => { createNew: () => void }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      store.getState().createNew()
      await new Promise((r) => setTimeout(r, 500))
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

  async function openEditorWithAdjustmentLayer(): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )
    const layerId = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            addAdjustmentLayer: (s: number, e: number) => string | null
          }
        }
      ).__reelsStore
      const id = reels.addAdjustmentLayer(0, 5000)
      if (!id) throw new Error('addAdjustmentLayer returned null')
      return id
    })
    // zundo throttle (200ms) 통과시키기 위해 잠깐 대기.
    await page.waitForTimeout(300)
    return layerId
  }

  async function getLayer(id: string): Promise<{
    filterPreset?: string
    filterIntensity?: number
    colorAdjust?: { brightness?: number; saturation?: number }
  } | null> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate((lid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                adjustmentLayers?: Array<{
                  id: string
                  filterPreset?: string
                  filterIntensity?: number
                  colorAdjust?: { brightness?: number; saturation?: number }
                }>
              }
            }
          }
        }
      ).__reelsStore
      const layers = reels.state().project.adjustmentLayers ?? []
      return layers.find((l) => l.id === lid) ?? null
    }, id)
  }

  async function undo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => {
      const u = (
        window as unknown as {
          __reelsUndoRedo: { getState: () => { undo: () => void } }
        }
      ).__reelsUndoRedo
      u.getState().undo()
    })
    await launched.page.waitForTimeout(250)
  }

  test('filter preset on adjustment layer is reverted by undo', async () => {
    if (!launched) throw new Error('launch failed')
    const layerId = await openEditorWithAdjustmentLayer()
    expect((await getLayer(layerId))?.filterPreset).toBeFalsy()

    await launched.page.evaluate((lid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerFilterPreset: (
              id: string,
              preset: string,
              intensity: number
            ) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerFilterPreset(lid, 'underwater', 1)
    }, layerId)
    await launched.page.waitForTimeout(300)
    expect((await getLayer(layerId))?.filterPreset).toBe('underwater')

    await undo()

    const after = await getLayer(layerId)
    // undo 가 동작했으면 preset 이 사라지거나 'none' 으로 돌아가야 함.
    expect(after?.filterPreset === undefined || after?.filterPreset === 'none').toBe(true)
  })

  test('color adjust on adjustment layer is reverted by undo', async () => {
    if (!launched) throw new Error('launch failed')
    const layerId = await openEditorWithAdjustmentLayer()
    expect((await getLayer(layerId))?.colorAdjust).toBeFalsy()

    await launched.page.evaluate((lid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerColorAdjust: (
              id: string,
              partial: { brightness?: number; saturation?: number }
            ) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerColorAdjust(lid, { brightness: 14, saturation: 63 })
    }, layerId)
    await launched.page.waitForTimeout(300)
    const before = await getLayer(layerId)
    expect(before?.colorAdjust?.brightness).toBe(14)
    expect(before?.colorAdjust?.saturation).toBe(63)

    await undo()

    const after = await getLayer(layerId)
    // undo 가 동작했으면 colorAdjust 가 neutral 로 돌아가야 함 (저장된 값
    // undefined 또는 brightness 0, saturation 0).
    const bright = after?.colorAdjust?.brightness ?? 0
    const sat = after?.colorAdjust?.saturation ?? 0
    expect(bright).toBe(0)
    expect(sat).toBe(0)
  })

  /**
   * 사용자 시나리오 재현: 색보정 슬라이더(input[type=range])에 focus 가 있는
   * 상태로 Ctrl+Z 를 누르면 undo 가 안 됨. Editor.tsx keydown 핸들러가 input
   * focus 면 일률적으로 early-return 해서 Ctrl+Z 가 묵살되는 게 원인.
   */
  test('Ctrl+Z keypress while a range slider has focus undoes the last layer mutation', async () => {
    if (!launched) throw new Error('launch failed')
    const layerId = await openEditorWithAdjustmentLayer()

    // 색보정 적용 → undo step 1개 추가.
    await launched.page.evaluate((lid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerColorAdjust: (
              id: string,
              partial: { brightness?: number }
            ) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerColorAdjust(lid, { brightness: 14 })
    }, layerId)
    await launched.page.waitForTimeout(300)
    expect((await getLayer(layerId))?.colorAdjust?.brightness).toBe(14)

    // 슬라이더 focus 시뮬레이션 — 실제 슬라이더 컴포넌트 렌더는 무관, 핵심은
    // input[type=range] 가 focus 된 상태에서 Ctrl+Z 가 keydown handler 에
    // 도달하는지.
    await launched.page.evaluate(() => {
      const inp = document.createElement('input')
      inp.type = 'range'
      inp.id = '__test_range__'
      inp.style.position = 'fixed'
      inp.style.left = '0'
      inp.style.top = '0'
      document.body.appendChild(inp)
      inp.focus()
    })
    await launched.page.waitForTimeout(100)

    // 정말 range input 이 focus 됐는지 확인.
    const focusedTag = await launched.page.evaluate(() => {
      const a = document.activeElement as HTMLInputElement | null
      return { tag: a?.tagName?.toLowerCase(), type: a?.type }
    })
    expect(focusedTag).toEqual({ tag: 'input', type: 'range' })

    await launched.page.keyboard.press('Control+z')
    await launched.page.waitForTimeout(300)

    // undo 가 동작했으면 colorAdjust 가 neutral 로.
    const after = await getLayer(layerId)
    expect(after?.colorAdjust?.brightness ?? 0).toBe(0)
  })
})
