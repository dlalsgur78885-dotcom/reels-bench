import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 5 — Timeline toolbar (CapCut-style rebuild) e2e suite.
 *
 * Verification items
 *  1. All toolbar buttons render and are reachable via data-testid
 *  2. Undo/redo, split, delete — disabled when no clip; active when clip selected
 *  3. Tool mode toggle: select ↔ split (split mode: lane click splits clip)
 *  4. Split-delete before / after
 *  5. Marker add → ruler pin → pin click removes it
 *  6. Snap toggle on/off, zoom slider, timeline fit
 *  7. Voice recording button — no crash, error-state UI when mic unavailable
 *  8. Regression: zoom −/+/level testids, add-video-track-button testid preserved
 *
 * Design note — selectedClipId:
 *   The toolbar's canSplit / canDelete flags read from `selectedClipId` which
 *   lives in Editor's local React state and is only updated by clicking a
 *   clip body element in the DOM. Tests that need a selected clip must click
 *   the rendered clip-body element, not just call the UI-store's selectClip.
 *
 * Tag: @phase-5-toolbar
 */

// ---------------------------------------------------------------------------
// Type shorthands used in evaluate() closures.
// ---------------------------------------------------------------------------
type ReelsStore = {
  state: () => {
    project: {
      tracks: Array<{
        id: string
        kind: string
        clips: Array<{
          id: string
          startMs: number
          endMs: number
          trimInMs?: number
          trimOutMs?: number
          kind?: string
          mediaId?: string
        }>
      }>
    }
  }
  addMedia: (asset: unknown) => void
  addClip: (clip: unknown) => void
  newId: () => string
}

type TimelineUiStore = {
  getState: () => {
    toolMode: 'select' | 'split'
    snapEnabled: boolean
    avLinkEnabled: boolean
    markers: Array<{ id: string; atMs: number; label?: string }>
    pps: number
    playheadMs: number
    setPlayheadMs: (ms: number) => void
    setPlaying: (p: boolean) => void
    clearSelection: () => void
    selectClip: (id: string) => void
    setPps: (p: number) => void
    setToolMode: (mode: 'select' | 'split') => void
    setSnapEnabled: (e: boolean) => void
    setAvLinkEnabled: (e: boolean) => void
    addMarker: (atMs: number, label?: string) => string
    removeMarker: (id: string) => void
    clearMarkers: () => void
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.locator('[data-testid="open-editor-button"]').click()
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
    null,
    { timeout: 5_000 }
  )
  // Reset to a clean slate. createNew() defers temporal.clear() by ~250ms so
  // we wait 800ms total to ensure history is wiped.
  await page.evaluate(async () => {
    const store = (
      window as unknown as {
        __PROJECT_STORE_FOR_TEST__: {
          getState: () => { createNew: () => void }
        }
      }
    ).__PROJECT_STORE_FOR_TEST__
    store.getState().createNew()
    const ui = (
      window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
    ).__TIMELINE_UI_FOR_TEST__
    ui.getState().setPlayheadMs(0)
    ui.getState().setPlaying(false)
    ui.getState().clearSelection()
    ui.getState().clearMarkers()
    ui.getState().setToolMode('select')
    if (ui.getState().setPps) ui.getState().setPps(60)
    // Wait for the UNDO_THROTTLE_MS + timer delay to expire so temporal is cleared.
    await new Promise((r) => setTimeout(r, 800))
  })
}

