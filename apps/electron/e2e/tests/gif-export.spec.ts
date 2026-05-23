/**
 * Phase 3.28 — animated GIF export.
 *
 * Covers:
 *   1. Export dialog exposes GIF preset button; EXPORT_PRESET_KEYS has 6 entries.
 *   2. exporter.run with presetKey='gif' produces a valid .gif (ok=true, size>1KB,
 *      GIF89a magic bytes).
 *   3. GIF is animated (>1 frame).
 *   4. GIF has no audio stream.
 *   5. Output extension coercion — wrong ext (.mp4) → result ends .gif.
 *   6. Temp file cleanup — gif-temp-*.mp4 is removed after the run.
 *   7. mp4 presets unaffected — buildPlan for 'instagram-reels' still returns
 *      scale=1080:1920, concat=n=2 (or xfade), 8000k; buildPlan for 'gif'
 *      returns the short-circuit synthetic result (ok, no crash).
 *   8. Batch dialog includes gif preset; filename preview ends .gif.
 *   9. Duration warning — >30s project + gif preset → warning visible;
 *      short project → not visible.
 *
 * @phase-3-28-gif-export
 */

import { expect, test } from '@playwright/test'
import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Preset metadata (mirrored from exportPresets.ts)
// ---------------------------------------------------------------------------
const PRESET_SUFFIX_GIF = 'gif_480'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.locator('[data-testid="open-editor-button"]').click()
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
    null,
    { timeout: 5_000 }
  )
}

async function addFixtureMedia(
  launched: LaunchedApp
): Promise<{ mediaId: string; durationMs: number; path: string }> {
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
  launched: LaunchedApp,
  mediaId: string,
  durationMs: number,
  startMs = 0
): Promise<string> {
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

/**
 * Probe the given GIF file with the bundled ffmpeg and return the frame count
 * by parsing the final `frame=N` line from progress output. Returns -1 on
 * parse failure (should not block the test, just cause it to fail descriptively).
 */
function probeGifFrameCount(gifPath: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const ffmpegPath = process.env.E2E_FFMPEG_PATH ?? 'ffmpeg'
    // -f null -  forces full decode; progress output includes `frame=N`
    const proc = spawn(
      ffmpegPath,
      ['-hide_banner', '-i', gifPath, '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    let output = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (c: string) => { output += c })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (c: string) => { output += c })
    proc.on('error', () => resolve(-1))
    proc.on('close', () => {
      // Parse the last occurrence of "frame=NNN" (with optional spaces)
      const matches = [...output.matchAll(/frame=\s*(\d+)/g)]
      if (matches.length === 0) {
        resolve(-1)
        return
      }
      const last = matches[matches.length - 1]
      resolve(parseInt(last[1], 10))
    })
    setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
      resolve(-1)
    }, 30_000)
  })
}

/**
 * Probe the given file for audio streams using ffmpeg stderr output.
 * Returns true if any `Audio:` stream is found.
 */
function probeHasAudio(filePath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const ffmpegPath = process.env.E2E_FFMPEG_PATH ?? 'ffmpeg'
    const proc = spawn(
      ffmpegPath,
      ['-hide_banner', '-i', filePath],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (c: string) => { stderr += c })
    proc.on('error', () => resolve(false))
    proc.on('close', () => {
      resolve(/Stream #\d+:\d+[^\n]*Audio:/.test(stderr))
    })
    setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
      resolve(false)
    }, 10_000)
  })
}

