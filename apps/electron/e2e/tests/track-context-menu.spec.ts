import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 3 — TrackContextMenu e2e suite.
 *
 * Verifies the six right-click operations on a track header lane, the
 * open/close lifecycle, and all guard conditions:
 *   - Last video track cannot be deleted
 *   - Last caption track cannot be deleted
 *   - Audio track count hard-capped at MAX_AUDIO_TRACKS (8)
 *   - Bulk add/delete capped at MAX_BULK_TRACKS (10)
 *
 * Tests drive the store directly via `__reelsStore` testBridge for setup,
 * then synthesise a contextmenu event on the rendered lane header element so
 * the real TrackContextMenu component is exercised. DOM interactions are used
 * for the six menu items to confirm the full component → handler → store round-trip.
 *
 * Regression specs (timeline.spec.ts, track-routing.spec.ts) are run in this
 * file's sibling dirs; Phase 3 tag: @phase-3-track-menu.
 */

// ---------------------------------------------------------------------------
// Type alias for the testBridge surface used in this file.
// ---------------------------------------------------------------------------
type ReelsStore = {
  state: () => {
    project: {
      tracks: Array<{
        id: string
        kind: string
        name: string
        role?: string | null
        clips: unknown[]
      }>
    }
  }
  renameTrack: (trackId: string, name: string) => void
  addTrack: (kind: string, role?: string) => string | null
  addAudioSubmixTrack: () => string | null
  addTracks: (kind: string, count: number, role?: string) => string[]
  removeTrack: (trackId: string) => boolean
  removeTracks: (trackIds: string[]) => string[]
  newId: () => string
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Wait for the editor to mount and the testBridge to be ready. */
async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.locator('[data-testid="open-editor-button"]').click()
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
    null,
    { timeout: 5_000 }
  )
  // Reset to a clean project.
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
}

/**
 * Right-click the first track header of the given kind and wait for the
 * context menu to appear.
 *
 * We target `track-header-<kind>` (the left-side label bar) rather than the
 * clip-lane because the lane has a `e.target !== e.currentTarget` guard that
 * suppresses the event when subchildren are clicked. The header fires
 * `handleTrackHeaderContext` unconditionally.
 */
async function rightClickLane(launched: LaunchedApp, kind: string): Promise<void> {
  const { page } = launched
  // Prefer the track header — it fires the context menu unconditionally.
  const header = page.locator(`[data-testid="track-header-${kind}"]`).first()
  await expect(header).toBeVisible()
  await header.click({ button: 'right' })
  await expect(page.locator('[data-testid="track-context-menu"]')).toBeVisible({
    timeout: 3_000
  })
}

/**
 * Read all tracks from the store snapshot.
 */
async function getTracks(
  launched: LaunchedApp
): Promise<ReelsStore['state'] extends () => { project: { tracks: infer T } } ? T : never> {
  const { page } = launched
  return await page.evaluate(() => {
    const reels = (
      window as unknown as { __reelsStore: ReelsStore }
    ).__reelsStore
    return reels.state().project.tracks as never
  })
}

