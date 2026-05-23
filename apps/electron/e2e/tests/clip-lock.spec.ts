/**
 * @phase-clip-lock — 클립 잠금 (per-clip lock) feature tests (Phase 3.41).
 *
 * Contract tested:
 *
 *  (1)  Toggle — setClipLocked(id, true) → clip.locked === true;
 *       setClipLocked(id, false) → clip.locked === undefined.
 *  (2)  Body drag blocked — UI drag on locked clip body → startMs unchanged;
 *       data-locked="true" is set.
 *  (3)  Trim handles blocked — UI drag on trim-handle-left/right → trim/start/end unchanged.
 *  (4)  Delete shortcut blocked — select clip, dispatch Delete key → clip still present.
 *  (5)  splitClipAt store call rejected — returns null; project unchanged.
 *  (6)  removeClip store call rejected — clip still present.
 *  (7)  moveClipToTrack rejected — trackId unchanged.
 *  (8)  Context menu toggle — right-click, click lock row → locked; right-click, unlock row → unlocked.
 *  (9)  EffectsPanel banner — select locked clip → banner visible; click unlock-btn → banner gone.
 * (10)  Unlock restores editing — after unlock, body drag works normally.
 * (11)  BYTE-IDENTICAL gate — locking all clips does not change filterGraph.
 * (12)  Undo one step — setClipLocked(id, true) adds one undo step; undo restores locked=undefined.
 * (13)  Overlay + caption locked — drag blocked and removeClip rejected for overlay and caption clips.
 * (14)  Group + lock — lock one member, moveClipGroup blocked; removeClip(other member) also blocked.
 * (15)  Locked clip still selectable — click body → selectedClipIds has(id) === true.
 * (16)  Lock badge renders — clip-lock-badge visible when locked, absent when unlocked.
 */

import { expect, test } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Type bridges
// ---------------------------------------------------------------------------
type TrackKind = 'video' | 'audio' | 'caption' | 'overlay'

type Track = {
  id: string
  kind: TrackKind
  clips: Clip[]
}

type Clip = {
  id: string
  kind: string
  mediaId?: string
  trackId: string
  startMs: number
  endMs: number
  trimInMs?: number
  trimOutMs?: number
  speed?: number
  groupId?: string
  locked?: boolean
  [key: string]: unknown
}

