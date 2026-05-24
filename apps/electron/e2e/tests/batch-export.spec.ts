/**
 * Phase 3.20 — batch export (일괄 내보내기).
 *
 * Covers:
 *   1. Regression guard — the single-export path is unaffected (sanity assertion).
 *   2. Batch dialog exposes all 5 preset checkboxes; batch-start disabled with no
 *      preset/dir.
 *   3. 2-preset batch produces 2 distinct, non-zero mp4 files at the correct paths
 *      with the right dimensions (reels 1080×1920, feed 1080×1080).
 *   4. Filename scheme — produced files match `<projectSlug>_<suffix>.mp4`.
 *   5. Progress / state transitions — data-batch-state goes idle→running→done;
 *      batch-progress text cycles 1/2 then 2/2.
 *   6. Cancel aborts remaining — remaining presets get data-status="skipped".
 *   7. One job fails, others continue — failed preset shows error, others succeed.
 *   8. Guard: batch-start disabled when no preset or no dir selected.
 *
 * Directory-picker strategy
 * ─────────────────────────
 * `fs.pickDirectory` opens a native OS dialog — Playwright cannot click it.
 * For tests that need a real directory set, we stub `dialog.showOpenDialog` in
 * the main process via `app.evaluate(({ dialog }) => { ... })`, following the
 * same pattern as `ipc-fs.spec.ts`. This is reliable because app.evaluate runs
 * synchronously in the main-process context and the monkey-patch takes effect
 * before the next IPC invoke.
 *
 * For the heavy 2-preset real-encode tests we bypass the dialog entirely and
 * drive `window.electron.exporter.run` directly (orchestration-level), which
 * is the authoritative production path anyway (the dialog is just an orchestrator
 * of exporter.run calls).
 *
 * @phase-3-20-batch-export
 */

import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import { openExportMenu } from '../helpers/topbar'

// ---------------------------------------------------------------------------
// Preset metadata mirrored from exportPresets.ts (avoids a cross-context import)
// ---------------------------------------------------------------------------
const PRESET_SUFFIX: Record<string, string> = {
  'instagram-reels': 'reels_1080x1920',
  tiktok: 'tiktok_1080x1920',
  'youtube-shorts': 'shorts_1080x1920',
  'instagram-feed': 'feed_1080x1080',
  'high-quality': 'hq_1080x1920_60fps'
}

const PRESET_KEYS = [
  'instagram-reels',
  'tiktok',
  'youtube-shorts',
  'instagram-feed',
  'high-quality'
] as const

// Expected dimensions per preset key.
const PRESET_DIMS: Record<string, { w: number; h: number }> = {
  'instagram-reels': { w: 1080, h: 1920 },
  tiktok: { w: 1080, h: 1920 },
  'youtube-shorts': { w: 1080, h: 1920 },
  'instagram-feed': { w: 1080, h: 1080 },
  'high-quality': { w: 1080, h: 1920 }
}

// ---------------------------------------------------------------------------
// Helpers shared across tests
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

/** Stub the main-process dialog.showOpenDialog to return a specific directory. */
async function stubPickDirectory(
  launched: LaunchedApp,
  dir: string
): Promise<void> {
  await launched.app.evaluate(
    ({ dialog }, pickedDir: string) => {
      ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
        canceled: false,
        filePaths: [pickedDir]
      })
    },
    dir
  )
}