// ---------------------------------------------------------------------------
// Suite.
// ---------------------------------------------------------------------------
test.describe('@phase-3-track-menu TrackContextMenu', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
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

  // -------------------------------------------------------------------------
  // 1. Open / close lifecycle.
  // -------------------------------------------------------------------------
  test('right-clicking a track lane shows the context menu with 6 action items', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await rightClickLane(launched, 'video')

    const menu = page.locator('[data-testid="track-context-menu"]')
    await expect(menu).toBeVisible()
    // All six top-level menu items must be present.
    await expect(menu.locator('[data-testid="track-menu-rename"]')).toBeVisible()
    await expect(menu.locator('[data-testid="track-menu-add-one"]')).toBeVisible()
    await expect(menu.locator('[data-testid="track-menu-add-submix"]')).toBeVisible()
    await expect(menu.locator('[data-testid="track-menu-delete-one"]')).toBeVisible()
    await expect(menu.locator('[data-testid="track-menu-add-many"]')).toBeVisible()
    await expect(menu.locator('[data-testid="track-menu-delete-many"]')).toBeVisible()
  })

  test('clicking outside the menu closes it', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await rightClickLane(launched, 'video')

    const menu = page.locator('[data-testid="track-context-menu"]')
    await expect(menu).toBeVisible()

    // Click somewhere far from the menu (top-left corner of the editor).
    await page.mouse.click(10, 10)
    await expect(menu).not.toBeVisible({ timeout: 2_000 })
  })

  test('pressing Escape closes the menu', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await rightClickLane(launched, 'video')

    const menu = page.locator('[data-testid="track-context-menu"]')
    await expect(menu).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible({ timeout: 2_000 })
  })

  // -------------------------------------------------------------------------
  // 2. 이름 바꾸기 (rename).
  // -------------------------------------------------------------------------
  test('rename: opens inline input, Enter commits new name to store', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const tracksBefore = await getTracks(launched)
    const videoTrack = tracksBefore.find((t: { kind: string }) => t.kind === 'video')
    if (!videoTrack) throw new Error('no video track in fresh project')
    const originalName = videoTrack.name

    await rightClickLane(launched, 'video')
    const menu = page.locator('[data-testid="track-context-menu"]')

    // Click "이름 바꾸기" to open the rename panel.
    await menu.locator('[data-testid="track-menu-rename"]').click()
    const input = menu.locator('[data-testid="track-menu-rename-input"]')
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()

    // Clear and type a new name, then press Enter.
    const newName = 'My Custom Track'
    await input.selectText()
    await input.type(newName)
    await page.keyboard.press('Enter')

    // Menu must close.
    await expect(menu).not.toBeVisible({ timeout: 2_000 })

    // Store must reflect the new name.
    const tracksAfter = await getTracks(launched)
    const renamed = tracksAfter.find((t: { id: string }) => t.id === videoTrack.id)
    expect(renamed).toBeDefined()
    expect(renamed!.name).toBe(newName)
    expect(renamed!.name).not.toBe(originalName)
  })

  test('rename: "확인" button also commits and closes', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const tracksBefore = await getTracks(launched)
    const videoTrack = tracksBefore.find((t: { kind: string }) => t.kind === 'video')
    if (!videoTrack) throw new Error('no video track')

    await rightClickLane(launched, 'video')
    const menu = page.locator('[data-testid="track-context-menu"]')
    await menu.locator('[data-testid="track-menu-rename"]').click()
    const input = menu.locator('[data-testid="track-menu-rename-input"]')
    await input.selectText()
    await input.type('Button Test Name')
    await menu.locator('[data-testid="track-menu-rename-ok"]').click()

    await expect(menu).not.toBeVisible({ timeout: 2_000 })

    const tracksAfter = await getTracks(launched)
    const renamed = tracksAfter.find((t: { id: string }) => t.id === videoTrack.id)
    expect(renamed?.name).toBe('Button Test Name')
  })

  // -------------------------------------------------------------------------
  // 3. 트랙 하나 추가 (add-one).
  // -------------------------------------------------------------------------
  test('add-one: adds one video track and closes menu', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const tracksBefore = await getTracks(launched)
    const videoBefore = tracksBefore.filter((t: { kind: string }) => t.kind === 'video').length

    await rightClickLane(launched, 'video')
    const menu = page.locator('[data-testid="track-context-menu"]')
    await menu.locator('[data-testid="track-menu-add-one"]').click()

    // Menu closes immediately.
    await expect(menu).not.toBeVisible({ timeout: 2_000 })

    const tracksAfter = await getTracks(launched)
    const videoAfter = tracksAfter.filter((t: { kind: string }) => t.kind === 'video').length
    expect(videoAfter).toBe(videoBefore + 1)
  })

  test('add-one: adds one audio track when right-clicking audio lane', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const tracksBefore = await getTracks(launched)
    const audioBefore = tracksBefore.filter((t: { kind: string }) => t.kind === 'audio').length

    await rightClickLane(launched, 'audio')
    const menu = page.locator('[data-testid="track-context-menu"]')
    await menu.locator('[data-testid="track-menu-add-one"]').click()

    await expect(menu).not.toBeVisible({ timeout: 2_000 })

    const tracksAfter = await getTracks(launched)
    const audioAfter = tracksAfter.filter((t: { kind: string }) => t.kind === 'audio').length
    expect(audioAfter).toBe(audioBefore + 1)
  })

  // -------------------------------------------------------------------------
  // 4. 오디오 서브믹스 트랙 추가 (add-submix).
  // -------------------------------------------------------------------------
  test('add-submix: creates an audio track with role=submix', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    await rightClickLane(launched, 'video')
    const menu = page.locator('[data-testid="track-context-menu"]')
    await menu.locator('[data-testid="track-menu-add-submix"]').click()

    await expect(menu).not.toBeVisible({ timeout: 2_000 })

    const tracksAfter = await getTracks(launched)
    const submix = tracksAfter.find(
      (t: { kind: string; role?: string | null }) => t.kind === 'audio' && t.role === 'submix'
    )
    expect(submix).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // 5. 트랙 하나 삭제 (delete-one).
  // -------------------------------------------------------------------------
  test('delete-one: removes the targeted track and closes menu', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // Add a second video track so there are 2 — then we can safely delete one.
    await page.evaluate(() => {
      const reels = (
        window as unknown as { __reelsStore: ReelsStore }
      ).__reelsStore
      reels.addTrack('video')
    })

    const tracksBefore = await getTracks(launched)
    const videoBefore = tracksBefore.filter((t: { kind: string }) => t.kind === 'video').length
    expect(videoBefore).toBe(2)

    await rightClickLane(launched, 'video')
    const menu = page.locator('[data-testid="track-context-menu"]')
    await menu.locator('[data-testid="track-menu-delete-one"]').click()

    await expect(menu).not.toBeVisible({ timeout: 2_000 })

    const tracksAfter = await getTracks(launched)
    const videoAfter = tracksAfter.filter((t: { kind: string }) => t.kind === 'video').length
    expect(videoAfter).toBe(1)
  })

  // -------------------------------------------------------------------------
  // 6. 여러 트랙 추가 (add-many).
  // -------------------------------------------------------------------------
  test('add-many: opens count panel, adds N tracks on confirm', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const tracksBefore = await getTracks(launched)
    const audioBefore = tracksBefore.filter((t: { kind: string }) => t.kind === 'audio').length

    await rightClickLane(launched, 'audio')
    const menu = page.locator('[data-testid="track-context-menu"]')

    // Click "여러 트랙 추가" to reveal the panel.
    await menu.locator('[data-testid="track-menu-add-many"]').click()
    const panel = menu.locator('[data-testid="track-menu-add-many-panel"]')
    await expect(panel).toBeVisible()

    // Set count to 3.
    const numInput = panel.locator('[data-testid="track-menu-add-many-input"]')
    await numInput.fill('3')

    // Click "추가".
    await panel.locator('[data-testid="track-menu-add-many-ok"]').click()
    await expect(menu).not.toBeVisible({ timeout: 2_000 })

    const tracksAfter = await getTracks(launched)
    const audioAfter = tracksAfter.filter((t: { kind: string }) => t.kind === 'audio').length
    // The store caps at MAX_AUDIO_TRACKS=8 but fresh project has 2 audio tracks,
    // so 3 more is well within bounds.
    expect(audioAfter).toBe(audioBefore + 3)
  })

  // -------------------------------------------------------------------------
  // 7. 여러 트랙 삭제 (delete-many).
  // -------------------------------------------------------------------------
  test('delete-many: opens count panel, removes N tracks on confirm', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // Add 3 audio tracks so we have enough to bulk-delete.
    await page.evaluate(() => {
      const reels = (
        window as unknown as { __reelsStore: ReelsStore }
      ).__reelsStore
      reels.addTracks('audio', 3)
    })

    const tracksBefore = await getTracks(launched)
    const audioBefore = tracksBefore.filter((t: { kind: string }) => t.kind === 'audio').length
    expect(audioBefore).toBeGreaterThanOrEqual(3)

    await rightClickLane(launched, 'audio')
    const menu = page.locator('[data-testid="track-context-menu"]')

    await menu.locator('[data-testid="track-menu-delete-many"]').click()
    const panel = menu.locator('[data-testid="track-menu-delete-many-panel"]')
    await expect(panel).toBeVisible()

    // Set count to 2.
    const numInput = panel.locator('[data-testid="track-menu-delete-many-input"]')
    await numInput.fill('2')

    await panel.locator('[data-testid="track-menu-delete-many-ok"]').click()
    await expect(menu).not.toBeVisible({ timeout: 2_000 })

    const tracksAfter = await getTracks(launched)
    const audioAfter = tracksAfter.filter((t: { kind: string }) => t.kind === 'audio').length
    expect(audioAfter).toBe(audioBefore - 2)
  })

  // -------------------------------------------------------------------------
  // 8. Guard: last video track deletion blocked.
  // -------------------------------------------------------------------------
  test('guard: delete-one is disabled when only one video track remains', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // Fresh project has exactly 1 video track.
    const tracks = await getTracks(launched)
    const videoCount = tracks.filter((t: { kind: string }) => t.kind === 'video').length
    expect(videoCount).toBe(1)

    await rightClickLane(launched, 'video')
    const menu = page.locator('[data-testid="track-context-menu"]')
    const deleteItem = menu.locator('[data-testid="track-menu-delete-one"]')

    // aria-disabled="true" signals a disabled state (from the MenuItem component).
    await expect(deleteItem).toHaveAttribute('aria-disabled', 'true')

    // Clicking must NOT reduce the track count.
    await deleteItem.click({ force: true })
    // Menu stays open (disabled item does nothing) or closes — either way the
    // video track count must remain 1.
    await page.waitForTimeout(300)
    const tracksAfter = await getTracks(launched)
    const videoAfter = tracksAfter.filter((t: { kind: string }) => t.kind === 'video').length
    expect(videoAfter).toBe(1)
  })

  test('guard: delete-one is disabled when only one caption track remains', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // Fresh project has exactly 1 caption track.
    const tracks = await getTracks(launched)
    const captionCount = tracks.filter((t: { kind: string }) => t.kind === 'caption').length
    expect(captionCount).toBe(1)

    await rightClickLane(launched, 'caption')
    const menu = page.locator('[data-testid="track-context-menu"]')
    const deleteItem = menu.locator('[data-testid="track-menu-delete-one"]')

    await expect(deleteItem).toHaveAttribute('aria-disabled', 'true')

    await deleteItem.click({ force: true })
    await page.waitForTimeout(300)
    const tracksAfter = await getTracks(launched)
    const captionAfter = tracksAfter.filter((t: { kind: string }) => t.kind === 'caption').length
    expect(captionAfter).toBe(1)
  })

  // -------------------------------------------------------------------------
  // 9. Guard: audio track cap at MAX_AUDIO_TRACKS (8).
  // -------------------------------------------------------------------------
  test('guard: add-one is disabled when audio track count is at MAX_AUDIO_TRACKS (8)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // Fill audio tracks up to the cap (8).
    await page.evaluate(() => {
      const reels = (
        window as unknown as { __reelsStore: ReelsStore }
      ).__reelsStore
      // Fresh project has 2 audio tracks; add 6 more to hit the cap of 8.
      reels.addTracks('audio', 6)
    })

    const tracks = await getTracks(launched)
    const audioCount = tracks.filter((t: { kind: string }) => t.kind === 'audio').length
    expect(audioCount).toBe(8)

    await rightClickLane(launched, 'audio')
    const menu = page.locator('[data-testid="track-context-menu"]')
    const addItem = menu.locator('[data-testid="track-menu-add-one"]')

    // add-one must be aria-disabled when headroom is 0.
    await expect(addItem).toHaveAttribute('aria-disabled', 'true')

    await addItem.click({ force: true })
    await page.waitForTimeout(300)
    const tracksAfter = await getTracks(launched)
    const audioAfter = tracksAfter.filter((t: { kind: string }) => t.kind === 'audio').length
    expect(audioAfter).toBe(8)
  })

  // -------------------------------------------------------------------------
  // 10. Guard: add-many caps at MAX_BULK_TRACKS (10).
  // -------------------------------------------------------------------------
  test('guard: add-many input is clamped to MAX_BULK_TRACKS (10)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // The fresh project has 2 audio tracks, leaving up to 6 headroom before
    // the audio cap (8). But add-many is also hard-capped at MAX_BULK_TRACKS=10.
    // We'll use video tracks (no cap of 8; MAX_VIDEO_TRACKS=6) to verify that
    // the bulk-add input max attribute is min(headroom, MAX_BULK_TRACKS).
    // Fresh project has 1 video → addMany headroom = min(5, 10) = 5.
    await rightClickLane(launched, 'video')
    const menu = page.locator('[data-testid="track-context-menu"]')
    await menu.locator('[data-testid="track-menu-add-many"]').click()

    const panel = menu.locator('[data-testid="track-menu-add-many-panel"]')
    await expect(panel).toBeVisible()

    const numInput = panel.locator('[data-testid="track-menu-add-many-input"]')
    // The input's max must not exceed MAX_BULK_TRACKS=10.
    const maxAttr = await numInput.getAttribute('max')
    expect(Number(maxAttr)).toBeLessThanOrEqual(10)

    // Try to enter a value beyond 10 — component should clamp.
    await numInput.fill('999')
    await panel.locator('[data-testid="track-menu-add-many-ok"]').click()
    await expect(menu).not.toBeVisible({ timeout: 2_000 })

    // No more than MAX_BULK_TRACKS (10) tracks should have been added regardless.
    const tracksAfter = await getTracks(launched)
    const videoAfter = tracksAfter.filter((t: { kind: string }) => t.kind === 'video').length
    // Started at 1; hard cap for videos is MAX_VIDEO_TRACKS=6 and BULK cap=10.
    // Effective add = min(clamped-input, headroom). Either way it's ≤ 6.
    expect(videoAfter).toBeLessThanOrEqual(6)
    expect(videoAfter).toBeGreaterThan(1)
  })

  // -------------------------------------------------------------------------
  // 11. Context menu carries correct data-track-kind attribute.
  // -------------------------------------------------------------------------
  test('context menu data-track-kind reflects the right-clicked lane kind', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // Right-click audio lane → menu should report kind=audio.
    await rightClickLane(launched, 'audio')
    const menu = page.locator('[data-testid="track-context-menu"]')
    await expect(menu).toHaveAttribute('data-track-kind', 'audio')
    await page.keyboard.press('Escape')

    // Right-click video lane → kind=video.
    await rightClickLane(launched, 'video')
    await expect(menu).toHaveAttribute('data-track-kind', 'video')
    await page.keyboard.press('Escape')
  })

  // -------------------------------------------------------------------------
  // 12. delete-many: disabled when track count for kind <= 1 (mustKeepOne guard).
  // -------------------------------------------------------------------------
  test('delete-many is aria-disabled on a kind with only one remaining track', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // Fresh project: 1 video track → delete-many must be disabled for video.
    const tracks = await getTracks(launched)
    expect(tracks.filter((t: { kind: string }) => t.kind === 'video').length).toBe(1)

    await rightClickLane(launched, 'video')
    const menu = page.locator('[data-testid="track-context-menu"]')
    const deleteManyItem = menu.locator('[data-testid="track-menu-delete-many"]')
    await expect(deleteManyItem).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
  })
})
