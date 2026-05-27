/**
 * @phase-cross-track-drag — 트랙 간 클립 드래그 (Phase 3.40) feature tests.
 *
 * Contract tested:
 *
 *  (1)  moveClipToTrack — media clip moves from V0 to a second video track V1.
 *       V0 empty, V1 has the clip, startMs/endMs preserved.
 *  (2)  moveClipToTrack — media clip moves from V0 to an audio track.
 *       Clip relocated, kind still 'media'.
 *  (3)  Incompatible matrix — no-op. media→caption, caption→video, overlay→audio
 *       each leave the clip on its original track.
 *  (4)  UI drag onto a different compatible track (V0 → V1) via mouse events.
 *       clip.trackId === V1.id afterwards.
 *  (5)  UI drag — horizontal-only motion (no Y change). clip.startMs shifts;
 *       clip.trackId unchanged. (Regression gate.)
 *  (6)  UI drag onto incompatible track — trackId unchanged; horizontal shift OK.
 *  (7)  Group-aware — only the dragged clip moves; sibling stays on source track;
 *       both retain the same groupId.
 *  (8)  Undo — moveClipToTrack adds one undo step; undo restores original trackId.
 *  (9)  BYTE-IDENTICAL — round-trip (V0→V1→V0) produces the same filterGraph as
 *       the baseline captured before the first move.
 * (10)  Drop indicator — mid-drag, [data-cross-track-drop-target="true"] appears
 *       on the hovered compatible lane and disappears when cursor leaves.
 * (11)  Overlap clamp — target track already has a clip; dragged clip's startMs
 *       is pushed so it does not overlap.
 */

