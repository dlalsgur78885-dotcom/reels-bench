/**
 * @phase-3-34-subtitle-export — SRT / VTT subtitle export.
 *
 * Contract tested:
 *
 *  (1)  Builder correctness (pure, via window.__reelsSubtitleExport):
 *         - captionsToSrt: cue index, timestamp regex, span text, blank separator
 *         - captionsToVtt: WEBVTT header, dot separator in timestamps
 *         - formatTimestamp: srt comma, vtt dot, edge cases (0 ms, 1h+)
 *  (2)  Sort + index — out-of-order startMs → ascending, contiguous 1..N
 *  (3)  Empty-text clips dropped — empty spans omitted; indices stay contiguous
 *  (4)  End-to-end write (SRT + VTT) — stub saveFile dialog, click button,
 *         assert file on disk, content === pure builder output
 *  (5)  Empty project → export-srt-button is disabled
 *  (6)  Special characters — Korean + emoji + XML metacharacters verbatim in file
 *  (7)  mp4 export unaffected — buildPlan filterGraph identical before/after subtitle export
 */

import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import { openCaptionsMenu } from '../helpers/topbar'

// ---------------------------------------------------------------------------
// Local type aliases (mirrors shared/project.ts — no cross-context import)
// ---------------------------------------------------------------------------
type CaptionSpan = { text: string; emphasis?: string; color?: string }

type CaptionClip = {
  id: string
  kind: 'caption'
  trackId: string
  startMs: number
  endMs: number
  spans: CaptionSpan[]
  style: {
    preset: string
    fontSize: number
    align: string
    yPosition: number
    background: { kind: string }
  }
}

type SubtitleExport = {
  captionsToSrt: (clips: CaptionClip[]) => string
  captionsToVtt: (clips: CaptionClip[]) => string
  captionsToSubtitle: (clips: CaptionClip[], format: 'srt' | 'vtt') => string
  formatTimestamp: (ms: number, format: 'srt' | 'vtt') => string
}

type ReelsStore = {
  state: () => {
    project: {
      tracks: Array<{
        id: string
        kind: string
        clips: Array<Record<string, unknown>>
      }>
    }
  }
  addCaption: (c: CaptionClip) => void
  addCaptions: (cs: CaptionClip[]) => void
  newId: () => string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal caption clip for pure builder tests. trackId is irrelevant
 *  for the pure builders; use 'test-track' as a placeholder. */
function makeCaption(
  id: string,
  startMs: number,
  endMs: number,
  spans: CaptionSpan[]
): CaptionClip {
  return {
    id,
    kind: 'caption',
    trackId: 'test-track',
    startMs,
    endMs,
    spans,
    style: {
      preset: 'bottom-center',
      fontSize: 48,
      align: 'center',
      yPosition: 0.85,
      background: { kind: 'none' }
    }
  }
}

/** Open the editor page and wait for the store bridge to be ready. */
async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.locator('[data-testid="open-editor-button"]').click()
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
    null,
    { timeout: 5_000 }
  )
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsSubtitleExport?: unknown }).__reelsSubtitleExport,
    null,
    { timeout: 5_000 }
  )
}

/** Stub dialog.showSaveDialog in the main process to return a fixed path. */
async function stubSaveDialog(launched: LaunchedApp, filePath: string): Promise<void> {
  await launched.app.evaluate(
    ({ dialog }, p: string) => {
      ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
        canceled: false,
        filePath: p
      })
    },
    filePath
  )
  // Also allow-list the path so exportSubtitle's assertPathAllowed check passes.
  await launched.page.evaluate(async (p) => {
    await window.electron.fs.allowPath(p)
  }, filePath)
}

/** Add one or more caption clips through the test-bridge addCaptions action. */
async function addCaptionsToStore(launched: LaunchedApp, clips: CaptionClip[]): Promise<void> {
  const { page } = launched
  // addCaptions routes through the store's caption track (no trackId override needed by caller).
  await page.evaluate((cs: CaptionClip[]) => {
    const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
    reels.addCaptions(cs)
  }, clips)
}

