/**
 * @phase-clip-grouping — 클립 그룹/링크 (Clip Grouping / Linking) feature tests.
 *
 * Contract tested:
 *
 *  (1)  groupClips — 2 clips get same non-empty groupId; single-clip call returns null.
 *  (2)  Select one selects all — selectClip on a grouped clip selects ALL group members.
 *  (3)  Move one moves all — moveClipGroup shifts all members by the same delta.
 *  (4)  Move clamp — negative target clamps earliest member to 0; delta kept cohesive.
 *  (5)  Delete one deletes all — removeClip on a grouped clip removes ALL members.
 *  (6)  Ungroup — ungroupClips clears groupId; subsequent select/move affects only the
 *       single clip.
 *  (7)  detachAudio auto-links — detachAudio links source + detached audio in same group;
 *       removeClip(source) deletes both.
 *  (8)  duplicate strips group — duplicateClip of a grouped clip has groupId=undefined.
 *  (9)  split keeps group — splitClipAt on a grouped clip leaves both halves grouped.
 * (10)  BYTE-IDENTICAL export — groupId never affects the filterGraph (identical to
 *       ungrouped baseline).
 * (11)  Undo — groupClips, moveClipGroup, removeClip(group) each undo in one step.
 * (12)  UI — context menu shows menu-group/menu-ungroup; clip body has data-group-id +
 *       clip-group-badge.
 */

