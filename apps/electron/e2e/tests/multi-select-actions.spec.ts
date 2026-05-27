/**
 * Reels 11 슬라이드 8 — drag 다중 선택 후 이동/우클릭/DEL 일괄 적용.
 *
 * Contract tested:
 *  (1) moveClipsByDelta — 멤버 전부에 동일 delta 적용 (anchor 기준).
 *  (2) moveClipsByDelta — locked 멤버 1개라도 있으면 전체 거부 (no-op).
 *  (3) moveClipsByDelta — earliest member 가 0 아래로 못 내려감 (delta floor).
 *  (4) moveClipsByDelta — 트랙 내 non-member 와 겹침 금지 (per-member clamp).
 *  (5) DEL 키 — 선택된 모든 클립 일괄 삭제 (locked 멤버는 skip).
 *
 * @reels-11-slide-8-multi-select
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type Track = {
  id: string
  kind: 'video' | 'audio' | 'caption' | 'overlay'
  clips: Clip[]
}
type Clip = {
  id: string
  startMs: number
  endMs: number
  locked?: boolean
  [key: string]: unknown
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: { tracks: Track[] }
        createNew: () => void
      }
    }
    __reelsStore: {
      state: () => { project: { tracks: Track[] } }
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
      moveClipsByDelta: (
        clipIds: string[],
        anchorId: string,
        desiredStartMs: number
      ) => void
      setClipLocked: (clipId: string, locked: boolean) => void
      removeClip: (id: string) => void
    }
    __reelsTimelineUi: {
      setState: (s: {
        selectedClipIds: Set<string>
        selectedAdjustmentLayerId: null
      }) => void
      getState: () => { selectedClipIds: Set<string> }
    }
  }
}

test.describe('@reels-11-slide-8-multi-select drag 다중 선택 일괄 동작', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 400))
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
    })
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
      await new Promise((r) => setTimeout(r, 700))
    })
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(() => !!window.__reelsStore, null, {
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

  async function seedTwoClips(): Promise<{
    id1: string
    id2: string
    mediaId: string
  }> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const reels = window.__reelsStore
      const track = reels.state().project.tracks.find((t) => t.kind === 'video')
      if (!track) throw new Error('no video track')
      const mediaId = reels.newId()
      reels.addMedia({
        id: mediaId,
        path: '/fake/seed.mp4',
        kind: 'video',
        durationMs: 5000,
        width: 1920,
        height: 1080,
        codec: 'h264',
        importedAt: Date.now(),
        fileName: 'seed.mp4',
        fileSizeBytes: 0
      })
      const id1 = reels.newId()
      reels.addClip({
        id: id1,
        kind: 'media',
        mediaId,
        trackId: track.id,
        startMs: 1000,
        endMs: 2000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      const id2 = reels.newId()
      reels.addClip({
        id: id2,
        kind: 'media',
        mediaId,
        trackId: track.id,
        startMs: 3000,
        endMs: 4000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      return { id1, id2, mediaId }
    })
  }

  test('A-1 멤버 전부에 동일 delta 적용', async () => {
    const { page } = launched!
    const { id1, id2 } = await seedTwoClips()
    // anchor=id1: 1000 → 1500 (delta +500). id2 도 +500 (3000 → 3500).
    await page.evaluate(
      ({ a, b }) => {
        window.__reelsStore.moveClipsByDelta([a, b], a, 1500)
      },
      { a: id1, b: id2 }
    )
    const result = await page.evaluate(({ a, b }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      const c1 = clips.find((c) => c.id === a)!
      const c2 = clips.find((c) => c.id === b)!
      return { c1Start: c1.startMs, c2Start: c2.startMs }
    }, { a: id1, b: id2 })
    expect(result.c1Start).toBe(1500)
    expect(result.c2Start).toBe(3500)
  })

  test('A-2 locked 멤버 있으면 전체 거부 (no-op)', async () => {
    const { page } = launched!
    const { id1, id2 } = await seedTwoClips()
    await page.evaluate(
      ({ a, b }) => {
        window.__reelsStore.setClipLocked(b, true)
        window.__reelsStore.moveClipsByDelta([a, b], a, 1500)
      },
      { a: id1, b: id2 }
    )
    const result = await page.evaluate(({ a, b }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      const c1 = clips.find((c) => c.id === a)!
      const c2 = clips.find((c) => c.id === b)!
      return { c1Start: c1.startMs, c2Start: c2.startMs }
    }, { a: id1, b: id2 })
    expect(result.c1Start).toBe(1000)
    expect(result.c2Start).toBe(3000)
  })

  test('A-3 earliest 멤버 0 아래 슬라이드 floor', async () => {
    const { page } = launched!
    const { id1, id2 } = await seedTwoClips()
    // anchor=id1: 1000 → -2000 (delta -3000). earliest=1000 → delta floor=-1000.
    // id1 → 0, id2 → 2000.
    await page.evaluate(
      ({ a, b }) => {
        window.__reelsStore.moveClipsByDelta([a, b], a, -2000)
      },
      { a: id1, b: id2 }
    )
    const result = await page.evaluate(({ a, b }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      const c1 = clips.find((c) => c.id === a)!
      const c2 = clips.find((c) => c.id === b)!
      return { c1Start: c1.startMs, c2Start: c2.startMs }
    }, { a: id1, b: id2 })
    expect(result.c1Start).toBe(0)
    expect(result.c2Start).toBe(2000)
  })

  test('A-4 non-member 와 겹치지 않게 per-member clamp', async () => {
    const { page } = launched!
    const { id1, id2, mediaId } = await seedTwoClips()
    // 같은 트랙에 5000~6000 에 non-member 클립 추가.
    const id3 = await page.evaluate((mid) => {
      const reels = window.__reelsStore
      const track = reels.state().project.tracks.find((t) => t.kind === 'video')!
      const newId = reels.newId()
      reels.addClip({
        id: newId,
        kind: 'media',
        mediaId: mid,
        trackId: track.id,
        startMs: 5000,
        endMs: 6000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      return newId
    }, mediaId)
    // anchor=id1: 1000 → 10000 (delta +9000). id2(end=4000) → 13000 would overlap
    // nothing, but the clamp logic uses the most restrictive bound = id3.startMs.
    // id2.duration=1000, id2 max start so end<=5000 → id2 max start=4000.
    // member-id2 delta max = 4000-3000 = 1000. So delta clamps to 1000.
    // id1 → 2000, id2 → 4000.
    await page.evaluate(
      ({ a, b }) => {
        window.__reelsStore.moveClipsByDelta([a, b], a, 10000)
      },
      { a: id1, b: id2 }
    )
    const result = await page.evaluate(({ a, b, cId }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      const c1 = clips.find((cc) => cc.id === a)
      const c2 = clips.find((cc) => cc.id === b)
      const c3 = clips.find((cc) => cc.id === cId)
      return {
        c1Start: c1?.startMs ?? null,
        c2Start: c2?.startMs ?? null,
        c3Start: c3?.startMs ?? null
      }
    }, { a: id1, b: id2, cId: id3 })
    expect(result.c1Start).toBe(2000)
    expect(result.c2Start).toBe(4000)
    expect(result.c3Start).toBe(5000)
  })

  test('A-5 DEL 키 다중 선택 일괄 삭제', async () => {
    const { page } = launched!
    const { id1, id2 } = await seedTwoClips()
    // 두 클립 선택.
    await page.evaluate(
      ({ a, b }) => {
        window.__reelsTimelineUi.setState({
          selectedClipIds: new Set([a, b]),
          selectedAdjustmentLayerId: null
        })
      },
      { a: id1, b: id2 }
    )
    // 빈 영역 focus 한 뒤 DEL 키 발사 (focus 가 input 이면 무시되니 body 에 둠).
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="editor-page"]') as HTMLElement
      el?.focus()
    })
    await page.keyboard.press('Delete')
    await page.waitForTimeout(150)
    const remaining = await page.evaluate(() => {
      return window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
        .map((c) => c.id)
    })
    expect(remaining).not.toContain(id1)
    expect(remaining).not.toContain(id2)
  })
})