/** Create a fresh temp dir for output, guaranteed clean. */
function makeTmpDir(suffix = ''): string {
  const dir = path.join(
    os.tmpdir(),
    'reels-studio-e2e',
    `gif-out-${Date.now()}${suffix}`
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('@phase-3-28-gif-export animated GIF export', () => {
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
  // 1. Export dialog exposes GIF preset; EXPORT_PRESET_KEYS has 6 entries
  // -------------------------------------------------------------------------
  test('1. ExportDialog exposes export-preset-gif; EXPORT_PRESET_KEYS has 6 presets', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    await page.locator('[data-testid="open-export-dialog"]').click()
    await expect(page.locator('[data-testid="export-dialog"]')).toBeVisible()

    // All 6 preset buttons must be visible.
    for (const key of [
      'instagram-reels',
      'tiktok',
      'youtube-shorts',
      'instagram-feed',
      'high-quality',
      'gif'
    ]) {
      await expect(
        page.locator(`[data-testid="export-preset-${key}"]`)
      ).toBeVisible()
    }

    // Verify that the renderer's EXPORT_PRESET_KEYS array has exactly 6 items.
    const keyCount = await page.evaluate(() => {
      // Access via the store's module — we import from the renderer bundle at runtime.
      // The BatchExportDialog loops EXPORT_PRESET_KEYS to render checkboxes, so
      // we count the visible batch-preset-* checkboxes as a proxy.
      // Alternatively we can inspect the preset buttons already in DOM.
      const buttons = document.querySelectorAll('[data-testid^="export-preset-"]')
      return buttons.length
    })
    expect(keyCount, 'expected exactly 6 export preset buttons').toBe(6)
  })

  // -------------------------------------------------------------------------
  // 2. GIF export produces a valid .gif with GIF89a magic bytes
  // -------------------------------------------------------------------------
  test('2. exporter.run with presetKey=gif produces a valid GIF89a file', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    await addVideoClip(launched, mediaId, durationMs)

    const outDir = makeTmpDir('-valid')
    const outPath = path.join(outDir, `test-${Date.now()}.gif`)

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
          jobId: `e2e-gif-valid-${Date.now()}`,
          presetKey: 'gif',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `GIF export failed: ${r.error ?? ''}`).toBe(true)
    // outputPath must end with .gif (possibly coerced from outPath)
    const actualPath: string = r.outputPath ?? outPath
    expect(actualPath.toLowerCase().endsWith('.gif')).toBe(true)
    expect(existsSync(actualPath), `GIF file missing at ${actualPath}`).toBe(true)
    expect(statSync(actualPath).size).toBeGreaterThan(1024)

    // Validate GIF magic bytes: "GIF87a" or "GIF89a" (ffmpeg writes GIF89a).
    const buf = readFileSync(actualPath)
    const header = buf.slice(0, 6).toString('ascii')
    expect(
      header === 'GIF89a' || header === 'GIF87a',
      `expected GIF magic bytes, got: ${JSON.stringify(header)}`
    ).toBe(true)

    // Cleanup
    try { rmSync(outDir, { recursive: true }) } catch { /* ignore */ }
  }, 120_000)

  // -------------------------------------------------------------------------
  // 3. GIF is animated (>1 frame)
  // -------------------------------------------------------------------------
  test('3. exported GIF is animated (more than 1 frame)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    // The fixture is 5s at 24fps; at 15fps the GIF should have ~75 frames.
    await addVideoClip(launched, mediaId, durationMs)

    const outDir = makeTmpDir('-anim')
    const outPath = path.join(outDir, `anim-${Date.now()}.gif`)

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
          jobId: `e2e-gif-anim-${Date.now()}`,
          presetKey: 'gif',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `GIF export failed: ${r.error ?? ''}`).toBe(true)
    const actualPath: string = r.outputPath ?? outPath

    // Probe frame count via bundled ffmpeg.
    const frameCount = await probeGifFrameCount(actualPath)
    expect(
      frameCount,
      `probeGifFrameCount returned ${frameCount} — could not parse`
    ).toBeGreaterThan(-1)
    expect(
      frameCount,
      `expected animated GIF (>1 frame) but got ${frameCount} frames`
    ).toBeGreaterThan(1)

    // Cleanup
    try { rmSync(outDir, { recursive: true }) } catch { /* ignore */ }
  }, 120_000)

  // -------------------------------------------------------------------------
  // 4. GIF has no audio stream
  // -------------------------------------------------------------------------
  test('4. exported GIF has no audio stream', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    await addVideoClip(launched, mediaId, durationMs)

    const outDir = makeTmpDir('-noaudio')
    const outPath = path.join(outDir, `noaudio-${Date.now()}.gif`)

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
          jobId: `e2e-gif-noaudio-${Date.now()}`,
          presetKey: 'gif',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `GIF export failed: ${r.error ?? ''}`).toBe(true)
    const actualPath: string = r.outputPath ?? outPath

    const hasAudio = await probeHasAudio(actualPath)
    expect(hasAudio, 'GIF must not contain an audio stream').toBe(false)

    // Cleanup
    try { rmSync(outDir, { recursive: true }) } catch { /* ignore */ }
  }, 120_000)

  // -------------------------------------------------------------------------
  // 5. Output extension coercion — wrong ext (.mp4) → result ends .gif
  // -------------------------------------------------------------------------
  test('5. output extension coerced from .mp4 to .gif', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    await addVideoClip(launched, mediaId, durationMs)

    const outDir = makeTmpDir('-coerce')
    // Deliberately pass a .mp4 path for a GIF export.
    const wrongExtPath = path.join(outDir, `coerce-${Date.now()}.mp4`)

    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, wrongExtPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-gif-coerce-${Date.now()}`,
          presetKey: 'gif',
          outputPath
        })
      },
      { outputPath: wrongExtPath }
    )

    expect(r.ok, `GIF export failed: ${r.error ?? ''}`).toBe(true)
    // The reported outputPath must end .gif
    const actualPath: string = r.outputPath ?? wrongExtPath
    expect(
      actualPath.toLowerCase().endsWith('.gif'),
      `expected result.outputPath to end .gif but got: ${actualPath}`
    ).toBe(true)
    expect(existsSync(actualPath)).toBe(true)

    // The .mp4 path should NOT exist (it was coerced away).
    expect(
      existsSync(wrongExtPath),
      '.mp4 path should not exist — extension was coerced to .gif'
    ).toBe(false)

    // Cleanup
    try { rmSync(outDir, { recursive: true }) } catch { /* ignore */ }
  }, 120_000)

  // -------------------------------------------------------------------------
  // 6. Temp file cleanup — gif-temp-*.mp4 removed after run
  // -------------------------------------------------------------------------
  test('6. gif-temp-*.mp4 is cleaned up after a successful GIF export', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    await addVideoClip(launched, mediaId, durationMs)

    const outDir = makeTmpDir('-cleanup')
    const jobId = `e2e-gif-cleanup-${Date.now()}`
    const outPath = path.join(outDir, `cleanup-${Date.now()}.gif`)

    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath, jid }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.run(project, {
          jobId: jid,
          presetKey: 'gif',
          outputPath
        })
      },
      { outputPath: outPath, jid: jobId }
    )

    expect(r.ok, `GIF export failed: ${r.error ?? ''}`).toBe(true)

    // The temp mp4 for this job ID must not exist after the run.
    const tempName = `gif-temp-${jobId}.mp4`
    const tempPath = path.join(outDir, tempName)
    expect(
      existsSync(tempPath),
      `temp file ${tempName} should have been cleaned up`
    ).toBe(false)

    // Belt-and-suspenders: scan the entire output dir for any gif-temp-*.mp4.
    const leaked = readdirSync(outDir).filter((f) => f.startsWith('gif-temp-') && f.endsWith('.mp4'))
    expect(
      leaked.length,
      `leaked gif-temp files found: ${leaked.join(', ')}`
    ).toBe(0)

    // Cleanup
    try { rmSync(outDir, { recursive: true }) } catch { /* ignore */ }
  }, 120_000)

  // -------------------------------------------------------------------------
  // 7. mp4 presets unaffected + buildPlan for gif returns synthetic result
  // -------------------------------------------------------------------------
  test('7. buildPlan for instagram-reels unchanged; buildPlan for gif returns synthetic ok result', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    await addVideoClip(launched, mediaId, durationMs, 0)
    await addVideoClip(launched, mediaId, durationMs, durationMs)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `gif-plan-mp4-${Date.now()}.mp4`)
    const outPathGif = path.join(os.tmpdir(), 'reels-studio-e2e', `gif-plan-gif-${Date.now()}.gif`)

    // buildPlan for instagram-reels (2-clip project).
    const mp4Plan = await page.evaluate(
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

    expect(mp4Plan.ok, `buildPlan instagram-reels failed: ${mp4Plan.error ?? ''}`).toBe(true)
    expect(mp4Plan.videoSegmentCount).toBe(2)
    expect(mp4Plan.filterGraph).toBeTruthy()
    expect(mp4Plan.filterGraph).toContain('scale=1080:1920')
    // 2-clip project uses concat=n=2 (or xfade if available).
    const hasConcat = (mp4Plan.filterGraph as string).includes('concat=n=2')
    const hasXfade = (mp4Plan.filterGraph as string).includes('xfade=transition=fade')
    expect(
      hasConcat || hasXfade,
      `expected concat=n=2 or xfade in filterGraph, got: ${mp4Plan.filterGraph}`
    ).toBe(true)
    expect(mp4Plan.argvPreview).toContain('8000k')
    expect(mp4Plan.argvPreview).toContain('-b:v')

    // buildPlan for gif — must return ok=true (short-circuit) and not crash.
    const gifPlan = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(
          project,
          'gif',
          outputPath
        )
      },
      { outputPath: outPathGif }
    )

    expect(gifPlan.ok, `buildPlan gif should return ok=true (synthetic)`).toBe(true)
    // The synthetic argvPreview describes the 2-pass approach.
    expect(
      gifPlan.argvPreview,
      'expected GIF 2-pass description in argvPreview'
    ).toContain('GIF')
    // The filterGraph is the palettegen/paletteuse chain.
    expect(gifPlan.filterGraph).toBeTruthy()
    expect(
      (gifPlan.filterGraph as string).includes('palettegen') || (gifPlan.filterGraph as string).includes('fps=15'),
      'expected palettegen or fps=15 in gif filterGraph'
    ).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 8. Batch dialog includes gif preset; filename preview ends .gif
  // -------------------------------------------------------------------------
  test('8. BatchExportDialog shows batch-preset-gif; filename preview ends .gif', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)

    await page.locator('[data-testid="open-batch-export-dialog"]').click()
    const dialog = page.locator('[data-testid="batch-export-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // The gif checkbox must be present.
    await expect(
      page.locator('[data-testid="batch-preset-gif"]')
    ).toBeVisible()

    // Select gif and deselect others so the filename preview only shows gif.
    // First uncheck all, then check gif only.
    for (const key of ['instagram-reels', 'tiktok', 'youtube-shorts', 'instagram-feed', 'high-quality']) {
      const checkbox = page.locator(`[data-testid="batch-preset-${key}"]`)
      if (await checkbox.isChecked()) {
        await checkbox.click()
      }
    }
    const gifCheckbox = page.locator('[data-testid="batch-preset-gif"]')
    if (!(await gifCheckbox.isChecked())) {
      await gifCheckbox.click()
    }

    // The filename preview for gif must end .gif.
    const gifFilenameEl = page.locator('[data-testid="batch-filename-gif"]')
    await expect(gifFilenameEl).toBeVisible({ timeout: 4_000 })
    const gifFilenameText = await gifFilenameEl.textContent()
    expect(
      gifFilenameText?.endsWith('.gif') ?? false,
      `expected gif filename preview to end .gif, got: ${gifFilenameText}`
    ).toBe(true)
    // Must contain the gif suffix.
    expect(gifFilenameText).toContain(PRESET_SUFFIX_GIF)
  })

  // -------------------------------------------------------------------------
  // 9. Duration warning — >30s project → warning visible; short → not visible
  // -------------------------------------------------------------------------
  test('9. export-gif-duration-warning shown for >30s project; hidden for short project', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)

    // Build a project that is longer than 30s by stacking many clips end-to-end.
    // The fixture is 5s; we need >30s, so add 7 back-to-back copies = 35s.
    const clipCount = 7
    for (let i = 0; i < clipCount; i++) {
      await addVideoClip(launched, mediaId, durationMs, i * durationMs)
    }

    // Open the export dialog and select GIF.
    await page.locator('[data-testid="open-export-dialog"]').click()
    await expect(page.locator('[data-testid="export-dialog"]')).toBeVisible()

    await page.locator('[data-testid="export-preset-gif"]').click()

    // Warning must be visible for a >30s project with GIF selected.
    await expect(
      page.locator('[data-testid="export-gif-duration-warning"]')
    ).toBeVisible({ timeout: 4_000 })

    // Switch to instagram-reels — warning must disappear.
    await page.locator('[data-testid="export-preset-instagram-reels"]').click()
    await expect(
      page.locator('[data-testid="export-gif-duration-warning"]')
    ).not.toBeVisible({ timeout: 4_000 })

    // Close dialog and create a short project (single 5s clip).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    // Reset to a fresh project with only one clip.
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

    // Add a single short clip.
    const { mediaId: midShort, durationMs: durShort } = await addFixtureMedia(launched)
    await addVideoClip(launched, midShort, durShort)

    // Open dialog again, select GIF.
    await page.locator('[data-testid="open-export-dialog"]').click()
    await expect(page.locator('[data-testid="export-dialog"]')).toBeVisible()
    await page.locator('[data-testid="export-preset-gif"]').click()

    // Warning must NOT be visible for a 5s project.
    await expect(
      page.locator('[data-testid="export-gif-duration-warning"]')
    ).not.toBeVisible({ timeout: 4_000 })
  })
})
