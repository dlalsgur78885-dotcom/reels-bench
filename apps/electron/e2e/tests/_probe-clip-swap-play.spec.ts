/**
 * Slide 6 / 0.2.7 verification — 두 클립 연속 시나리오에서
 * 두 번째 클립으로 swap된 직후 자동 재생되는지 확인.
 * @clip-swap-play
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@clip-swap-play', () => {
  let launched: LaunchedApp | null = null
  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', {
      state: 'attached', timeout: 45_000
    })
    await page.waitForFunction(() => !!(window as unknown as {__reelsStore?:unknown}).__reelsStore, null, { timeout: 8_000 })
  })
  test.afterEach(async () => {
    if (launched) {
      try { await launched.app.close() } catch { /* */ }
      launched = null
    }
  })

  test('두 클립 연속 + 재생 → 첫 클립 끝나면 두 번째가 자동 재생됨', async () => {
    test.setTimeout(60_000)
    const { page } = launched!
    const fixture = process.env.E2E_FIXTURE_MP4!
    // 2 clip on same Video track, back-to-back.
    await page.evaluate(async (fp: string) => {
      await window.electron.fs.allowPath(fp)
      const probe = await window.electron.media.probe(fp)
      const reels = window.__reelsStore
      const mid1 = reels.newId()
      const mid2 = reels.newId()
      // Two distinct media ids → different src → triggers src swap path.
      reels.addMedia({ id: mid1, path: fp, kind: probe.kind, durationMs: probe.durationMs,
        width: probe.width ?? 720, height: probe.height ?? 1280, codec: probe.codec,
        importedAt: Date.now(), fileName: 'a.mp4', fileSizeBytes: 0 })
      reels.addMedia({ id: mid2, path: fp, kind: probe.kind, durationMs: probe.durationMs,
        width: probe.width ?? 720, height: probe.height ?? 1280, codec: probe.codec,
        importedAt: Date.now(), fileName: 'b.mp4', fileSizeBytes: 0 })
      const t = reels.state().project.tracks.find((t) => t.kind === 'video')!
      reels.addClip({ id: reels.newId(), kind: 'media', mediaId: mid1, trackId: t.id,
        startMs: 0, endMs: 2000, trimInMs: 0, trimOutMs: 2000, speed: 1 })
      reels.addClip({ id: reels.newId(), kind: 'media', mediaId: mid2, trackId: t.id,
        startMs: 2000, endMs: 4000, trimInMs: 0, trimOutMs: 2000, speed: 1 })
    }, fixture)
    await page.waitForTimeout(800)

    // 1) Trigger a real user gesture so chromium autoplay policy passes.
    //    Without this, `v.play()` returns a rejected promise and the
    //    <video> stays paused — false-positive failure for our fix.
    await page.locator('body').click().catch(() => {})

    // 2) Drive playhead into clip 1, set playing=true, wait a few ticks.
    await page.evaluate(() => {
      const ui = (window as unknown as { __reelsTimelineUi: { getState: () => { setPlaying: (b: boolean) => void; setPlayheadMs: (n: number) => void } } }).__reelsTimelineUi
      ui.getState().setPlayheadMs(500)
      ui.getState().setPlaying(true)
    })
    await page.waitForTimeout(1500)
    const stateClip1 = await page.evaluate(() => {
      const vids = Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]'))
      return vids.map((v) => ({ paused: v.paused, src: v.src.slice(-30) }))
    })
    console.log('CLIP1_STATE', JSON.stringify(stateClip1))

    // 3) Jump to JUST AFTER clip boundary (2050ms — well inside clip 2).
    //    Critical: we KEEP playing=true. Old code (pre-0.2.7) would src-swap
    //    + load() and leave the new <video> paused. 0.2.7 fix calls play()
    //    inside the swap effect when playing===true.
    await page.evaluate(() => {
      const ui = (window as unknown as { __reelsTimelineUi: { getState: () => { setPlayheadMs: (n: number) => void } } }).__reelsTimelineUi
      ui.getState().setPlayheadMs(2050)
    })
    await page.waitForTimeout(1500)

    const status = await page.evaluate(() => {
      const vids = Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]'))
      return vids.map((v) => ({
        src: (v.src || '').slice(-40),
        paused: v.paused,
        currentTime: v.currentTime,
        readyState: v.readyState,
        ended: v.ended
      }))
    })
    console.log('CLIP2_STATE', JSON.stringify(status, null, 2))
    expect(status.length).toBeGreaterThanOrEqual(1)
    expect(status.some((v) => !v.paused)).toBe(true)
  })

  test('재생 중 preview video가 멈춰도 watchdog이 다시 재생시킴', async () => {
    test.setTimeout(60_000)
    const { page } = launched!
    const fixture = process.env.E2E_FIXTURE_MP4!

    await page.evaluate(async (fp: string) => {
      await window.electron.fs.allowPath(fp)
      const probe = await window.electron.media.probe(fp)
      const reels = window.__reelsStore
      const mediaId = reels.newId()
      reels.addMedia({
        id: mediaId,
        path: fp,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width ?? 720,
        height: probe.height ?? 1280,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName: 'watchdog.mp4',
        fileSizeBytes: 0
      })
      const track = reels.state().project.tracks.find((t) => t.kind === 'video')!
      reels.addClip({
        id: reels.newId(),
        kind: 'media',
        mediaId,
        trackId: track.id,
        startMs: 0,
        endMs: 3000,
        trimInMs: 0,
        trimOutMs: 3000,
        speed: 1
      })
    }, fixture)

    await page.locator('body').click().catch(() => {})
    await page.evaluate(() => {
      const ui = (window as unknown as {
        __reelsTimelineUi: {
          getState: () => {
            setPlaying: (b: boolean) => void
            setPlayheadMs: (n: number) => void
          }
        }
      }).__reelsTimelineUi
      ui.getState().setPlayheadMs(500)
      ui.getState().setPlaying(true)
    })

    await page.waitForFunction(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      return videos.some((v) => !v.paused && v.readyState >= 2)
    }, null, { timeout: 8_000 })

    await page.evaluate(() => {
      for (const v of document.querySelectorAll<HTMLVideoElement>(
        'video[data-preview-video-layer]'
      )) {
        v.pause()
      }
    })

    await page.waitForFunction(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      return videos.some((v) => !v.paused)
    }, null, { timeout: 4_000 })

    const recovered = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      ).map((v) => ({
        paused: v.paused,
        currentTime: v.currentTime,
        readyState: v.readyState
      }))
    )
    expect(recovered.some((v) => !v.paused)).toBe(true)
  })

  test('재생 중 변형/조정/undo 후에도 프리뷰와 오디오가 계속 진행됨', async () => {
    test.setTimeout(90_000)
    const { page } = launched!
    const videoFixture = process.env.E2E_FIXTURE_MP4
    const audioFixture = process.env.E2E_FIXTURE_MP3
    test.skip(!videoFixture || !audioFixture, 'E2E fixtures are required')

    const ids = await page.evaluate(
      async ({ videoPath, audioPath }) => {
        await window.electron.fs.allowPath(videoPath)
        await window.electron.fs.allowPath(audioPath)
        const videoProbe = await window.electron.media.probe(videoPath)
        const audioProbe = await window.electron.media.probe(audioPath)
        const reels = window.__reelsStore
        const videoId = reels.newId()
        const audioId = reels.newId()
        reels.addMedia({
          id: videoId,
          path: videoPath,
          kind: videoProbe.kind,
          durationMs: videoProbe.durationMs,
          width: videoProbe.width ?? 720,
          height: videoProbe.height ?? 1280,
          codec: videoProbe.codec,
          importedAt: Date.now(),
          fileName: 'slide10-video.mp4',
          fileSizeBytes: 0
        })
        reels.addMedia({
          id: audioId,
          path: audioPath,
          kind: audioProbe.kind,
          durationMs: audioProbe.durationMs,
          codec: audioProbe.codec,
          importedAt: Date.now(),
          fileName: 'slide10-audio.mp3',
          fileSizeBytes: 0
        })
        const videoTrack = reels.state().project.tracks.find((t) => t.kind === 'video')!
        const secondVideoTrackId = reels.addTrack('video')
        if (!secondVideoTrackId) throw new Error('failed to add second video track')
        const voiceTrack = reels
          .state()
          .project.tracks.find((t) => t.kind === 'audio' && t.role === 'voice')!
        if (videoProbe.durationMs < 1800 || audioProbe.durationMs < 1800) {
          throw new Error('fixtures too short for slide10 playback regression')
        }
        const videoClipId = reels.newId()
        const secondVideoClipId = reels.newId()
        const audioClipId = reels.newId()
        reels.addClip({
          id: videoClipId,
          kind: 'media',
          mediaId: videoId,
          trackId: videoTrack.id,
          startMs: 0,
          endMs: Math.min(2400, videoProbe.durationMs),
          trimInMs: 0,
          trimOutMs: Math.min(2400, videoProbe.durationMs),
          speed: 1
        })
        reels.addClip({
          id: secondVideoClipId,
          kind: 'media',
          mediaId: videoId,
          trackId: secondVideoTrackId,
          startMs: 0,
          endMs: Math.min(2400, videoProbe.durationMs),
          trimInMs: 0,
          trimOutMs: Math.min(2400, videoProbe.durationMs),
          speed: 1
        })
        reels.addClip({
          id: audioClipId,
          kind: 'media',
          mediaId: audioId,
          trackId: voiceTrack.id,
          startMs: 0,
          endMs: Math.min(2400, audioProbe.durationMs),
          trimInMs: 0,
          trimOutMs: Math.min(2400, audioProbe.durationMs),
          speed: 1
        })
        return { secondVideoClipId, videoClipId, voiceTrackId: voiceTrack.id }
      },
      { videoPath: videoFixture!, audioPath: audioFixture! }
    )

    await page.waitForTimeout(350)
    await page.locator('body').click().catch(() => {})
    await page.evaluate(() => {
      const ui = window.__reelsTimelineUi.getState()
      ui.setPlayheadMs(250)
      ui.setPlaying(true)
    })

    await page.waitForFunction(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      const a = document.querySelector<HTMLAudioElement>('audio[data-testid="preview-audio"]')
      return videos.length >= 2 && !!a && videos.every((v) => !v.paused && v.readyState >= 2) && !a.paused
    }, null, { timeout: 10_000 })

    const before = await page.evaluate(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      const a = document.querySelector<HTMLAudioElement>('audio[data-testid="preview-audio"]')!
      return { videoTimes: videos.map((v) => v.currentTime), audioTime: a.currentTime }
    })

    await page.evaluate(async ({ secondVideoClipId, videoClipId }) => {
      window.__reelsStore.setClipTransform(videoClipId, {
        scale: 0.52,
        y: -0.25
      })
      window.__reelsStore.setClipTransform(secondVideoClipId, {
        scale: 0.52,
        y: 0.25
      })
      await new Promise((resolve) => setTimeout(resolve, 260))
      const layerId = window.__reelsStore.addAdjustmentLayer(0, 2400)
      if (layerId) {
        window.__reelsStore.setAdjustmentLayerColorAdjust(layerId, {
          brightness: 12,
          saturation: 18
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 260))
      window.__reelsUndoRedo.getState().undo()
    }, ids)

    await page.waitForTimeout(650)
    const after = await page.evaluate(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      const a = document.querySelector<HTMLAudioElement>('audio[data-testid="preview-audio"]')!
      return {
        videoPaused: videos.map((v) => v.paused),
        audioPaused: a.paused,
        videoTimes: videos.map((v) => v.currentTime),
        audioTime: a.currentTime,
        ended: videos.map((v) => v.ended),
        playing: window.__reelsTimelineUi.getState().playing,
        playheadMs: window.__reelsTimelineUi.getState().playheadMs,
        graphState: window.__previewAudioGraph.getState(),
        gains: window.__previewAudioGraph.trackGains()
      }
    })
    expect(after.videoPaused.every((paused) => paused === false)).toBe(true)
    expect(after.audioPaused).toBe(false)
    expect(after.ended.every((ended) => ended === false)).toBe(true)
    expect(after.playing).toBe(true)
    expect(after.playheadMs).toBeLessThan(2300)
    expect(after.videoTimes.length).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < after.videoTimes.length; i++) {
      expect(after.videoTimes[i]).toBeGreaterThan((before.videoTimes[i] ?? 0) + 0.15)
    }
    expect(after.audioTime).toBeGreaterThan(before.audioTime + 0.15)
    if (after.graphState !== 'unavailable') {
      expect(after.gains[ids.voiceTrackId]).toBeGreaterThan(0)
    }
  })

  test('slide 7: 상하 레이아웃 적용 후 undo 해도 프리뷰와 오디오가 멈추지 않음', async () => {
    test.setTimeout(90_000)
    const { page } = launched!
    const videoFixture = process.env.E2E_FIXTURE_MP4
    const audioFixture = process.env.E2E_FIXTURE_MP3
    test.skip(!videoFixture || !audioFixture, 'E2E fixtures are required')

    const ids = await page.evaluate(
      async ({ videoPath, audioPath }) => {
        await window.electron.fs.allowPath(videoPath)
        await window.electron.fs.allowPath(audioPath)
        const videoProbe = await window.electron.media.probe(videoPath)
        const audioProbe = await window.electron.media.probe(audioPath)
        const reels = window.__reelsStore
        const videoId = reels.newId()
        const audioId = reels.newId()
        reels.addMedia({
          id: videoId,
          path: videoPath,
          kind: videoProbe.kind,
          durationMs: videoProbe.durationMs,
          width: videoProbe.width ?? 720,
          height: videoProbe.height ?? 1280,
          codec: videoProbe.codec,
          importedAt: Date.now(),
          fileName: 'slide7-video.mp4',
          fileSizeBytes: 0
        })
        reels.addMedia({
          id: audioId,
          path: audioPath,
          kind: audioProbe.kind,
          durationMs: audioProbe.durationMs,
          codec: audioProbe.codec,
          importedAt: Date.now(),
          fileName: 'slide7-voice.mp3',
          fileSizeBytes: 0
        })
        const firstTrack = reels.state().project.tracks.find((t) => t.kind === 'video')!
        const secondTrackId = reels.addTrack('video')
        if (!secondTrackId) throw new Error('failed to add second video track')
        const secondTrack = reels.state().project.tracks.find((t) => t.id === secondTrackId)!
        const voiceTrack = reels
          .state()
          .project.tracks.find((t) => t.kind === 'audio' && t.role === 'voice')!
        const dur = Math.min(2400, videoProbe.durationMs, audioProbe.durationMs)
        if (dur < 1800) throw new Error('fixtures too short for slide7 playback regression')
        const idA = reels.newId()
        const idB = reels.newId()
        const audioClipId = reels.newId()
        reels.addClip({
          id: idA,
          kind: 'media',
          mediaId: videoId,
          trackId: firstTrack.id,
          startMs: 0,
          endMs: dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        reels.addClip({
          id: idB,
          kind: 'media',
          mediaId: videoId,
          trackId: secondTrack.id,
          startMs: 0,
          endMs: dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        reels.addClip({
          id: audioClipId,
          kind: 'media',
          mediaId: audioId,
          trackId: voiceTrack.id,
          startMs: 0,
          endMs: dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        reels.applyLayout('2up-v', [idA, idB])
        window.__reelsUndoRedo.getState().undo()
        return { voiceTrackId: voiceTrack.id }
      },
      { videoPath: videoFixture!, audioPath: audioFixture! }
    )

    await page.waitForTimeout(350)
    await page.locator('body').click().catch(() => {})
    await page.evaluate(() => {
      const ui = window.__reelsTimelineUi.getState()
      ui.setPlayheadMs(250)
      ui.setPlaying(true)
    })

    await page.waitForFunction(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      const audio = document.querySelector<HTMLAudioElement>('audio[data-testid="preview-audio"]')
      return videos.length >= 2 && !!audio && videos.every((v) => !v.paused && v.readyState >= 2) && !audio.paused
    }, null, { timeout: 10_000 })

    const before = await page.evaluate(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      const audio = document.querySelector<HTMLAudioElement>('audio[data-testid="preview-audio"]')!
      return {
        videoTimes: videos.map((v) => v.currentTime),
        audioTime: audio.currentTime
      }
    })
    await page.waitForTimeout(650)
    const after = await page.evaluate(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      const audio = document.querySelector<HTMLAudioElement>('audio[data-testid="preview-audio"]')!
      return {
        videoPaused: videos.map((v) => v.paused),
        videoTimes: videos.map((v) => v.currentTime),
        audioPaused: audio.paused,
        audioTime: audio.currentTime,
        playing: window.__reelsTimelineUi.getState().playing,
        playheadMs: window.__reelsTimelineUi.getState().playheadMs,
        graphState: window.__previewAudioGraph.getState(),
        gains: window.__previewAudioGraph.trackGains()
      }
    })

    expect(after.playing).toBe(true)
    expect(after.playheadMs).toBeGreaterThan(600)
    expect(after.videoPaused.every((paused) => paused === false)).toBe(true)
    expect(after.audioPaused).toBe(false)
    expect(after.videoTimes.length).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < after.videoTimes.length; i++) {
      expect(after.videoTimes[i]).toBeGreaterThan((before.videoTimes[i] ?? 0) + 0.15)
    }
    expect(after.audioTime).toBeGreaterThan(before.audioTime + 0.15)
    if (after.graphState !== 'unavailable') {
      expect(after.gains[ids.voiceTrackId]).toBeGreaterThan(0)
    }
  })

  // 슬라이드 7 — "조정·색보정 넣고 틀면 프리뷰 버벅", "변형·크기/회전 조절 시
  // 프리뷰 영상 멈춘 상태로 줌 효과 적용". 앞 테스트는 adjustment LAYER 색보정 +
  // scale/y 만 다룬다. 슬라이드 문구 그대로 (1) 클립 자체 조정 탭 색보정
  // (setClipColorAdjust) (2) 회전 포함 변형을 재생 중 적용해도 <video> 프레임이
  // 멈추지 않고 currentTime 이 계속 전진하는지 직접 검증한다. 색보정·변형은 CSS
  // filter/transform 으로만 적용되고 mediaPlaybackSignature 에 포함되지 않으므로
  // src 재동기화(=프레임 freeze)를 유발하지 않아야 한다.
  test('slide 7: 재생 중 클립 색보정 + 회전 변형을 적용해도 프리뷰 프레임이 멈추지 않음', async () => {
    test.setTimeout(90_000)
    const { page } = launched!
    const videoFixture = process.env.E2E_FIXTURE_MP4
    test.skip(!videoFixture, 'E2E fixtures are required')

    const ids = await page.evaluate(async (videoPath) => {
      await window.electron.fs.allowPath(videoPath)
      const probe = await window.electron.media.probe(videoPath)
      if (probe.durationMs < 1800) {
        throw new Error('fixture too short for slide7 color/transform regression')
      }
      const reels = window.__reelsStore
      const videoId = reels.newId()
      reels.addMedia({
        id: videoId,
        path: videoPath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width ?? 720,
        height: probe.height ?? 1280,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName: 'slide7-color-transform.mp4',
        fileSizeBytes: 0
      })
      const videoTrack = reels.state().project.tracks.find((t) => t.kind === 'video')!
      const dur = Math.min(2400, probe.durationMs)
      const clipId = reels.newId()
      reels.addClip({
        id: clipId,
        kind: 'media',
        mediaId: videoId,
        trackId: videoTrack.id,
        startMs: 0,
        endMs: dur,
        trimInMs: 0,
        trimOutMs: dur,
        speed: 1
      })
      return { clipId }
    }, videoFixture!)

    await page.waitForTimeout(300)
    await page.locator('body').click().catch(() => {})
    await page.evaluate(() => {
      const ui = window.__reelsTimelineUi.getState()
      ui.setPlayheadMs(250)
      ui.setPlaying(true)
    })

    await page.waitForFunction(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      return videos.length >= 1 && videos.every((v) => !v.paused && v.readyState >= 2)
    }, null, { timeout: 10_000 })

    const before = await page.evaluate(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      return { videoTimes: videos.map((v) => v.currentTime) }
    })

    // 재생 중 (1) 조정 탭 색보정 → (2) 회전 + 크기 변형을 순차 적용.
    await page.evaluate(async ({ clipId }) => {
      window.__reelsStore.setClipColorAdjust(clipId, {
        brightness: 18,
        contrast: -14,
        saturation: 22
      })
      await new Promise((resolve) => setTimeout(resolve, 220))
      window.__reelsStore.setClipTransform(clipId, {
        scale: 1.4,
        rotation: 15
      })
      await new Promise((resolve) => setTimeout(resolve, 220))
    }, ids)

    await page.waitForTimeout(600)
    const after = await page.evaluate(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      return {
        videoPaused: videos.map((v) => v.paused),
        videoTimes: videos.map((v) => v.currentTime),
        ended: videos.map((v) => v.ended),
        playing: window.__reelsTimelineUi.getState().playing,
        playheadMs: window.__reelsTimelineUi.getState().playheadMs
      }
    })

    // 색보정·변형 적용에도 재생은 멈추지 않아야 한다.
    expect(after.playing).toBe(true)
    expect(after.playheadMs).toBeGreaterThan(600)
    expect(after.videoPaused.every((paused) => paused === false)).toBe(true)
    expect(after.ended.every((ended) => ended === false)).toBe(true)
    // 핵심: 프레임이 "멈춘 상태로 줌 효과만 적용"되는 회귀가 없도록
    // currentTime 이 적용 전 대비 실제로 전진했는지 확인.
    expect(after.videoTimes.length).toBeGreaterThanOrEqual(1)
    for (let i = 0; i < after.videoTimes.length; i++) {
      expect(after.videoTimes[i]).toBeGreaterThan((before.videoTimes[i] ?? 0) + 0.15)
    }
  })
})
