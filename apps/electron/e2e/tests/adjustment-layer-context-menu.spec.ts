/**
 * pptx11 슬라이드 24 — 조정 레이어 우클릭 컨텍스트 메뉴.
 *
 * 검증 항목:
 *  (1) 조정 레이어 블록 우클릭 → AdjustmentLayerContextMenu 노출
 *  (2) 잠금 토글 — locked=true 면 후속 grade 변경 / 이동 차단
 *  (3) 복제 — 원본 직후 같은 길이로 새 레이어 추가
 *  (4) 자르기 — playhead 지점에서 둘로 split
 *  (5) 특성 복사/붙여넣기 — grade/transform/fade 를 대상 layer 로 복사
 *  (6) 삭제 — 메뉴에서 삭제 시 layers 에서 제거
 *  (7) playhead 가 layer 범위 밖이면 자르기 비활성
 *  (8) locked 면 split/duplicate/delete/paste 비활성
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-adjustment-layer-ctx adjustment layer right-click menu', () => {
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

  async function openEditorAndAddLayer(span = 5000): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )
    const layerId = await page.evaluate((s) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            addAdjustmentLayer: (a: number, b: number) => string | null
          }
        }
      ).__reelsStore
      const id = reels.addAdjustmentLayer(0, s)
      if (!id) throw new Error('addAdjustmentLayer returned null')
      return id
    }, span)
    await page.waitForTimeout(200)
    return layerId
  }

  async function getLayers(): Promise<
    Array<{
      id: string
      startMs: number
      endMs: number
      locked?: boolean
      filterPreset?: string
      colorAdjust?: { brightness?: number }
      transform?: { scale?: number; y?: number }
      fadeInMs?: number
    }>
  > {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                adjustmentLayers?: Array<{
                  id: string
                  startMs: number
                  endMs: number
                  locked?: boolean
                  filterPreset?: string
                  colorAdjust?: { brightness?: number }
                  transform?: { scale?: number; y?: number }
                  fadeInMs?: number
                }>
              }
            }
          }
        }
      ).__reelsStore
      return reels.state().project.adjustmentLayers ?? []
    })
  }

  async function setPlayhead(ms: number): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate((m) => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { setPlayheadMs: (n: number) => void }
          }
        }
      ).__reelsTimelineUi
      ui.getState().setPlayheadMs(m)
    }, ms)
    await launched.page.waitForTimeout(80)
  }

  test('right-click on adjustment layer opens context menu with all rows', async () => {
    if (!launched) throw new Error('launch failed')
    const layerId = await openEditorAndAddLayer()
    await launched.page
      .locator(`[data-testid="adjustment-layer-${layerId}"]`)
      .click({ button: 'right' })
    await launched.page.waitForTimeout(120)
    await expect(
      launched.page.locator('[data-testid="adjustment-layer-context-menu"]')
    ).toBeVisible()
    for (const key of [
      'toggle-lock',
      'split',
      'duplicate',
      'copy-properties',
      'paste-properties',
      'delete'
    ]) {
      await expect(
        launched.page.locator(`[data-testid="adjustment-ctx-${key}"]`)
      ).toBeVisible()
    }
  })

  test('lock toggle disables grade mutation, unlock re-enables', async () => {
    if (!launched) throw new Error('launch failed')
    const layerId = await openEditorAndAddLayer()

    // 잠금 토글 → locked=true.
    await launched.page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerLocked: (id: string, l: boolean) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerLocked(id, true)
    }, layerId)
    expect((await getLayers())[0].locked).toBe(true)

    // 잠금 상태에서 filter preset 적용 시도 → no-op.
    await launched.page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerFilterPreset: (
              id: string,
              p: string,
              i: number
            ) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerFilterPreset(id, 'underwater', 1)
    }, layerId)
    expect((await getLayers())[0].filterPreset).toBeFalsy()

    // 잠금 해제 후 동일 시도 → 정상 적용.
    await launched.page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerLocked: (id: string, l: boolean) => void
            setAdjustmentLayerFilterPreset: (
              id: string,
              p: string,
              i: number
            ) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerLocked(id, false)
      reels.setAdjustmentLayerFilterPreset(id, 'underwater', 1)
    }, layerId)
    expect((await getLayers())[0].filterPreset).toBe('underwater')
  })

  test('duplicate creates a sibling layer at original.endMs', async () => {
    if (!launched) throw new Error('launch failed')
    const layerId = await openEditorAndAddLayer(3000)
    const orig = (await getLayers())[0]
    const newId = await launched.page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            duplicateAdjustmentLayer: (id: string) => string | null
          }
        }
      ).__reelsStore
      return reels.duplicateAdjustmentLayer(id)
    }, layerId)
    expect(newId).toBeTruthy()
    const after = await getLayers()
    expect(after.length).toBe(2)
    const dup = after.find((l) => l.id === newId)!
    // 원본 직후, 같은 duration.
    expect(dup.startMs).toBe(orig.endMs)
    expect(dup.endMs - dup.startMs).toBe(orig.endMs - orig.startMs)
  })

  test('split at playhead produces two layers covering the original window', async () => {
    if (!launched) throw new Error('launch failed')
    const layerId = await openEditorAndAddLayer(4000)
    // playhead 를 layer 중간에.
    await setPlayhead(2000)

    const newRightId = await launched.page.evaluate(
      ({ id, at }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              splitAdjustmentLayerAt: (id: string, m: number) => string | null
            }
          }
        ).__reelsStore
        return reels.splitAdjustmentLayerAt(id, at)
      },
      { id: layerId, at: 2000 }
    )
    expect(newRightId).toBeTruthy()

    const after = await getLayers()
    expect(after.length).toBe(2)
    const left = after.find((l) => l.id === layerId)!
    const right = after.find((l) => l.id === newRightId)!
    expect(left.startMs).toBe(0)
    expect(left.endMs).toBe(2000)
    expect(right.startMs).toBe(2000)
    expect(right.endMs).toBe(4000)
  })

  test('copy/paste properties copies grade, transform and fade without timing', async () => {
    if (!launched) throw new Error('launch failed')
    const sourceId = await openEditorAndAddLayer(3000)
    const targetId = await launched.page.evaluate((srcId) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            addAdjustmentLayer: (a: number, b: number) => string | null
            setAdjustmentLayerColorAdjust: (id: string, p: { brightness: number }) => void
            setAdjustmentLayerTransform: (
              id: string,
              p: { scale: number; y: number }
            ) => void
            setAdjustmentLayerFade: (id: string, fadeInMs: number, fadeOutMs: number) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerColorAdjust(srcId, { brightness: 42 })
      reels.setAdjustmentLayerTransform(srcId, { scale: 0.5, y: -0.25 })
      reels.setAdjustmentLayerFade(srcId, 600, 0)
      const id = reels.addAdjustmentLayer(5000, 8000)
      if (!id) throw new Error('second adjustment layer failed')
      return id
    }, sourceId)

    await launched.page
      .locator(`[data-testid="adjustment-layer-${sourceId}"]`)
      .click({ button: 'right' })
    await launched.page.locator('[data-testid="adjustment-ctx-copy-properties"]').click()
    await launched.page.waitForTimeout(100)
    await launched.page
      .locator(`[data-testid="adjustment-layer-${targetId}"]`)
      .click({ button: 'right' })
    await expect(
      launched.page.locator('[data-testid="adjustment-ctx-paste-properties"]')
    ).toHaveAttribute('data-enabled', 'true')
    await launched.page.locator('[data-testid="adjustment-ctx-paste-properties"]').click()
    await launched.page.waitForTimeout(150)

    const after = await getLayers()
    const target = after.find((l) => l.id === targetId)!
    expect(target.startMs).toBe(5000)
    expect(target.endMs).toBe(8000)
    expect(target.colorAdjust?.brightness).toBe(42)
    expect(target.transform?.scale).toBeCloseTo(0.5, 4)
    expect(target.transform?.y).toBeCloseTo(-0.25, 4)
    expect(target.fadeInMs).toBe(600)
  })

  test('delete via context-menu Delete row removes the layer', async () => {
    if (!launched) throw new Error('launch failed')
    const layerId = await openEditorAndAddLayer()
    expect((await getLayers()).length).toBe(1)

    await launched.page
      .locator(`[data-testid="adjustment-layer-${layerId}"]`)
      .click({ button: 'right' })
    await launched.page.waitForTimeout(100)
    await launched.page
      .locator('[data-testid="adjustment-ctx-delete"]')
      .click()
    await launched.page.waitForTimeout(200)

    expect((await getLayers()).length).toBe(0)
  })

  test('split row is disabled when playhead falls outside the layer', async () => {
    if (!launched) throw new Error('launch failed')
    const layerId = await openEditorAndAddLayer(3000)
    // playhead 를 layer 시작 전.
    await setPlayhead(0)

    await launched.page
      .locator(`[data-testid="adjustment-layer-${layerId}"]`)
      .click({ button: 'right' })
    await launched.page.waitForTimeout(100)

    const enabled = await launched.page.getAttribute(
      '[data-testid="adjustment-ctx-split"]',
      'data-enabled'
    )
    expect(enabled).toBe('false')
  })

  test('locked layer disables split / duplicate / delete rows', async () => {
    if (!launched) throw new Error('launch failed')
    const layerId = await openEditorAndAddLayer(3000)
    await launched.page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerLocked: (id: string, l: boolean) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerLocked(id, true)
    }, layerId)
    await setPlayhead(1500)

    await launched.page
      .locator(`[data-testid="adjustment-layer-${layerId}"]`)
      .click({ button: 'right' })
    await launched.page.waitForTimeout(100)

    for (const key of ['split', 'duplicate', 'paste-properties', 'delete']) {
      const enabled = await launched.page.getAttribute(
        `[data-testid="adjustment-ctx-${key}"]`,
        'data-enabled'
      )
      expect(enabled).toBe('false')
    }
    // 잠금 토글 자체는 항상 활성 — 잠금 해제 길이 보존.
    const lockEnabled = await launched.page.getAttribute(
      '[data-testid="adjustment-ctx-toggle-lock"]',
      'data-enabled'
    )
    expect(lockEnabled).toBe('true')
  })
})
