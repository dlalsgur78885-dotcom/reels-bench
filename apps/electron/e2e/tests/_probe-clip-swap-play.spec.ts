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

  test('slide 8: layout undo and visual edits do not remount preview video elements', async () => {
    test.setTimeout(90_000)
    const { page } = launched!
    const videoFixture = process.env.E2E_FIXTURE_MP4
    if (!videoFixture) throw new Error('E2E_FIXTURE_MP4 not set')

    const ids = await page.evaluate(async (videoPath) => {
      await window.electron.fs.allowPath(videoPath)
      const probe = await window.electron.media.probe(videoPath)
      if (probe.durationMs < 4200) {
        throw new Error('fixture too short for slide8 stable-node regression')
      }
      const reels = window.__reelsStore
      const mediaId = reels.newId()
      reels.addMedia({
        id: mediaId,
        path: videoPath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName: 'stable-node.mp4',
        fileSizeBytes: 1
      })
      const firstTrack = reels.state().project.tracks.find((t) => t.kind === 'video')!
      const secondTrackId = reels.addTrack('video')
      if (!secondTrackId) throw new Error('failed to add second video track')
      const clipA = reels.newId()
      const clipB = reels.newId()
      const dur = Math.min(4200, probe.durationMs)
      reels.addClip({
        id: clipA,
        kind: 'media',
        mediaKind: 'video',
        mediaId,
        trackId: firstTrack.id,
        startMs: 0,
        endMs: dur,
        trimInMs: 0,
        trimOutMs: dur,
        speed: 1
      })
      reels.addClip({
        id: clipB,
        kind: 'media',
        mediaKind: 'video',
        mediaId,
        trackId: secondTrackId,
        startMs: 0,
        endMs: dur,
        trimInMs: 0,
        trimOutMs: dur,
        speed: 1
      })
      return { clipA, clipB }
    }, videoFixture)

    await page.locator('body').click().catch(() => {})
    await page.evaluate(() => {
      window.__reelsTimelineUi.getState().setPlayheadMs(120)
      window.__reelsTimelineUi.getState().setPlaying(true)
    })
    await page.waitForFunction(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      return videos.length >= 2 && videos.every((v) => !v.paused && v.readyState >= 2)
    }, null, { timeout: 10_000 })

    const before = await page.evaluate(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      videos.forEach((v, idx) => {
        ;(v as HTMLVideoElement & { __stableNodeToken?: string }).__stableNodeToken =
          `stable-${idx}`
      })
      return videos.map((v) => ({
        trackId: v.dataset.trackId,
        token: (v as HTMLVideoElement & { __stableNodeToken?: string }).__stableNodeToken
      }))
    })
    expect(before.length).toBeGreaterThanOrEqual(2)

    await page.evaluate(async ({ clipA, clipB }) => {
      window.__reelsStore.applyLayout('2up-v', [clipA, clipB])
      await new Promise((resolve) => setTimeout(resolve, 260))
      window.__reelsUndoRedo.getState().undo()
      await new Promise((resolve) => setTimeout(resolve, 260))
      window.__reelsStore.setClipColorAdjust(clipA, {
        brightness: 16,
        contrast: -10,
        saturation: 18
      })
      await new Promise((resolve) => setTimeout(resolve, 180))
      window.__reelsStore.setClipTransform(clipA, {
        scale: 1.35,
        rotation: 12
      })
      await new Promise((resolve) => setTimeout(resolve, 180))
    }, ids)
    await page.waitForTimeout(900)

    const after = await page.evaluate(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      return videos.map((v) => ({
        trackId: v.dataset.trackId,
        active: v.getClientRects().length > 0,
        src: v.currentSrc || v.src,
        token: (v as HTMLVideoElement & { __stableNodeToken?: string }).__stableNodeToken,
        paused: v.paused,
        currentTime: v.currentTime
      }))
    })

    expect(after.length).toBeGreaterThanOrEqual(before.length)
    for (const item of before) {
      const sameTrack = after.find((v) => v.trackId === item.trackId)
      expect(sameTrack?.token).toBe(item.token)
      if (sameTrack?.active && sameTrack.src) {
        expect(sameTrack.paused).toBe(false)
        expect(sameTrack.currentTime).toBeGreaterThan(0.2)
      }
    }
    expect(after.some((v) => v.active && v.src && !v.paused)).toBe(true)
  })

  // 슬라이드 11 (릴스벤치19) — "작업 여러번 걸치면 프리뷰 멈춤, TTS·음악 안
  // 들림". 기존 slide 7/8/10 테스트는 변형·색보정·레이아웃·undo 를 1회씩만
  // 적용한다. 이 테스트는 그 편집들을 재생 중 20회 누적시킨 뒤에도
  //   (1) <video> currentTime 이 계속 전진하고
  //   (2) requestVideoFrameCallback 로 센 "실제 표시된 프레임" 수가 늘어나며
  //       (= 프레임이 멈춘 채 줌만 적용되는 회귀가 없고)
  //   (3) voice 오디오가 계속 재생되고 audioGraph gain 이 살아있는지
  // 를 검증한다. 누적 편집이 src 재동기화(freeze)나 오디오 그래프 끊김을
  // 유발하면 여기서 잡힌다.
  test('slide 11: 재생 중 변형·색보정·레이아웃·undo 를 20회 누적해도 프리뷰·오디오가 멈추지 않음', async () => {
    test.setTimeout(120_000)
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
          fileName: 'slide11-video.mp4',
          fileSizeBytes: 0
        })
        reels.addMedia({
          id: audioId,
          path: audioPath,
          kind: audioProbe.kind,
          durationMs: audioProbe.durationMs,
          codec: audioProbe.codec,
          importedAt: Date.now(),
          fileName: 'slide11-voice.mp3',
          fileSizeBytes: 0
        })
        const firstTrack = reels.state().project.tracks.find((t) => t.kind === 'video')!
        const secondTrackId = reels.addTrack('video')
        if (!secondTrackId) throw new Error('failed to add second video track')
        const secondTrack = reels.state().project.tracks.find((t) => t.id === secondTrackId)!
        const voiceTrack = reels
          .state()
          .project.tracks.find((t) => t.kind === 'audio' && t.role === 'voice')!
        // 누적 편집 동안 클립이 끝나 ended 되지 않도록 fixture 전체 길이를 쓴다.
        const dur = Math.min(videoProbe.durationMs, audioProbe.durationMs)
        if (dur < 3000) throw new Error('fixtures too short for slide11 stress regression')
        const clipA = reels.newId()
        const clipB = reels.newId()
        const audioClipId = reels.newId()
        reels.addClip({
          id: clipA, kind: 'media', mediaId: videoId, trackId: firstTrack.id,
          startMs: 0, endMs: dur, trimInMs: 0, trimOutMs: dur, speed: 1
        })
        reels.addClip({
          id: clipB, kind: 'media', mediaId: videoId, trackId: secondTrack.id,
          startMs: 0, endMs: dur, trimInMs: 0, trimOutMs: dur, speed: 1
        })
        reels.addClip({
          id: audioClipId, kind: 'media', mediaId: audioId, trackId: voiceTrack.id,
          startMs: 0, endMs: dur, trimInMs: 0, trimOutMs: dur, speed: 1
        })
        return { clipA, clipB, voiceTrackId: voiceTrack.id }
      },
      { videoPath: videoFixture!, audioPath: audioFixture! }
    )

    await page.waitForTimeout(350)
    await page.locator('body').click().catch(() => {})
    await page.evaluate(() => {
      const ui = window.__reelsTimelineUi.getState()
      ui.setPlayheadMs(120)
      ui.setPlaying(true)
    })

    await page.waitForFunction(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      const audio = document.querySelector<HTMLAudioElement>('audio[data-testid="preview-audio"]')
      return videos.length >= 2 && !!audio &&
        videos.every((v) => !v.paused && v.readyState >= 2) && !audio.paused
    }, null, { timeout: 10_000 })

    // 실제 표시 프레임 카운터를 video element 마다 설치 (requestVideoFrameCallback).
    await page.evaluate(() => {
      const w = window as unknown as { __slide11FrameCounts?: Record<number, number> }
      w.__slide11FrameCounts = {}
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      videos.forEach((v, idx) => {
        w.__slide11FrameCounts![idx] = 0
        const rvfc = (v as HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number
        }).requestVideoFrameCallback
        if (typeof rvfc !== 'function') return
        const pump = (): void => {
          w.__slide11FrameCounts![idx] += 1
          ;(v as HTMLVideoElement & {
            requestVideoFrameCallback: (cb: () => void) => number
          }).requestVideoFrameCallback(pump)
        }
        ;(v as HTMLVideoElement & {
          requestVideoFrameCallback: (cb: () => void) => number
        }).requestVideoFrameCallback(pump)
      })
    })

    const before = await page.evaluate(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      const audio = document.querySelector<HTMLAudioElement>('audio[data-testid="preview-audio"]')!
      const w = window as unknown as { __slide11FrameCounts: Record<number, number> }
      return {
        videoTimes: videos.map((v) => v.currentTime),
        audioTime: audio.currentTime,
        frameCounts: { ...w.__slide11FrameCounts }
      }
    })

    // 재생을 유지한 채 변형·색보정·레이아웃·undo 를 20회 누적.
    await page.evaluate(async ({ clipA, clipB }) => {
      const reels = window.__reelsStore
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms))
      for (let i = 0; i < 20; i++) {
        reels.setClipTransform(clipA, {
          scale: 1 + (i % 5) * 0.08,
          rotation: (i % 7) * 5,
          y: ((i % 3) - 1) * 0.2
        })
        reels.setClipColorAdjust(clipA, {
          brightness: (i % 9) * 4,
          contrast: ((i % 6) - 3) * 5,
          saturation: (i % 8) * 6
        })
        if (i % 4 === 0) {
          reels.applyLayout('2up-v', [clipA, clipB])
          await sleep(40)
          window.__reelsUndoRedo.getState().undo()
        }
        await sleep(70)
      }
    }, ids)

    await page.waitForTimeout(700)
    const after = await page.evaluate(() => {
      const videos = Array.from(
        document.querySelectorAll<HTMLVideoElement>('video[data-preview-video-layer]')
      )
      const audio = document.querySelector<HTMLAudioElement>('audio[data-testid="preview-audio"]')!
      const w = window as unknown as { __slide11FrameCounts: Record<number, number> }
      return {
        videoPaused: videos.map((v) => v.paused),
        videoTimes: videos.map((v) => v.currentTime),
        ended: videos.map((v) => v.ended),
        audioPaused: audio.paused,
        audioTime: audio.currentTime,
        playing: window.__reelsTimelineUi.getState().playing,
        graphState: window.__previewAudioGraph.getState(),
        gains: window.__previewAudioGraph.trackGains(),
        frameCounts: { ...w.__slide11FrameCounts }
      }
    })

    // (1) 재생 상태·프레임 유지.
    expect(after.playing).toBe(true)
    expect(after.videoPaused.every((p) => p === false)).toBe(true)
    expect(after.ended.every((e) => e === false)).toBe(true)
    // (2) video currentTime 누적 편집 후에도 전진.
    expect(after.videoTimes.length).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < after.videoTimes.length; i++) {
      expect(after.videoTimes[i]).toBeGreaterThan((before.videoTimes[i] ?? 0) + 0.15)
    }
    // (3) "프레임이 멈춘 채 줌만 적용" 회귀 차단 — 실제 표시 프레임이 늘어야 함.
    const rvfcSupported = Object.values(before.frameCounts).length > 0
    if (rvfcSupported) {
      for (const key of Object.keys(after.frameCounts)) {
        const idx = Number(key)
        expect(after.frameCounts[idx]).toBeGreaterThan((before.frameCounts[idx] ?? 0) + 3)
      }
    }
    // (4) TTS·음악 안 들림 회귀 차단 — voice 오디오 계속 재생 + gain 유지.
    expect(after.audioPaused).toBe(false)
    expect(after.audioTime).toBeGreaterThan(before.audioTime + 0.15)
    if (after.graphState !== 'unavailable') {
      expect(after.gains[ids.voiceTrackId]).toBeGreaterThan(0)
    }
  })
})