type ProjectState = {
  project: {
    tracks: Track[]
    media: Record<string, unknown>
  }
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => ProjectState & { createNew: () => void }
    }
    __reelsStore: {
      state: () => ProjectState
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      addCaption: (c: unknown) => void
      addOverlay?: (c: unknown) => void
      newId: () => string
      removeClip: (clipId: string) => void
      splitClipAt: (clipId: string, atMs: number) => string | null
      moveClipToTrack: (clipId: string, newTrackId: string) => void
      groupClips: (clipIds: string[]) => string | null
      moveClipGroup: (clipId: string, desiredStartMs: number) => void
      updateMediaClipTrim: (
        clipId: string,
        partial: { startMs?: number; endMs?: number }
      ) => void
      setClipLocked: (clipId: string, locked: boolean) => void
      addVideoTrack: () => string | null
      selectClip: (clipId: string | null) => void
    }
    __reelsUndoRedo: {
      getState: () => {
        undo: () => void
        redo: () => void
        pastStates: unknown[]
        futureStates: unknown[]
      }
    }
    __reelsTimelineUi: {
      getState: () => {
        selectedClipIds: Set<string>
        selectClip: (clipId: string | null) => void
      }
    }
    __TIMELINE_UI_FOR_TEST__: {
      getState: () => {
        selectedClipIds: Set<string>
        clearSelection: () => void
        toggleClipSelected: (clipId: string) => void
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-clip-lock clip lock contract (Phase 3.41)', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 600))
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
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
  // Internal helpers
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
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsUndoRedo?: unknown }).__reelsUndoRedo,
      null,
      { timeout: 5_000 }
    )
  }

  async function addFixtureMedia(): Promise<{ mediaId: string; durationMs: number }> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    const { page } = launched
    return page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = window.__reelsStore
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

  async function addVideoClip(
    mediaId: string,
    durationMs: number,
    startMs = 0
  ): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(
      ({ mid, dur, st }) => {
        const reels = window.__reelsStore
        const track = reels.state().project.tracks.find((t) => t.kind === 'video')
        if (!track) throw new Error('no video track')
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: track.id,
          startMs: st,
          endMs: st + dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        return cid
      },
      { mid: mediaId, dur: durationMs, st: startMs }
    )
  }

  async function addCaptionClip(startMs: number, endMs: number): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(
      ({ st, en }) => {
        const reels = window.__reelsStore
        const captionTrack = reels.state().project.tracks.find(
          (t) => t.kind === 'caption'
        )
        if (!captionTrack) throw new Error('no caption track')
        const cid = reels.newId()
        reels.addCaption({
          id: cid,
          trackId: captionTrack.id,
          startMs: st,
          endMs: en,
          text: 'test caption',
          kind: 'caption'
        })
        return cid
      },
      { st: startMs, en: endMs }
    )
  }

  async function addOverlayClip(startMs: number, endMs: number): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(
      ({ st, en }) => {
        const reels = window.__reelsStore
        const overlayTrack = reels.state().project.tracks.find(
          (t) => t.kind === 'overlay'
        )
        if (!overlayTrack) throw new Error('no overlay track')
        const cid = reels.newId()
        // addOverlay lazily creates the track; use addClip directly since
        // we already have the overlay track id.
        reels.addClip({
          id: cid,
          kind: 'overlay',
          trackId: overlayTrack.id,
          startMs: st,
          endMs: en,
          source: { type: 'shape', shape: 'rect', color: '#ff0000' },
          baseWidthFrac: 0.3,
          baseHeightFrac: 0.3
        })
        return cid
      },
      { st: startMs, en: endMs }
    )
  }

  async function findClip(clipId: string): Promise<Clip | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return (await page.evaluate((cid) => {
      for (const t of window.__reelsStore.state().project.tracks)
        for (const c of t.clips)
          if (c.id === cid) return c as Clip
      return null
    }, clipId)) as Clip | null
  }

  async function getHistoryCounts(): Promise<{ past: number; future: number }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(() => {
      const s = window.__reelsUndoRedo.getState()
      return { past: s.pastStates.length, future: s.futureStates.length }
    })
  }

  async function undo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => window.__reelsUndoRedo.getState().undo())
    await launched.page.waitForTimeout(300)
  }

  async function tick(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.waitForTimeout(280)
  }

  async function lockClip(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(
      (cid) => window.__reelsStore.setClipLocked(cid, true),
      clipId
    )
    await tick()
  }

  async function unlockClip(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(
      (cid) => window.__reelsStore.setClipLocked(cid, false),
      clipId
    )
    await tick()
  }

  async function buildPlan(outputPath: string): Promise<{
    ok: boolean
    filterGraph?: string
    error?: string
  }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(
      async ({ op }) => {
        const project = (window.__reelsStore.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', op)
      },
      { op: outputPath }
    )
  }

  // =========================================================================
  // (1) Toggle — setClipLocked state transitions
  // =========================================================================
  test('(1) @phase-clip-lock toggle: setClipLocked(true) → locked===true; setClipLocked(false) → locked===undefined', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    // Initially unlocked.
    const initial = await findClip(clipId)
    expect(initial?.locked).not.toBe(true)

    // Lock.
    await page.evaluate((cid) => window.__reelsStore.setClipLocked(cid, true), clipId)
    await tick()
    const locked = await findClip(clipId)
    expect(locked?.locked).toBe(true)

    // Unlock → locked field must be absent (undefined), not false.
    await page.evaluate((cid) => window.__reelsStore.setClipLocked(cid, false), clipId)
    await tick()
    const unlocked = await findClip(clipId)
    expect(unlocked?.locked).toBeUndefined()
  })

  // =========================================================================
  // (2) Body drag blocked — startMs unchanged when clip is locked
  // =========================================================================
  test('(2) @phase-clip-lock body drag blocked: locked clip body drag leaves startMs unchanged; data-locked="true"', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    // Lock the clip.
    await lockClip(clipId)

    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    await expect(clipBody).toBeVisible({ timeout: 5_000 })

    // Assert data-locked attribute before drag.
    await expect(clipBody).toHaveAttribute('data-locked', 'true', { timeout: 3_000 })

    const clipRect = await clipBody.boundingBox()
    expect(clipRect).not.toBeNull()

    const before = await findClip(clipId)
    const origStartMs = before!.startMs

    // Simulate drag attempt (+120px horizontal).
    const startX = clipRect!.x + clipRect!.width / 2
    const startY = clipRect!.y + clipRect!.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 8, startY)
    await page.mouse.move(startX + 120, startY)
    await page.waitForTimeout(100)
    await page.mouse.up()
    await tick()

    const after = await findClip(clipId)
    // startMs must not have changed because the clip is locked.
    expect(after!.startMs).toBe(origStartMs)
    // data-locked attribute must still be set.
    await expect(clipBody).toHaveAttribute('data-locked', 'true')
  })

  // =========================================================================
  // (3) Trim handles blocked
  // =========================================================================
  test('(3) @phase-clip-lock trim handles blocked: trim-handle drag on locked clip leaves trim unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    await lockClip(clipId)

    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    await expect(clipBody).toBeVisible({ timeout: 5_000 })
    const clipRect = await clipBody.boundingBox()
    expect(clipRect).not.toBeNull()

    const before = await findClip(clipId)
    const origStartMs = before!.startMs
    const origEndMs = before!.endMs

    // Try dragging the left trim handle (near the left edge of clip body).
    const trimHandleLeft = page.locator(
      `[data-testid="clip-body"][data-clip-id="${clipId}"] [data-testid="trim-handle-left"]`
    )
    // If trim handle exists, try dragging it; otherwise drag the left edge directly.
    const handleExists = await trimHandleLeft.count()
    if (handleExists > 0) {
      const hRect = await trimHandleLeft.boundingBox()
      if (hRect) {
        await page.mouse.move(hRect.x + hRect.width / 2, hRect.y + hRect.height / 2)
        await page.mouse.down()
        await page.mouse.move(hRect.x + 60, hRect.y + hRect.height / 2)
        await page.waitForTimeout(100)
        await page.mouse.up()
        await tick()
      }
    } else {
      // Drag left edge of the clip.
      await page.mouse.move(clipRect!.x + 4, clipRect!.y + clipRect!.height / 2)
      await page.mouse.down()
      await page.mouse.move(clipRect!.x + 60, clipRect!.y + clipRect!.height / 2)
      await page.waitForTimeout(100)
      await page.mouse.up()
      await tick()
    }

    const after = await findClip(clipId)
    // Neither start nor end should change.
    expect(after!.startMs).toBe(origStartMs)
    expect(after!.endMs).toBe(origEndMs)
  })

  // =========================================================================
  // (4) Delete shortcut blocked
  // =========================================================================
  test('(4) @phase-clip-lock delete shortcut blocked: Delete key on locked selected clip leaves clip present', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    await lockClip(clipId)

    // Select the clip via store (ensures it's the selected clip for Delete routing).
    await page.evaluate((cid) => window.__reelsStore.selectClip(cid), clipId)
    await page.waitForTimeout(150)

    // Dispatch Delete key.
    await page.keyboard.press('Delete')
    await tick()

    const after = await findClip(clipId)
    expect(after).not.toBeNull()
    expect(after!.locked).toBe(true)
  })

  // =========================================================================
  // (5) splitClipAt store call rejected
  // =========================================================================
  test('(5) @phase-clip-lock splitClipAt rejected: returns null; project unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    await lockClip(clipId)

    const before = await findClip(clipId)
    const splitMs = Math.floor(durationMs / 2)

    const result = await page.evaluate(
      ({ cid, ms }) => window.__reelsStore.splitClipAt(cid, ms),
      { cid: clipId, ms: splitMs }
    )
    await tick()

    // Must return null (rejected).
    expect(result).toBeNull()

    // Original clip unchanged.
    const after = await findClip(clipId)
    expect(after).not.toBeNull()
    expect(after!.startMs).toBe(before!.startMs)
    expect(after!.endMs).toBe(before!.endMs)
    expect(after!.locked).toBe(true)

    // No new clip should have appeared.
    const allClipIds = await page.evaluate(() => {
      const ids: string[] = []
      for (const t of window.__reelsStore.state().project.tracks)
        for (const c of t.clips) ids.push(c.id)
      return ids
    })
    expect(allClipIds.filter((id) => id !== clipId).length).toBe(
      // Same number of clips as before lock (no new split halves).
      0
    )
  })

  // =========================================================================
  // (6) removeClip store call rejected
  // =========================================================================
  test('(6) @phase-clip-lock removeClip rejected: locked clip survives removeClip call', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    await lockClip(clipId)

    await page.evaluate((cid) => window.__reelsStore.removeClip(cid), clipId)
    await tick()

    const after = await findClip(clipId)
    expect(after).not.toBeNull()
    expect(after!.locked).toBe(true)
  })

  // =========================================================================
  // (7) moveClipToTrack rejected
  // =========================================================================
  test('(7) @phase-clip-lock moveClipToTrack rejected: locked clip trackId unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    // Add a second video track to try moving to.
    const v1Id = await page.evaluate(() => window.__reelsStore.addVideoTrack())
    if (!v1Id) throw new Error('addVideoTrack returned null')
    await tick()

    const before = await findClip(clipId)
    const origTrackId = before!.trackId

    await lockClip(clipId)

    await page.evaluate(
      ({ cid, tid }) => window.__reelsStore.moveClipToTrack(cid, tid),
      { cid: clipId, tid: v1Id }
    )
    await tick()

    const after = await findClip(clipId)
    expect(after!.trackId).toBe(origTrackId)
  })

  // =========================================================================
  // (8) Context menu toggle
  // =========================================================================
  test('(8) @phase-clip-lock context menu toggle: right-click lock row locks; unlock row unlocks', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    await expect(clipBody).toBeVisible({ timeout: 5_000 })

    // --- Right-click unlocked clip → click lock row ---
    await clipBody.click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible({
      timeout: 3_000
    })

    const toggleLockRow = page.locator('[data-testid="menu-toggle-lock"]')
    await expect(toggleLockRow).toBeVisible({ timeout: 3_000 })
    await toggleLockRow.click()
    await tick()

    // Clip should now be locked.
    const afterLock = await findClip(clipId)
    expect(afterLock!.locked).toBe(true)

    // --- Right-click locked clip → click unlock row ---
    await clipBody.click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible({
      timeout: 3_000
    })

    const toggleUnlockRow = page.locator('[data-testid="menu-toggle-lock"]')
    await expect(toggleUnlockRow).toBeVisible({ timeout: 3_000 })
    await toggleUnlockRow.click()
    await tick()

    // Clip should now be unlocked.
    const afterUnlock = await findClip(clipId)
    expect(afterUnlock!.locked).toBeUndefined()
  })

  // =========================================================================
  // (9) EffectsPanel banner
  // =========================================================================
  test('(9) @phase-clip-lock effects panel banner: locked clip shows banner; unlock-btn clears it', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    // Click the clip body in the DOM so Editor.tsx sets selectedClipId.
    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    await expect(clipBody).toBeVisible({ timeout: 5_000 })
    await clipBody.click()
    await page.waitForTimeout(200)

    // Open the effects panel via the toolbar toggle button.
    const toggleBtn = page.locator('[data-testid="toggle-effects-panel"]')
    await expect(toggleBtn).toBeVisible({ timeout: 3_000 })
    await toggleBtn.click()
    await page.waitForTimeout(200)

    // Lock the clip via store — the effects panel should switch to the locked banner.
    await lockClip(clipId)

    // The effects panel locked banner must appear.
    const banner = page.locator('[data-testid="effects-panel-locked-banner"]')
    await expect(banner).toBeVisible({ timeout: 5_000 })

    // Click the unlock button inside the banner.
    const unlockBtn = page.locator('[data-testid="effects-panel-unlock-btn"]')
    await expect(unlockBtn).toBeVisible({ timeout: 3_000 })
    await unlockBtn.click()
    await tick()

    // Banner must disappear after unlocking.
    await expect(banner).not.toBeVisible({ timeout: 3_000 })

    // Clip must be unlocked in the store.
    const after = await findClip(clipId)
    expect(after!.locked).toBeUndefined()
  })

  // =========================================================================
  // (10) Unlock restores editing — drag works after unlock
  // =========================================================================
  test('(10) @phase-clip-lock unlock restores editing: body drag shifts startMs after unlock', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    // Lock, then unlock.
    await lockClip(clipId)
    await unlockClip(clipId)

    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    await expect(clipBody).toBeVisible({ timeout: 5_000 })
    // data-locked should now be false after unlock.
    await expect(clipBody).toHaveAttribute('data-locked', 'false', { timeout: 3_000 })

    const clipRect = await clipBody.boundingBox()
    expect(clipRect).not.toBeNull()

    const before = await findClip(clipId)
    const origStartMs = before!.startMs

    // Drag to the right (+120px).
    const startX = clipRect!.x + clipRect!.width / 2
    const startY = clipRect!.y + clipRect!.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 8, startY)
    await page.mouse.move(startX + 120, startY)
    await page.waitForTimeout(100)
    await page.mouse.up()
    await tick()

    const after = await findClip(clipId)
    // After unlock, drag should have shifted startMs.
    expect(after!.startMs).toBeGreaterThan(origStartMs)
  })

  // =========================================================================
  // (11) BYTE-IDENTICAL gate — locking all clips must not affect filterGraph
  // =========================================================================
  test('(11) @phase-clip-lock BYTE-IDENTICAL: locking all clips produces identical filterGraph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs, 0)
    await tick()

    // Capture baseline BEFORE locking.
    const baselinePath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `lock-baseline-${Date.now()}.mp4`
    )
    const baseline = await buildPlan(baselinePath)
    expect(baseline.ok, `baseline buildPlan failed: ${baseline.error ?? ''}`).toBe(true)
    const baselineGraph = baseline.filterGraph ?? ''
    expect(baselineGraph).toBeTruthy()

    // Lock every clip in the project.
    await page.evaluate(() => {
      for (const t of window.__reelsStore.state().project.tracks)
        for (const c of t.clips)
          window.__reelsStore.setClipLocked(c.id, true)
    })
    await tick()

    // filterGraph must be byte-identical.
    const lockedPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `lock-locked-${Date.now()}.mp4`
    )
    const locked = await buildPlan(lockedPath)
    expect(locked.ok, `locked buildPlan failed: ${locked.error ?? ''}`).toBe(true)
    const lockedGraph = locked.filterGraph ?? ''

    expect(lockedGraph).toBe(baselineGraph)
  })

  // =========================================================================
  // (12) Undo one step
  // =========================================================================
  test('(12) @phase-clip-lock undo: setClipLocked(true) adds one undo step; undo restores locked=undefined', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const beforeHistory = await getHistoryCounts()

    await page.evaluate((cid) => window.__reelsStore.setClipLocked(cid, true), clipId)
    await tick()

    // One new undo step.
    const afterLock = await getHistoryCounts()
    expect(afterLock.past).toBe(beforeHistory.past + 1)

    // Confirm locked.
    const locked = await findClip(clipId)
    expect(locked!.locked).toBe(true)

    // Undo → locked field must be gone (undefined).
    await undo()

    const afterUndo = await findClip(clipId)
    expect(afterUndo!.locked).toBeUndefined()

    // History count back to baseline.
    const afterUndoHistory = await getHistoryCounts()
    expect(afterUndoHistory.past).toBe(beforeHistory.past)
  })

  // =========================================================================
  // (13) Overlay + caption locked — drag blocked and removeClip rejected
  // =========================================================================
  test('(13a) @phase-clip-lock overlay locked: removeClip rejected; drag blocked', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { durationMs } = await addFixtureMedia()
    const overlayId = await addOverlayClip(0, durationMs)
    await tick()

    await lockClip(overlayId)

    // removeClip must be a no-op.
    await page.evaluate((cid) => window.__reelsStore.removeClip(cid), overlayId)
    await tick()
    const afterRemove = await findClip(overlayId)
    expect(afterRemove).not.toBeNull()
    expect(afterRemove!.locked).toBe(true)

    // Drag on the clip body must leave startMs unchanged.
    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${overlayId}"]`)
    const exists = await clipBody.count()
    if (exists > 0) {
      await expect(clipBody).toBeVisible({ timeout: 3_000 })
      await expect(clipBody).toHaveAttribute('data-locked', 'true', { timeout: 3_000 })
      const clipRect = await clipBody.boundingBox()
      if (clipRect) {
        const before = await findClip(overlayId)
        const origStart = before!.startMs
        await page.mouse.move(clipRect.x + clipRect.width / 2, clipRect.y + clipRect.height / 2)
        await page.mouse.down()
        await page.mouse.move(clipRect.x + clipRect.width / 2 + 8, clipRect.y + clipRect.height / 2)
        await page.mouse.move(clipRect.x + clipRect.width / 2 + 120, clipRect.y + clipRect.height / 2)
        await page.waitForTimeout(100)
        await page.mouse.up()
        await tick()
        const after = await findClip(overlayId)
        expect(after!.startMs).toBe(origStart)
      }
    }
  })

  test('(13b) @phase-clip-lock caption locked: removeClip rejected; data-locked on body', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { durationMs } = await addFixtureMedia()
    const captionId = await addCaptionClip(0, durationMs)
    await tick()

    await lockClip(captionId)

    // removeClip must be a no-op.
    await page.evaluate((cid) => window.__reelsStore.removeClip(cid), captionId)
    await tick()
    const afterRemove = await findClip(captionId)
    expect(afterRemove).not.toBeNull()
    expect(afterRemove!.locked).toBe(true)

    // If clip body is rendered, it must show data-locked="true".
    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${captionId}"]`)
    const exists = await clipBody.count()
    if (exists > 0) {
      await expect(clipBody).toHaveAttribute('data-locked', 'true', { timeout: 3_000 })
    }
  })

  // =========================================================================
  // (14) Group + lock — locked member anchors the whole group
  // =========================================================================
  test('(14) @phase-clip-lock group+lock: locking one member blocks moveClipGroup for the group; removeClip(other) blocked', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    // Group both clips.
    await page.evaluate(([a, b]) => window.__reelsStore.groupClips([a, b]), [idA, idB])
    await tick()

    // Lock only clip A.
    await lockClip(idA)

    const beforeA = await findClip(idA)
    const beforeB = await findClip(idB)

    // Try to move the group via clip B (A is locked → group block).
    await page.evaluate(
      ({ cid, ms }) => window.__reelsStore.moveClipGroup(cid, ms),
      { cid: idB, ms: beforeB!.startMs + 2000 }
    )
    await tick()

    const afterA = await findClip(idA)
    const afterB = await findClip(idB)
    // Positions must be unchanged because a group member (A) is locked.
    expect(afterA!.startMs).toBe(beforeA!.startMs)
    expect(afterB!.startMs).toBe(beforeB!.startMs)

    // removeClip(B) should also be blocked because A (same group) is locked
    // AND per the contract the grouped-sweep in removeClip hits A which is locked.
    await page.evaluate((cid) => window.__reelsStore.removeClip(cid), idB)
    await tick()
    const afterRemoveA = await findClip(idA)
    const afterRemoveB = await findClip(idB)
    // Both should still be present.
    expect(afterRemoveA).not.toBeNull()
    expect(afterRemoveB).not.toBeNull()
  })

  // =========================================================================
  // (15) Locked clip still selectable
  // =========================================================================
  test('(15) @phase-clip-lock selectable: locked clip can still be selected by clicking its body', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    await lockClip(clipId)

    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    await expect(clipBody).toBeVisible({ timeout: 5_000 })

    // Click the clip body to select it.
    await clipBody.click()
    await page.waitForTimeout(200)

    // selectedClipIds must include this clip.
    const selectedIds = await page.evaluate(() => {
      return [...window.__reelsTimelineUi.getState().selectedClipIds]
    })
    expect(selectedIds).toContain(clipId)
  })

  // =========================================================================
  // (16) Lock badge renders
  // =========================================================================
  test('(16) @phase-clip-lock badge: clip-lock-badge visible when locked; absent when unlocked', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    await expect(clipBody).toBeVisible({ timeout: 5_000 })

    const badge = page.locator(
      `[data-testid="clip-body"][data-clip-id="${clipId}"] [data-testid="clip-lock-badge"]`
    )

    // Unlocked state — badge must NOT be present.
    await expect(badge).toHaveCount(0)

    // Lock.
    await lockClip(clipId)

    // Locked state — badge must appear.
    await expect(badge).toBeVisible({ timeout: 5_000 })

    // Unlock.
    await unlockClip(clipId)

    // Unlocked again — badge must disappear.
    await expect(badge).toHaveCount(0, { timeout: 3_000 })
  })
})
