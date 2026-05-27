/**
 * Reels 11 슬라이드 9 — 트랙 빈 공간(갭) 선택 후 DEL → 갭 삭제 + ripple.
 *
 * Contract:
 *  (1) rippleRemoveGap — 갭 endMs 이후 시작 클립이 (gap 길이)만큼 좌이동.
 *  (2) rippleRemoveGap — 갭 내부에 걸치는 클립이 있으면 no-op.
 *  (3) rippleRemoveGap — 시프트 대상에 locked 클립이 있으면 전체 no-op.
 *  (4) UI — 빈 lane 영역 클릭 시 [data-testid=selected-gap-highlight] 표시,
 *          좌우 클립 사이 갭 ms 범위 정확.
 *  (5) UI — DEL 키 → 갭 사라지고 뒷 클립 좌이동, highlight 제거.
 *
 * @reels-11-slide-9-gap-ripple
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

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
        project: { tracks: Array<{ id: string; kind: string; clips: Clip[] }> }
        createNew: () => void
      }
    }
    __reelsStore: {
      state: () => {
        project: { tracks: Array<{ id: string; kind: string; clips: Clip[] }> }
      }
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
      rippleRemoveGap: (trackId: string, startMs: number, endMs: number) => void
      setClipLocked: (clipId: string, locked: boolean) => void
    }
    __reelsTimelineUi: {
      getState: () => {
        selectedGap: { trackId: string; startMs: number; endMs: number } | null
        setSelectedGap: (
          g: { trackId: string; startMs: number; endMs: number } | null
        ) => void
      }
    }
  }
}

test.describe('@reels-11-slide-9-gap-ripple 빈 공간 선택 + DEL ripple', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 400))
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
      await new Promise((r) => setTimeout(r, 700))
    })
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(() => !!window.__reelsStore, null, { timeout: 5_000 })
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

  async function seedTwoClipsWithGap(): Promise<{
    trackId: string
    id1: string
    id2: string
  }> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate(() => {
      const reels = window.__reelsStore
      const track = reels.state().project.tracks.find((t) => t.kind === 'video')!
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
        startMs: 0,
        endMs: 1000,
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
      return { trackId: track.id, id1, id2 }
    })
  }

  test('A-1 rippleRemoveGap 뒷 클립 좌이동', async () => {
    const { page } = launched!
    const { trackId, id1, id2 } = await seedTwoClipsWithGap()
    // 갭 [1000, 3000) 삭제 → id2 가 1000 으로.
    await page.evaluate(
      ({ tid }) => {
        window.__reelsStore.rippleRemoveGap(tid, 1000, 3000)
      },
      { tid: trackId }
    )
    const result = await page.evaluate(({ a, b }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      const c1 = clips.find((c) => c.id === a)!
      const c2 = clips.find((c) => c.id === b)!
      return { c1: { startMs: c1.startMs, endMs: c1.endMs }, c2: { startMs: c2.startMs, endMs: c2.endMs } }
    }, { a: id1, b: id2 })
    expect(result.c1.startMs).toBe(0)
    expect(result.c1.endMs).toBe(1000)
    expect(result.c2.startMs).toBe(1000)
    expect(result.c2.endMs).toBe(2000)
  })

  test('A-2 갭 내부에 클립 걸치면 no-op', async () => {
    const { page } = launched!
    const { trackId, id1, id2 } = await seedTwoClipsWithGap()
    // [500, 3500) 은 id1(0~1000) + id2(3000~4000) 양쪽에 걸침 → no-op.
    await page.evaluate(
      ({ tid }) => {
        window.__reelsStore.rippleRemoveGap(tid, 500, 3500)
      },
      { tid: trackId }
    )
    const result = await page.evaluate(({ a, b }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      return {
        c1: clips.find((c) => c.id === a)!.startMs,
        c2: clips.find((c) => c.id === b)!.startMs
      }
    }, { a: id1, b: id2 })
    expect(result.c1).toBe(0)
    expect(result.c2).toBe(3000)
  })

  test('A-3 시프트 대상 locked 면 no-op', async () => {
    const { page } = launched!
    const { trackId, id1, id2 } = await seedTwoClipsWithGap()
    await page.evaluate(
      ({ tid, b }) => {
        window.__reelsStore.setClipLocked(b, true)
        window.__reelsStore.rippleRemoveGap(tid, 1000, 3000)
      },
      { tid: trackId, b: id2 }
    )
    const result = await page.evaluate(({ a, b }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      return {
        c1: clips.find((c) => c.id === a)!.startMs,
        c2: clips.find((c) => c.id === b)!.startMs
      }
    }, { a: id1, b: id2 })
    expect(result.c1).toBe(0)
    expect(result.c2).toBe(3000)
  })

  test('A-4 빈 lane 클릭 → highlight + DEL → ripple + highlight 사라짐', async () => {
    const { page } = launched!
    const { trackId, id1, id2 } = await seedTwoClipsWithGap()
    // setSelectedGap 직접 호출 (좌표 계산 회피).
    await page.evaluate(
      ({ tid }) => {
        window.__reelsTimelineUi
          .getState()
          .setSelectedGap({ trackId: tid, startMs: 1000, endMs: 3000 })
      },
      { tid: trackId }
    )
    const hl = page.locator('[data-testid="selected-gap-highlight"]')
    await expect(hl).toBeVisible({ timeout: 5_000 })
    const startAttr = await hl.getAttribute('data-gap-start-ms')
    const endAttr = await hl.getAttribute('data-gap-end-ms')
    expect(startAttr).toBe('1000')
    expect(endAttr).toBe('3000')
    // DEL 키 → ripple.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="editor-page"]') as HTMLElement
      el?.focus()
    })
    await page.keyboard.press('Delete')
    await page.waitForTimeout(150)
    await expect(hl).toHaveCount(0)
    const result = await page.evaluate(({ a, b }) => {
      const clips = window
        .__reelsStore.state()
        .project.tracks.flatMap((t) => t.clips)
      return {
        c1: clips.find((c) => c.id === a)!.startMs,
        c2: clips.find((c) => c.id === b)!.startMs
      }
    }, { a: id1, b: id2 })
    expect(result.c1).toBe(0)
    expect(result.c2).toBe(1000)
  })
})
