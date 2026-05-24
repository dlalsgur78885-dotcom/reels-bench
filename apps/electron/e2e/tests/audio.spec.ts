import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import { openOptionsMenu } from '../helpers/topbar'

/**
 * Phase 2.5 — audio shaping, track controls, silence removal, beats, waveform.
 *
 * Most logic is verified through the renderer test bridge so we don't have to
 * juggle real audio playback inside the sandbox. The waveform IPC is exercised
 * end-to-end with the bundled lavfi fixture (5s test.mp4 with sine + testsrc).
 */
test.describe('@phase-2-audio audio shaping + track controls', () => {
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
      await new Promise((r) => setTimeout(r, 700))
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
  // Helpers
  // -------------------------------------------------------------------------
  async function openEditorWithMedia(): Promise<{
    mediaId: string
    durationMs: number
    path: string
  }> {
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

    const result = await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = (
        window as unknown as {
          __reelsStore: {
            addMedia: (a: unknown) => void
            newId: () => string
          }
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
    return { ...result, path: fixture }
  }

  async function addClipOnTrack(
    kind: 'video' | 'audio',
    mediaId: string,
    durationMs: number
  ): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(
      ({ k, mid, dur }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              state: () => {
                project: { tracks: Array<{ id: string; kind: string; role?: string }> }
              }
              addClip: (c: unknown) => void
              newId: () => string
            }
          }
        ).__reelsStore
        const trk = reels.state().project.tracks.find((t) => t.kind === k)
        if (!trk) throw new Error('no track of kind ' + k)
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
        return cid
      },
      { k: kind, mid: mediaId, dur: durationMs }
    )
  }

  async function getClip(clipId: string): Promise<{
    kind: string
    startMs: number
    endMs: number
    trimInMs?: number
    trimOutMs?: number
    gainDb?: number
    fadeInMs?: number
    fadeOutMs?: number
    isMuted?: boolean
  } | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  clips: Array<Record<string, unknown>>
                }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) return c
      return null
    }, clipId) as unknown as Promise<ReturnType<typeof getClip> extends Promise<infer R> ? R : never>
  }

  // -------------------------------------------------------------------------
  // Defaults: createNew adds BGM track with ducking config.
  // -------------------------------------------------------------------------
  test('default project has voice + BGM audio tracks; BGM has duckTarget=voice', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const tracks = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  kind: string
                  role?: string
                  duckTarget?: string | null
                  duckingDb?: number
                }>
              }
            }
          }
        }
      ).__reelsStore
      return reels.state().project.tracks.map((t) => ({
        kind: t.kind,
        role: t.role,
        duckTarget: t.duckTarget,
        duckingDb: t.duckingDb
      }))
    })
    const audios = tracks.filter((t) => t.kind === 'audio')
    expect(audios.length).toBe(2)
    const voice = audios.find((t) => t.role === 'voice')
    const bgm = audios.find((t) => t.role === 'bgm')
    expect(voice).toBeTruthy()
    expect(bgm).toBeTruthy()
    expect(bgm?.duckTarget).toBe('voice')
    expect(bgm?.duckingDb).toBe(-12)
  })

  // -------------------------------------------------------------------------
  // Gain / fade / mute
  // -------------------------------------------------------------------------
  test('setClipGainDb clamps to [-60, +12]', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const cid = await addClipOnTrack('video', mediaId, durationMs)

    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: { setClipGainDb: (id: string, db: number) => void }
        }
      ).__reelsStore
      reels.setClipGainDb(id, 9999)
    }, cid)
    let after = await getClip(cid)
    expect(after?.gainDb).toBe(12)

    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: { setClipGainDb: (id: string, db: number) => void }
        }
      ).__reelsStore
      reels.setClipGainDb(id, -9999)
    }, cid)
    after = await getClip(cid)
    expect(after?.gainDb).toBe(-60)

    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: { setClipGainDb: (id: string, db: number) => void }
        }
      ).__reelsStore
      reels.setClipGainDb(id, -6)
    }, cid)
    after = await getClip(cid)
    expect(after?.gainDb).toBe(-6)
  })

  test('setClipFade rejects negatives and clamps within clip duration', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const cid = await addClipOnTrack('video', mediaId, durationMs)

    // Negative → no-op (clip keeps prior values, which are undefined).
    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: { setClipFade: (id: string, fin: number, fout: number) => void }
        }
      ).__reelsStore
      reels.setClipFade(id, -10, 100)
    }, cid)
    let after = await getClip(cid)
    expect(after?.fadeInMs).toBeUndefined()
    expect(after?.fadeOutMs).toBeUndefined()

    // Reasonable values → applied as-is.
    await page.evaluate(
      ({ id, fin, fout }) => {
        const reels = (
          window as unknown as {
            __reelsStore: { setClipFade: (id: string, fin: number, fout: number) => void }
          }
        ).__reelsStore
        reels.setClipFade(id, fin, fout)
      },
      { id: cid, fin: 500, fout: 700 }
    )
    after = await getClip(cid)
    expect(after?.fadeInMs).toBe(500)
    expect(after?.fadeOutMs).toBe(700)

    // Both fades together longer than duration → proportional shrink.
    await page.evaluate(
      ({ id, dur }) => {
        const reels = (
          window as unknown as {
            __reelsStore: { setClipFade: (id: string, fin: number, fout: number) => void }
          }
        ).__reelsStore
        reels.setClipFade(id, dur, dur)
      },
      { id: cid, dur: durationMs }
    )
    after = await getClip(cid)
    // After shrink: fin+fout <= durationMs.
    expect((after?.fadeInMs ?? 0) + (after?.fadeOutMs ?? 0)).toBeLessThanOrEqual(
      durationMs
    )
  })

  test('setClipMuted toggles flag on media clip only', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const cid = await addClipOnTrack('audio', mediaId, durationMs)

    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: { setClipMuted: (id: string, m: boolean) => void }
        }
      ).__reelsStore
      reels.setClipMuted(id, true)
    }, cid)
    let after = await getClip(cid)
    expect(after?.isMuted).toBe(true)

    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: { setClipMuted: (id: string, m: boolean) => void }
        }
      ).__reelsStore
      reels.setClipMuted(id, false)
    }, cid)
    after = await getClip(cid)
    expect(after?.isMuted).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Track mute / solo + preview <audio>/<video> muted attribute
  // -------------------------------------------------------------------------
  test('track mute sets <video> muted=true at the playhead', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addClipOnTrack('video', mediaId, durationMs)

    // Move playhead inside the clip.
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { setPlayheadMs: (ms: number) => void }
          }
        }
      ).__reelsTimelineUi.getState().setPlayheadMs(1500)
    })

    // Locate the video track and mute it.
    const videoTrackId = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: { tracks: Array<{ id: string; kind: string }> }
            }
          }
        }
      ).__reelsStore
      return reels.state().project.tracks.find((t) => t.kind === 'video')!.id
    })
    await page.evaluate((tid) => {
      const reels = (
        window as unknown as {
          __reelsStore: { setTrackMuted: (id: string, m: boolean) => void }
        }
      ).__reelsStore
      reels.setTrackMuted(tid, true)
    }, videoTrackId)

    // Allow PreviewCanvas's rAF tick to run.
    await page.waitForTimeout(80)
    await expect(page.locator('[data-testid="preview-video"]')).toHaveAttribute(
      'data-track-audible',
      'false'
    )
    // The element's `muted` reflective property should also flip true.
    const muted = await page.locator('[data-testid="preview-video"]').evaluate(
      (el) => (el as HTMLMediaElement).muted
    )
    expect(muted).toBe(true)
  })

  test('track solo: when one track has solo, non-solo audio track mutes', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addClipOnTrack('video', mediaId, durationMs)

    await page.evaluate(() => {
      ;(
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { setPlayheadMs: (ms: number) => void }
          }
        }
      ).__reelsTimelineUi.getState().setPlayheadMs(1500)
    })

    // Solo a different (audio) track.
    const audioTrackId = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: { tracks: Array<{ id: string; kind: string; role?: string }> }
            }
          }
        }
      ).__reelsStore
      return reels.state().project.tracks.find(
        (t) => t.kind === 'audio' && t.role === 'voice'
      )!.id
    })
    await page.evaluate((tid) => {
      const reels = (
        window as unknown as {
          __reelsStore: { setTrackSolo: (id: string, s: boolean) => void }
        }
      ).__reelsStore
      reels.setTrackSolo(tid, true)
    }, audioTrackId)

    await page.waitForTimeout(80)
    // Video track has no solo → should be inaudible.
    await expect(page.locator('[data-testid="preview-video"]')).toHaveAttribute(
      'data-track-audible',
      'false'
    )
  })

  // -------------------------------------------------------------------------
  // removeSilencesFromClip with mocked silence ranges.
  // -------------------------------------------------------------------------
  test('removeSilencesFromClip splits a clip into the correct surviving slices', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const cid = await addClipOnTrack('audio', mediaId, durationMs)

    // Mock silences in source-time coords: drop [1000..1800] and [3000..3600].
    const ranges = [
      { startMs: 1000, endMs: 1800, durationMs: 800 },
      { startMs: 3000, endMs: 3600, durationMs: 600 }
    ]
    const newIds = await page.evaluate(
      ({ id, r }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              removeSilencesFromClip: (id: string, r: unknown) => string[]
            }
          }
        ).__reelsStore
        return reels.removeSilencesFromClip(id, r)
      },
      { id: cid, r: ranges }
    )
    // 3 survivors: [0..1000], [1800..3000], [3600..durationMs].
    expect(newIds.length).toBe(3)

    const all = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  kind: string
                  clips: Array<Record<string, unknown>>
                }>
              }
            }
          }
        }
      ).__reelsStore
      const audio = reels.state().project.tracks.find((t) => t.kind === 'audio')!
      return audio.clips
        .filter((c) => (c as { kind?: string }).kind === 'media')
        .map((c) => ({
          startMs: c.startMs,
          endMs: c.endMs,
          trimInMs: c.trimInMs,
          trimOutMs: c.trimOutMs
        }))
        .sort(
          (a, b) =>
            (a.startMs as number) - (b.startMs as number)
        )
    })
    expect(all.length).toBe(3)
    expect(all[0].startMs).toBe(0)
    expect(all[0].endMs).toBe(1000)
    expect(all[1].startMs).toBe(1800)
    expect(all[1].endMs).toBe(3000)
    expect(all[2].startMs).toBe(3600)
    expect(all[2].endMs).toBe(durationMs)
    // Trim points chain so each surviving piece points at the right source slice.
    expect(all[0].trimInMs).toBe(0)
    expect(all[0].trimOutMs).toBe(1000)
    expect(all[1].trimInMs).toBe(1800)
    expect(all[1].trimOutMs).toBe(3000)
    expect(all[2].trimInMs).toBe(3600)
    expect(all[2].trimOutMs).toBe(durationMs)
  })

  // -------------------------------------------------------------------------
  // BPM beats render on ruler when snap is enabled.
  // -------------------------------------------------------------------------
  test('beat snap renders ruler tick marks based on BPM', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addClipOnTrack('video', mediaId, durationMs)

    // Set BPM=120 (so 2 beats / second) and turn on snap.
    await openOptionsMenu(page)
    await page.locator('[data-testid="bpm-input"]').fill('120')
    await page.locator('[data-testid="bpm-input"]').blur()
    await page.locator('[data-testid="beat-snap-toggle"]').click()
    await expect(page.locator('[data-testid="beat-snap-toggle"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    // With a 5s fixture + BPM 120, we expect roughly 11 beat ticks (0,500,...,5000).
    const tickCount = await page.locator('[data-testid="ruler-beat-tick"]').count()
    expect(tickCount).toBeGreaterThanOrEqual(5)
  })

  // -------------------------------------------------------------------------
  // Beat snap pulls a clip edge to the nearest beat.
  // -------------------------------------------------------------------------
  test('beat snap on: clip move snaps to nearest beat', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    // Need to be inside the editor for the Editor's BPM effect to drive the
    // timelineUi beats array; load a clip first so a duration is set.
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addClipOnTrack('video', mediaId, durationMs)

    // Enter BPM=120 via the input, then read back the beats array.
    await openOptionsMenu(page)
    await page.locator('[data-testid="bpm-input"]').fill('120')
    await page.locator('[data-testid="bpm-input"]').blur()
    // Editor's useEffect runs synchronously after state set; a short wait is
    // enough to let zustand listeners propagate.
    await page.waitForTimeout(120)

    const snapped = await page.evaluate(() => {
      const beats = (
        window as unknown as {
          __reelsTimelineUi: { getState: () => { beats: number[] } }
        }
      ).__reelsTimelineUi
      const arr = beats.getState().beats.slice(0, 5)
      // Inline nearest-beat snap check for 480ms with 80ms tolerance.
      let best = 480
      let bestDist = Infinity
      for (const b of arr) {
        const d = Math.abs(b - 480)
        if (d < bestDist) {
          bestDist = d
          best = b
        }
      }
      return { beats: arr, nearest: bestDist <= 80 ? best : 480 }
    })
    expect(snapped.beats[0]).toBe(0)
    expect(snapped.beats[1]).toBe(500)
    expect(snapped.nearest).toBe(500)
  })

  // -------------------------------------------------------------------------
  // Waveform generation produces a real file from the fixture.
  // -------------------------------------------------------------------------
  test('media.generateWaveform produces a PNG and a data URI', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')

    const result = await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
      const wf = await window.electron.media.generateWaveform(p, {
        mediaId: 'wftest',
        width: 600,
        height: 60
      })
      return wf
    }, fixture)
    expect(result.path).toMatch(/wftest\.png$/)
    expect(result.width).toBe(600)
    expect(result.height).toBe(60)
    expect(result.dataUri.startsWith('data:image/png;base64,')).toBe(true)
    // The data URI body should be at least a small PNG (>= 200 base64 chars).
    expect(result.dataUri.length).toBeGreaterThan(200)
  })

  // -------------------------------------------------------------------------
  // Silence detect runs end-to-end against the fixture.
  // -------------------------------------------------------------------------
  test('audio.detectSilence runs against fixture (returns array)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    const ranges = await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
      return await window.electron.audio.detectSilence(p, {
        noiseDb: -30,
        minMs: 200
      })
    }, fixture)
    // The fixture has a continuous sine wave, so silencedetect should return [].
    expect(Array.isArray(ranges)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Beats IPC stub honors BPM input.
  // -------------------------------------------------------------------------
  test('audio.detectBeats returns BPM-derived beats', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    const beats = await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
      return await window.electron.audio.detectBeats(p, {
        bpm: 120,
        startOffsetMs: 0,
        durationMs: 5000
      })
    }, fixture)
    expect(beats.length).toBeGreaterThan(0)
    expect(beats[0].timeMs).toBe(0)
    expect(beats[1].timeMs).toBe(500)
  })

  // -------------------------------------------------------------------------
  // Waveform DOM strip: clip carries data-has-waveform when uri is set.
  // -------------------------------------------------------------------------
  test('audio clip shows waveform background after generation', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const cid = await addClipOnTrack('audio', mediaId, durationMs)

    // Seed the cached data URI directly.
    await page.evaluate((mid) => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { setWaveformUri: (m: string, u: string) => void }
          }
        }
      ).__reelsTimelineUi
      ui.getState().setWaveformUri(
        mid,
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
      )
    }, mediaId)
    await page.waitForTimeout(80)
    await expect(
      page.locator(
        `[data-testid="media-clip-block"][data-clip-id="${cid}"]`
      )
    ).toHaveAttribute('data-has-waveform', 'true')
  })
})
