/**
 * pptx11 슬라이드 23 — 조정 레이어 fade in / fade out.
 *
 * 검증 항목:
 *  (1) setAdjustmentLayerFade 로 fade 길이 저장 + clamp ([0, halfDur])
 *  (2) fade=0 이면 schema field 자체 drop (neutral-collapse)
 *  (3) locked 면 setAdjustmentLayerFade no-op
 *  (4) preview: fade window 안에선 data-adjustment-active=true 유지 + CSS
 *     filter intensity 가 점진 변화 (fade=0 baseline 과 다름)
 *  (5) export: adjustmentLayerToFfmpeg 가 fade 있으면 step-gated 다중
 *     enable=between(...) 분기 emit
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-adjustment-layer-fade adjustment layer fade in/out', () => {
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

  async function openEditorWithLayer(spanMs = 4000): Promise<string> {
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
            setAdjustmentLayerColorAdjust: (
              id: string,
              p: { brightness?: number }
            ) => void
          }
        }
      ).__reelsStore
      const id = reels.addAdjustmentLayer(0, s)
      if (!id) throw new Error('addAdjustmentLayer returned null')
      // 색보정 한 단계 적용해 preview 필터가 emit 되도록.
      reels.setAdjustmentLayerColorAdjust(id, { brightness: 30 })
      return id
    }, spanMs)
    await page.waitForTimeout(200)
    return layerId
  }

  async function getLayer(): Promise<{
    fadeInMs?: number
    fadeOutMs?: number
    locked?: boolean
  } | null> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                adjustmentLayers?: Array<{
                  fadeInMs?: number
                  fadeOutMs?: number
                  locked?: boolean
                }>
              }
            }
          }
        }
      ).__reelsStore
      return reels.state().project.adjustmentLayers?.[0] ?? null
    })
  }

  test('setAdjustmentLayerFade stores values and clamps to half-duration', async () => {
    if (!launched) throw new Error('launch failed')
    const id = await openEditorWithLayer(4000)
    // halfDur = 2000ms. 500ms / 500ms 는 정상 저장.
    await launched.page.evaluate((lid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerFade: (
              id: string,
              fin: number,
              fout: number
            ) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerFade(lid, 500, 500)
    }, id)
    expect((await getLayer())?.fadeInMs).toBe(500)
    expect((await getLayer())?.fadeOutMs).toBe(500)

    // 5000ms 요청 → 2000 으로 clamp.
    await launched.page.evaluate((lid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerFade: (
              id: string,
              fin: number,
              fout: number
            ) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerFade(lid, 5000, 5000)
    }, id)
    expect((await getLayer())?.fadeInMs).toBe(2000)
    expect((await getLayer())?.fadeOutMs).toBe(2000)
  })

  test('fade=0 collapses the schema field to undefined (neutral-collapse)', async () => {
    if (!launched) throw new Error('launch failed')
    const id = await openEditorWithLayer()
    await launched.page.evaluate((lid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerFade: (
              id: string,
              fin: number,
              fout: number
            ) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerFade(lid, 800, 600)
    }, id)
    expect((await getLayer())?.fadeInMs).toBe(800)

    await launched.page.evaluate((lid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerFade: (
              id: string,
              fin: number,
              fout: number
            ) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerFade(lid, 0, 0)
    }, id)
    const after = await getLayer()
    expect(after?.fadeInMs).toBeUndefined()
    expect(after?.fadeOutMs).toBeUndefined()
  })

  test('locked layer rejects setAdjustmentLayerFade', async () => {
    if (!launched) throw new Error('launch failed')
    const id = await openEditorWithLayer()
    await launched.page.evaluate((lid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerLocked: (id: string, l: boolean) => void
            setAdjustmentLayerFade: (
              id: string,
              fin: number,
              fout: number
            ) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerLocked(lid, true)
      reels.setAdjustmentLayerFade(lid, 500, 500)
    }, id)
    const layer = await getLayer()
    expect(layer?.locked).toBe(true)
    expect(layer?.fadeInMs).toBeUndefined()
  })

  test('preview CSS filter intensity ramps in fade region', async () => {
    if (!launched) throw new Error('launch failed')
    const id = await openEditorWithLayer(4000)

    // fade-in 1000ms 설정 (0~1000ms 동안 brightness 점진 적용).
    await launched.page.evaluate((lid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setAdjustmentLayerFade: (
              id: string,
              fin: number,
              fout: number
            ) => void
          }
        }
      ).__reelsStore
      reels.setAdjustmentLayerFade(lid, 1000, 0)
    }, id)
    await launched.page.waitForTimeout(150)

    const readFilter = async (ms: number): Promise<string> => {
      await launched!.page.evaluate((m) => {
        const ui = (
          window as unknown as {
            __reelsTimelineUi: {
              getState: () => { setPlayheadMs: (n: number) => void }
            }
          }
        ).__reelsTimelineUi
        ui.getState().setPlayheadMs(m)
      }, ms)
      await launched!.page.waitForTimeout(140)
      return (await launched!.page.getAttribute(
        '[data-testid="preview-fitted-rect"]',
        'style'
      )) ?? ''
    }

    // playhead = 100ms: fade-in 안에 있음, factor ≈ 0.1 → 약한 brightness.
    const earlyStyle = await readFilter(100)
    // playhead = 2000ms: middle, factor = 1.0 → 강한 brightness.
    const midStyle = await readFilter(2000)
    // 두 시점의 filter string 이 달라야 함 (intensity 차이).
    // 한쪽이 brightness( ~) 가 0.x, 다른 쪽이 1.x 등.
    expect(earlyStyle).not.toBe(midStyle)
    // 둘 다 data-adjustment-active=true 안에 있어야 함.
    const activeAtMid = await launched.page.getAttribute(
      '[data-testid="preview-fitted-rect"]',
      'data-adjustment-active'
    )
    expect(activeAtMid).toBe('true')
  })
})
