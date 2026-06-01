/**
 * pptx17 slide 18 — multiple selected caption clips share style edits.
 *
 * Contract: when CaptionEditor is open for one caption and the timeline
 * selection contains several caption clips, style-like controls apply to every
 * selected caption. Text/timing/word edits stay single-caption.
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

async function openEditorWithCaption(launched: LaunchedApp): Promise<string> {
  const { page } = launched
  await page.locator('[data-testid="open-editor-button"]').click()
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
    null,
    { timeout: 5_000 }
  )
  await page.keyboard.press('c')
  await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible({
    timeout: 5_000
  })
  return page.evaluate(() => {
    const reels = (
      window as unknown as {
        __reelsStore: {
          state: () => {
            project: {
              tracks: Array<{
                clips: Array<{ id: string; kind: string }>
              }>
            }
          }
        }
      }
    ).__reelsStore
    for (const t of reels.state().project.tracks)
      for (const c of t.clips)
        if (c.kind === 'caption') return c.id
    throw new Error('caption not found')
  })
}

async function addSecondCaptionAndSelectBoth(
  launched: LaunchedApp,
  firstId: string
): Promise<string> {
  return launched.page.evaluate((a) => {
    const win = window as unknown as {
      __reelsStore: {
        newId: () => string
        addCaption: (clip: unknown) => void
        state: () => {
          project: {
            tracks: Array<{
              id: string
              kind: string
              clips: Array<{ id: string; kind: string; style?: unknown }>
            }>
          }
        }
      }
      __reelsTimelineUi: {
        setState: (patch: unknown) => void
      }
    }
    const project = win.__reelsStore.state().project
    const captionTrack = project.tracks.find((t) => t.kind === 'caption')
    if (!captionTrack) throw new Error('caption track missing')
    const first = captionTrack.clips.find((c) => c.id === a.firstId)
    if (!first) throw new Error('first caption missing')
    const secondId = win.__reelsStore.newId()
    win.__reelsStore.addCaption({
      id: secondId,
      kind: 'caption',
      trackId: captionTrack.id,
      startMs: 1200,
      endMs: 2600,
      spans: [{ text: 'second' }],
      style: { ...(first.style as Record<string, unknown>) }
    })
    win.__reelsTimelineUi.setState({
      selectedClipIds: new Set([a.firstId, secondId])
    })
    return secondId
  }, { firstId })
}

async function readCaptions(page: LaunchedApp['page'], ids: string[]): Promise<Array<{
  id: string
  style: Record<string, unknown>
  animation?: Record<string, unknown>
}>> {
  return page.evaluate((captionIds) => {
    const reels = (
      window as unknown as {
        __reelsStore: {
          state: () => {
            project: {
              tracks: Array<{
                clips: Array<{
                  id: string
                  kind: string
                  style: Record<string, unknown>
                  animation?: Record<string, unknown>
                }>
              }>
            }
          }
        }
      }
    ).__reelsStore
    const wanted = new Set(captionIds)
    const out: Array<{
      id: string
      style: Record<string, unknown>
      animation?: Record<string, unknown>
    }> = []
    for (const t of reels.state().project.tracks)
      for (const c of t.clips)
        if (c.kind === 'caption' && wanted.has(c.id)) {
          out.push({ id: c.id, style: c.style, animation: c.animation })
        }
    return out
  }, ids)
}

test.describe('@slide-18-caption-bulk-style', () => {
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
    if (!launched) return
    try {
      await launched.app.close()
    } catch {
      /* ignore */
    }
    launched = null
  })

  test('selected caption clips receive font, position, alignment, background, effects, and animation edits', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const firstId = await openEditorWithCaption(launched)
    const secondId = await addSecondCaptionAndSelectBoth(launched, firstId)

    await page.locator('[data-testid="caption-fontfamily-select"]').selectOption('impact')
    await page.locator('[data-testid="caption-fontsize-input"]').fill('144')
    await page.locator('[data-testid="caption-yposition-slider"]').fill('0.25')
    await page.locator('[data-testid="caption-align-right"]').click()
    await page.locator('[data-testid="caption-bg-pill"]').click()
    await page.locator('[data-testid="caption-bg-height-frac"]').fill('0.12')
    await page.locator('[data-testid="caption-stroke-toggle"]').check()
    await page.locator('[data-testid="caption-stroke-width"]').fill('8')
    await page.locator('[data-testid="caption-shadow-toggle"]').check()
    await page.locator('[data-testid="caption-anim-entrance"]').selectOption('pop')
    await page.locator('[data-testid="caption-anim-exit"]').selectOption('fade')

    await expect.poll(async () => readCaptions(page, [firstId, secondId])).toEqual([
      expect.objectContaining({
        id: firstId,
        style: expect.objectContaining({
          fontFamilyId: 'impact',
          fontSize: 144,
          yPosition: 0.25,
          align: 'right',
          background: 'pill',
          backgroundHeightFrac: 0.12,
          textStroke: expect.objectContaining({ width: 8 }),
          textShadow: expect.objectContaining({ blur: 4 })
        }),
        animation: expect.objectContaining({ entrance: 'pop', exit: 'fade' })
      }),
      expect.objectContaining({
        id: secondId,
        style: expect.objectContaining({
          fontFamilyId: 'impact',
          fontSize: 144,
          yPosition: 0.25,
          align: 'right',
          background: 'pill',
          backgroundHeightFrac: 0.12,
          textStroke: expect.objectContaining({ width: 8 }),
          textShadow: expect.objectContaining({ blur: 4 })
        }),
        animation: expect.objectContaining({ entrance: 'pop', exit: 'fade' })
      })
    ])
  })
})