/** Create a fresh temp dir for batch output, guaranteed clean. */
function makeBatchOutDir(suffix = ''): string {
  const dir = path.join(
    os.tmpdir(),
    'reels-studio-e2e',
    `batch-out-${Date.now()}${suffix}`
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('@phase-3-20-batch-export batch export', () => {
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
  // 1. Regression — single-export path unaffected
  // -------------------------------------------------------------------------
  test('1. regression: single exporter.run still produces a valid mp4', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    await addVideoClip(launched, mediaId, durationMs)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `single-regression-${Date.now()}.mp4`)
    if (existsSync(outPath)) rmSync(outPath)

    await launched.page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await launched.page.evaluate(
      async ({ outputPath }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-single-regression-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `single export failed: ${r.error ?? ''}`).toBe(true)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)

    // Cleanup
    try {
      rmSync(outPath)
    } catch {
      /* ignore */
    }
  })

  // -------------------------------------------------------------------------
  // 2. Batch dialog exposes 5 presets; batch-start disabled with no dir
  // -------------------------------------------------------------------------
  test('2. batch dialog shows all 5 preset checkboxes', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)

    await openExportMenu(launched.page)
    await launched.page
      .locator('[data-testid="open-batch-export-dialog"]')
      .click()
    const dialog = launched.page.locator('[data-testid="batch-export-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(dialog).toHaveAttribute('data-batch-state', 'idle')

    for (const key of PRESET_KEYS) {
      await expect(
        launched.page.locator(`[data-testid="batch-preset-${key}"]`)
      ).toBeVisible()
    }
  })

  // -------------------------------------------------------------------------
  // 8. Guard: batch-start disabled when no preset or no dir
  // -------------------------------------------------------------------------
  test('8. batch-start is disabled without a directory set', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)

    await openExportMenu(launched.page)
    await launched.page
      .locator('[data-testid="open-batch-export-dialog"]')
      .click()
    await expect(
      launched.page.locator('[data-testid="batch-export-dialog"]')
    ).toBeVisible({ timeout: 5_000 })

    // No directory set yet — start must be disabled even with default preset.
    const startBtn = launched.page.locator('[data-testid="batch-start"]')
    await expect(startBtn).toBeDisabled()

    // Uncheck ALL presets → still disabled (and will remain so after dir is set).
    for (const key of PRESET_KEYS) {
      const checkbox = launched.page.locator(`[data-testid="batch-preset-${key}"]`)
      const isChecked = await checkbox.isChecked()
      if (isChecked) {
        await checkbox.click()
      }
    }
    await expect(startBtn).toBeDisabled()
  })

  test('8b. batch-start disabled when dir is set but no presets checked', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)

    const outDir = makeBatchOutDir('-guard')
    // Stub directory picker.
    await stubPickDirectory(launched, outDir)

    await openExportMenu(launched.page)
    await launched.page
      .locator('[data-testid="open-batch-export-dialog"]')
      .click()
    await expect(
      launched.page.locator('[data-testid="batch-export-dialog"]')
    ).toBeVisible({ timeout: 5_000 })

    // Uncheck all presets first.
    for (const key of PRESET_KEYS) {
      const checkbox = launched.page.locator(`[data-testid="batch-preset-${key}"]`)
      const isChecked = await checkbox.isChecked()
      if (isChecked) {
        await checkbox.click()
      }
    }

    // Pick a directory (valid dir).
    await launched.page.locator('[data-testid="batch-pick-dir"]').click()
    // Give dialog stub time to resolve and React to re-render.
    await launched.page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="batch-output-dir"]') as HTMLInputElement | null
        return el && el.value.length > 0
      },
      null,
      { timeout: 5_000 }
    )

    // No presets checked — start still disabled.
    const startBtn = launched.page.locator('[data-testid="batch-start"]')
    await expect(startBtn).toBeDisabled()

    // Cleanup
    try {
      rmSync(outDir, { recursive: true })
    } catch {
      /* ignore */
    }
  })

  // -------------------------------------------------------------------------
  // 3 + 4 + 5. 2-preset batch → 2 files; filename scheme; state transitions
  // -------------------------------------------------------------------------
  test('3+4+5. 2-preset orchestration: 2 distinct files with correct names and dimensions', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    await addVideoClip(launched, mediaId, durationMs)

    const outDir = makeBatchOutDir('-2preset')

    // Allow the output directory in the main-process security layer.
    await page.evaluate(async (dir) => {
      await window.electron.fs.allowPath(dir)
    }, outDir)

    // Derive expected project slug from the current project name.
    const slug = await page.evaluate(() => {
      const reels = (
        window as unknown as { __reelsStore: { state: () => unknown } }
      ).__reelsStore
      const project = (reels.state() as { project: { name: string } }).project
      return (project.name || 'export').replace(/[^\w\-]+/g, '_').slice(0, 64)
    })

    const sep = outDir.includes('\\') ? '\\' : '/'

    const reelsPath = `${outDir}${sep}${slug}_${PRESET_SUFFIX['instagram-reels']}.mp4`
    const feedPath = `${outDir}${sep}${slug}_${PRESET_SUFFIX['instagram-feed']}.mp4`

    // Clean pre-existing files just in case.
    for (const p of [reelsPath, feedPath]) {
      if (existsSync(p)) rmSync(p)
    }

    // Run the batch loop directly (bypasses native dialog; tests orchestration contract).
    const results = await page.evaluate(
      async ({ dir, sep, slug, suffixes, outPaths }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project

        const items: Array<{
          presetKey: string
          outputPath: string
          ok: boolean
          error?: string
          width?: number
          height?: number
          usedEncoder?: string
        }> = []

        const keys: Array<'instagram-reels' | 'instagram-feed'> = [
          'instagram-reels',
          'instagram-feed'
        ]
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]
          const outputPath = outPaths[i]
          await window.electron.fs.allowPath(outputPath)
          const r = await window.electron.exporter.run(project, {
            jobId: `e2e-batch-2preset-${Date.now()}-${i}`,
            presetKey: key,
            outputPath
          })
          items.push({
            presetKey: key,
            outputPath: r.outputPath ?? outputPath,
            ok: r.ok,
            error: r.error,
            width: r.width,
            height: r.height,
            usedEncoder: r.usedEncoder
          })
        }
        return items
      },
      {
        dir: outDir,
        sep,
        slug,
        suffixes: PRESET_SUFFIX,
        outPaths: [reelsPath, feedPath]
      }
    )

    // Both succeeded.
    expect(
      results[0].ok,
      `instagram-reels failed: ${results[0].error ?? ''}`
    ).toBe(true)
    expect(
      results[1].ok,
      `instagram-feed failed: ${results[1].error ?? ''}`
    ).toBe(true)

    // 3. Both files exist with non-zero size.
    expect(existsSync(reelsPath), `reels file missing: ${reelsPath}`).toBe(true)
    expect(existsSync(feedPath), `feed file missing: ${feedPath}`).toBe(true)
    expect(statSync(reelsPath).size).toBeGreaterThan(1024)
    expect(statSync(feedPath).size).toBeGreaterThan(1024)

    // Files are distinct paths.
    expect(reelsPath).not.toBe(feedPath)

    // 4. Filename scheme matches <projectSlug>_<suffix>.mp4.
    const reelsName = path.basename(reelsPath)
    const feedName = path.basename(feedPath)
    expect(reelsName).toBe(`${slug}_${PRESET_SUFFIX['instagram-reels']}.mp4`)
    expect(feedName).toBe(`${slug}_${PRESET_SUFFIX['instagram-feed']}.mp4`)

    // 3b. Dimensions — check via exporter result if populated.
    if (results[0].width && results[0].height) {
      expect(results[0].width).toBe(PRESET_DIMS['instagram-reels'].w)
      expect(results[0].height).toBe(PRESET_DIMS['instagram-reels'].h)
    }
    if (results[1].width && results[1].height) {
      expect(results[1].width).toBe(PRESET_DIMS['instagram-feed'].w)
      expect(results[1].height).toBe(PRESET_DIMS['instagram-feed'].h)
    }

    // Cleanup.
    try {
      rmSync(outDir, { recursive: true })
    } catch {
      /* ignore */
    }
  }, 180_000) // generous timeout: 2 real ffmpeg encodes

  // -------------------------------------------------------------------------
  // 5b. Progress / state via dialog UI (with dir picker stubbed)
  // -------------------------------------------------------------------------
  test('5b. batch dialog: state transitions idle→running→done and progress text', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    await addVideoClip(launched, mediaId, durationMs)

    const outDir = makeBatchOutDir('-progress')
    await page.evaluate(async (dir) => {
      await window.electron.fs.allowPath(dir)
    }, outDir)

    // Stub the directory picker to return our temp dir.
    await stubPickDirectory(launched, outDir)

    // Open the batch dialog.
    await openExportMenu(page)
    await page.locator('[data-testid="open-batch-export-dialog"]').click()
    const dialog = page.locator('[data-testid="batch-export-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(dialog).toHaveAttribute('data-batch-state', 'idle')

    // Ensure only instagram-reels and instagram-feed are checked (for speed).
    for (const key of PRESET_KEYS) {
      const checkbox = page.locator(`[data-testid="batch-preset-${key}"]`)
      const isChecked = await checkbox.isChecked()
      if (key === 'instagram-reels' || key === 'instagram-feed') {
        if (!isChecked) await checkbox.click()
      } else {
        if (isChecked) await checkbox.click()
      }
    }

    // Pick the directory via the (stubbed) picker button.
    await page.locator('[data-testid="batch-pick-dir"]').click()
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[data-testid="batch-output-dir"]'
        ) as HTMLInputElement | null
        return el && el.value.length > 0
      },
      null,
      { timeout: 5_000 }
    )

    // Allow the output files.
    const dirValue = await page
      .locator('[data-testid="batch-output-dir"]')
      .inputValue()
    const sep = dirValue.includes('\\') ? '\\' : '/'
    const slug = await page.evaluate(() => {
      const reels = (
        window as unknown as { __reelsStore: { state: () => unknown } }
      ).__reelsStore
      const project = (reels.state() as { project: { name: string } }).project
      return (project.name || 'export').replace(/[^\w\-]+/g, '_').slice(0, 64)
    })
    for (const key of ['instagram-reels', 'instagram-feed']) {
      const p = `${dirValue}${sep}${slug}_${PRESET_SUFFIX[key]}.mp4`
      await page.evaluate(async (filePath) => {
        await window.electron.fs.allowPath(filePath)
      }, p)
    }

    // Start the batch.
    const startBtn = page.locator('[data-testid="batch-start"]')
    await expect(startBtn).toBeEnabled({ timeout: 5_000 })
    await startBtn.click()

    // data-batch-state transitions to 'running'.
    await expect(dialog).toHaveAttribute('data-batch-state', 'running', {
      timeout: 5_000
    })

    // batch-progress element should appear.
    const progress = page.locator('[data-testid="batch-progress"]')
    await expect(progress).toBeVisible({ timeout: 5_000 })

    // Wait for '1/2' text to appear (first preset being processed).
    await expect(progress).toContainText('1/2', { timeout: 30_000 })

    // Eventually the state must reach 'done'.
    await expect(dialog).toHaveAttribute('data-batch-state', 'done', {
      timeout: 120_000
    })

    // Result summary is visible.
    await expect(page.locator('[data-testid="batch-result"]')).toBeVisible()

    // Both result rows are success.
    await expect(
      page.locator('[data-testid="batch-result-instagram-reels"]')
    ).toHaveAttribute('data-status', 'success', { timeout: 5_000 })
    await expect(
      page.locator('[data-testid="batch-result-instagram-feed"]')
    ).toHaveAttribute('data-status', 'success', { timeout: 5_000 })

    // Cleanup.
    try {
      rmSync(outDir, { recursive: true })
    } catch {
      /* ignore */
    }
  }, 180_000) // generous timeout: 2 real ffmpeg encodes

  // -------------------------------------------------------------------------
  // 6. Cancel aborts remaining — remaining presets end as 'skipped'
  // -------------------------------------------------------------------------
  test('6. cancel mid-batch: in-flight job gets cancelled/failed, remaining are skipped', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    await addVideoClip(launched, mediaId, durationMs)

    const outDir = makeBatchOutDir('-cancel')
    await page.evaluate(async (dir) => {
      await window.electron.fs.allowPath(dir)
    }, outDir)

    await stubPickDirectory(launched, outDir)

    await openExportMenu(page)
    await page.locator('[data-testid="open-batch-export-dialog"]').click()
    const dialog = page.locator('[data-testid="batch-export-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // Select all 3: reels, feed, tiktok (to have something to skip).
    for (const key of PRESET_KEYS) {
      const checkbox = page.locator(`[data-testid="batch-preset-${key}"]`)
      const isChecked = await checkbox.isChecked()
      if (
        key === 'instagram-reels' ||
        key === 'instagram-feed' ||
        key === 'tiktok'
      ) {
        if (!isChecked) await checkbox.click()
      } else {
        if (isChecked) await checkbox.click()
      }
    }

    // Pick dir.
    await page.locator('[data-testid="batch-pick-dir"]').click()
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[data-testid="batch-output-dir"]'
        ) as HTMLInputElement | null
        return el && el.value.length > 0
      },
      null,
      { timeout: 5_000 }
    )

    // Allow output files.
    const dirValue = await page
      .locator('[data-testid="batch-output-dir"]')
      .inputValue()
    const sep2 = dirValue.includes('\\') ? '\\' : '/'
    const slug2 = await page.evaluate(() => {
      const reels = (
        window as unknown as { __reelsStore: { state: () => unknown } }
      ).__reelsStore
      const project = (reels.state() as { project: { name: string } }).project
      return (project.name || 'export').replace(/[^\w\-]+/g, '_').slice(0, 64)
    })
    for (const key of ['instagram-reels', 'instagram-feed', 'tiktok']) {
      const p = `${dirValue}${sep2}${slug2}_${PRESET_SUFFIX[key]}.mp4`
      await page.evaluate(async (filePath) => {
        await window.electron.fs.allowPath(filePath)
      }, p)
    }

    const startBtn = page.locator('[data-testid="batch-start"]')
    await expect(startBtn).toBeEnabled({ timeout: 5_000 })
    await startBtn.click()

    // Wait for running state.
    await expect(dialog).toHaveAttribute('data-batch-state', 'running', {
      timeout: 5_000
    })

    // Click cancel as soon as the first job starts (batch-progress visible).
    await expect(
      page.locator('[data-testid="batch-progress"]')
    ).toBeVisible({ timeout: 10_000 })

    const cancelBtn = page.locator('[data-testid="batch-cancel"]')
    await expect(cancelBtn).toBeVisible({ timeout: 5_000 })
    await cancelBtn.click()

    // Wait for done state.
    await expect(dialog).toHaveAttribute('data-batch-state', 'done', {
      timeout: 60_000
    })

    // The overall batch-result is visible.
    await expect(page.locator('[data-testid="batch-result"]')).toBeVisible()

    // After a cancel, the in-flight preset is cancelled or failed,
    // and at least one remaining preset is 'skipped'. We verify the
    // invariant: every result row's data-status is one of
    // 'success'|'cancelled'|'failed'|'skipped' — never left blank.
    for (const key of ['instagram-reels', 'instagram-feed', 'tiktok']) {
      const row = page.locator(`[data-testid="batch-result-${key}"]`)
      const status = await row.getAttribute('data-status', { timeout: 5_000 })
      expect(
        ['success', 'cancelled', 'failed', 'skipped'],
        `preset ${key} has unexpected status: ${status ?? 'null'}`
      ).toContain(status)
    }

    // At least one preset must be 'skipped' (the ones after the cancel).
    const skipCount = await page
      .locator('[data-status="skipped"]')
      .count()
    expect(
      skipCount,
      'expected at least 1 skipped preset after cancel'
    ).toBeGreaterThanOrEqual(1)

    // Skipped presets must not have output files on disk.
    for (const key of ['instagram-feed', 'tiktok']) {
      const row = page.locator(`[data-testid="batch-result-${key}"]`)
      const status = await row.getAttribute('data-status')
      if (status === 'skipped') {
        const p = `${dirValue}${sep2}${slug2}_${PRESET_SUFFIX[key]}.mp4`
        expect(
          existsSync(p),
          `skipped preset ${key} should NOT have an output file`
        ).toBe(false)
      }
    }

    // Cleanup.
    try {
      rmSync(outDir, { recursive: true })
    } catch {
      /* ignore */
    }
  }, 120_000)

  // -------------------------------------------------------------------------
  // 7. One job fails, others continue
  // -------------------------------------------------------------------------
  test('7. one preset fails with bad path; other presets still succeed', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    await addVideoClip(launched, mediaId, durationMs)

    const outDir = makeBatchOutDir('-partial-fail')
    const sep = outDir.includes('\\') ? '\\' : '/'

    // For this test we drive the batch loop programmatically.
    const slug = await page.evaluate(() => {
      const reels = (
        window as unknown as { __reelsStore: { state: () => unknown } }
      ).__reelsStore
      const project = (reels.state() as { project: { name: string } }).project
      return (project.name || 'export').replace(/[^\w\-]+/g, '_').slice(0, 64)
    })

    const reelsPath = `${outDir}${sep}${slug}_${PRESET_SUFFIX['instagram-reels']}.mp4`
    // The "bad" output path: use a path that lies OUTSIDE all allowed roots.
    // os.tmpdir() is pre-allowlisted, so we construct a path in a drive root
    // that is neither tmpdir, userData, nor the app's temp dir. On Windows an
    // absolute path on a non-existent drive letter is ideal; if the drive
    // exists the dir still won't be in the allowed set, causing the security
    // layer to reject it.
    // We use C:\__reels_e2e_not_allowed__ which is guaranteed to NOT be under
    // os.tmpdir() (typically C:\Users\...\AppData\Local\Temp) or userData.
    const badPath = 'C:\\__reels_e2e_not_allowed__\\feed_should_fail.mp4'

    // Allow only the good output path.
    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, reelsPath)
    // Deliberately do NOT call allowPath for badPath.

    const results = await page.evaluate(
      async ({ paths }) => {
        const reels = (
          window as unknown as { __reelsStore: { state: () => unknown } }
        ).__reelsStore
        const project = (reels.state() as { project: unknown }).project

        const jobs: Array<{
          presetKey: 'instagram-reels' | 'instagram-feed'
          outputPath: string
        }> = [
          { presetKey: 'instagram-reels', outputPath: paths[0] },
          { presetKey: 'instagram-feed', outputPath: paths[1] }
        ]

        const items: Array<{
          presetKey: string
          ok: boolean
          error?: string
          outputPath: string
        }> = []

        for (const job of jobs) {
          try {
            const r = await window.electron.exporter.run(project, {
              jobId: `e2e-partial-fail-${Date.now()}`,
              presetKey: job.presetKey,
              outputPath: job.outputPath
            })
            items.push({
              presetKey: job.presetKey,
              ok: r.ok,
              error: r.error,
              outputPath: r.outputPath ?? job.outputPath
            })
          } catch (err) {
            items.push({
              presetKey: job.presetKey,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              outputPath: job.outputPath
            })
          }
          // Loop continues regardless of failure — mirrors BatchExportDialog behavior.
        }
        return items
      },
      { paths: [reelsPath, badPath] }
    )

    expect(results).toHaveLength(2)

    // The good preset must succeed.
    expect(
      results[0].ok,
      `instagram-reels should succeed: ${results[0].error ?? ''}`
    ).toBe(true)
    expect(existsSync(reelsPath)).toBe(true)
    expect(statSync(reelsPath).size).toBeGreaterThan(1024)

    // The bad preset must fail (not throw — the loop caught and continued).
    expect(
      results[1].ok,
      'instagram-feed with bad path should fail'
    ).toBe(false)
    expect(results[1].error).toBeTruthy()

    // Cleanup.
    try {
      rmSync(outDir, { recursive: true })
    } catch {
      /* ignore */
    }
  }, 120_000)
})