import { expect, test } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Type bridges (mirrored from shared/project.ts and store/project.ts)
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
      newId: () => string
      // Track management
      addVideoTrack: () => string | null
      addTrack: (kind: TrackKind, role?: string) => string | null
      // Clip management
      removeClip: (clipId: string) => void
      moveClipToTrack: (clipId: string, newTrackId: string) => void
      groupClips: (clipIds: string[]) => string | null
      moveClipGroup: (clipId: string, desiredStartMs: number) => void
      updateMediaClipTrim: (
        clipId: string,
        partial: { startMs?: number; endMs?: number }
      ) => void
    }
    __reelsUndoRedo: {
      getState: () => {
        undo: () => void
        redo: () => void
        pastStates: unknown[]
        futureStates: unknown[]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-cross-track-drag cross-track clip drag (Phase 3.40)', () => {
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

  /** Add a media clip on the first video track. Returns the clip id. */
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

  /** Add a media clip onto a specific track by id. Returns the clip id. */
  async function addVideoClipOnTrack(
    mediaId: string,
    durationMs: number,
    trackId: string,
    startMs = 0
  ): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(
      ({ mid, dur, tid, st }) => {
        const reels = window.__reelsStore
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: tid,
          startMs: st,
          endMs: st + dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        return cid
      },
      { mid: mediaId, dur: durationMs, tid: trackId, st: startMs }
    )
  }

  /** Add a caption clip onto the first caption track. Returns the clip id. */
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

  /** Find a clip by id across all tracks. Returns null when not found. */
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

  /** Return the first track of the given kind. */
  async function getTrackByKind(kind: TrackKind): Promise<Track | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return (await page.evaluate((k) => {
      return (
        window.__reelsStore.state().project.tracks.find((t) => t.kind === k) ?? null
      )
    }, kind)) as Track | null
  }

  /** Return all tracks of the given kind. */
  async function getTracksByKind(kind: TrackKind): Promise<Track[]> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return (await page.evaluate((k) => {
      return window.__reelsStore.state().project.tracks.filter((t) => t.kind === k)
    }, kind)) as Track[]
  }

  /** Add a second video track and return its id. */
  async function addSecondVideoTrack(): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const id = await page.evaluate(() => window.__reelsStore.addVideoTrack())
    if (!id) throw new Error('addVideoTrack returned null (hit track cap?)')
    return id
  }

  /** Add an audio track and return its id. */
  async function addAudioTrack(): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const id = await page.evaluate(() => window.__reelsStore.addTrack('audio'))
    if (!id) throw new Error('addTrack("audio") returned null')
    return id
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
  // (1) moveClipToTrack — media clip moves from V0 to second video track V1
  // =========================================================================
  test('(1) @phase-cross-track-drag moveClipToTrack: media clip moves V0 → V1; V0 empty; V1 has clip; timing preserved', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const v1Id = await addSecondVideoTrack()
    await tick()

    // Capture timing before.
    const before = await findClip(clipId)
    expect(before).not.toBeNull()
    const origStart = before!.startMs
    const origEnd = before!.endMs
    const srcTrackId = before!.trackId

    // Move clip from V0 to V1.
    await page.evaluate(
      ({ cid, tid }) => window.__reelsStore.moveClipToTrack(cid, tid),
      { cid: clipId, tid: v1Id }
    )
    await tick()

    // V0 must be empty.
    const v0 = await page.evaluate(
      (tid) =>
        window.__reelsStore
          .state()
          .project.tracks.find((t) => t.id === tid)?.clips ?? [],
      srcTrackId
    )
    expect(v0.length).toBe(0)

    // V1 must have exactly the clip.
    const v1 = await page.evaluate(
      (tid) =>
        window.__reelsStore
          .state()
          .project.tracks.find((t) => t.id === tid)?.clips ?? [],
      v1Id
    )
    expect(v1.length).toBe(1)

    const after = await findClip(clipId)
    expect(after).not.toBeNull()
    expect(after!.trackId).toBe(v1Id)
    expect(after!.startMs).toBe(origStart)
    expect(after!.endMs).toBe(origEnd)
    expect(after!.kind).toBe('media')
  })

  // =========================================================================
  // (2) moveClipToTrack — video media clip → audio track 거부 (Reels 11 슬라이드
  // 11). 이전엔 가능했지만 사용자 요구로 동종 가드 추가. 음원/영상 trackKind
  // 매트릭스 엄격화.
  // =========================================================================
  test('(2) @phase-cross-track-drag moveClipToTrack: video media → audio track REJECTED (slide 11)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const audioId = await addAudioTrack()
    await tick()

    const before = await findClip(clipId)
    expect(before!.kind).toBe('media')
    const origTrackId = before!.trackId

    await page.evaluate(
      ({ cid, tid }) => window.__reelsStore.moveClipToTrack(cid, tid),
      { cid: clipId, tid: audioId }
    )
    await tick()

    const after = await findClip(clipId)
    expect(after).not.toBeNull()
    // 거부됐으므로 trackId 가 원본 그대로.
    expect(after!.trackId).toBe(origTrackId)
    expect(after!.trackId).not.toBe(audioId)
  })

  // =========================================================================
  // (3) Incompatible matrix — no-ops
  // =========================================================================
  test('(3a) @phase-cross-track-drag incompatible matrix: media → caption track → no-op', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const captionTrack = await getTrackByKind('caption')
    expect(captionTrack).not.toBeNull()

    const before = await findClip(clipId)
    const origTrackId = before!.trackId

    await page.evaluate(
      ({ cid, tid }) => window.__reelsStore.moveClipToTrack(cid, tid),
      { cid: clipId, tid: captionTrack!.id }
    )
    await tick()

    const after = await findClip(clipId)
    expect(after!.trackId).toBe(origTrackId)
  })

  test('(3b) @phase-cross-track-drag incompatible matrix: caption → video track → no-op', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { durationMs } = await addFixtureMedia()
    const captionId = await addCaptionClip(0, durationMs)
    await tick()

    const videoTrack = await getTrackByKind('video')
    expect(videoTrack).not.toBeNull()

    const before = await findClip(captionId)
    const origTrackId = before!.trackId

    await page.evaluate(
      ({ cid, tid }) => window.__reelsStore.moveClipToTrack(cid, tid),
      { cid: captionId, tid: videoTrack!.id }
    )
    await tick()

    const after = await findClip(captionId)
    expect(after!.trackId).toBe(origTrackId)
  })

  test('(3c) @phase-cross-track-drag incompatible matrix: media → overlay track → no-op', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    // Find the overlay track (it always exists in the default project).
    const overlayTrack = await getTrackByKind('overlay')
    expect(overlayTrack).not.toBeNull()

    const before = await findClip(clipId)
    const origTrackId = before!.trackId

    await page.evaluate(
      ({ cid, tid }) => window.__reelsStore.moveClipToTrack(cid, tid),
      { cid: clipId, tid: overlayTrack!.id }
    )
    await tick()

    const after = await findClip(clipId)
    expect(after!.trackId).toBe(origTrackId)
  })

  // =========================================================================
  // (4) UI drag onto different compatible track moves the clip
  // =========================================================================
  test('(4) @phase-cross-track-drag UI: mousedrag over V1 row → clip.trackId === V1', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const v1Id = await addSecondVideoTrack()
    await tick()

    // Wait for DOM to catch up to the new track.
    await page.waitForSelector('[data-testid="track-lane-video"]', { timeout: 5_000 })

    // Get the bounding rect of V1's lane (the second video lane).
    const laneLocator = page.locator('[data-testid="track-lane-video"]').nth(1)
    await expect(laneLocator).toBeVisible({ timeout: 5_000 })
    const v1Rect = await laneLocator.boundingBox()
    expect(v1Rect).not.toBeNull()

    // Get the bounding rect of the clip body.
    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    await expect(clipBody).toBeVisible({ timeout: 5_000 })
    const clipRect = await clipBody.boundingBox()
    expect(clipRect).not.toBeNull()

    // Simulate: mousedown on clip → mousemove down into V1 → mouseup.
    const startX = clipRect!.x + clipRect!.width / 2
    const startY = clipRect!.y + clipRect!.height / 2
    // Target Y is inside V1 lane (centred).
    const targetY = v1Rect!.y + v1Rect!.height / 2
    // Small horizontal delta so the drag threshold is crossed.
    const targetX = startX + 15

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    // Move incrementally to trigger onMove correctly.
    await page.mouse.move(startX + 8, startY)
    await page.mouse.move(targetX, (startY + targetY) / 2)
    await page.mouse.move(targetX, targetY)
    await page.waitForTimeout(100)
    await page.mouse.up()
    await tick()

    const after = await findClip(clipId)
    expect(after).not.toBeNull()
    expect(after!.trackId).toBe(v1Id)
  })

  // =========================================================================
  // (5) UI drag — horizontal-only motion; trackId unchanged (regression gate)
  // =========================================================================
  test('(5) @phase-cross-track-drag UI: horizontal-only drag shifts startMs; trackId unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    await expect(clipBody).toBeVisible({ timeout: 5_000 })
    const clipRect = await clipBody.boundingBox()
    expect(clipRect).not.toBeNull()

    const before = await findClip(clipId)
    const origTrackId = before!.trackId

    const startX = clipRect!.x + clipRect!.width / 2
    const startY = clipRect!.y + clipRect!.height / 2

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    // Move only horizontally — no Y change.
    await page.mouse.move(startX + 8, startY)
    await page.mouse.move(startX + 120, startY)
    await page.waitForTimeout(100)
    await page.mouse.up()
    await tick()

    const after = await findClip(clipId)
    expect(after).not.toBeNull()
    // startMs must have shifted (rightward drag → later position).
    expect(after!.startMs).toBeGreaterThan(before!.startMs)
    // trackId must be unchanged — no cross-track move happened.
    expect(after!.trackId).toBe(origTrackId)
  })

  // =========================================================================
  // (6) UI drag onto incompatible track — trackId unchanged; horizontal shift OK
  // =========================================================================
  test('(6) @phase-cross-track-drag UI: drag onto caption lane → trackId unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    // Find the caption lane — always present in default project.
    const captionLane = page.locator('[data-testid="track-lane-caption"]')
    await expect(captionLane).toBeVisible({ timeout: 5_000 })
    const captionRect = await captionLane.boundingBox()
    expect(captionRect).not.toBeNull()

    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    await expect(clipBody).toBeVisible({ timeout: 5_000 })
    const clipRect = await clipBody.boundingBox()
    expect(clipRect).not.toBeNull()

    const before = await findClip(clipId)
    const origTrackId = before!.trackId

    const startX = clipRect!.x + clipRect!.width / 2
    const startY = clipRect!.y + clipRect!.height / 2
    const captionCenterY = captionRect!.y + captionRect!.height / 2

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 8, startY)
    await page.mouse.move(startX + 15, (startY + captionCenterY) / 2)
    await page.mouse.move(startX + 15, captionCenterY)
    await page.waitForTimeout(100)
    await page.mouse.up()
    await tick()

    const after = await findClip(clipId)
    expect(after).not.toBeNull()
    // Track must be UNCHANGED — caption is incompatible with media clip.
    expect(after!.trackId).toBe(origTrackId)
  })

  // =========================================================================
  // (7) Group-aware — only the dragged clip moves; sibling stays on V0
  // =========================================================================
  test('(7) @phase-cross-track-drag group-aware: moveClipToTrack(A, V1) leaves B on V0; both retain groupId', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // Two clips on V0.
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    // Group them.
    const groupId = await page.evaluate(
      ([a, b]) => window.__reelsStore.groupClips([a, b]),
      [idA, idB]
    )
    expect(groupId).not.toBeNull()
    await tick()

    const v1Id = await addSecondVideoTrack()
    await tick()

    const beforeA = await findClip(idA)
    const beforeB = await findClip(idB)
    const v0Id = beforeA!.trackId

    // Move only A to V1.
    await page.evaluate(
      ({ cid, tid }) => window.__reelsStore.moveClipToTrack(cid, tid),
      { cid: idA, tid: v1Id }
    )
    await tick()

    const afterA = await findClip(idA)
    const afterB = await findClip(idB)

    // A is on V1.
    expect(afterA!.trackId).toBe(v1Id)
    // B remains on V0.
    expect(afterB!.trackId).toBe(v0Id)
    // Both retain the same groupId.
    expect(afterA!.groupId).toBe(groupId)
    expect(afterB!.groupId).toBe(groupId)
    expect(afterA!.groupId).toBe(afterB!.groupId)

    // Confirm B is unchanged in the store list under V0.
    const v0Clips = await page.evaluate(
      (tid) =>
        window.__reelsStore
          .state()
          .project.tracks.find((t) => t.id === tid)?.clips ?? [],
      v0Id
    )
    expect(v0Clips.some((c: Clip) => c.id === idB)).toBe(true)
    expect(v0Clips.some((c: Clip) => c.id === idA)).toBe(false)

    // Suppress TS complaints about beforeB being unused.
    void beforeB
  })

  // =========================================================================
  // (8) Undo — moveClipToTrack adds one step; undo restores trackId
  // =========================================================================
  test('(8) @phase-cross-track-drag undo: moveClipToTrack → undo restores clip to source track in one step', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const v1Id = await addSecondVideoTrack()
    await tick()

    const before = await findClip(clipId)
    const origTrackId = before!.trackId

    const beforeHistory = await getHistoryCounts()

    await page.evaluate(
      ({ cid, tid }) => window.__reelsStore.moveClipToTrack(cid, tid),
      { cid: clipId, tid: v1Id }
    )
    await tick()

    const afterMove = await findClip(clipId)
    expect(afterMove!.trackId).toBe(v1Id)

    const afterHistory = await getHistoryCounts()
    // Exactly one new undo step (note: addVideoTrack also adds a step, so we
    // compare relative to afterHistory captured before moveClipToTrack).
    expect(afterHistory.past).toBe(beforeHistory.past + 1)

    // Undo → clip restored to original track.
    await undo()

    const afterUndo = await findClip(clipId)
    expect(afterUndo!.trackId).toBe(origTrackId)
  })

  // =========================================================================
  // (9) BYTE-IDENTICAL gate — round-trip V0→V1→V0 produces same filterGraph
  // =========================================================================
  test('(9) @phase-cross-track-drag BYTE-IDENTICAL: V0→V1→V0 round-trip produces identical filterGraph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const v1Id = await addSecondVideoTrack()
    await tick()

    // Capture baseline BEFORE any move.
    const baselinePath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `cross-track-baseline-${Date.now()}.mp4`
    )
    const baseline = await buildPlan(baselinePath)
    expect(baseline.ok, `baseline buildPlan failed: ${baseline.error ?? ''}`).toBe(true)
    const baselineGraph = baseline.filterGraph ?? ''
    expect(baselineGraph).toBeTruthy()

    // V0 → V1.
    await page.evaluate(
      ({ cid, tid }) => window.__reelsStore.moveClipToTrack(cid, tid),
      { cid: clipId, tid: v1Id }
    )
    await tick()

    // Get V0 id (need to re-read; the track still exists but is empty).
    const v0Id = await page.evaluate(() => {
      const tracks = window.__reelsStore.state().project.tracks
      const videoTracks = tracks.filter((t) => t.kind === 'video')
      // The first video track is V0 (addVideoTrack inserts after the last one).
      return videoTracks[0]?.id ?? null
    })
    expect(v0Id).not.toBeNull()

    // V1 → back to V0.
    await page.evaluate(
      ({ cid, tid }) => window.__reelsStore.moveClipToTrack(cid, tid),
      { cid: clipId, tid: v0Id }
    )
    await tick()

    // Clip must be back on V0.
    const roundTrip = await findClip(clipId)
    expect(roundTrip!.trackId).toBe(v0Id)

    // Capture filterGraph after round-trip.
    const afterPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `cross-track-roundtrip-${Date.now()}.mp4`
    )
    const after = await buildPlan(afterPath)
    expect(after.ok, `round-trip buildPlan failed: ${after.error ?? ''}`).toBe(true)
    const afterGraph = after.filterGraph ?? ''

    // BYTE-IDENTICAL GATE.
    expect(afterGraph).toBe(baselineGraph)
  })

  // =========================================================================
  // (10) Drop indicator — [data-cross-track-drop-target] during drag
  // =========================================================================
  test('(10) @phase-cross-track-drag drop indicator: attribute true on hovered compatible lane during drag', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const clipId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    await addSecondVideoTrack()
    await tick()

    await page.waitForSelector('[data-testid="track-lane-video"]', { timeout: 5_000 })

    const v1Lane = page.locator('[data-testid="track-lane-video"]').nth(1)
    await expect(v1Lane).toBeVisible({ timeout: 5_000 })
    const v1Rect = await v1Lane.boundingBox()
    expect(v1Rect).not.toBeNull()

    const clipBody = page.locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
    await expect(clipBody).toBeVisible({ timeout: 5_000 })
    const clipRect = await clipBody.boundingBox()
    expect(clipRect).not.toBeNull()

    const startX = clipRect!.x + clipRect!.width / 2
    const startY = clipRect!.y + clipRect!.height / 2
    const v1CenterY = v1Rect!.y + v1Rect!.height / 2

    // Begin drag.
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    // Cross the drag threshold.
    await page.mouse.move(startX + 8, startY)
    // Move into V1.
    await page.mouse.move(startX + 15, v1CenterY)
    await page.waitForTimeout(150)

    // While mid-drag, the V1 lane should have data-cross-track-drop-target="true".
    const dropAttr = await v1Lane.getAttribute('data-cross-track-drop-target')
    expect(dropAttr).toBe('true')

    // Move cursor BACK to the source V0 lane.
    await page.mouse.move(startX + 15, startY)
    await page.waitForTimeout(150)

    // Now no lane should have the attribute set to true.
    const anyTrue = await page.evaluate(() => {
      const lanes = document.querySelectorAll('[data-cross-track-drop-target="true"]')
      return lanes.length
    })
    expect(anyTrue).toBe(0)

    // Release — let the drag complete naturally.
    await page.mouse.up()
    await tick()
  })

  // =========================================================================
  // (11) Overlap clamp — UI drag onto target track that already has a clip.
  //      The Timeline's onUp handler calls clampNoOverlap before moveClipToTrack
  //      so A must not overlap X in the target lane after the drag completes.
  // =========================================================================
  test('(11) @phase-cross-track-drag overlap clamp: UI drag onto occupied V1 lane clamps A so it does not overlap X', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // V0 — clip A at 0..durationMs.
    const idA = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const v1Id = await addSecondVideoTrack()
    await tick()

    // V1 — clip X at 1000..1000+durationMs (overlaps A if A stays at 0).
    const idX = await addVideoClipOnTrack(mediaId, durationMs, v1Id, 1000)
    await tick()

    // Confirm setup.
    const clipX = await findClip(idX)
    expect(clipX!.trackId).toBe(v1Id)
    expect(clipX!.startMs).toBe(1000)

    // Locate the DOM elements.
    await page.waitForSelector('[data-testid="track-lane-video"]', { timeout: 5_000 })
    const v1Lane = page.locator('[data-testid="track-lane-video"]').nth(1)
    await expect(v1Lane).toBeVisible({ timeout: 5_000 })
    const v1Rect = await v1Lane.boundingBox()
    expect(v1Rect).not.toBeNull()

    const clipABody = page.locator(`[data-testid="clip-body"][data-clip-id="${idA}"]`)
    await expect(clipABody).toBeVisible({ timeout: 5_000 })
    const clipARect = await clipABody.boundingBox()
    expect(clipARect).not.toBeNull()

    const startX = clipARect!.x + clipARect!.width / 2
    const startY = clipARect!.y + clipARect!.height / 2
    const v1CenterY = v1Rect!.y + v1Rect!.height / 2

    // Drag A down into V1. Keep A's horizontal position so it lands at the
    // same timeline position (0ms) — which would overlap X at 1000ms given a
    // 5s fixture. The clamp on mouseup must resolve the overlap.
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 8, startY)
    await page.mouse.move(startX + 8, (startY + v1CenterY) / 2)
    await page.mouse.move(startX + 8, v1CenterY)
    await page.waitForTimeout(150)
    await page.mouse.up()
    await tick()

    const afterA = await findClip(idA)
    expect(afterA).not.toBeNull()
    // A must now be on V1.
    expect(afterA!.trackId).toBe(v1Id)

    // Re-read X from the live store (its position may not have changed).
    const afterX = await findClip(idX)
    expect(afterX).not.toBeNull()

    const aStart = afterA!.startMs
    const aEnd = afterA!.endMs
    const xStart = afterX!.startMs
    const xEnd = afterX!.endMs

    // No overlap: A is entirely before X OR A is entirely after X.
    const overlap = aStart < xEnd && aEnd > xStart
    expect(overlap).toBe(false)
  })
})