import { expect, test } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Type bridges (mirrored from shared/project.ts)
// ---------------------------------------------------------------------------
type Track = {
  id: string
  kind: string
  role?: string
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
  isMuted?: boolean
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
      newId: () => string
      // Group actions
      groupClips: (clipIds: string[]) => string | null
      ungroupClips: (groupIdOrClipId: string) => void
      moveClipGroup: (clipId: string, desiredStartMs: number) => void
      // Existing clip actions
      removeClip: (clipId: string) => void
      removeCaption?: (clipId: string) => void
      removeOverlay?: (clipId: string) => void
      detachAudio: (clipId: string) => string | null
      duplicateClip: (clipId: string) => string | null
      // splitClipAt returns the NEW right-side clip id (left half keeps the original id).
      splitClipAt: (clipId: string, atMs: number) => string | null
      selectClip: (clipId: string) => void
    }
    __reelsUndoRedo: {
      getState: () => {
        undo: () => void
        redo: () => void
        pastStates: unknown[]
        futureStates: unknown[]
      }
    }
    __TIMELINE_UI_FOR_TEST__: {
      getState: () => {
        selectedClipIds: Set<string>
        setPlayheadMs: (ms: number) => void
        clearSelection: () => void
        toggleClipSelected: (clipId: string) => void
      }
    }
    __reelsTimelineUi: {
      getState: () => { setPlayheadMs: (ms: number) => void }
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-clip-grouping clip grouping / linking contract', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    // Small guard so a previous process's debug port fully releases.
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

  /** Add a media clip on the first video track and return its clip id. */
  async function addVideoClip(mediaId: string, durationMs: number, startMs = 0): Promise<string> {
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

  /** Return all clips from all tracks. */
  async function getAllClips(): Promise<Clip[]> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(() => {
      const clips: Clip[] = []
      for (const t of window.__reelsStore.state().project.tracks)
        for (const c of t.clips) clips.push(c as Clip)
      return clips
    }) as Promise<Clip[]>
  }

  async function getSelectedClipIds(): Promise<string[]> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(() => {
      // selectedClipIds is a Set<string>; convert to array before returning
      // across the playwright bridge (Sets serialize as {} otherwise).
      return [...window.__TIMELINE_UI_FOR_TEST__.getState().selectedClipIds]
    })
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

  /** Wait long enough for zundo's throttle window to close. */
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
  // (1) groupClips — basic grouping contract
  // =========================================================================
  test('(1) @phase-clip-grouping groupClips assigns same non-empty groupId to both clips; returns that id; single-clip call returns null', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    // Group both clips.
    const groupId = await page.evaluate(
      ([a, b]) => window.__reelsStore.groupClips([a, b]),
      [idA, idB]
    )
    await tick()

    expect(groupId).not.toBeNull()
    expect(typeof groupId).toBe('string')
    expect((groupId as string).length).toBeGreaterThan(0)

    const clipA = await findClip(idA)
    const clipB = await findClip(idB)
    expect(clipA?.groupId).toBe(groupId)
    expect(clipB?.groupId).toBe(groupId)
    // Both clips must carry the same non-empty groupId.
    expect(clipA?.groupId).toBe(clipB?.groupId)

    // Single-clip call must return null and leave state unchanged.
    const before = await getAllClips()
    const nullResult = await page.evaluate(
      ([a]) => window.__reelsStore.groupClips([a]),
      [idA]
    )
    await tick()
    expect(nullResult).toBeNull()

    const after = await getAllClips()
    // No mutation: total clip count unchanged.
    expect(after.length).toBe(before.length)
    // GroupId of clipA unchanged.
    const clipAAfter = await findClip(idA)
    expect(clipAAfter?.groupId).toBe(groupId)
  })

  // =========================================================================
  // (2) Select one selects all
  // =========================================================================
  test('(2) @phase-clip-grouping selectClip on a grouped clip selects ALL group members', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    await page.evaluate(([a, b]) => window.__reelsStore.groupClips([a, b]), [idA, idB])
    await tick()

    // Clear selection, then select only clip A.
    await page.evaluate(() => {
      window.__TIMELINE_UI_FOR_TEST__.getState().clearSelection()
    })
    await page.waitForTimeout(100)

    await page.evaluate((a) => window.__reelsStore.selectClip(a), idA)
    await page.waitForTimeout(150)

    const selected = await getSelectedClipIds()
    expect(selected).toContain(idA)
    expect(selected).toContain(idB)
  })

  // =========================================================================
  // (3) Move one moves all
  // =========================================================================
  test('(3) @phase-clip-grouping moveClipGroup shifts all group members by the same delta', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    // Place clips at 0 and 2000ms so both have room to shift.
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    await page.evaluate(([a, b]) => window.__reelsStore.groupClips([a, b]), [idA, idB])
    await tick()

    const beforeA = await findClip(idA)
    const beforeB = await findClip(idB)
    if (!beforeA || !beforeB) throw new Error('clips missing before move')

    const delta = 1000
    const desiredStart = beforeA.startMs + delta

    await page.evaluate(
      ({ a, d }) => window.__reelsStore.moveClipGroup(a, d),
      { a: idA, d: desiredStart }
    )
    await tick()

    const afterA = await findClip(idA)
    const afterB = await findClip(idB)
    if (!afterA || !afterB) throw new Error('clips missing after move')

    // Both startMs and endMs shift by the same delta.
    expect(afterA.startMs).toBe(beforeA.startMs + delta)
    expect(afterA.endMs).toBe(beforeA.endMs + delta)
    expect(afterB.startMs).toBe(beforeB.startMs + delta)
    expect(afterB.endMs).toBe(beforeB.endMs + delta)

    // Track assignments must be unchanged.
    expect(afterA.trackId).toBe(beforeA.trackId)
    expect(afterB.trackId).toBe(beforeB.trackId)

    // Clip widths (duration) must be preserved.
    expect(afterA.endMs - afterA.startMs).toBe(beforeA.endMs - beforeA.startMs)
    expect(afterB.endMs - afterB.startMs).toBe(beforeB.endMs - beforeB.startMs)
  })

  // =========================================================================
  // (4) Move clamp — negative target clamps earliest member to 0
  // =========================================================================
  test('(4) @phase-clip-grouping moveClipGroup clamps so earliest member startMs >= 0; group stays cohesive', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    // idA starts at 0, idB starts at durationMs.
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    await page.evaluate(([a, b]) => window.__reelsStore.groupClips([a, b]), [idA, idB])
    await tick()

    const beforeA = await findClip(idA)
    const beforeB = await findClip(idB)
    if (!beforeA || !beforeB) throw new Error('clips missing before clamp move')

    // Request a move that would put idA at -2000 (negative → clamped to 0).
    const negativeTarget = -2000
    await page.evaluate(
      ({ a, d }) => window.__reelsStore.moveClipGroup(a, d),
      { a: idA, d: negativeTarget }
    )
    await tick()

    const afterA = await findClip(idA)
    const afterB = await findClip(idB)
    if (!afterA || !afterB) throw new Error('clips missing after clamp move')

    // The earliest member must be clamped at 0.
    expect(afterA.startMs).toBeGreaterThanOrEqual(0)

    // The gap between A and B must be exactly preserved (cohesion).
    const gapBefore = beforeB.startMs - beforeA.startMs
    const gapAfter = afterB.startMs - afterA.startMs
    expect(gapAfter).toBe(gapBefore)

    // B must also be >= 0 (as a consequence of the gap preservation).
    expect(afterB.startMs).toBeGreaterThanOrEqual(0)
  })

  // =========================================================================
  // (5) Delete one deletes all
  // =========================================================================
  test('(5) @phase-clip-grouping removeClip on a grouped clip removes ALL group members', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    await page.evaluate(([a, b]) => window.__reelsStore.groupClips([a, b]), [idA, idB])
    await tick()

    // Remove only clip A — B must also disappear.
    await page.evaluate((a) => window.__reelsStore.removeClip(a), idA)
    await tick()

    const clipA = await findClip(idA)
    const clipB = await findClip(idB)
    expect(clipA).toBeNull()
    expect(clipB).toBeNull()
  })

  // =========================================================================
  // (6) Ungroup
  // =========================================================================
  test('(6) @phase-clip-grouping ungroupClips clears groupId on all members; subsequent operations affect only one clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    await page.evaluate(([a, b]) => window.__reelsStore.groupClips([a, b]), [idA, idB])
    await tick()

    // Ungroup using clip A's id (may also accept groupId — pass clipId per contract).
    await page.evaluate((a) => window.__reelsStore.ungroupClips(a), idA)
    await tick()

    const clipA = await findClip(idA)
    const clipB = await findClip(idB)
    expect(clipA?.groupId).toBeUndefined()
    expect(clipB?.groupId).toBeUndefined()

    // After ungrouping, selectClip(A) must NOT select B.
    await page.evaluate(() => {
      window.__TIMELINE_UI_FOR_TEST__.getState().clearSelection()
    })
    await page.evaluate((a) => window.__reelsStore.selectClip(a), idA)
    await page.waitForTimeout(150)

    const selected = await getSelectedClipIds()
    expect(selected).toContain(idA)
    expect(selected).not.toContain(idB)

    // After ungrouping, moveClipGroup (or a normal move via moveClipGroup) must
    // shift only clip A.
    const beforeA = await findClip(idA)
    const beforeB = await findClip(idB)
    if (!beforeA || !beforeB) throw new Error('clips missing before post-ungroup move')

    await page.evaluate(
      ({ a, d }) => window.__reelsStore.moveClipGroup(a, d),
      { a: idA, d: beforeA.startMs + 500 }
    )
    await tick()

    const afterA = await findClip(idA)
    const afterB = await findClip(idB)
    if (!afterA || !afterB) throw new Error('clips missing after post-ungroup move')

    // A must have moved.
    expect(afterA.startMs).not.toBe(beforeA.startMs)
    // B must be unmoved.
    expect(afterB.startMs).toBe(beforeB.startMs)
  })

  // =========================================================================
  // (7) detachAudio auto-links source + detached audio into a group
  // =========================================================================
  test('(7) @phase-clip-grouping detachAudio auto-links source + detached clip in same group; removeClip(source) deletes both', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const srcId = await addVideoClip(mediaId, durationMs, 0)
    await tick()

    const detachedId = await page.evaluate(
      (cid) => window.__reelsStore.detachAudio(cid),
      srcId
    )
    expect(detachedId).not.toBeNull()
    await tick()

    const srcClip = await findClip(srcId)
    const detachedClip = await findClip(detachedId!)
    expect(srcClip).not.toBeNull()
    expect(detachedClip).not.toBeNull()

    // Both must share the same non-empty groupId.
    expect(srcClip?.groupId).toBeTruthy()
    expect(detachedClip?.groupId).toBeTruthy()
    expect(srcClip?.groupId).toBe(detachedClip?.groupId)

    // Removing the source clip must also delete the detached audio clip.
    await page.evaluate((cid) => window.__reelsStore.removeClip(cid), srcId)
    await tick()

    expect(await findClip(srcId)).toBeNull()
    expect(await findClip(detachedId!)).toBeNull()
  })

  // =========================================================================
  // (8) duplicate strips group
  // =========================================================================
  test('(8) @phase-clip-grouping duplicateClip of a grouped clip produces a duplicate with groupId=undefined', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    const groupId = await page.evaluate(
      ([a, b]) => window.__reelsStore.groupClips([a, b]),
      [idA, idB]
    )
    await tick()
    expect(groupId).not.toBeNull()

    // Duplicate clip A.
    const dupId = await page.evaluate(
      (a) => window.__reelsStore.duplicateClip(a),
      idA
    )
    await tick()

    expect(dupId).not.toBeNull()
    const dupClip = await findClip(dupId!)
    expect(dupClip).not.toBeNull()
    // The duplicate must NOT carry the groupId.
    expect(dupClip?.groupId).toBeUndefined()
  })

  // =========================================================================
  // (9) split keeps group
  // =========================================================================
  test('(9) @phase-clip-grouping splitClipAt on a grouped clip — both halves retain the original groupId', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    // Two clips; we'll split the first one.
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    const groupId = await page.evaluate(
      ([a, b]) => window.__reelsStore.groupClips([a, b]),
      [idA, idB]
    )
    await tick()
    expect(groupId).not.toBeNull()

    // Split clip A at its midpoint.
    // splitClipAt returns the NEW right-side clip's id; the left half keeps idA.
    const splitMs = Math.floor(durationMs / 2)
    const rightId = await page.evaluate(
      ({ a, ms }) => window.__reelsStore.splitClipAt(a, ms),
      { a: idA, ms: splitMs }
    )
    await tick()

    expect(rightId).not.toBeNull()

    // The left half keeps the original clip id (idA).
    const leftClip = await findClip(idA)
    const rightClip = await findClip(rightId!)
    expect(leftClip).not.toBeNull()
    expect(rightClip).not.toBeNull()

    // Both halves must carry the original groupId.
    expect(leftClip?.groupId).toBe(groupId)
    expect(rightClip?.groupId).toBe(groupId)
  })

  // =========================================================================
  // (10) BYTE-IDENTICAL export — groupId never affects the filterGraph
  // =========================================================================
  test('(10) @phase-clip-grouping BYTE-IDENTICAL: grouped project and ungrouped baseline produce identical filterGraph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    // Capture baseline BEFORE grouping.
    const baselinePath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `group-baseline-${Date.now()}.mp4`
    )
    const baseline = await buildPlan(baselinePath)
    expect(baseline.ok, `baseline buildPlan failed: ${baseline.error ?? ''}`).toBe(true)
    const baselineGraph = baseline.filterGraph ?? ''
    expect(baselineGraph).toBeTruthy()

    // Now group the two clips.
    const groupId = await page.evaluate(
      ([a, b]) => window.__reelsStore.groupClips([a, b]),
      [idA, idB]
    )
    await tick()
    expect(groupId).not.toBeNull()

    // buildPlan with groupId set must produce identical graph.
    const groupedPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `group-grouped-${Date.now()}.mp4`
    )
    const grouped = await buildPlan(groupedPath)
    expect(grouped.ok, `grouped buildPlan failed: ${grouped.error ?? ''}`).toBe(true)
    const groupedGraph = grouped.filterGraph ?? ''

    // BYTE-IDENTICAL GATE.
    expect(groupedGraph).toBe(baselineGraph)
  })

  // =========================================================================
  // (11) Undo — groupClips, moveClipGroup, removeClip(group) each undo in one step
  // =========================================================================
  test('(11a) @phase-clip-grouping undo: groupClips → undo clears groupId in one step', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    const beforeHistory = await getHistoryCounts()

    const groupId = await page.evaluate(
      ([a, b]) => window.__reelsStore.groupClips([a, b]),
      [idA, idB]
    )
    await tick()
    expect(groupId).not.toBeNull()

    const afterGroup = await getHistoryCounts()
    expect(afterGroup.past).toBe(beforeHistory.past + 1)

    // Confirm grouping is in place.
    expect((await findClip(idA))?.groupId).toBe(groupId)
    expect((await findClip(idB))?.groupId).toBe(groupId)

    // Undo once.
    await undo()

    const afterUndo = await getHistoryCounts()
    expect(afterUndo.past).toBe(beforeHistory.past)

    // GroupId must be cleared on both clips.
    const clipAAfterUndo = await findClip(idA)
    const clipBAfterUndo = await findClip(idB)
    expect(clipAAfterUndo?.groupId).toBeUndefined()
    expect(clipBAfterUndo?.groupId).toBeUndefined()
  })

  test('(11b) @phase-clip-grouping undo: moveClipGroup → undo restores all members in one step', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    await page.evaluate(([a, b]) => window.__reelsStore.groupClips([a, b]), [idA, idB])
    await tick()

    const beforeMoveA = await findClip(idA)
    const beforeMoveB = await findClip(idB)
    if (!beforeMoveA || !beforeMoveB) throw new Error('clips missing before move')

    const beforeMoveHistory = await getHistoryCounts()

    await page.evaluate(
      ({ a, d }) => window.__reelsStore.moveClipGroup(a, d),
      { a: idA, d: beforeMoveA.startMs + 1000 }
    )
    await tick()

    const afterMoveHistory = await getHistoryCounts()
    expect(afterMoveHistory.past).toBe(beforeMoveHistory.past + 1)

    // Undo the move.
    await undo()

    const afterUndoA = await findClip(idA)
    const afterUndoB = await findClip(idB)
    if (!afterUndoA || !afterUndoB) throw new Error('clips missing after undo')

    // Both clips must be back to their pre-move positions.
    expect(afterUndoA.startMs).toBe(beforeMoveA.startMs)
    expect(afterUndoB.startMs).toBe(beforeMoveB.startMs)
  })

  test('(11c) @phase-clip-grouping undo: removeClip(grouped) → undo restores all members in one step', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    await page.evaluate(([a, b]) => window.__reelsStore.groupClips([a, b]), [idA, idB])
    await tick()

    const beforeRemoveHistory = await getHistoryCounts()

    // Remove clip A (should delete both).
    await page.evaluate((a) => window.__reelsStore.removeClip(a), idA)
    await tick()

    expect(await findClip(idA)).toBeNull()
    expect(await findClip(idB)).toBeNull()

    const afterRemoveHistory = await getHistoryCounts()
    expect(afterRemoveHistory.past).toBe(beforeRemoveHistory.past + 1)

    // Undo the removal — both clips must be restored.
    await undo()

    const restoredA = await findClip(idA)
    const restoredB = await findClip(idB)
    expect(restoredA).not.toBeNull()
    expect(restoredB).not.toBeNull()
    // GroupId must be restored too.
    expect(restoredA?.groupId).toBe(restoredB?.groupId)
    expect(restoredA?.groupId).toBeTruthy()
  })

  // =========================================================================
  // (12) UI — context menu group/ungroup; clip body data-group-id + badge
  // =========================================================================
  test('(12a) @phase-clip-grouping UI: context menu shows menu-group row; menu-ungroup enabled on grouped clip, disabled on ungrouped', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    const clipBlockA = page.locator(
      `[data-testid="media-clip-block"][data-clip-id="${idA}"]`
    )
    await expect(clipBlockA).toBeVisible({ timeout: 5_000 })

    // --- Ungrouped clip: right-click → menu-group row must exist; menu-ungroup must be disabled ---
    await clipBlockA.click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible({
      timeout: 3_000
    })

    // menu-group row must exist (always rendered, even when disabled).
    const groupRow = page.locator('[data-testid="menu-group"]')
    await expect(groupRow).toBeVisible()

    // menu-ungroup must be disabled for an ungrouped clip.
    const ungroupRowBefore = page.locator('[data-testid="menu-ungroup"]')
    await expect(ungroupRowBefore).toBeVisible()
    const ungroupAriaDisabledBefore = await ungroupRowBefore.getAttribute('aria-disabled')
    expect(ungroupAriaDisabledBefore).toBe('true')

    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="clip-context-menu"]')).toHaveCount(0)

    // --- Group the clips; right-click grouped clip → menu-ungroup must be ENABLED ---
    await page.evaluate(([a, b]) => window.__reelsStore.groupClips([a, b]), [idA, idB])
    await tick()

    // Right-clicking a grouped clip triggers handleContext → handleSelect(clipA)
    // → selectClip(clipA) which, because clipA has a groupId, expands to select
    // ALL group members. The Timeline's `grouped` computed value reads from the
    // ctx clip's groupId, so menu-ungroup must now be enabled.
    await clipBlockA.click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible({
      timeout: 3_000
    })

    const ungroupRow = page.locator('[data-testid="menu-ungroup"]')
    await expect(ungroupRow).toBeVisible()
    const ungroupAriaDisabled = await ungroupRow.getAttribute('aria-disabled')
    // Clip is now grouped — menu-ungroup must NOT be disabled.
    expect(ungroupAriaDisabled).not.toBe('true')

    await page.keyboard.press('Escape')
  })

  test('(12b) @phase-clip-grouping UI: grouped clip body has data-group-id attribute and clip-group-badge is visible', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const idA = await addVideoClip(mediaId, durationMs, 0)
    const idB = await addVideoClip(mediaId, durationMs, durationMs)
    await tick()

    const groupId = await page.evaluate(
      ([a, b]) => window.__reelsStore.groupClips([a, b]),
      [idA, idB]
    )
    await tick()
    expect(groupId).not.toBeNull()

    // Wait for the DOM to reflect the group update.
    const clipBodyA = page.locator(
      `[data-testid="clip-body"][data-clip-id="${idA}"]`
    )
    await expect(clipBodyA).toBeVisible({ timeout: 5_000 })

    // data-group-id must be set to the groupId on the clip body.
    await expect(clipBodyA).toHaveAttribute('data-group-id', groupId as string, { timeout: 4_000 })

    // The clip-group-badge must be visible inside the grouped clip body.
    const badge = page.locator(
      `[data-testid="clip-body"][data-clip-id="${idA}"] [data-testid="clip-group-badge"]`
    )
    await expect(badge).toBeVisible({ timeout: 4_000 })
  })
})
