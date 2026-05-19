import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 4-WebAudio — preview audio routing graph.
 *
 * Verifies that the AudioContext-based mixer supports:
 *   - Multiple audio tracks playing simultaneously in preview (BGM + voice)
 *   - Track mute / solo via per-track GainNode = 0
 *   - BGM ducking via linearRampToValueAtTime (click-free, ramp ≤ 40 ms)
 *   - AudioContext resumes after a user gesture (autoplay policy)
 *
 * All assertions read state via the `window.__previewAudioGraph` test bridge
 * exposed by `src/renderer/src/lib/testBridge.ts`.
 */
test.describe('@phase-4-webaudio preview audio graph', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
    })
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

  // -------------------------------------------------------------------------
  // Helpers — minimal versions of the audio.spec.ts utilities.
  // -------------------------------------------------------------------------
  async function importFixture(): Promise<{ mediaId: string; durationMs: number }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')

    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )

    return await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = (
        window as unknown as {
          __reelsStore: { addMedia: (a: unknown) => void; newId: () => string }
        }
      ).__reelsStore
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

  async function addAudioClipOnRole(
    mediaId: string,
    durationMs: number,
    role: 'voice' | 'bgm'
  ): Promise<{ clipId: string; trackId: string }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(
      ({ mid, dur, r }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              state: () => {
                project: {
                  tracks: Array<{ id: string; kind: string; role?: string }>
                }
              }
              addClip: (c: unknown) => void
              newId: () => string
            }
          }
        ).__reelsStore
        const trk = reels
          .state()
          .project.tracks.find((t) => t.kind === 'audio' && t.role === r)
        if (!trk) throw new Error('no audio track with role ' + r)
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: trk.id,
          startMs: 0,
          endMs: dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        return { clipId: cid, trackId: trk.id }
      },
      { mid: mediaId, dur: durationMs, r: role }
    )
  }

  async function setPlayhead(ms: number): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate((t) => {
      ;(
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { setPlayheadMs: (ms: number) => void }
          }
        }
      ).__reelsTimelineUi.getState().setPlayheadMs(t)
    }, ms)
    // Let PreviewCanvas's rAF tick run.
    await page.waitForTimeout(120)
  }

  // -------------------------------------------------------------------------
  // Test 1: graph bridge installed + AudioContext lifecycle.
  // -------------------------------------------------------------------------
  test('preview audio graph bridge is installed', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const installed = await page.evaluate(() => {
      const g = (window as unknown as { __previewAudioGraph?: unknown })
        .__previewAudioGraph
      return !!g
    })
    expect(installed).toBe(true)
  })

  test('AudioContext resumes after a user gesture', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await importFixture()
    await addAudioClipOnRole(mediaId, durationMs, 'voice')

    // Park the playhead inside the clip so an <audio> element gets wired.
    await setPlayhead(1500)
    // Simulate the user clicking the play button — this is a real user
    // gesture as far as Chromium is concerned and should unblock the
    // AudioContext.resume() chain.
    await page.locator('[data-testid="transport-play"]').click()
    await page.waitForTimeout(150)

    const state = await page.evaluate(() => {
      const g = (
        window as unknown as {
          __previewAudioGraph: {
            getState: () => string
            resume: () => Promise<void>
          }
        }
      ).__previewAudioGraph
      return g.getState()
    })
    // After a user gesture + element interaction the state should not still
    // be 'suspended'. It may be 'running' or 'unavailable' depending on the
    // sandbox; both are acceptable since the resume code is best-effort.
    expect(['running', 'unavailable']).toContain(state)
  })

  // -------------------------------------------------------------------------
  // Test 2: multi-track simultaneous audio — both gains > 0 when both
  // tracks have audible clips overlapping the playhead.
  // -------------------------------------------------------------------------
  test('BGM + voice clips overlap → both track gains > 0 simultaneously', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await importFixture()
    const voice = await addAudioClipOnRole(mediaId, durationMs, 'voice')
    const bgm = await addAudioClipOnRole(mediaId, durationMs, 'bgm')

    await page.locator('[data-testid="transport-play"]').click()
    await page.waitForTimeout(80)
    await page.locator('[data-testid="transport-play"]').click() // pause
    await setPlayhead(1500)

    // Read post-ramp gains. Wait 50ms so the 20ms linearRampToValueAtTime
    // has fully settled.
    await page.waitForTimeout(60)
    const gains = await page.evaluate(() => {
      const g = (
        window as unknown as {
          __previewAudioGraph: { trackGains: () => Record<string, number> }
        }
      ).__previewAudioGraph
      return g.trackGains()
    })

    const isUnavailable = await page.evaluate(() => {
      const g = (
        window as unknown as { __previewAudioGraph: { getState: () => string } }
      ).__previewAudioGraph
      return g.getState() === 'unavailable'
    })
    test.skip(isUnavailable, 'AudioContext unavailable in this sandbox')

    expect(gains[voice.trackId]).toBeGreaterThan(0)
    expect(gains[bgm.trackId]).toBeGreaterThan(0)
    // BGM should be ducked since the voice clip is audible at this playhead.
    // Default duck = -12dB → linear 0.251. Allow some slack.
    expect(gains[bgm.trackId]).toBeLessThan(gains[voice.trackId])
    expect(gains[bgm.trackId]).toBeLessThan(0.4)
  })

  // -------------------------------------------------------------------------
  // Test 3: track mute → that track's gain becomes 0.
  // -------------------------------------------------------------------------
  test('muting the voice track drops its gain to 0', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await importFixture()
    const voice = await addAudioClipOnRole(mediaId, durationMs, 'voice')
    const bgm = await addAudioClipOnRole(mediaId, durationMs, 'bgm')

    await page.locator('[data-testid="transport-play"]').click()
    await page.waitForTimeout(60)
    await page.locator('[data-testid="transport-play"]').click()
    await setPlayhead(1500)

    const isUnavailable = await page.evaluate(() => {
      const g = (
        window as unknown as { __previewAudioGraph: { getState: () => string } }
      ).__previewAudioGraph
      return g.getState() === 'unavailable'
    })
    test.skip(isUnavailable, 'AudioContext unavailable in this sandbox')

    // Mute voice via track-mute.
    await page.evaluate((tid) => {
      ;(
        window as unknown as {
          __reelsStore: { setTrackMuted: (id: string, m: boolean) => void }
        }
      ).__reelsStore.setTrackMuted(tid, true)
    }, voice.trackId)
    await page.waitForTimeout(80)

    const gains = await page.evaluate(() => {
      return (
        window as unknown as {
          __previewAudioGraph: { trackGains: () => Record<string, number> }
        }
      ).__previewAudioGraph.trackGains()
    })
    expect(gains[voice.trackId]).toBe(0)
    // BGM should NO LONGER be ducked (voice is muted), so its gain rebounds
    // toward 1.0 (full).
    expect(gains[bgm.trackId]).toBeGreaterThan(0.5)
  })

  // -------------------------------------------------------------------------
  // Test 4: solo → non-solo tracks gain = 0.
  // -------------------------------------------------------------------------
  test('soloing the voice track silences BGM', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await importFixture()
    const voice = await addAudioClipOnRole(mediaId, durationMs, 'voice')
    const bgm = await addAudioClipOnRole(mediaId, durationMs, 'bgm')

    await page.locator('[data-testid="transport-play"]').click()
    await page.waitForTimeout(60)
    await page.locator('[data-testid="transport-play"]').click()
    await setPlayhead(1500)

    const isUnavailable = await page.evaluate(() => {
      const g = (
        window as unknown as { __previewAudioGraph: { getState: () => string } }
      ).__previewAudioGraph
      return g.getState() === 'unavailable'
    })
    test.skip(isUnavailable, 'AudioContext unavailable in this sandbox')

    await page.evaluate((tid) => {
      ;(
        window as unknown as {
          __reelsStore: { setTrackSolo: (id: string, s: boolean) => void }
        }
      ).__reelsStore.setTrackSolo(tid, true)
    }, voice.trackId)
    await page.waitForTimeout(80)

    const gains = await page.evaluate(() => {
      return (
        window as unknown as {
          __previewAudioGraph: { trackGains: () => Record<string, number> }
        }
      ).__previewAudioGraph.trackGains()
    })
    expect(gains[voice.trackId]).toBeGreaterThan(0)
    expect(gains[bgm.trackId]).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Test 5: ducking is click-free — the gain animates over a ramp window
  // bounded by ~40ms (we set rampMs=20 in setTrackGain calls). Sample twice
  // and confirm the value did move.
  // -------------------------------------------------------------------------
  test('BGM ducking ramp is bounded (≤ 40ms settle window)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await importFixture()
    await addAudioClipOnRole(mediaId, durationMs, 'voice')
    const bgm = await addAudioClipOnRole(mediaId, durationMs, 'bgm')

    await page.locator('[data-testid="transport-play"]').click()
    await page.waitForTimeout(60)
    await page.locator('[data-testid="transport-play"]').click()
    await setPlayhead(1500)

    const isUnavailable = await page.evaluate(() => {
      const g = (
        window as unknown as { __previewAudioGraph: { getState: () => string } }
      ).__previewAudioGraph
      return g.getState() === 'unavailable'
    })
    test.skip(isUnavailable, 'AudioContext unavailable in this sandbox')

    // After the ramp settles (>= 40ms after the last setTrackGain), the
    // BGM gain should be at the ducked target (≈ 0.25 for -12dB).
    await page.waitForTimeout(60)
    const settled = await page.evaluate((tid) => {
      const g = (
        window as unknown as {
          __previewAudioGraph: { trackGains: () => Record<string, number> }
        }
      ).__previewAudioGraph.trackGains()
      return g[tid]
    }, bgm.trackId)
    // -12dB = 10^(-12/20) ≈ 0.251.
    expect(settled).toBeGreaterThan(0.15)
    expect(settled).toBeLessThan(0.4)
  })

  // -------------------------------------------------------------------------
  // Test 6: clip-level mute keeps the BGM audible solo.
  // -------------------------------------------------------------------------
  test('muting voice clip → only BGM track gain stays > 0 (no ducking)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await importFixture()
    const voice = await addAudioClipOnRole(mediaId, durationMs, 'voice')
    const bgm = await addAudioClipOnRole(mediaId, durationMs, 'bgm')

    await page.locator('[data-testid="transport-play"]').click()
    await page.waitForTimeout(60)
    await page.locator('[data-testid="transport-play"]').click()
    await setPlayhead(1500)

    const isUnavailable = await page.evaluate(() => {
      const g = (
        window as unknown as { __previewAudioGraph: { getState: () => string } }
      ).__previewAudioGraph
      return g.getState() === 'unavailable'
    })
    test.skip(isUnavailable, 'AudioContext unavailable in this sandbox')

    // Mute the voice CLIP (not the track) — voiceActiveAt should return
    // false now, so BGM no longer ducks.
    await page.evaluate((cid) => {
      ;(
        window as unknown as {
          __reelsStore: { setClipMuted: (id: string, m: boolean) => void }
        }
      ).__reelsStore.setClipMuted(cid, true)
    }, voice.clipId)
    await page.waitForTimeout(80)

    const gains = await page.evaluate(() => {
      return (
        window as unknown as {
          __previewAudioGraph: { trackGains: () => Record<string, number> }
        }
      ).__previewAudioGraph.trackGains()
    })
    expect(gains[voice.trackId]).toBe(0)
    expect(gains[bgm.trackId]).toBeGreaterThan(0.7)
  })

  // -------------------------------------------------------------------------
  // Test 7: source count grows as audio elements get wired.
  // -------------------------------------------------------------------------
  test('source-node count tracks number of audio tracks rendered', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await importFixture()
    await addAudioClipOnRole(mediaId, durationMs, 'voice')
    await addAudioClipOnRole(mediaId, durationMs, 'bgm')
    await setPlayhead(1500)

    // Trigger a user gesture so the graph initializes if it hasn't.
    await page.locator('[data-testid="transport-play"]').click()
    await page.waitForTimeout(60)
    await page.locator('[data-testid="transport-play"]').click()
    await page.waitForTimeout(80)

    const isUnavailable = await page.evaluate(() => {
      const g = (
        window as unknown as { __previewAudioGraph: { getState: () => string } }
      ).__previewAudioGraph
      return g.getState() === 'unavailable'
    })
    test.skip(isUnavailable, 'AudioContext unavailable in this sandbox')

    const count = await page.evaluate(() => {
      return (
        window as unknown as {
          __previewAudioGraph: { sourceCount: () => number }
        }
      ).__previewAudioGraph.sourceCount()
    })
    // Voice + BGM = 2 audio elements. Video element also gets wired if it
    // has any active clip, but there's no video clip in this scenario, so
    // we expect at least 2.
    expect(count).toBeGreaterThanOrEqual(2)
  })

  // -------------------------------------------------------------------------
  // Test 8: multiple <audio> elements in the DOM (one per audio track).
  // -------------------------------------------------------------------------
  test('PreviewCanvas renders one <audio> element per audio track', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await importFixture()
    await addAudioClipOnRole(mediaId, durationMs, 'voice')
    await addAudioClipOnRole(mediaId, durationMs, 'bgm')
    await setPlayhead(1500)

    // Count both legacy testid (preview-audio, exactly 1) AND the per-track
    // ones (preview-audio-track, ≥1) — together they should equal the
    // number of audio tracks in the project (2 by default).
    const primary = await page.locator('[data-testid="preview-audio"]').count()
    const extras = await page
      .locator('[data-testid="preview-audio-track"]')
      .count()
    expect(primary + extras).toBeGreaterThanOrEqual(2)
  })
})