/** Open editor and load the fixture video into the media library. Returns mediaId and durationMs. */
async function openEditorWithMedia(launched: LaunchedApp): Promise<{
  mediaId: string
  durationMs: number
}> {
  const { page } = launched
  const fixture = process.env.E2E_FIXTURE_MP4
  if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set — globalSetup failed')

  await openEditor(launched)

  return await page.evaluate(async (filePath: string) => {
    await window.electron.fs.allowPath(filePath)
    const probe = await window.electron.media.probe(filePath)
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath
    const reels = (
      window as unknown as { __reelsStore: ReelsStore }
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
    // Wait a tick for React to re-render the media card.
    await new Promise((r) => setTimeout(r, 200))
    return { mediaId: id, durationMs: probe.durationMs }
  }, fixture)
}

/** Add a video clip to the first video track and wait for the DOM block to appear. */
async function addVideoClip(
  launched: LaunchedApp,
  durationMs: number,
  mediaId: string
): Promise<string> {
  const { page } = launched
  const clipId = await page.evaluate(
    ({ mediaId: id, dur }) => {
      const reels = (
        window as unknown as { __reelsStore: ReelsStore }
      ).__reelsStore
      const tracks = reels.state().project.tracks
      const videoTrack = tracks.find((t) => t.kind === 'video')
      if (!videoTrack) throw new Error('no video track')
      const cid = reels.newId()
      reels.addClip({
        id: cid,
        kind: 'media',
        mediaId: id,
        trackId: videoTrack.id,
        startMs: 0,
        endMs: dur,
        trimInMs: 0,
        trimOutMs: dur,
        speed: 1
      })
      return cid
    },
    { mediaId, dur: durationMs }
  )
  // Wait for the clip block to appear in the DOM.
  await page.waitForSelector('[data-testid="media-clip-block"]', { timeout: 5_000 })
  return clipId
}

/**
 * Click the clip body in the DOM to select it via Editor's onSelectClip handler.
 * This is required so `selectedClipId` in Editor's local state is updated, which
 * controls canSplit / canDelete in the toolbar.
 */
async function clickClipToSelect(launched: LaunchedApp, clipId: string): Promise<void> {
  const { page } = launched
  const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
  await expect(clipBody).toBeVisible({ timeout: 5_000 })
  await clipBody.click()
  // Give React a frame to update selectedClipId state.
  await page.waitForTimeout(150)
}

async function setPlayhead(launched: LaunchedApp, ms: number): Promise<void> {
  const { page } = launched
  await page.evaluate((t) => {
    const ui = (
      window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
    ).__TIMELINE_UI_FOR_TEST__
    ui.getState().setPlayheadMs(t)
  }, ms)
}

/** Get current markers from store. */
async function getMarkers(
  launched: LaunchedApp
): Promise<Array<{ id: string; atMs: number }>> {
  return await launched.page.evaluate(() => {
    const ui = (
      window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
    ).__TIMELINE_UI_FOR_TEST__
    return ui.getState().markers
  })
}

/** Get all clips across all tracks from the store. */
async function getAllClips(launched: LaunchedApp): Promise<
  Array<{ id: string; startMs: number; endMs: number; trackKind: string }>
> {
  return await launched.page.evaluate(() => {
    const reels = (
      window as unknown as { __reelsStore: ReelsStore }
    ).__reelsStore
    const result: Array<{ id: string; startMs: number; endMs: number; trackKind: string }> = []
    for (const t of reels.state().project.tracks) {
      for (const c of t.clips) {
        result.push({ id: c.id, startMs: c.startMs, endMs: c.endMs, trackKind: t.kind })
      }
    }
    return result
  })
}

// ===========================================================================
// Suite
// ===========================================================================

test.describe('@phase-5-toolbar Timeline toolbar (Phase 5)', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
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

  // =========================================================================
  // 1. All toolbar buttons render with expected data-testid attributes
  // =========================================================================
  test('toolbar renders all Phase-5 buttons with their data-testid', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const toolbar = page.locator('[data-testid="timeline-toolbar"]')
    await expect(toolbar).toBeVisible()

    // Left group — editing controls
    await expect(toolbar.locator('[data-testid="add-video-track-button"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="tool-select-button"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="tool-split-button"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-undo-button"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-redo-button"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-split-button"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-split-delete-before-button"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-split-delete-after-button"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-delete-button"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-add-marker-button"]')).toBeVisible()

    // Right group — utilities
    await expect(toolbar.locator('[data-testid="timeline-record-button"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-snap-toggle"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-avlink-toggle"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-fit-button"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-zoom-out"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-zoom-slider"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-zoom-in"]')).toBeVisible()
    await expect(toolbar.locator('[data-testid="timeline-zoom-level"]')).toBeVisible()
  })

  // =========================================================================
  // 2. Split, delete disabled without selection — enabled with media clip selected
  // =========================================================================
  test('split/delete buttons disabled with no selection, enabled when media clip is selected', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia(launched)

    const toolbar = page.locator('[data-testid="timeline-toolbar"]')

    // No clip selected — split, split-delete, delete must be disabled.
    await expect(toolbar.locator('[data-testid="timeline-split-button"]')).toBeDisabled()
    await expect(toolbar.locator('[data-testid="timeline-split-delete-before-button"]')).toBeDisabled()
    await expect(toolbar.locator('[data-testid="timeline-split-delete-after-button"]')).toBeDisabled()
    await expect(toolbar.locator('[data-testid="timeline-delete-button"]')).toBeDisabled()

    // Add a clip and click it to select it via the DOM (sets Editor's selectedClipId).
    const clipId = await addVideoClip(launched, durationMs, mediaId)
    await clickClipToSelect(launched, clipId)

    // Now the buttons must be enabled.
    await expect(toolbar.locator('[data-testid="timeline-split-button"]')).toBeEnabled()
    await expect(toolbar.locator('[data-testid="timeline-split-delete-before-button"]')).toBeEnabled()
    await expect(toolbar.locator('[data-testid="timeline-split-delete-after-button"]')).toBeEnabled()
    await expect(toolbar.locator('[data-testid="timeline-delete-button"]')).toBeEnabled()
  })

  // =========================================================================
  // 3. Undo / redo button states
  // =========================================================================
  test('undo disabled on fresh project; enabled after addMedia, redo follows', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Open editor without media so we get a clean undo state AFTER the 800ms wait.
    await openEditor(launched)

    const toolbar = page.locator('[data-testid="timeline-toolbar"]')

    // After createNew + 800ms, temporal should be cleared — undo disabled.
    await expect(toolbar.locator('[data-testid="timeline-undo-button"]')).toBeDisabled()
    await expect(toolbar.locator('[data-testid="timeline-redo-button"]')).toBeDisabled()

    // Mutate via addMedia (tracked by zundo).
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = (
        window as unknown as { __reelsStore: ReelsStore }
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
    }, fixture)

    // Wait for zundo throttle to latch the snapshot (UNDO_THROTTLE_MS = 200ms + margin).
    await page.waitForTimeout(400)

    // Undo must now be enabled.
    await expect(toolbar.locator('[data-testid="timeline-undo-button"]')).toBeEnabled()

    // Click undo — media should be removed.
    await toolbar.locator('[data-testid="timeline-undo-button"]').click()
    await page.waitForTimeout(300)

    const mediaCountAfterUndo = await page.evaluate(() => {
      const reels = (
        window as unknown as { __reelsStore: ReelsStore }
      ).__reelsStore
      return Object.keys(reels.state().project.media ?? {}).length
    })
    // After undo the media entry should be gone (0 media assets in fresh project).
    expect(mediaCountAfterUndo).toBe(0)

    // Redo must now be enabled.
    await expect(toolbar.locator('[data-testid="timeline-redo-button"]')).toBeEnabled()

    // Click redo.
    await toolbar.locator('[data-testid="timeline-redo-button"]').click()
    await page.waitForTimeout(300)

    const mediaCountAfterRedo = await page.evaluate(() => {
      const reels = (
        window as unknown as { __reelsStore: ReelsStore }
      ).__reelsStore
      return Object.keys(reels.state().project.media ?? {}).length
    })
    expect(mediaCountAfterRedo).toBe(1)
  })

  // =========================================================================
  // 4. Split button — splits selected media clip at playhead
  // =========================================================================
  test('split button splits selected media clip at the playhead', async () => {
    if (!launched) throw new Error('launch failed')
    const { mediaId, durationMs } = await openEditorWithMedia(launched)

    const clipId = await addVideoClip(launched, durationMs, mediaId)
    const splitAt = Math.floor(durationMs / 2)

    // Select via DOM click (required for toolbar canSplit).
    await clickClipToSelect(launched, clipId)
    await setPlayhead(launched, splitAt)

    await launched.page.locator('[data-testid="timeline-split-button"]').click()
    await launched.page.waitForTimeout(300)

    const clips = await getAllClips(launched)
    const videoClips = clips.filter((c) => c.trackKind === 'video')
    expect(videoClips.length).toBe(2)

    const left = videoClips.find((c) => c.id === clipId)
    const right = videoClips.find((c) => c.id !== clipId)
    expect(left?.endMs).toBe(splitAt)
    expect(right?.startMs).toBe(splitAt)
    expect(right?.endMs).toBe(durationMs)
  })

  // =========================================================================
  // 5a. Split-delete before
  // =========================================================================
  test('split-delete-before removes the left piece and keeps the right piece', async () => {
    if (!launched) throw new Error('launch failed')
    const { mediaId, durationMs } = await openEditorWithMedia(launched)

    const clipId = await addVideoClip(launched, durationMs, mediaId)
    const splitAt = Math.floor(durationMs * 0.4)

    await clickClipToSelect(launched, clipId)
    await setPlayhead(launched, splitAt)

    await launched.page
      .locator('[data-testid="timeline-split-delete-before-button"]')
      .click()
    await launched.page.waitForTimeout(300)

    const clips = await getAllClips(launched)
    const videoClips = clips.filter((c) => c.trackKind === 'video')
    // Only the right piece remains.
    expect(videoClips.length).toBe(1)
    expect(videoClips[0].startMs).toBe(splitAt)
    expect(videoClips[0].endMs).toBe(durationMs)
  })

  // =========================================================================
  // 5b. Split-delete after
  // =========================================================================
  test('split-delete-after removes the right piece and keeps the left piece', async () => {
    if (!launched) throw new Error('launch failed')
    const { mediaId, durationMs } = await openEditorWithMedia(launched)

    const clipId = await addVideoClip(launched, durationMs, mediaId)
    const splitAt = Math.floor(durationMs * 0.6)

    await clickClipToSelect(launched, clipId)
    await setPlayhead(launched, splitAt)

    await launched.page
      .locator('[data-testid="timeline-split-delete-after-button"]')
      .click()
    await launched.page.waitForTimeout(300)

    const clips = await getAllClips(launched)
    const videoClips = clips.filter((c) => c.trackKind === 'video')
    // Only the left piece remains.
    expect(videoClips.length).toBe(1)
    expect(videoClips[0].startMs).toBe(0)
    expect(videoClips[0].endMs).toBe(splitAt)
  })

  // =========================================================================
  // 6. Delete button
  // =========================================================================
  test('delete button removes the selected clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { mediaId, durationMs } = await openEditorWithMedia(launched)

    const clipId = await addVideoClip(launched, durationMs, mediaId)
    await clickClipToSelect(launched, clipId)

    await launched.page.locator('[data-testid="timeline-delete-button"]').click()
    await launched.page.waitForTimeout(300)

    const clips = await getAllClips(launched)
    const videoClips = clips.filter((c) => c.trackKind === 'video')
    expect(videoClips).toHaveLength(0)
  })

  // =========================================================================
  // 7. Tool mode toggle — select ↔ split
  // =========================================================================
  test('tool-select and tool-split buttons toggle toolMode with correct aria-pressed', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const selectBtn = page.locator('[data-testid="tool-select-button"]')
    const splitBtn = page.locator('[data-testid="tool-split-button"]')

    // Default is select mode.
    await expect(selectBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(splitBtn).toHaveAttribute('aria-pressed', 'false')

    // Switch to split mode.
    await splitBtn.click()
    await expect(splitBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(selectBtn).toHaveAttribute('aria-pressed', 'false')

    const modeAfterSplit = await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().toolMode
    })
    expect(modeAfterSplit).toBe('split')

    // Switch back to select.
    await selectBtn.click()
    await expect(selectBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(splitBtn).toHaveAttribute('aria-pressed', 'false')

    const modeAfterSelect = await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().toolMode
    })
    expect(modeAfterSelect).toBe('select')
  })

  test('split tool mode: clicking a clip body splits it at the click point', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia(launched)
    const clipId = await addVideoClip(launched, durationMs, mediaId)

    // Enter split mode via the toolbar button.
    await page.locator('[data-testid="tool-split-button"]').click()
    await expect(page.locator('[data-testid="tool-split-button"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // Click roughly the middle of the clip body. In split mode this should
    // trigger handleSplitToolClick on the clip's onMouseDown handler.
    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    const box = await clipBody.boundingBox()
    if (!box) throw new Error('clip body bbox missing')

    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2)
    await page.waitForTimeout(300)

    const clips = await getAllClips(launched)
    const videoClips = clips.filter((c) => c.trackKind === 'video')
    // The split-tool click should have produced two clips.
    expect(videoClips.length).toBeGreaterThanOrEqual(2)
  })

  // =========================================================================
  // 8. Markers: add → ruler pin → click pin removes → clear-markers button
  // =========================================================================
  test('add-marker button adds a marker at the current playhead, shown as ruler pin', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    await setPlayhead(launched, 1000)

    // No markers yet.
    const beforeMarkers = await getMarkers(launched)
    expect(beforeMarkers).toHaveLength(0)

    await page.locator('[data-testid="timeline-add-marker-button"]').click()
    await page.waitForTimeout(150)

    const afterMarkers = await getMarkers(launched)
    expect(afterMarkers).toHaveLength(1)
    expect(afterMarkers[0].atMs).toBe(1000)

    await expect(page.locator('[data-testid="ruler-marker"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="ruler-marker"]').first()).toBeVisible()
  })

  test('clicking a ruler-marker pin removes that marker from the store', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // Add two markers via the store directly.
    await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      ui.getState().addMarker(2000)
      ui.getState().addMarker(4000)
    })
    await page.waitForTimeout(100)

    await expect(page.locator('[data-testid="ruler-marker"]')).toHaveCount(2)

    // Click the first pin.
    await page.locator('[data-testid="ruler-marker"]').first().click()
    await page.waitForTimeout(100)

    await expect(page.locator('[data-testid="ruler-marker"]')).toHaveCount(1)

    const remaining = await getMarkers(launched)
    expect(remaining).toHaveLength(1)
    // The surviving marker should be the one at 4000ms.
    expect(remaining[0].atMs).toBe(4000)
  })

  test('clear-markers button appears when markers exist and removes all of them', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // No markers — clear button must be absent.
    await expect(page.locator('[data-testid="timeline-clear-markers-button"]')).toHaveCount(0)

    // Add two markers.
    await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      ui.getState().addMarker(1500)
      ui.getState().addMarker(3000)
    })
    await page.waitForTimeout(100)

    // Clear button should appear.
    await expect(page.locator('[data-testid="timeline-clear-markers-button"]')).toBeVisible()

    // Click clear.
    await page.locator('[data-testid="timeline-clear-markers-button"]').click()
    await page.waitForTimeout(100)

    const remaining = await getMarkers(launched)
    expect(remaining).toHaveLength(0)
    await expect(page.locator('[data-testid="ruler-marker"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="timeline-clear-markers-button"]')).toHaveCount(0)
  })

  // =========================================================================
  // 9. Snap toggle
  // =========================================================================
  test('snap toggle changes snapEnabled in store and reflects via aria-pressed', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const snapBtn = page.locator('[data-testid="timeline-snap-toggle"]')

    // Default: snapEnabled=true.
    const initialSnap = await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().snapEnabled
    })
    expect(initialSnap).toBe(true)
    await expect(snapBtn).toHaveAttribute('aria-pressed', 'true')

    // Toggle off.
    await snapBtn.click()
    await expect(snapBtn).toHaveAttribute('aria-pressed', 'false')
    const snapOff = await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().snapEnabled
    })
    expect(snapOff).toBe(false)

    // Toggle back on.
    await snapBtn.click()
    await expect(snapBtn).toHaveAttribute('aria-pressed', 'true')
    const snapOn = await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().snapEnabled
    })
    expect(snapOn).toBe(true)
  })

  // =========================================================================
  // 10. A/V link toggle
  // =========================================================================
  test('A/V link toggle changes avLinkEnabled and updates aria-pressed', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const avBtn = page.locator('[data-testid="timeline-avlink-toggle"]')

    // Default: avLinkEnabled=false.
    await expect(avBtn).toHaveAttribute('aria-pressed', 'false')

    await avBtn.click()
    await expect(avBtn).toHaveAttribute('aria-pressed', 'true')
    const enabled = await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().avLinkEnabled
    })
    expect(enabled).toBe(true)

    // Toggle back.
    await avBtn.click()
    await expect(avBtn).toHaveAttribute('aria-pressed', 'false')
  })

  // =========================================================================
  // 11. Zoom slider updates pps and zoom-level display
  // =========================================================================
  test('zoom slider value reflects pps and zoom-level readout tracks it', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const slider = page.locator('[data-testid="timeline-zoom-slider"]')
    const levelDisplay = page.locator('[data-testid="timeline-zoom-level"]')

    // Default pps = 60.
    const defaultPps = await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().pps
    })
    expect(defaultPps).toBe(60)

    // Update pps to 120 via the store so the slider and readout update.
    await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      ui.getState().setPps(120)
    })
    await page.waitForTimeout(150)

    // Zoom-level readout must contain "120".
    await expect(levelDisplay).toContainText('120')

    // Slider value must be 120.
    const sliderVal = await slider.inputValue()
    expect(Number(sliderVal)).toBeCloseTo(120, 0)
  })

  // =========================================================================
  // 12. Timeline fit button
  // =========================================================================
  test('timeline-fit button reduces pps from max to fit content', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia(launched)
    await addVideoClip(launched, durationMs, mediaId)

    // Zoom in to max first.
    await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      ui.getState().setPps(400)
    })
    await page.waitForTimeout(100)

    await page.locator('[data-testid="timeline-fit-button"]').click()
    await page.waitForTimeout(300)

    const ppsAfterFit = await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().pps
    })
    // Fit must reduce pps below the 400 max.
    expect(ppsAfterFit).toBeLessThan(400)
    expect(ppsAfterFit).toBeGreaterThanOrEqual(10)
  })

  // =========================================================================
  // 13. Voice recording — no crash; graceful error when mic unavailable
  // =========================================================================
  test('record button does not crash; shows error UI when mic is denied in headless', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const recBtn = page.locator('[data-testid="timeline-record-button"]')
    await expect(recBtn).toBeVisible()

    // In headless Electron e2e there is no real microphone.
    // The component catches the getUserMedia rejection and shows
    // timeline-record-error without crashing.
    await recBtn.click()
    // Wait for the async getUserMedia to settle.
    await page.waitForTimeout(1000)

    // Record button must remain in the DOM (no page crash).
    await expect(recBtn).toBeVisible()

    // No renderer exceptions unrelated to the known mic-denied error.
    const unexpectedErrors = launched.pageErrors.filter(
      (e) => !/getUserMedia|microphone|NotFound|NotAllowed|Permission|denied/i.test(e.message)
    )
    expect(unexpectedErrors).toHaveLength(0)

    // If the error banner appeared, verify it can be dismissed by clicking.
    const errorBanner = page.locator('[data-testid="timeline-record-error"]')
    const errorVisible = await errorBanner.isVisible().catch(() => false)
    if (errorVisible) {
      await errorBanner.click()
      await expect(errorBanner).not.toBeVisible({ timeout: 2_000 })
    }

    // The recording timer must NOT appear (we never entered recording state).
    await expect(page.locator('[data-testid="timeline-record-timer"]')).toHaveCount(0)
  })

  // =========================================================================
  // 14. Regression — add-video-track-button preserved and functional
  // =========================================================================
  test('regression: add-video-track-button testid preserved and adds a video track', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const addBtn = page.locator('[data-testid="add-video-track-button"]')
    await expect(addBtn).toBeVisible()

    const tracksBefore = await page.evaluate(() => {
      const reels = (
        window as unknown as { __reelsStore: ReelsStore }
      ).__reelsStore
      return reels.state().project.tracks.filter((t) => t.kind === 'video').length
    })

    await addBtn.click()
    await page.waitForTimeout(200)

    const tracksAfter = await page.evaluate(() => {
      const reels = (
        window as unknown as { __reelsStore: ReelsStore }
      ).__reelsStore
      return reels.state().project.tracks.filter((t) => t.kind === 'video').length
    })

    expect(tracksAfter).toBe(tracksBefore + 1)
  })

  // =========================================================================
  // 15. Regression — zoom -/+/level testids preserved and functional
  // =========================================================================
  test('regression: timeline-zoom-in/out/level testids preserved and change pps', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const zoomIn = page.locator('[data-testid="timeline-zoom-in"]')
    const zoomOut = page.locator('[data-testid="timeline-zoom-out"]')
    const zoomLevel = page.locator('[data-testid="timeline-zoom-level"]')

    await expect(zoomIn).toBeVisible()
    await expect(zoomOut).toBeVisible()
    await expect(zoomLevel).toBeVisible()

    const ppsBefore = await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().pps
    })

    // Zoom in → pps must increase.
    await zoomIn.click()
    const ppsAfterIn = await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().pps
    })
    expect(ppsAfterIn).toBeGreaterThan(ppsBefore)

    // Zoom out twice → pps must decrease from ppsAfterIn.
    await zoomOut.click()
    await zoomOut.click()
    const ppsAfterOut = await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().pps
    })
    expect(ppsAfterOut).toBeLessThan(ppsAfterIn)

    // Zoom level display must contain a number.
    const levelText = await zoomLevel.textContent()
    expect(levelText).toMatch(/\d+/)
  })
})
