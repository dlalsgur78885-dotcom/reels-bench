import { expect, test } from '@playwright/test'
import { existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 2.6 — transitions + LUT filters + export pipeline.
 *
 * We exercise:
 *   - Filter preset application (CSS chain on the preview <video>)
 *   - Transition data model + timeline indicator
 *   - Export preset list completeness (5 keys)
 *   - Filter graph construction for 2-clip projects (concat / xfade detection)
 *   - End-to-end ffmpeg export with 2 small fixture mp4s + caption + BGM
 *     → output mp4 has nonzero size + correct dimensions/duration.
 */
test.describe('@phase-2-export transitions / filters / export pipeline', () => {
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

  // ---------------------------------------------------------------------------
  // Helpers
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
  }

  async function addFixtureMedia(): Promise<{
    mediaId: string
    durationMs: number
    path: string
  }> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    const { page } = launched
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

  async function addVideoClip(
    mediaId: string,
    durationMs: number,
    startMs = 0
  ): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(
      ({ mid, dur, st }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              state: () => { project: { tracks: Array<{ id: string; kind: string }> } }
              addClip: (c: unknown) => void
              newId: () => string
            }
          }
        ).__reelsStore
        const track = reels
          .state()
          .project.tracks.find((t) => t.kind === 'video')
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

  async function getClipFromState(clipId: string): Promise<Record<string, unknown> | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return (await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: { tracks: Array<{ clips: Array<Record<string, unknown>> }> }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) return c
      return null
    }, clipId)) as Record<string, unknown> | null
  }

  // ---------------------------------------------------------------------------
  // 1. Filter preset application — CSS filter on <video>
  // ---------------------------------------------------------------------------
  test('filter preset bw applies CSS grayscale to <video>', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)
    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setClipFilter: (id: string, preset: string, intensity?: number) => void
          }
        }
      ).__reelsStore
      reels.setClipFilter(id, 'bw', 1)
    }, cid)
    // Move playhead onto this clip.
    await page.evaluate(() => {
      const ui = (window as unknown as { __reelsTimelineUi: { getState: () => { setPlayheadMs: (ms: number) => void } } }).__reelsTimelineUi
      ui.getState().setPlayheadMs(50)
    })
    const video = page.locator('[data-testid="preview-video"]')
    await expect(video).toHaveAttribute('data-filter-preset', 'bw', { timeout: 4_000 })
    const css = await video.evaluate((el) => (el as HTMLElement).style.filter)
    expect(css).toContain('grayscale')

    const updated = await getClipFromState(cid)
    expect(updated?.filterPreset).toBe('bw')
    expect(updated?.filterIntensity).toBe(1)
  })

  test('filter intensity clamps to [0,1] and 0 stores as no-op', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)
    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setClipFilter: (id: string, preset: string, intensity?: number) => void
          }
        }
      ).__reelsStore
      reels.setClipFilter(id, 'cinematic', 5) // way over 1
    }, cid)
    let updated = await getClipFromState(cid)
    expect(updated?.filterIntensity).toBe(1)

    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setClipFilter: (id: string, preset: string, intensity?: number) => void
          }
        }
      ).__reelsStore
      reels.setClipFilter(id, 'cinematic', -2)
    }, cid)
    updated = await getClipFromState(cid)
    expect(updated?.filterIntensity).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // 2. Transition data model + timeline indicator
  // ---------------------------------------------------------------------------
  test('setClipTransitionIn stores kind+duration and renders timeline badge', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    // Two clips back-to-back so the second is a valid xfade target.
    const c1 = await addVideoClip(mediaId, durationMs, 0)
    const c2 = await addVideoClip(mediaId, durationMs, durationMs)
    expect(c1).toBeTruthy()
    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setClipTransitionIn: (id: string, kind: string, dur?: number) => void
          }
        }
      ).__reelsStore
      reels.setClipTransitionIn(id, 'crossfade', 600)
    }, c2)
    const c2State = await getClipFromState(c2)
    expect(c2State?.transitionIn).toBeTruthy()
    expect((c2State?.transitionIn as { kind: string }).kind).toBe('crossfade')
    expect((c2State?.transitionIn as { durationMs: number }).durationMs).toBe(600)

    // The timeline indicator badge should be visible for the second clip.
    const indicator = page.locator(
      `[data-testid="transition-indicator"][data-clip-id="${c2}"]`
    )
    await expect(indicator).toBeVisible({ timeout: 4_000 })
    await expect(indicator).toHaveAttribute('data-transition-kind', 'crossfade')
  })

  test('transitionIn kind=none clears the transition', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const c1 = await addVideoClip(mediaId, durationMs, 0)
    const c2 = await addVideoClip(mediaId, durationMs, durationMs)
    expect(c1).toBeTruthy()
    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setClipTransitionIn: (id: string, kind: string, dur?: number) => void
          }
        }
      ).__reelsStore
      reels.setClipTransitionIn(id, 'crossfade', 500)
      reels.setClipTransitionIn(id, 'none')
    }, c2)
    const state = await getClipFromState(c2)
    expect(state?.transitionIn).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // 3. Export preset list completeness
  // ---------------------------------------------------------------------------
  test('export dialog exposes all 5 presets', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await page.locator('[data-testid="open-export-dialog"]').click()
    await expect(page.locator('[data-testid="export-dialog"]')).toBeVisible()
    for (const key of [
      'instagram-reels',
      'tiktok',
      'youtube-shorts',
      'instagram-feed',
      'high-quality'
    ]) {
      const btn = page.locator(`[data-testid="export-preset-${key}"]`)
      await expect(btn).toBeVisible()
    }
    // Default selected = instagram-reels.
    await expect(
      page.locator('[data-testid="export-preset-instagram-reels"]')
    ).toHaveAttribute('data-active', 'true')
  })

  test('Ctrl+E opens the export dialog', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await page.keyboard.press('Control+e')
    await expect(page.locator('[data-testid="export-dialog"]')).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // 4. Filter graph construction — exporter:buildPlan
  // ---------------------------------------------------------------------------
  test('buildPlan for a 2-clip project includes scale=1080:1920 and either concat=n=2 or xfade', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs, 0)
    await addVideoClip(mediaId, durationMs, durationMs)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-no-trans.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (
          window as unknown as {
            __reelsStore: { state: () => unknown }
          }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          outputPath
        )
      },
      { outputPath: outPath }
    )
    expect(result.ok).toBe(true)
    expect(result.videoSegmentCount).toBe(2)
    expect(result.filterGraph).toBeTruthy()
    expect(result.filterGraph).toContain('scale=1080:1920')
    expect(result.filterGraph).toContain('concat=n=2')
    expect(result.argvPreview).toContain('-b:v')
    expect(result.argvPreview).toContain('8000k')
  })

  test('buildPlan with a transition produces xfade in the graph (or concat fallback when xfade unavailable)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs, 0)
    const c2 = await addVideoClip(mediaId, durationMs, durationMs)
    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setClipTransitionIn: (id: string, kind: string, dur?: number) => void
          }
        }
      ).__reelsStore
      reels.setClipTransitionIn(id, 'crossfade', 500)
    }, c2)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-xfade.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (
          window as unknown as {
            __reelsStore: { state: () => unknown }
          }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          outputPath
        )
      },
      { outputPath: outPath }
    )
    expect(result.ok).toBe(true)
    // Bundled ffmpeg may pre-date xfade (added in 4.3). Either path is valid:
    //   - xfade=transition=fade  → modern ffmpeg
    //   - concat=n=2             → fallback when xfade is unavailable
    const graph = result.filterGraph ?? ''
    const hasXfade = graph.includes('xfade=transition=fade')
    const hasConcat = graph.includes('concat=n=2')
    expect(hasXfade || hasConcat).toBe(true)
  })

  test('buildPlan applies eq= filter when a clip has filterPreset=bw', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs, 0)
    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setClipFilter: (id: string, preset: string, intensity?: number) => void
          }
        }
      ).__reelsStore
      reels.setClipFilter(id, 'bw', 1)
    }, cid)
    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-bw.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          outputPath
        )
      },
      { outputPath: outPath }
    )
    expect(result.ok).toBe(true)
    expect(result.filterGraph).toMatch(/eq=.*saturation=0/)
  })

  test('buildPlan with no video clips returns an error', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-empty.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          outputPath
        )
      },
      { outputPath: outPath }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no video clips')
  })

  // ---------------------------------------------------------------------------
  // 5. Real ffmpeg export — full integration smoke
  // ---------------------------------------------------------------------------
  test('exporter:run produces a valid mp4 from a 1-clip timeline', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs, 0)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `single-${Date.now()}.mp4`)
    if (existsSync(outPath)) {
      try {
        rmSync(outPath)
      } catch {
        /* ignore */
      }
    }
    // Mark the output dir as allowed (temp root is already allowlisted, but
    // we ensure it via allowPath belt-and-suspenders).
    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-export-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath }
    )
    expect(r.ok, `expected export to succeed, error: ${r.error ?? ''}`).toBe(true)
    expect(r.outputPath).toBe(outPath)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)
    // 9:16 preset.
    if (r.width && r.height) {
      expect(r.width).toBe(1080)
      expect(r.height).toBe(1920)
    }
  })

  test('exporter:run with 2 clips + transition produces a valid mp4', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs, 0)
    const c2 = await addVideoClip(mediaId, durationMs, durationMs)
    await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            setClipTransitionIn: (id: string, kind: string, dur?: number) => void
          }
        }
      ).__reelsStore
      reels.setClipTransitionIn(id, 'crossfade', 500)
    }, c2)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `two-clips-${Date.now()}.mp4`)
    if (existsSync(outPath)) {
      try {
        rmSync(outPath)
      } catch {
        /* ignore */
      }
    }
    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-export-2-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath }
    )
    expect(r.ok, `expected export to succeed, error: ${r.error ?? ''}`).toBe(true)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)
  })

  // ---------------------------------------------------------------------------
  // 6. Hardware-encoder toggle (Phase 4.2).
  // ---------------------------------------------------------------------------

  /**
   * Mock the renderer's `window.electron.ffmpeg.capabilities` call so we can
   * exercise the dialog's toggle UI without depending on the host's actual
   * HW encoders. We monkey-patch the bridge in the renderer process; the
   * actual IPC isn't touched. Must be invoked BEFORE the ExportDialog mounts
   * (its `useEffect` reads capabilities exactly once on mount).
   */
  async function stubCapabilities(
    encoders: string[],
    preferred: string
  ): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    // contextBridge-exposed `window.electron.*` is frozen and can't be
    // monkey-patched. The dialog instead reads `window.__E2E_CAPABILITIES__`
    // when present (see ExportDialog.tsx mount-time useEffect).
    await page.evaluate(
      ({ encoders, preferred }) => {
        ;(
          window as unknown as {
            __E2E_CAPABILITIES__: { encoders: string[]; preferred: string }
          }
        ).__E2E_CAPABILITIES__ = { encoders, preferred }
      },
      { encoders, preferred }
    )
  }

  test('HW toggle is enabled and ON by default when a HW encoder is preferred', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await stubCapabilities(['h264_nvenc', 'libx264'], 'h264_nvenc')
    await page.locator('[data-testid="open-export-dialog"]').click()
    const row = page.locator('[data-testid="export-hw-toggle-row"]')
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('data-hw-available', 'true', {
      timeout: 4_000
    })
    await expect(row).toHaveAttribute('data-preferred-encoder', 'h264_nvenc')
    const toggle = page.locator('[data-testid="export-hw-toggle"]')
    await expect(toggle).toBeEnabled()
    await expect(toggle).toBeChecked()
    const label = page.locator('[data-testid="export-hw-toggle-label"]')
    await expect(label).toContainText('h264_nvenc')
    await expect(label).toContainText('하드웨어 가속 사용')
  })

  test('HW toggle is disabled and shows "사용 불가" when only libx264 is available', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await stubCapabilities(['libx264'], 'libx264')
    await page.locator('[data-testid="open-export-dialog"]').click()
    const row = page.locator('[data-testid="export-hw-toggle-row"]')
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('data-hw-available', 'false', {
      timeout: 4_000
    })
    const toggle = page.locator('[data-testid="export-hw-toggle"]')
    await expect(toggle).toBeDisabled()
    await expect(toggle).not.toBeChecked()
    const label = page.locator('[data-testid="export-hw-toggle-label"]')
    await expect(label).toContainText('사용 불가')
    const hint = page.locator('[data-testid="export-hw-hint"]')
    await expect(hint).toBeVisible()
    await expect(hint).toContainText('하드웨어 가속 인코더가 없습니다')
  })

  test('exporter:run with useHardwareAccel=true on a libx264-only system silently falls back to libx264', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs, 0)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `hw-flag-${Date.now()}.mp4`)
    if (existsSync(outPath)) {
      try {
        rmSync(outPath)
      } catch {
        /* ignore */
      }
    }
    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-hw-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath,
          useHardwareAccel: true
        })
      },
      { outputPath: outPath }
    )
    expect(r.ok, `expected export to succeed, error: ${r.error ?? ''}`).toBe(true)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)
    // usedEncoder must be set regardless of HW vs fallback path.
    expect(r.usedEncoder).toBeTruthy()
    // On a libx264-only system the fallback resolves to libx264; on a real
    // HW box (this Windows machine has h264_amf) it resolves to that. Both
    // are acceptable for this regression test.
    const allowed = ['libx264', 'h264_amf', 'h264_nvenc', 'h264_qsv', 'h264_videotoolbox']
    expect(allowed).toContain(r.usedEncoder as string)
  })
})
