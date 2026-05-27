/**
 * Reels 11 슬라이드 11 — 비디오/오디오 트랙 cross-kind drop 방지.
 *
 * Contract:
 *  (1) addClip — audio media → video track: reject (track 에 안 들어감).
 *  (2) addClip — video media → audio track: reject.
 *  (3) addClip — image media → audio track: reject.
 *  (4) addClip — audio media → audio track: 정상 추가.
 *  (5) addClip — video media → video track: 정상 추가.
 *  (6) moveClipToTrack — video media clip 을 audio 트랙으로 이동: no-op (trackId 보존).
 *  (7) moveClipToTrack — audio media clip 을 video 트랙으로 이동: no-op.
 *
 * @reels-11-slide-11-track-kind-guard
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type Track = {
  id: string
  kind: 'video' | 'audio' | 'caption' | 'overlay'
  clips: Array<{ id: string; mediaId?: string; trackId: string }>
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: {
          tracks: Track[]
          media: Record<string, { id: string; kind: string }>
        }
        createNew: () => void
      }
    }
    __reelsStore: {
      state: () => {
        project: {
          tracks: Track[]
          media: Record<string, { id: string; kind: string }>
        }
      }
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      moveClipToTrack: (id: string, newTrackId: string) => void
      newId: () => string
    }
  }
}

test.describe('@reels-11-slide-11-track-kind-guard 트랙 종류 가드', () => {
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

  async function seedMedia(
    kind: 'video' | 'audio' | 'image'
  ): Promise<string> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate((k) => {
      const reels = window.__reelsStore
      const id = reels.newId()
      reels.addMedia({
        id,
        path: `/fake/${k}.bin`,
        kind: k,
        durationMs: k === 'image' ? 3000 : 2000,
        width: 1920,
        height: 1080,
        codec: k === 'audio' ? 'aac' : 'h264',
        importedAt: Date.now(),
        fileName: `${k}.bin`,
        fileSizeBytes: 0
      })
      return id
    }, kind)
  }

  test('A-1 audio → video 트랙 addClip reject', async () => {
    const { page } = launched!
    const mediaId = await seedMedia('audio')
    const result = await page.evaluate((mid) => {
      const reels = window.__reelsStore
      const videoTrack = reels.state().project.tracks.find((t) => t.kind === 'video')!
      const newClipId = reels.newId()
      reels.addClip({
        id: newClipId,
        kind: 'media',
        mediaId: mid,
        trackId: videoTrack.id,
        startMs: 0,
        endMs: 1000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      const after = reels
        .state()
        .project.tracks.find((t) => t.kind === 'video')!.clips
        .map((c) => c.id)
      return { newClipId, contains: after.includes(newClipId) }
    }, mediaId)
    expect(result.contains).toBe(false)
  })

  test('A-2 video → audio 트랙 addClip reject', async () => {
    const { page } = launched!
    const mediaId = await seedMedia('video')
    const result = await page.evaluate((mid) => {
      const reels = window.__reelsStore
      const audioTrack = reels.state().project.tracks.find((t) => t.kind === 'audio')!
      const newClipId = reels.newId()
      reels.addClip({
        id: newClipId,
        kind: 'media',
        mediaId: mid,
        trackId: audioTrack.id,
        startMs: 0,
        endMs: 1000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      const audio = reels.state().project.tracks.find((t) => t.kind === 'audio')!
      return audio.clips.map((c) => c.id).includes(newClipId)
    }, mediaId)
    expect(result).toBe(false)
  })

  test('A-3 image → audio 트랙 addClip reject', async () => {
    const { page } = launched!
    const mediaId = await seedMedia('image')
    const result = await page.evaluate((mid) => {
      const reels = window.__reelsStore
      const audioTrack = reels.state().project.tracks.find((t) => t.kind === 'audio')!
      const newClipId = reels.newId()
      reels.addClip({
        id: newClipId,
        kind: 'media',
        mediaId: mid,
        trackId: audioTrack.id,
        startMs: 0,
        endMs: 1000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      return reels
        .state()
        .project.tracks.find((t) => t.kind === 'audio')!.clips
        .map((c) => c.id)
        .includes(newClipId)
    }, mediaId)
    expect(result).toBe(false)
  })

  test('A-4 audio → audio 트랙 정상 추가', async () => {
    const { page } = launched!
    const mediaId = await seedMedia('audio')
    const result = await page.evaluate((mid) => {
      const reels = window.__reelsStore
      const audioTrack = reels.state().project.tracks.find((t) => t.kind === 'audio')!
      const newClipId = reels.newId()
      reels.addClip({
        id: newClipId,
        kind: 'media',
        mediaId: mid,
        trackId: audioTrack.id,
        startMs: 0,
        endMs: 1000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      return reels
        .state()
        .project.tracks.find((t) => t.kind === 'audio')!.clips
        .map((c) => c.id)
        .includes(newClipId)
    }, mediaId)
    expect(result).toBe(true)
  })

  test('A-5 video → video 트랙 정상 추가', async () => {
    const { page } = launched!
    const mediaId = await seedMedia('video')
    const result = await page.evaluate((mid) => {
      const reels = window.__reelsStore
      const videoTrack = reels.state().project.tracks.find((t) => t.kind === 'video')!
      const newClipId = reels.newId()
      reels.addClip({
        id: newClipId,
        kind: 'media',
        mediaId: mid,
        trackId: videoTrack.id,
        startMs: 0,
        endMs: 1000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      return reels
        .state()
        .project.tracks.find((t) => t.kind === 'video')!.clips
        .map((c) => c.id)
        .includes(newClipId)
    }, mediaId)
    expect(result).toBe(true)
  })

  test('A-6 video clip → audio 트랙 moveClipToTrack no-op', async () => {
    const { page } = launched!
    const mediaId = await seedMedia('video')
    const setup = await page.evaluate((mid) => {
      const reels = window.__reelsStore
      const videoTrack = reels.state().project.tracks.find((t) => t.kind === 'video')!
      const audioTrack = reels.state().project.tracks.find((t) => t.kind === 'audio')!
      const clipId = reels.newId()
      reels.addClip({
        id: clipId,
        kind: 'media',
        mediaId: mid,
        trackId: videoTrack.id,
        startMs: 0,
        endMs: 1000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      return { clipId, videoTrackId: videoTrack.id, audioTrackId: audioTrack.id }
    }, mediaId)
    await page.evaluate(({ id, atid }) => {
      window.__reelsStore.moveClipToTrack(id, atid)
    }, { id: setup.clipId, atid: setup.audioTrackId })
    const after = await page.evaluate((cid) => {
      const tracks = window.__reelsStore.state().project.tracks
      for (const t of tracks) {
        if (t.clips.find((c) => c.id === cid)) return t.kind
      }
      return null
    }, setup.clipId)
    expect(after).toBe('video')
  })

  test('A-7 audio clip → video 트랙 moveClipToTrack no-op', async () => {
    const { page } = launched!
    const mediaId = await seedMedia('audio')
    const setup = await page.evaluate((mid) => {
      const reels = window.__reelsStore
      const audioTrack = reels.state().project.tracks.find((t) => t.kind === 'audio')!
      const videoTrack = reels.state().project.tracks.find((t) => t.kind === 'video')!
      const clipId = reels.newId()
      reels.addClip({
        id: clipId,
        kind: 'media',
        mediaId: mid,
        trackId: audioTrack.id,
        startMs: 0,
        endMs: 1000,
        trimInMs: 0,
        trimOutMs: 1000,
        speed: 1
      })
      return { clipId, audioTrackId: audioTrack.id, videoTrackId: videoTrack.id }
    }, mediaId)
    await page.evaluate(({ id, vtid }) => {
      window.__reelsStore.moveClipToTrack(id, vtid)
    }, { id: setup.clipId, vtid: setup.videoTrackId })
    const after = await page.evaluate((cid) => {
      const tracks = window.__reelsStore.state().project.tracks
      for (const t of tracks) {
        if (t.clips.find((c) => c.id === cid)) return t.kind
      }
      return null
    }, setup.clipId)
    expect(after).toBe('audio')
  })
})