/** Create a temp directory, guaranteed fresh. */
function makeTempDir(tag: string): string {
  const dir = path.join(os.tmpdir(), 'reels-studio-e2e', `subtitle-export-${Date.now()}-${tag}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-3-34-subtitle-export SRT / VTT subtitle export', () => {
  let launched: LaunchedApp | null = null
  const cleanupFiles: string[] = []

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    // Fresh project for every test.
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: { getState: () => { createNew: () => void } }
        }
      ).__PROJECT_STORE_FOR_TEST__
      store.getState().createNew()
      await new Promise((r) => setTimeout(r, 700))
    })
  })

  test.afterEach(async () => {
    // Clean up any files written to disk during tests.
    for (const f of cleanupFiles) {
      try { rmSync(f) } catch { /* ignore */ }
    }
    cleanupFiles.length = 0
    if (launched) {
      try { await launched.app.close() } catch { /* ignore */ }
      launched = null
    }
  })

  // -------------------------------------------------------------------------
  // Test 1 — Builder correctness (pure, via window.__reelsSubtitleExport)
  // -------------------------------------------------------------------------
  test('(1) @phase-3-34-subtitle-export captionsToSrt and captionsToVtt format output correctly', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })

    const result = await page.evaluate(() => {
      const ex = (window as unknown as { __reelsSubtitleExport: SubtitleExport }).__reelsSubtitleExport
      const clips: CaptionClip[] = [
        {
          id: 'c1',
          kind: 'caption',
          trackId: 'trk',
          startMs: 1000,
          endMs: 4000,
          spans: [{ text: 'Hello world' }],
          style: { preset: 'bottom-center', fontSize: 48, align: 'center', yPosition: 0.85, background: { kind: 'none' } }
        },
        {
          id: 'c2',
          kind: 'caption',
          trackId: 'trk',
          startMs: 5000,
          endMs: 8000,
          spans: [{ text: 'Second cue' }],
          style: { preset: 'bottom-center', fontSize: 48, align: 'center', yPosition: 0.85, background: { kind: 'none' } }
        },
        {
          id: 'c3',
          kind: 'caption',
          trackId: 'trk',
          startMs: 10000,
          endMs: 13000,
          spans: [{ text: 'Third cue' }],
          style: { preset: 'bottom-center', fontSize: 48, align: 'center', yPosition: 0.85, background: { kind: 'none' } }
        }
      ]
      return {
        srt: ex.captionsToSrt(clips),
        vtt: ex.captionsToVtt(clips),
        ts_srt_1000: ex.formatTimestamp(1000, 'srt'),
        ts_vtt_1000: ex.formatTimestamp(1000, 'vtt'),
        ts_srt_0: ex.formatTimestamp(0, 'srt'),
        ts_srt_3661500: ex.formatTimestamp(3661500, 'srt'),
        ts_vtt_3661500: ex.formatTimestamp(3661500, 'vtt')
      }
    })

    // --- SRT assertions ---
    const srtLines = result.srt.split('\n')

    // First index line is "1"
    expect(srtLines[0]).toBe('1')

    // Timestamp line matches HH:MM:SS,mmm --> HH:MM:SS,mmm
    const tsPattern = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/
    expect(srtLines[1]).toMatch(tsPattern)

    // Cue body text
    expect(srtLines[2]).toBe('Hello world')

    // Blank line separator between cues
    expect(srtLines[3]).toBe('')

    // Second cue has index 2
    const cue2StartLine = srtLines.indexOf('2')
    expect(cue2StartLine).toBeGreaterThan(0)
    expect(srtLines[cue2StartLine + 2]).toBe('Second cue')

    // Third cue has index 3
    const cue3StartLine = srtLines.indexOf('3')
    expect(cue3StartLine).toBeGreaterThan(0)
    expect(srtLines[cue3StartLine + 2]).toBe('Third cue')

    // --- VTT assertions ---
    expect(result.vtt).toMatch(/^WEBVTT\n\n/)

    // VTT timestamps use dot, not comma
    const vttLines = result.vtt.split('\n')
    const vttTsLine = vttLines.find((l) => l.includes('-->'))
    expect(vttTsLine).toBeTruthy()
    expect(vttTsLine).toContain('.')
    expect(vttTsLine).not.toContain(',')

    // --- formatTimestamp assertions ---
    expect(result.ts_srt_1000).toBe('00:00:01,000')
    expect(result.ts_vtt_1000).toBe('00:00:01.000')
    expect(result.ts_srt_0).toBe('00:00:00,000')
    expect(result.ts_srt_3661500).toBe('01:01:01,500')
    expect(result.ts_vtt_3661500).toBe('01:01:01.500')
  })

  // -------------------------------------------------------------------------
  // Test 2 — Sort + contiguous index
  // -------------------------------------------------------------------------
  test('(2) @phase-3-34-subtitle-export out-of-order captions are sorted ascending with 1..N indices', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })

    const result = await page.evaluate(() => {
      const ex = (window as unknown as { __reelsSubtitleExport: SubtitleExport }).__reelsSubtitleExport
      // Deliberately reversed order.
      const clips: CaptionClip[] = [
        {
          id: 'c3',
          kind: 'caption',
          trackId: 'trk',
          startMs: 9000,
          endMs: 11000,
          spans: [{ text: 'Third' }],
          style: { preset: 'bottom-center', fontSize: 48, align: 'center', yPosition: 0.85, background: { kind: 'none' } }
        },
        {
          id: 'c1',
          kind: 'caption',
          trackId: 'trk',
          startMs: 1000,
          endMs: 3000,
          spans: [{ text: 'First' }],
          style: { preset: 'bottom-center', fontSize: 48, align: 'center', yPosition: 0.85, background: { kind: 'none' } }
        },
        {
          id: 'c2',
          kind: 'caption',
          trackId: 'trk',
          startMs: 5000,
          endMs: 7000,
          spans: [{ text: 'Second' }],
          style: { preset: 'bottom-center', fontSize: 48, align: 'center', yPosition: 0.85, background: { kind: 'none' } }
        }
      ]
      return ex.captionsToSrt(clips)
    })

    // Extract index + text pairs in document order.
    const lines = result.split('\n')
    // Indices: lines right before a timestamp line.
    const indices: number[] = []
    const texts: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{2}:\d{2}:\d{2},\d{3}/.test(lines[i])) {
        const idxLine = lines[i - 1]?.trim()
        const textLine = lines[i + 1]?.trim()
        if (idxLine) indices.push(parseInt(idxLine, 10))
        if (textLine) texts.push(textLine)
      }
    }

    // Indices must be 1, 2, 3 in ascending order.
    expect(indices).toEqual([1, 2, 3])
    // Text order must match ascending startMs order.
    expect(texts).toEqual(['First', 'Second', 'Third'])
  })

  // -------------------------------------------------------------------------
  // Test 3 — Empty-text clips dropped
  // -------------------------------------------------------------------------
  test('(3) @phase-3-34-subtitle-export clips with empty spans are dropped; indices stay contiguous', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })

    const result = await page.evaluate(() => {
      const ex = (window as unknown as { __reelsSubtitleExport: SubtitleExport }).__reelsSubtitleExport
      const clips: CaptionClip[] = [
        {
          id: 'c1',
          kind: 'caption',
          trackId: 'trk',
          startMs: 1000,
          endMs: 3000,
          spans: [{ text: 'Visible A' }],
          style: { preset: 'bottom-center', fontSize: 48, align: 'center', yPosition: 0.85, background: { kind: 'none' } }
        },
        {
          // empty span — should be dropped
          id: 'c2',
          kind: 'caption',
          trackId: 'trk',
          startMs: 4000,
          endMs: 6000,
          spans: [{ text: '' }],
          style: { preset: 'bottom-center', fontSize: 48, align: 'center', yPosition: 0.85, background: { kind: 'none' } }
        },
        {
          // no spans at all — should be dropped
          id: 'c3',
          kind: 'caption',
          trackId: 'trk',
          startMs: 7000,
          endMs: 9000,
          spans: [],
          style: { preset: 'bottom-center', fontSize: 48, align: 'center', yPosition: 0.85, background: { kind: 'none' } }
        },
        {
          id: 'c4',
          kind: 'caption',
          trackId: 'trk',
          startMs: 10000,
          endMs: 12000,
          spans: [{ text: 'Visible B' }],
          style: { preset: 'bottom-center', fontSize: 48, align: 'center', yPosition: 0.85, background: { kind: 'none' } }
        }
      ]
      return ex.captionsToSrt(clips)
    })

    // Should only have cues for "Visible A" and "Visible B" with indices 1 and 2.
    expect(result).toContain('Visible A')
    expect(result).toContain('Visible B')
    expect(result).not.toContain('c2')

    const lines = result.split('\n')
    const indices: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{2}:\d{2}:\d{2},\d{3}/.test(lines[i])) {
        const idxLine = parseInt(lines[i - 1]?.trim() ?? '0', 10)
        if (!isNaN(idxLine)) indices.push(idxLine)
      }
    }
    // Exactly 2 cues, indices 1 and 2 — no gap.
    expect(indices).toEqual([1, 2])
  })

  // -------------------------------------------------------------------------
  // Test 4 — End-to-end write (SRT + VTT)
  // -------------------------------------------------------------------------
  test('(4a) @phase-3-34-subtitle-export SRT write: file exists on disk with valid content', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // Add two captions to the project via the store bridge.
    const captionClips: CaptionClip[] = [
      makeCaption('e2e-1', 1000, 4000, [{ text: 'Hello' }]),
      makeCaption('e2e-2', 5000, 8000, [{ text: 'World' }])
    ]
    await addCaptionsToStore(launched, captionClips)
    await page.waitForTimeout(200)

    const outDir = makeTempDir('srt')
    const outPath = path.join(outDir, `subtitle-e2e-${Date.now()}.srt`)
    cleanupFiles.push(outPath)

    // Stub the save dialog to return our path.
    await stubSaveDialog(launched, outPath)

    // Phase 3.46 — caption export controls now live inside the 자막 ▾ popover.
    await openCaptionsMenu(page)
    // Ensure format selector is set to 'srt' (it's the default, but be explicit).
    await page.locator('[data-testid="export-subtitle-format"]').selectOption('srt')

    // Click the export button.
    const exportBtn = page.locator('[data-testid="export-srt-button"]')
    await expect(exportBtn).not.toBeDisabled({ timeout: 3_000 })
    await exportBtn.click()

    // Wait for the file to appear (up to 5s).
    await page.waitForTimeout(1_500)

    expect(existsSync(outPath), `SRT file should exist at ${outPath}`).toBe(true)

    const fileContent = readFileSync(outPath, 'utf-8')

    // Validate SRT structure.
    expect(fileContent).toContain('1\n')
    expect(fileContent).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/)
    expect(fileContent).toContain('Hello')
    expect(fileContent).toContain('World')

    // Cross-check against the pure builder output computed in the renderer.
    const expectedContent = await page.evaluate((clips: CaptionClip[]) => {
      const ex = (window as unknown as { __reelsSubtitleExport: SubtitleExport }).__reelsSubtitleExport
      return ex.captionsToSrt(clips)
    }, captionClips)

    // The file must match exactly what captionsToSrt produces for these clips.
    // (The renderer gathers from the project store so order may differ; we
    //  compare after trimming trailing whitespace for safety.)
    expect(fileContent.trim()).toBe(expectedContent.trim())
  })

  test('(4b) @phase-3-34-subtitle-export VTT write: file starts with WEBVTT', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const captionClips: CaptionClip[] = [
      makeCaption('v1', 2000, 5000, [{ text: 'VTT cue one' }])
    ]
    await addCaptionsToStore(launched, captionClips)
    await page.waitForTimeout(200)

    const outDir = makeTempDir('vtt')
    const outPath = path.join(outDir, `subtitle-e2e-${Date.now()}.vtt`)
    cleanupFiles.push(outPath)

    await stubSaveDialog(launched, outPath)
    await openCaptionsMenu(page)
    await page.locator('[data-testid="export-subtitle-format"]').selectOption('vtt')

    const exportBtn = page.locator('[data-testid="export-srt-button"]')
    await expect(exportBtn).not.toBeDisabled({ timeout: 3_000 })
    await exportBtn.click()

    await page.waitForTimeout(1_500)

    expect(existsSync(outPath), `VTT file should exist at ${outPath}`).toBe(true)

    const fileContent = readFileSync(outPath, 'utf-8')
    expect(fileContent).toMatch(/^WEBVTT/)
    expect(fileContent).toContain('VTT cue one')
    // VTT uses dots, not commas.
    expect(fileContent).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/)
    expect(fileContent).not.toContain(',')
  })

  // -------------------------------------------------------------------------
  // Test 5 — Empty project → button disabled
  // -------------------------------------------------------------------------
  test('(5) @phase-3-34-subtitle-export export-srt-button is disabled when no caption clips exist', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // Phase 3.46 — caption controls live inside the 자막 ▾ popover.
    await openCaptionsMenu(page)
    // No captions added — button must be disabled.
    const exportBtn = page.locator('[data-testid="export-srt-button"]')
    await expect(exportBtn).toBeVisible({ timeout: 5_000 })
    await expect(exportBtn).toBeDisabled()
  })

  // -------------------------------------------------------------------------
  // Test 6 — Special characters (Korean, emoji, XML metacharacters)
  // -------------------------------------------------------------------------
  test('(6) @phase-3-34-subtitle-export special characters (Korean + emoji + XML metacharacters) written verbatim', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    const specialText = '안녕하세요 🎬 <script>"&\'</script>'
    const clips: CaptionClip[] = [
      makeCaption('sp1', 0, 3000, [{ text: specialText }])
    ]
    await addCaptionsToStore(launched, clips)
    await page.waitForTimeout(200)

    const outDir = makeTempDir('special')
    const outPath = path.join(outDir, `subtitle-special-${Date.now()}.srt`)
    cleanupFiles.push(outPath)

    await stubSaveDialog(launched, outPath)
    await openCaptionsMenu(page)
    await page.locator('[data-testid="export-subtitle-format"]').selectOption('srt')

    const exportBtn = page.locator('[data-testid="export-srt-button"]')
    await expect(exportBtn).not.toBeDisabled({ timeout: 3_000 })
    await exportBtn.click()

    await page.waitForTimeout(1_500)

    expect(existsSync(outPath), `Special-char SRT file should exist at ${outPath}`).toBe(true)

    // File must be valid UTF-8 and contain the text verbatim (no escaping).
    const fileContent = readFileSync(outPath, 'utf-8')
    expect(fileContent).toContain(specialText)

    // Verify no HTML/XML entity escaping occurred.
    expect(fileContent).not.toContain('&amp;')
    expect(fileContent).not.toContain('&lt;')
    expect(fileContent).not.toContain('&gt;')
    expect(fileContent).not.toContain('&quot;')
  })

  // -------------------------------------------------------------------------
  // Test 7 — mp4 export unaffected (buildPlan filterGraph identical)
  // -------------------------------------------------------------------------
  test('(7) @phase-3-34-subtitle-export buildPlan filterGraph is identical before and after subtitle export', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)

    // We need a video clip so buildPlan produces a non-trivial filterGraph.
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) {
      console.warn('[subtitle-export test 7] E2E_FIXTURE_MP4 not set — skipping buildPlan check')
      test.skip()
      return
    }

    // Add fixture media + video clip.
    await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      const id = reels.newId()
      ;(reels as unknown as {
        addMedia: (a: unknown) => void
        addClip: (c: unknown) => void
      }).addMedia({
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
      const track = reels.state().project.tracks.find((t) => t.kind === 'video')
      if (!track) throw new Error('no video track')
      const cid = reels.newId()
      ;(reels as unknown as { addClip: (c: unknown) => void }).addClip({
        id: cid,
        kind: 'media',
        mediaId: id,
        trackId: track.id,
        startMs: 0,
        endMs: probe.durationMs,
        trimInMs: 0,
        trimOutMs: probe.durationMs,
        speed: 1
      })
    }, fixture)

    // Add a caption clip FIRST so the project state is stable before we compare.
    const captionClips: CaptionClip[] = [
      makeCaption('reg-1', 500, 2000, [{ text: 'Regression caption' }])
    ]
    await addCaptionsToStore(launched, captionClips)
    await page.waitForTimeout(200)

    const planOutPath = path.join(os.tmpdir(), 'reels-studio-e2e', `sub-export-plan-${Date.now()}.mp4`)

    // Capture filterGraph BEFORE the subtitle export click (captions already present).
    const planBefore = await page.evaluate(
      async (outputPath: string) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
      },
      planOutPath
    )
    expect(planBefore.ok, `buildPlan before subtitle export failed: ${planBefore.error ?? ''}`).toBe(true)
    const fgBefore = planBefore.filterGraph as string

    // Perform the subtitle export (write to disk). This must be read-only on the store.
    const subOutDir = makeTempDir('regression')
    const subOutPath = path.join(subOutDir, `regression-${Date.now()}.srt`)
    cleanupFiles.push(subOutPath)
    await stubSaveDialog(launched, subOutPath)
    await openCaptionsMenu(page)
    await page.locator('[data-testid="export-subtitle-format"]').selectOption('srt')
    await page.locator('[data-testid="export-srt-button"]').click()
    await page.waitForTimeout(1_500)
    expect(existsSync(subOutPath), 'subtitle file must exist for regression test').toBe(true)

    const planOutPath2 = path.join(os.tmpdir(), 'reels-studio-e2e', `sub-export-plan2-${Date.now()}.mp4`)

    // Capture filterGraph AFTER the subtitle export click.
    // The project state must be byte-identical — subtitle export never mutates the store.
    const planAfter = await page.evaluate(
      async (outputPath: string) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
      },
      planOutPath2
    )
    expect(planAfter.ok, `buildPlan after subtitle export failed: ${planAfter.error ?? ''}`).toBe(true)
    const fgAfter = planAfter.filterGraph as string

    // filterGraph must be identical — subtitle export is read-only on the video pipeline
    // and must never mutate the project store.
    expect(fgAfter, 'filterGraph must be unchanged after a subtitle export').toBe(fgBefore)
  })
})
