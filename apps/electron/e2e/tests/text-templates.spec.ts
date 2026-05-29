import { expect, test } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import { openAiMenu } from '../helpers/topbar'

/**
 * @phase-3-24 — Text-template picker tests.
 *
 * The 10 pre-designed templates are inserted as plain CaptionClips via the
 * picker UI (toolbar button → card click). Once inserted they are ordinary
 * captions — export / preview / undo all apply unchanged.
 *
 * Scenarios:
 *  T1: Picker lists every template (all 10 data-testid cards present)
 *  T2: Applying cta-follow inserts the right caption (spans, style, animation)
 *  T3: Every template produces a valid caption (all 5 CaptionStyle fields non-empty)
 *  T4: Inserted captions export normally (buildPlan ok, no NaN)
 *  T5: Undo/redo — apply → 1 caption → undo → 0 → redo → 1
 *  T6: Multiple templates stack — 3 different templates at 3 positions
 *  T7: Deep-clone integrity — same template twice; editing one doesn't corrupt the other
 *  T8: Edit after insert — CaptionEditor auto-opened; typing new text updates spans
 */

/** All 10 template ids in definition order. */
const ALL_TEMPLATE_IDS = [
  'title-bold',
  'title-subtitle',
  'lower-third-name',
  'lower-third-pill',
  'cta-follow',
  'cta-more',
  'cta-comment',
  'hook-wait',
  'hook-tip',
  'list-step'
] as const

