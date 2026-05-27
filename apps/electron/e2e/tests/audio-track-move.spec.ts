/**
 * pptx11 slide 4 regression — 오디오 클립을 다른 오디오 트랙으로 이동했을 때
 * 새 트랙의 <audio> element가 stale src를 유지하면 (이전 트랙에 있던 클립의
 * 파일이 그대로 재생) 사용자가 "음원 파일에서 TTS가 나옴"으로 인지.
 *
 * 핵심 invariant: moveClipToTrack(clip, targetTrack)이 적용된 후, target
 * 트랙의 <audio data-track-id="targetTrack"> element의 `.src`가 이동된 clip
 * 의 mediaId의 path에 대응되어야 함 (이전 트랙에 있던 클립의 path가 아님).
 */

import { expect, test } from '@playwright/test'
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-audio-track-move audio element src follows moved clip', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
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

  test('moveClipToTrack across audio tracks updates dest <audio>.src to moved clip media', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    const mp3 = process.env.E2E_FIXTURE_MP3
    if (!mp3) throw new Error('E2E_FIXTURE_MP3 not set')
    // 두 번째 audio fixture를 다른 경로에 복사 — toMediaUrl(path) 가 path를
    // URL-encode 하므로 서로 다른 path => 서로 다른 .src 가 됨.
    const mp3Second = join(dirname(mp3), 'test-second.mp3')
    copyFileSync(mp3, mp3Second)

    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )

    // 두 audio media 등록 + 두 audio track (voice, bgm) 둘 다 default project
    // 에 이미 존재하므로 그대로 사용.
    const setup = await page.evaluate(
      async ({ pathA, pathB }) => {
        await window.electron.fs.allowPath(pathA)
        await window.electron.fs.allowPath(pathB)
        const probeA = await window.electron.media.probe(pathA)
        const probeB = await window.electron.media.probe(pathB)
        const reels = (
          window as unknown as {
            __reelsStore: {
              state: () => {
                project: {
                  tracks: Array<{
                    id: string
                    kind: string
                    role?: string
                  }>
                }
              }
              addMedia: (a: unknown) => void
              addClip: (c: unknown) => void
              newId: () => string
            }
          }
        ).__reelsStore

        const mediaA = reels.newId()
        const mediaB = reels.newId()
        reels.addMedia({
          id: mediaA,
          path: pathA,
          kind: probeA.kind,
          durationMs: probeA.durationMs,
          width: probeA.width,
          height: probeA.height,
          codec: probeA.codec,
          importedAt: Date.now(),
          fileName: 'TTS - joonpark.mp3',
          fileSizeBytes: 0
        })
        reels.addMedia({
          id: mediaB,
          path: pathB,
          kind: probeB.kind,
          durationMs: probeB.durationMs,
          width: probeB.width,
          height: probeB.height,
          codec: probeB.codec,
          importedAt: Date.now(),
          fileName: '음원 파일 입니다.mp3',
          fileSizeBytes: 0
        })

        const audioTracks = reels
          .state()
          .project.tracks.filter((t) => t.kind === 'audio')
        if (audioTracks.length < 2) throw new Error('expected ≥2 audio tracks')
        const trackTTS = audioTracks[0] // BGM 3 equivalent — TTS가 들어가는 트랙
        const trackSound = audioTracks[1] // BGM 4 equivalent — SOUND가 들어가는 트랙

        const clipTTS = reels.newId()
        const clipSound = reels.newId()
        reels.addClip({
          id: clipTTS,
          kind: 'media',
          mediaId: mediaA,
          trackId: trackTTS.id,
          startMs: 0,
          endMs: probeA.durationMs,
          trimInMs: 0,
          trimOutMs: probeA.durationMs,
          speed: 1
        })
        reels.addClip({
          id: clipSound,
          kind: 'media',
          mediaId: mediaB,
          trackId: trackSound.id,
          startMs: 0,
          endMs: probeB.durationMs,
          trimInMs: 0,
          trimOutMs: probeB.durationMs,
          speed: 1
        })

        return {
          mediaPathA: pathA,
          mediaPathB: pathB,
          trackTTSId: trackTTS.id,
          trackSoundId: trackSound.id,
          clipTTSId: clipTTS,
          clipSoundId: clipSound
        }
      },
      { pathA: mp3, pathB: mp3Second }
    )

    // playhead를 두 클립 안으로 (1.5s, 두 mp3 모두 3s 길이라 안전).
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { setPlayheadMs: (ms: number) => void }
          }
        }
      ).__reelsTimelineUi.getState().setPlayheadMs(1500)
    })
    await page.waitForTimeout(250)

    // 기준선 — TTS 트랙의 <audio> element src가 TTS path 를 가리킴.
    const initialSrc = await page.evaluate((tid) => {
      const el = document.querySelector(
        `audio[data-track-id="${tid}"]`
      ) as HTMLAudioElement | null
      return el ? el.src : null
    }, setup.trackTTSId)
    expect(initialSrc).toBeTruthy()
    expect(initialSrc!).toContain(encodeURIComponent(setup.mediaPathA))

    // 사용자 시나리오: TTS 클립 삭제 → SOUND 클립을 TTS 트랙으로 이동.
    await page.evaluate(
      ({ clipTTSId, clipSoundId, trackTTSId }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              removeClip: (id: string) => void
              moveClipToTrack: (cid: string, tid: string) => void
            }
          }
        ).__reelsStore
        reels.removeClip(clipTTSId)
        reels.moveClipToTrack(clipSoundId, trackTTSId)
      },
      setup
    )
    await page.waitForTimeout(250)

    // 이동 후 — TTS 트랙의 <audio> element src 가 SOUND path 로 업데이트되어야
    // 함 (이전엔 stale TTS path를 유지하는 게 버그).
    const finalSrc = await page.evaluate((tid) => {
      const el = document.querySelector(
        `audio[data-track-id="${tid}"]`
      ) as HTMLAudioElement | null
      return el ? el.src : null
    }, setup.trackTTSId)
    expect(finalSrc).toBeTruthy()
    expect(finalSrc!).toContain(encodeURIComponent(setup.mediaPathB))
    expect(finalSrc!).not.toContain(encodeURIComponent(setup.mediaPathA))
  })

  test('moveClipToTrack while playing: dest element auto-plays new src (no stale paused)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    const mp3 = process.env.E2E_FIXTURE_MP3
    if (!mp3) throw new Error('E2E_FIXTURE_MP3 not set')
    const mp3Second = join(dirname(mp3), 'test-second.mp3')
    copyFileSync(mp3, mp3Second)

    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )

    const setup = await page.evaluate(
      async ({ pathA, pathB }) => {
        await window.electron.fs.allowPath(pathA)
        await window.electron.fs.allowPath(pathB)
        const probeA = await window.electron.media.probe(pathA)
        const probeB = await window.electron.media.probe(pathB)
        const reels = (
          window as unknown as {
            __reelsStore: {
              state: () => {
                project: {
                  tracks: Array<{ id: string; kind: string; role?: string }>
                }
              }
              addMedia: (a: unknown) => void
              addClip: (c: unknown) => void
              newId: () => string
            }
          }
        ).__reelsStore
        const mA = reels.newId()
        const mB = reels.newId()
        reels.addMedia({
          id: mA,
          path: pathA,
          kind: probeA.kind,
          durationMs: probeA.durationMs,
          width: probeA.width,
          height: probeA.height,
          codec: probeA.codec,
          importedAt: Date.now(),
          fileName: 'TTS.mp3',
          fileSizeBytes: 0
        })
        reels.addMedia({
          id: mB,
          path: pathB,
          kind: probeB.kind,
          durationMs: probeB.durationMs,
          width: probeB.width,
          height: probeB.height,
          codec: probeB.codec,
          importedAt: Date.now(),
          fileName: 'SOUND.mp3',
          fileSizeBytes: 0
        })
        const audio = reels
          .state()
          .project.tracks.filter((t) => t.kind === 'audio')
        const tTTS = audio[0]
        const tSound = audio[1]
        const cTTS = reels.newId()
        const cSound = reels.newId()
        reels.addClip({
          id: cTTS,
          kind: 'media',
          mediaId: mA,
          trackId: tTTS.id,
          startMs: 0,
          endMs: probeA.durationMs,
          trimInMs: 0,
          trimOutMs: probeA.durationMs,
          speed: 1
        })
        reels.addClip({
          id: cSound,
          kind: 'media',
          mediaId: mB,
          trackId: tSound.id,
          startMs: 0,
          endMs: probeB.durationMs,
          trimInMs: 0,
          trimOutMs: probeB.durationMs,
          speed: 1
        })
        return {
          pathB,
          trackTTSId: tTTS.id,
          clipTTSId: cTTS,
          clipSoundId: cSound
        }
      },
      { pathA: mp3, pathB: mp3Second }
    )

    // 재생 상태로 전환.
    await page.locator('[data-testid="transport-play"]').click()
    await page.waitForTimeout(300)

    // 사용자 시나리오: 재생 중에 TTS 삭제 + SOUND를 TTS 트랙으로 이동.
    await page.evaluate(
      ({ clipTTSId, clipSoundId, trackTTSId }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              removeClip: (id: string) => void
              moveClipToTrack: (cid: string, tid: string) => void
            }
          }
        ).__reelsStore
        reels.removeClip(clipTTSId)
        reels.moveClipToTrack(clipSoundId, trackTTSId)
      },
      setup
    )
    // canplay/loadeddata 이벤트가 fire 할 충분한 시간.
    await page.waitForTimeout(600)

    // 이동된 트랙의 element 상태 확인 — src가 SOUND 이고 paused=false 여야 함
    // (fix 전엔 src 교체 후 play() 가 호출되지 않아 paused=true 로 멈춤).
    const status = await page.evaluate((tid) => {
      const el = document.querySelector(
        `audio[data-track-id="${tid}"]`
      ) as HTMLAudioElement | null
      if (!el) return null
      return {
        src: el.src,
        paused: el.paused,
        readyState: el.readyState
      }
    }, setup.trackTTSId)
    expect(status).not.toBeNull()
    expect(status!.src).toContain(encodeURIComponent(setup.pathB))
    // readyState >= 2 (HAVE_CURRENT_DATA) 이면 onCanPlay 가 이미 fire 된 상태.
    // 그 시점 paused 가 false 여야 우리 fix가 동작한 증거.
    if (status!.readyState >= 2) {
      expect(status!.paused).toBe(false)
    }
  })
})