test.describe('@phase-3-24 text template picker', () => {
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
      await new Promise((r) => setTimeout(r, 900))
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

  // ---------------------------------------------------------------------------
  // Shared helpers (mirrors caption-text-decoration.spec.ts conventions)
  // ---------------------------------------------------------------------------

  async function openEditor(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )
  }

  async function tick(ms = 250): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.waitForTimeout(ms)
  }

  /** Set playhead via the timelineUi store. */
  async function setPlayhead(ms: number): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate((t) => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi?: { getState: () => { setPlayheadMs: (ms: number) => void } }
        }
      ).__reelsTimelineUi
      ui?.getState().setPlayheadMs(t)
    }, ms)
  }

  /** Return all clips on the caption track. */
  async function getCaptionClips(): Promise<
    Array<{
      id: string
      startMs: number
      endMs: number
      spans: Array<{ text: string }>
      style: Record<string, unknown>
      animation?: Record<string, unknown>
    }>
  > {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  kind: string
                  clips: Array<{
                    id: string
                    startMs: number
                    endMs: number
                    spans: Array<{ text: string }>
                    style: Record<string, unknown>
                    animation?: Record<string, unknown>
                  }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      const track = reels
        .state()
        .project.tracks.find((t) => t.kind === 'caption')
      return track?.clips ?? []
    })
  }

  /** Add fixture media to the store. */
  async function addFixtureMedia(): Promise<{ mediaId: string; durationMs: number }> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    const { page } = launched
    return page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = (
        window as unknown as {
          __reelsStore: {
            addMedia: (a: unknown) => void
            newId: () => string
          }
        }
      ).__reelsStore
      const id = reels.newId()
      reels.addMedia({
        id,
        path: filePath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      return { mediaId: id, durationMs: probe.durationMs }
    }, fixture)
  }

  /** Add a video clip to the video track. */
  async function addVideoClip(mediaId: string, durationMs: number): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate(
      ({ mid, dur }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              state: () => { project: { tracks: Array<{ id: string; kind: string }> } }
              addClip: (c: unknown) => void
              newId: () => string
            }
          }
        ).__reelsStore
        const track = reels.state().project.tracks.find((t) => t.kind === 'video')
        if (!track) throw new Error('no video track')
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: track.id,
          startMs: 0,
          endMs: dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
      },
      { mid: mediaId, dur: durationMs }
    )
  }

  /** Call exporter.buildPlan; returns { ok, filterGraph?, error? }. */
  async function buildPlan(
    outputPath: string
  ): Promise<{ ok: boolean; filterGraph?: string; error?: string }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outputPath)
    return page.evaluate(
      async ({ outPath }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outPath)
      },
      { outPath: outputPath }
    )
  }

  function tmpOut(label: string): string {
    const dir = path.join(os.tmpdir(), 'reels-studio-e2e', 'text-templates')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return path.join(dir, `${label}-${Date.now()}.mp4`)
  }

  /**
   * Open the picker, click a template card, wait for the picker to close and
   * the CaptionEditor to open. Returns the new caption's id from the store.
   */
  async function applyTemplateViaUI(templateId: string): Promise<string | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Snapshot caption count before.
    const before = await getCaptionClips()
    const beforeIds = new Set(before.map((c) => c.id))

    // Open picker if not already open.
    const pickerLocator = page.locator('[data-testid="text-template-picker"]')
    const pickerVisible = await pickerLocator.isVisible()
    if (!pickerVisible) {
      await openAiMenu(page)
      await page.locator('[data-testid="open-text-template-picker"]').click()
      await expect(pickerLocator).toBeVisible()
    }

    // Click the template card.
    await page.locator(`[data-testid="text-template-card-${templateId}"]`).click()
    await tick(300)

    // Find the new caption id.
    const after = await getCaptionClips()
    const newClip = after.find((c) => !beforeIds.has(c.id))
    return newClip?.id ?? null
  }

  // ===========================================================================
  // T1: Picker lists every template
  // ===========================================================================
  test('T1: picker lists all 10 template cards', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()

    // Open picker.
    await openAiMenu(page)
    await page.locator('[data-testid="open-text-template-picker"]').click()
    await expect(page.locator('[data-testid="text-template-picker"]')).toBeVisible()

    // All 10 cards must exist.
    for (const id of ALL_TEMPLATE_IDS) {
      await expect(
        page.locator(`[data-testid="text-template-card-${id}"]`)
      ).toBeVisible()
    }

    // Close button works.
    await page.locator('[data-testid="text-template-picker-close"]').click()
    await expect(page.locator('[data-testid="text-template-picker"]')).not.toBeVisible()
  })

  test('T1b slide 17: picker always reopens in the right dock, never lower-left', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor()

    const expectRightDocked = async (): Promise<void> => {
      const picker = page.locator('[data-testid="text-template-picker"]')
      await expect(picker).toBeVisible()
      const pickerBox = await picker.boundingBox()
      const editorBox = await page.locator('[data-testid="editor-page"]').boundingBox()
      expect(pickerBox).not.toBeNull()
      expect(editorBox).not.toBeNull()
      expect(pickerBox!.x).toBeGreaterThan(editorBox!.x + editorBox!.width - 430)
      expect(pickerBox!.y).toBeLessThan(editorBox!.y + 80)
      expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(
        editorBox!.x + editorBox!.width + 1
      )
    }

    await openAiMenu(page)
    await page.locator('[data-testid="open-text-template-picker"]').click()
    await expectRightDocked()
    await page.locator('[data-testid="text-template-picker-close"]').click()

    await openAiMenu(page)
    await page.locator('[data-testid="open-text-template-picker"]').click()
    await expectRightDocked()
    await page.locator('[data-testid="text-template-card-title-bold"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()

    await openAiMenu(page)
    await page.locator('[data-testid="open-text-template-picker"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toHaveCount(0)
    await expectRightDocked()
    await page.locator('[data-testid="text-template-picker-close"]').click()

    await page.locator('[data-testid="left-rail-text"]').click()
    await expectRightDocked()
  })

  // ===========================================================================
  // T2: Applying cta-follow inserts the right caption
  // ===========================================================================
  test('T2: applying cta-follow at 1000ms inserts correct caption (spans, style, animation)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor()
    await setPlayhead(1000)
    await tick(100)

    const newId = await applyTemplateViaUI('cta-follow')
    expect(newId, 'a new caption id must be returned').toBeTruthy()

    // The CaptionEditor should be auto-opened.
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()

    // Read the inserted clip directly from the store.
    const clips = await getCaptionClips()
    const clip = clips.find((c) => c.id === newId)
    expect(clip, 'clip should be in caption track').toBeDefined()
    if (!clip) return

    // Timing — cta-follow has durationMs: 2500.
    expect(clip.startMs).toBe(1000)
    expect(clip.endMs).toBe(1000 + 2500)

    // Spans: words('팔로우하세요') → one span per word → ['팔로우하세요'].
    const joinedText = clip.spans.map((s) => s.text).join('')
    expect(joinedText).toContain('팔로우하세요')

    // Style fields.
    expect(clip.style.preset).toBe('block-bold')
    expect(clip.style.fontSize).toBe(70)
    expect(clip.style.align).toBe('center')

    // textStroke: { color: '#000000', width: 8 }
    const stroke = clip.style.textStroke as { color: string; width: number } | undefined
    expect(stroke, 'textStroke should be present').toBeDefined()
    if (stroke) {
      expect(stroke.color).toBe('#000000')
      expect(stroke.width).toBe(8)
    }

    // textShadow: { color: '#00e5ff', offsetX: 0, offsetY: 0, blur: 24 }
    const shadow = clip.style.textShadow as {
      color: string; offsetX: number; offsetY: number; blur: number
    } | undefined
    expect(shadow, 'textShadow should be present').toBeDefined()
    if (shadow) {
      expect(shadow.color).toBe('#00e5ff')
    }

    // Animation: { entrance: 'pop', exit: 'fade', inMs: 350, outMs: 300 }
    const anim = clip.animation as { entrance: string; exit: string } | undefined
    expect(anim, 'animation should be present').toBeDefined()
    if (anim) {
      expect(anim.entrance).toBe('pop')
    }
  })

  // ===========================================================================
  // T3: Every template produces a valid caption
  // ===========================================================================
  test('T3: every template inserts a caption with all required style fields and non-empty spans', async () => {
    if (!launched) throw new Error('launch failed')

    await openEditor()

    for (const templateId of ALL_TEMPLATE_IDS) {
      // Place playhead far enough apart so clips don't overlap (each gets
      // a new position stepping by 5000ms).
      const idx = ALL_TEMPLATE_IDS.indexOf(templateId as typeof ALL_TEMPLATE_IDS[number])
      await setPlayhead(idx * 5000)
      await tick(100)

      const newId = await applyTemplateViaUI(templateId)
      expect(newId, `template ${templateId}: a new caption must be inserted`).toBeTruthy()

      const clips = await getCaptionClips()
      const clip = clips.find((c) => c.id === newId)
      expect(clip, `template ${templateId}: clip not found in caption track`).toBeDefined()
      if (!clip) continue

      // Non-empty spans.
      expect(
        clip.spans.length,
        `template ${templateId}: spans must not be empty`
      ).toBeGreaterThan(0)
      for (const span of clip.spans) {
        expect(
          span.text.length,
          `template ${templateId}: every span must have non-empty text`
        ).toBeGreaterThan(0)
      }

      // Required style fields.
      expect(clip.style.preset, `${templateId}: preset`).toBeTruthy()
      expect(clip.style.fontSize, `${templateId}: fontSize`).toBeGreaterThan(0)
      expect(clip.style.align, `${templateId}: align`).toBeTruthy()
      expect(typeof clip.style.yPosition, `${templateId}: yPosition type`).toBe('number')
      // background may be 'none' (falsy string passes a typeof check, not a truthy check).
      expect(
        typeof clip.style.background,
        `${templateId}: background must be a string`
      ).toBe('string')
    }
  })

  // ===========================================================================
  // T4: Inserted captions export normally
  // ===========================================================================
  test('T4: lower-third-name and cta-follow (stroke+shadow) both produce ok buildPlan with no NaN', async () => {
    if (!launched) throw new Error('launch failed')

    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // (A) lower-third-name — no stroke/shadow.
    await setPlayhead(300)
    await tick(100)
    const idA = await applyTemplateViaUI('lower-third-name')
    expect(idA).toBeTruthy()

    const resultA = await buildPlan(tmpOut('t4-lower-third'))
    expect(resultA.ok, `lower-third-name buildPlan failed: ${resultA.error ?? ''}`).toBe(true)
    expect(resultA.filterGraph ?? '').not.toContain('NaN')

    // (B) cta-follow — has textStroke + textShadow.
    await setPlayhead(5000)
    await tick(100)
    const idB = await applyTemplateViaUI('cta-follow')
    expect(idB).toBeTruthy()

    const resultB = await buildPlan(tmpOut('t4-cta-follow'))
    expect(resultB.ok, `cta-follow buildPlan failed: ${resultB.error ?? ''}`).toBe(true)
    const graph = resultB.filterGraph ?? ''
    expect(graph).not.toContain('NaN')

    // On the drawtext fallback path the stroke/shadow tokens must appear.
    if (graph.includes('drawtext=')) {
      // cta-follow has textStroke: { color: '#000000', width: 8 }
      // → bordercolor=0x000000, borderw= (not the legacy borderw=2 + black@0.7 pair
      //   if the stroke override is active)
      expect(graph).toMatch(/borderw=\d+/)
      // cta-follow has textShadow: { color: '#00e5ff', ... blur: 24 }
      // → shadowcolor=0x00E5FF
      if (graph.includes('shadowcolor=')) {
        expect(graph).toContain('shadowcolor=0x00E5FF')
      }
    }
  })

  // ===========================================================================
  // T5: Undo/redo — one-step undo of a template insert
  // ===========================================================================
  test('T5: apply template → 1 caption → undo → 0 captions → redo → 1 back', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsUndoRedo?: unknown }).__reelsUndoRedo,
      null,
      { timeout: 5_000 }
    )

    // Start with 0 captions.
    const before = await getCaptionClips()
    expect(before).toHaveLength(0)

    // Apply hook-wait via the picker.
    await setPlayhead(500)
    await tick(100)
    const newId = await applyTemplateViaUI('hook-wait')
    expect(newId).toBeTruthy()

    // Should have 1 caption now.
    const afterInsert = await getCaptionClips()
    expect(afterInsert).toHaveLength(1)

    // Undo.
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __reelsUndoRedo: { getState: () => { undo: () => void } }
        }
      ).__reelsUndoRedo.getState().undo()
    })
    await tick(300)

    const afterUndo = await getCaptionClips()
    expect(afterUndo).toHaveLength(0)

    // Redo.
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __reelsUndoRedo: { getState: () => { redo: () => void } }
        }
      ).__reelsUndoRedo.getState().redo()
    })
    await tick(300)

    const afterRedo = await getCaptionClips()
    expect(afterRedo).toHaveLength(1)
    // The re-inserted clip should have the same id as before undo.
    expect(afterRedo[0].id).toBe(newId)
  })

  // ===========================================================================
  // T6: Multiple templates stack
  // ===========================================================================
  test('T6: applying 3 templates at 3 positions creates 3 distinct captions with correct startMs + preset', async () => {
    if (!launched) throw new Error('launch failed')

    await openEditor()

    const cases: Array<{ id: string; playheadMs: number; expectedPreset: string }> = [
      { id: 'title-bold', playheadMs: 0, expectedPreset: 'block-bold' },
      { id: 'hook-tip', playheadMs: 5000, expectedPreset: 'gradient' },
      { id: 'list-step', playheadMs: 10000, expectedPreset: 'minimal-white' }
    ]

    const insertedIds: string[] = []
    for (const c of cases) {
      await setPlayhead(c.playheadMs)
      await tick(100)
      const id = await applyTemplateViaUI(c.id)
      expect(id, `${c.id}: must insert`).toBeTruthy()
      if (id) insertedIds.push(id)
    }

    const clips = await getCaptionClips()
    expect(clips).toHaveLength(3)

    for (const c of cases) {
      const clip = clips.find((cl) => cl.startMs === c.playheadMs)
      expect(clip, `clip at startMs=${c.playheadMs} must exist`).toBeDefined()
      if (!clip) continue
      expect(clip.style.preset).toBe(c.expectedPreset)
    }

    // All 3 ids are distinct.
    const uniqueIds = new Set(insertedIds)
    expect(uniqueIds.size).toBe(3)
  })

  // ===========================================================================
  // T7: Deep-clone integrity — mutating one inserted caption doesn't affect another
  // ===========================================================================
  test('T7: applying same template twice + patching one span/style leaves the other and a fresh insert unaffected', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor()

    // Insert cta-follow twice at different positions.
    await setPlayhead(0)
    await tick(100)
    const idA = await applyTemplateViaUI('cta-follow')
    expect(idA).toBeTruthy()

    await setPlayhead(5000)
    await tick(100)
    const idB = await applyTemplateViaUI('cta-follow')
    expect(idB).toBeTruthy()

    // Mutate clip A's style (change textStroke.width to 99) and spans via store.
    await page.evaluate(
      ({ cid }) => {
        const store = (
          window as unknown as {
            __PROJECT_STORE_FOR_TEST__: {
              getState: () => {
                updateCaption: (
                  id: string,
                  patch: { spans?: Array<{ text: string }>; style?: Record<string, unknown> }
                ) => void
              }
            }
          }
        ).__PROJECT_STORE_FOR_TEST__
        store.getState().updateCaption(cid, {
          spans: [{ text: '수정됨' }],
          style: {
            preset: 'block-bold',
            fontSize: 70,
            align: 'center',
            yPosition: 0.5,
            background: 'none',
            textStroke: { color: '#ff0000', width: 99 },
            textShadow: { color: '#00e5ff', offsetX: 0, offsetY: 0, blur: 24 }
          }
        })
      },
      { cid: idA }
    )
    await tick(200)

    const clips = await getCaptionClips()

    // Clip B must be unaffected — still has original stroke width 8.
    const clipB = clips.find((c) => c.id === idB)
    expect(clipB, 'clip B must still exist').toBeDefined()
    if (clipB) {
      const strokeB = clipB.style.textStroke as { color: string; width: number } | undefined
      expect(strokeB?.width, 'clip B stroke width must still be 8').toBe(8)
      const spansJoinedB = clipB.spans.map((s) => s.text).join('')
      expect(spansJoinedB).toContain('팔로우하세요')
    }

    // Clip A must reflect the mutation.
    const clipA = clips.find((c) => c.id === idA)
    expect(clipA).toBeDefined()
    if (clipA) {
      expect(clipA.spans[0].text).toBe('수정됨')
      const strokeA = clipA.style.textStroke as { color: string; width: number } | undefined
      expect(strokeA?.width).toBe(99)
    }

    // Insert a THIRD cta-follow — must still have the original template values.
    await setPlayhead(10000)
    await tick(100)
    const idC = await applyTemplateViaUI('cta-follow')
    expect(idC).toBeTruthy()

    const clipsAfter = await getCaptionClips()
    const clipC = clipsAfter.find((c) => c.id === idC)
    expect(clipC, 'clip C (fresh insert) must exist').toBeDefined()
    if (clipC) {
      const strokeC = clipC.style.textStroke as { color: string; width: number } | undefined
      expect(strokeC?.color, 'fresh insert must have original template stroke color').toBe('#000000')
      expect(strokeC?.width, 'fresh insert must have original template stroke width').toBe(8)
      const spansJoinedC = clipC.spans.map((s) => s.text).join('')
      expect(spansJoinedC).toContain('팔로우하세요')
    }
  })

  // ===========================================================================
  // T8: Edit after insert — CaptionEditor auto-opened; typing updates spans
  // ===========================================================================
  test('T8: after applying a template, typing new text in the auto-opened CaptionEditor updates the caption spans', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor()
    await setPlayhead(1000)
    await tick(100)

    // Apply title-bold — CaptionEditor should auto-open.
    const newId = await applyTemplateViaUI('title-bold')
    expect(newId).toBeTruthy()

    // CaptionEditor must be visible.
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()

    // Type new text in the caption text input.
    const ta = page.locator('[data-testid="caption-text-input"]')
    await expect(ta).toBeVisible()
    await ta.click({ clickCount: 3 })
    await ta.fill('새 제목입니다')
    await ta.blur()
    await tick(200)

    // Verify the spans were updated in the store.
    const clips = await getCaptionClips()
    const clip = clips.find((c) => c.id === newId)
    expect(clip, 'clip must still be in the caption track').toBeDefined()
    if (clip) {
      const joinedText = clip.spans.map((s) => s.text).join(' ')
      expect(joinedText).toContain('새')
      expect(joinedText).toContain('제목입니다')
    }

    // Overlay should reflect the new text.
    await expect(page.locator('[data-testid="caption-overlay"]')).toContainText('새')
  })
})
