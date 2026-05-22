/**
 * @phase-stt — Auto-caption STT dialog tests.
 *
 * All transcription is MOCKED via app.evaluate / ipcMain.removeHandler +
 * ipcMain.handle, following the exact pattern in prefill.spec.ts for
 * `download:downloadVideoToTemp`.
 *
 * CRITICAL MOCK DESIGN:
 *   The dialog generates a ulid jobId and passes it inside SttTranscribeOptions.
 *   It FILTERS onProgress events by that same jobId. So our mock stt:transcribe
 *   handler MUST capture the incoming jobId from its call args and echo that
 *   SAME jobId when it emits stt:progress events via webContents.send().
 *
 * Covered scenarios:
 *   1. bridge surface — window.electron.stt exposes exactly the 4 expected keys
 *   2. button + shortcut — open-stt-dialog button + Ctrl+T both open stt-dialog
 *   3. happy path — 2 progress events → success → 3 caption clips + toast + undo step
 *   4. no-audio error — {ok:false,code:'no_audio'} → Korean error stays in dialog
 *   5. cancel — pending transcribe + stt:cancel click → dialog returns to form
 *   6. model-missing notice — modelStatus→{present:false} → stt-model-notice renders
 *   7. concurrent guard — {ok:false,code:'queue_full'} → "이미 진행 중" message
 *   8. source picker states — no media → both options disabled; with media clip selected → clip enabled
 *   9. (optional, gated) real binary smoke — E2E_STT_REAL + E2E_FIXTURE_MP4
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Shared fixture setup helpers.
// ---------------------------------------------------------------------------

function getFixturePath(): string {
  const p = process.env.E2E_FIXTURE_MP4
  if (!p) throw new Error('E2E_FIXTURE_MP4 not set — globalSetup failed')
  return p
}

/**
 * Navigate to the editor page and wait for all bridges to be ready.
 */
async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
  await page.locator('[data-testid="open-editor-button"]').click()
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
    null,
    { timeout: 5_000 }
  )
}

/**
 * Seed a real media asset + a video clip on the video track via the test bridge,
 * so the STT dialog sees a usable timeline source.
 * Returns the mediaId and clipId.
 */
async function seedMediaClip(launched: LaunchedApp): Promise<{ mediaId: string; clipId: string }> {
  const { page } = launched
  const fixturePath = getFixturePath()
  return await page.evaluate(async (filePath: string) => {
    await window.electron.fs.allowPath(filePath)
    const probe = await window.electron.media.probe(filePath)
    const fileName = (filePath.split(/[/\\]/).pop()) ?? 'fixture.mp4'
    const reels = (
      window as unknown as {
        __reelsStore: {
          state: () => { project: { tracks: Array<{ id: string; kind: string }> } }
          addMedia: (a: unknown) => void
          addClip: (c: unknown) => void
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
    const videoTrack = reels.state().project.tracks.find((t) => t.kind === 'video')
    if (!videoTrack) throw new Error('no video track')
    const cid = reels.newId()
    reels.addClip({
      id: cid,
      kind: 'media',
      mediaId: id,
      trackId: videoTrack.id,
      startMs: 0,
      endMs: probe.durationMs,
      trimInMs: 0,
      trimOutMs: probe.durationMs,
      speed: 1
    })
    return { mediaId: id, clipId: cid }
  }, fixturePath)
}

/**
 * Select the clip on the timeline (sets selectedClipIds in the timelineUi store)
 * so the STT dialog can resolve "selected clip" source.
 */
async function selectClipInStore(launched: LaunchedApp, clipId: string): Promise<void> {
  const { page } = launched
  await page.evaluate((cid: string) => {
    const ui = (
      window as unknown as {
        __TIMELINE_UI_FOR_TEST__: {
          getState: () => { selectClip: (id: string) => void }
        }
      }
    ).__TIMELINE_UI_FOR_TEST__
    ui.getState().selectClip(cid)
  }, clipId)
}

/**
 * Install a mock stt:modelStatus handler that returns {present: true} by default.
 * Callers can override by passing the result they want.
 */
async function mockModelStatus(
  launched: LaunchedApp,
  result: { present: boolean; model?: string; sizeBytes?: number }
): Promise<void> {
  const { app } = launched
  await app.evaluate(({ ipcMain }, r) => {
    ipcMain.removeHandler('stt:modelStatus')
    ipcMain.handle('stt:modelStatus', async () => ({
      present: r.present,
      model: r.model ?? 'base',
      sizeBytes: r.sizeBytes
    }))
  }, result)
}

// ---------------------------------------------------------------------------
// 1. Bridge surface
// ---------------------------------------------------------------------------

test.describe('@phase-stt bridge surface', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
  })

  test.afterEach(async () => {
    if (launched) {
      try { await launched.app.close() } catch { /* ignore */ }
      launched = null
    }
  })

  test('window.electron.stt exposes exactly cancel, modelStatus, onProgress, transcribe', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.stt, null, { timeout: 5_000 })
    const keys = await page.evaluate(() => {
      const stt = (
        window as unknown as { electron: { stt: Record<string, unknown> } }
      ).electron.stt
      return Object.keys(stt).sort()
    })
    expect(keys).toEqual(['cancel', 'modelStatus', 'onProgress', 'transcribe'])
  })
})

// ---------------------------------------------------------------------------
// 2. Button + shortcut
// ---------------------------------------------------------------------------

test.describe('@phase-stt button and shortcut', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
  })

  test.afterEach(async () => {
    if (launched) {
      try { await launched.app.close() } catch { /* ignore */ }
      launched = null
    }
  })

  test('open-stt-dialog button is visible in editor topbar', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await expect(page.locator('[data-testid="open-stt-dialog"]')).toBeVisible()
    await expect(page.locator('[data-testid="open-stt-dialog"]')).toContainText('자동 자막 생성')
  })

  test('clicking open-stt-dialog opens stt-dialog', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    // Mock modelStatus so dialog opens cleanly without a real IPC call completing
    await mockModelStatus(launched, { present: true })
    await page.locator('[data-testid="open-stt-dialog"]').click()
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()
  })

  test('Ctrl+T opens stt-dialog', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await mockModelStatus(launched, { present: true })
    // Focus on body to ensure the shortcut listener fires (not in an input).
    await page.locator('[data-testid="timeline"]').click()
    await page.keyboard.press('Control+t')
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// 3. Happy path
// ---------------------------------------------------------------------------

test.describe('@phase-stt happy path', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
  })

  test.afterEach(async () => {
    if (launched) {
      try { await launched.app.close() } catch { /* ignore */ }
      launched = null
    }
  })

  test('mock transcribe → 2 progress events → 3 captions inserted → success toast → dialog closes', async () => {
    if (!launched) throw new Error('launch failed')
    const { app, page } = launched

    await openEditor(launched)
    // Reset to clean slate, then wait for createNew()'s deferred clear() to fire
    // (UNDO_THROTTLE_MS=200 + 50 + headroom). Without this wait the clear wipes
    // the addCaptions undo entry.
    await page.evaluate(async () => {
      const w = window as unknown as { __reelsStore: { createNew: () => void } }
      w.__reelsStore.createNew()
      await new Promise((r) => setTimeout(r, 400))
    })

    const { clipId } = await seedMediaClip(launched)
    await selectClipInStore(launched, clipId)

    // Wait for the undo throttle (200ms) to settle so seedMediaClip's mutations
    // are all flushed into pastStates before we snapshot pastBefore.
    await page.waitForTimeout(400)

    // Mock modelStatus → present so no download notice (keeps test simple).
    await mockModelStatus(launched, { present: true })

    // Mock stt:transcribe:
    //   - Emits 2 progress events echoing the incoming jobId.
    //   - Resolves with ok:true + 3 cues.
    await app.evaluate(({ ipcMain, webContents }, _unused) => {
      ipcMain.removeHandler('stt:transcribe')
      ipcMain.handle('stt:transcribe', async (_event, rawOpts: unknown) => {
        const opts = rawOpts as { jobId: string; sourcePath: string }
        const jid = opts.jobId
        // Simulate a brief extracting-audio phase.
        await new Promise<void>((r) => setTimeout(r, 60))
        for (const wc of webContents.getAllWebContents()) {
          if (!wc.isDestroyed()) {
            wc.send('stt:progress', { jobId: jid, phase: 'extracting-audio', percent: 30 })
          }
        }
        await new Promise<void>((r) => setTimeout(r, 60))
        for (const wc of webContents.getAllWebContents()) {
          if (!wc.isDestroyed()) {
            wc.send('stt:progress', { jobId: jid, phase: 'transcribing', percent: 70 })
          }
        }
        await new Promise<void>((r) => setTimeout(r, 60))
        return {
          jobId: jid,
          ok: true,
          cues: [
            { startMs: 0, endMs: 1000, text: '안녕하세요' },
            { startMs: 1000, endMs: 2000, text: '자동 자막입니다' },
            { startMs: 2000, endMs: 3000, text: '세 번째 자막' }
          ],
          language: 'ko',
          durationMs: 3000
        }
      })
    }, null)

    // Snapshot undo past-length before.
    const pastBefore = await page.evaluate(() => {
      const undo = (
        window as unknown as {
          __reelsUndoRedo: { getState: () => { pastStates: unknown[] } }
        }
      ).__reelsUndoRedo
      return undo.getState().pastStates.length
    })

    // Caption track count before.
    const captionsBefore = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __reelsStore: { state: () => { project: { tracks: Array<{ kind: string; clips: unknown[] }> } } }
        }
      ).__reelsStore
      const ct = store.state().project.tracks.find((t) => t.kind === 'caption')
      return ct?.clips.length ?? 0
    })

    // Open dialog.
    await page.locator('[data-testid="open-stt-dialog"]').click()
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()

    // Pick timeline source (whole timeline; clip is seeded on track so enabled).
    await page.locator('[data-testid="stt-source-timeline"]').click()

    // Select language.
    await page.locator('[data-testid="stt-language-select"]').selectOption('ko')

    // Start.
    await page.locator('[data-testid="stt-start"]').click()

    // Progress overlay should appear.
    await expect(page.locator('[data-testid="stt-progress"]')).toBeVisible({ timeout: 5_000 })

    // Dialog should close after success.
    await expect(page.locator('[data-testid="stt-dialog"]')).toHaveCount(0, { timeout: 15_000 })

    // Toast should show "자막 3개를 생성했습니다".
    // Toast component uses data-testid="toast-success" for the success variant.
    await expect(page.locator('[data-testid="toast-success"]')).toContainText('자막 3개', { timeout: 5_000 })

    // Wait for zundo's 200ms throttle to flush the addCaptions entry into pastStates.
    await page.waitForTimeout(400)

    // Caption track should have 3 more clips than before.
    const captionsAfter = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __reelsStore: { state: () => { project: { tracks: Array<{ kind: string; clips: unknown[] }> } } }
        }
      ).__reelsStore
      const ct = store.state().project.tracks.find((t) => t.kind === 'caption')
      return ct?.clips.length ?? 0
    })
    expect(captionsAfter - captionsBefore).toBe(3)

    // Undo past length should have increased by exactly 1 (bulk addCaptions = one undo step).
    const pastAfter = await page.evaluate(() => {
      const undo = (
        window as unknown as {
          __reelsUndoRedo: { getState: () => { pastStates: unknown[] } }
        }
      ).__reelsUndoRedo
      return undo.getState().pastStates.length
    })
    expect(pastAfter - pastBefore).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. no-audio error
// ---------------------------------------------------------------------------

test.describe('@phase-stt no-audio error', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
  })

  test.afterEach(async () => {
    if (launched) {
      try { await launched.app.close() } catch { /* ignore */ }
      launched = null
    }
  })

  test('no_audio code → Korean error text shown, dialog stays open', async () => {
    if (!launched) throw new Error('launch failed')
    const { app, page } = launched

    await openEditor(launched)
    const { clipId } = await seedMediaClip(launched)
    await selectClipInStore(launched, clipId)
    await mockModelStatus(launched, { present: true })

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('stt:transcribe')
      ipcMain.handle('stt:transcribe', async (_event, rawOpts: unknown) => {
        const opts = rawOpts as { jobId: string }
        return { jobId: opts.jobId, ok: false, error: 'no audio stream', code: 'no_audio' }
      })
    })

    await page.locator('[data-testid="open-stt-dialog"]').click()
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()
    await page.locator('[data-testid="stt-source-timeline"]').click()
    await page.locator('[data-testid="stt-start"]').click()

    // Error message must appear.
    await expect(page.locator('[data-testid="stt-error"]')).toBeVisible({ timeout: 8_000 })
    await expect(page.locator('[data-testid="stt-error"]')).toContainText(
      '선택한 구간에 음성이 없습니다'
    )
    // Dialog must remain open.
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// 5. Cancel
// ---------------------------------------------------------------------------

test.describe('@phase-stt cancel', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
  })

  test.afterEach(async () => {
    if (launched) {
      try { await launched.app.close() } catch { /* ignore */ }
      launched = null
    }
  })

  test('cancel button triggers stt:cancel IPC and dialog returns to form', async () => {
    if (!launched) throw new Error('launch failed')
    const { app, page } = launched

    await openEditor(launched)
    const { clipId } = await seedMediaClip(launched)
    await selectClipInStore(launched, clipId)
    await mockModelStatus(launched, { present: true })

    // A handler that stays pending until it sees stt:cancel, then resolves
    // with code:'cancelled'. We also track whether cancel was called.
    await app.evaluate(({ ipcMain, webContents }) => {
      // Track cancel invocations.
      ;(globalThis as unknown as { __sttCancelCalled: boolean }).__sttCancelCalled = false

      ipcMain.removeHandler('stt:transcribe')
      ipcMain.removeHandler('stt:cancel')

      ipcMain.handle('stt:transcribe', (_event, rawOpts: unknown): Promise<unknown> => {
        const opts = rawOpts as { jobId: string }
        const jid = opts.jobId
        // Emit a busy progress event so the cancel button appears.
        return new Promise<unknown>((resolve) => {
          setTimeout(() => {
            for (const wc of webContents.getAllWebContents()) {
              if (!wc.isDestroyed()) {
                wc.send('stt:progress', { jobId: jid, phase: 'transcribing', percent: 20 })
              }
            }
          }, 80)
          // Resolve as cancelled after 5s or when cancel is called.
          const cancelCheck = setInterval(() => {
            if ((globalThis as unknown as { __sttCancelCalled: boolean }).__sttCancelCalled) {
              clearInterval(cancelCheck)
              resolve({ jobId: jid, ok: false, error: 'cancelled', code: 'cancelled' })
            }
          }, 50)
          // Safety timeout so the test never hangs.
          setTimeout(() => {
            clearInterval(cancelCheck)
            resolve({ jobId: jid, ok: false, error: 'cancelled', code: 'cancelled' })
          }, 5000)
        })
      })

      ipcMain.handle('stt:cancel', (_event, rawJobId: unknown) => {
        void rawJobId
        ;(globalThis as unknown as { __sttCancelCalled: boolean }).__sttCancelCalled = true
      })
    })

    // Open dialog and start.
    await page.locator('[data-testid="open-stt-dialog"]').click()
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()
    await page.locator('[data-testid="stt-source-timeline"]').click()
    await page.locator('[data-testid="stt-start"]').click()

    // Progress overlay appears with cancel button.
    await expect(page.locator('[data-testid="stt-progress"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-testid="stt-cancel"]')).toBeVisible({ timeout: 5_000 })

    // Click cancel.
    await page.locator('[data-testid="stt-cancel"]').click()

    // Dialog should return to the form (progress overlay gone) and stay open.
    await expect(page.locator('[data-testid="stt-progress"]')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()

    // Verify stt:cancel IPC was invoked.
    const cancelCalled = await app.evaluate(() => {
      return (globalThis as unknown as { __sttCancelCalled: boolean }).__sttCancelCalled
    })
    expect(cancelCalled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. Model-missing notice
// ---------------------------------------------------------------------------

test.describe('@phase-stt model-missing notice', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
  })

  test.afterEach(async () => {
    if (launched) {
      try { await launched.app.close() } catch { /* ignore */ }
      launched = null
    }
  })

  test('stt-model-notice renders when modelStatus returns present:false', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    // Mock modelStatus to return not present.
    await mockModelStatus(launched, { present: false, sizeBytes: 148897792 })

    await page.locator('[data-testid="open-stt-dialog"]').click()
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()

    // Notice should mention the model size.
    await expect(page.locator('[data-testid="stt-model-notice"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-testid="stt-model-notice"]')).toContainText('142MB')
  })
})

// ---------------------------------------------------------------------------
// 7. Concurrent guard
// ---------------------------------------------------------------------------

test.describe('@phase-stt concurrent guard', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
  })

  test.afterEach(async () => {
    if (launched) {
      try { await launched.app.close() } catch { /* ignore */ }
      launched = null
    }
  })

  test('queue_full code → "이미 자막 생성이 진행 중" error in stt-error', async () => {
    if (!launched) throw new Error('launch failed')
    const { app, page } = launched

    await openEditor(launched)
    const { clipId } = await seedMediaClip(launched)
    await selectClipInStore(launched, clipId)
    await mockModelStatus(launched, { present: true })

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('stt:transcribe')
      ipcMain.handle('stt:transcribe', async (_event, rawOpts: unknown) => {
        const opts = rawOpts as { jobId: string }
        return {
          jobId: opts.jobId,
          ok: false,
          error: 'an STT job is already running',
          code: 'queue_full'
        }
      })
    })

    await page.locator('[data-testid="open-stt-dialog"]').click()
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()
    await page.locator('[data-testid="stt-source-timeline"]').click()
    await page.locator('[data-testid="stt-start"]').click()

    await expect(page.locator('[data-testid="stt-error"]')).toBeVisible({ timeout: 8_000 })
    await expect(page.locator('[data-testid="stt-error"]')).toContainText(
      '이미 자막 생성이 진행 중'
    )
    // Dialog stays open.
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// 8. Source picker states
// ---------------------------------------------------------------------------

test.describe('@phase-stt source picker states', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
  })

  test.afterEach(async () => {
    if (launched) {
      try { await launched.app.close() } catch { /* ignore */ }
      launched = null
    }
  })

  test('no media on timeline → both options aria-disabled, stt-empty shown', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    // Ensure a clean project with no media.
    await page.evaluate(() => {
      const w = window as unknown as { __reelsStore: { createNew: () => void } }
      w.__reelsStore.createNew()
    })
    await mockModelStatus(launched, { present: true })

    await page.locator('[data-testid="open-stt-dialog"]').click()
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()

    // stt-empty visible.
    await expect(page.locator('[data-testid="stt-empty"]')).toBeVisible()

    // Both source options should have aria-disabled="true".
    await expect(page.locator('[data-testid="stt-source-clip"]')).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    await expect(page.locator('[data-testid="stt-source-timeline"]')).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })

  test('with media clip selected → stt-source-clip aria-disabled=false, timeline enabled', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await openEditor(launched)
    await page.evaluate(() => {
      const w = window as unknown as { __reelsStore: { createNew: () => void } }
      w.__reelsStore.createNew()
    })

    const { clipId } = await seedMediaClip(launched)
    // Select the clip so stt-source-clip becomes enabled.
    await selectClipInStore(launched, clipId)
    await mockModelStatus(launched, { present: true })

    await page.locator('[data-testid="open-stt-dialog"]').click()
    await expect(page.locator('[data-testid="stt-dialog"]')).toBeVisible()

    // stt-empty must NOT be visible (there is media on the timeline).
    await expect(page.locator('[data-testid="stt-empty"]')).toHaveCount(0)

    // clip source must be enabled.
    await expect(page.locator('[data-testid="stt-source-clip"]')).toHaveAttribute(
      'aria-disabled',
      'false'
    )
    // timeline source also enabled (clip is on the video track).
    await expect(page.locator('[data-testid="stt-source-timeline"]')).toHaveAttribute(
      'aria-disabled',
      'false'
    )
  })
})

// ---------------------------------------------------------------------------
// 9. Optional real-binary smoke (gated on E2E_STT_REAL)
// ---------------------------------------------------------------------------

test.describe('@phase-stt real-binary smoke (gated)', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
  })

  test.afterEach(async () => {
    if (launched) {
      try { await launched.app.close() } catch { /* ignore */ }
      launched = null
    }
  })

  test.skip(
    !process.env.E2E_STT_REAL,
    'Real STT binary test skipped — set E2E_STT_REAL=1 to enable'
  )

  test('real whisper transcribes fixture clip without error', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const fixturePath = getFixturePath()

    await page.waitForFunction(() => !!window.electron?.stt, null, { timeout: 5_000 })
    await page.evaluate(async (path: string) => {
      await window.electron.fs.allowPath(path)
    }, fixturePath)

    const result = await page.evaluate(async (path: string) => {
      // Generate a simple jobId for this test.
      const jobId = `e2e-real-${Date.now()}`
      return window.electron.stt.transcribe({
        jobId,
        sourcePath: path,
        language: 'auto',
        model: 'base'
      })
    }, fixturePath)

    // We don't assert cue content (depends on fixture audio), only that the
    // result is structurally valid.
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.isArray(result.cues)).toBe(true)
      expect(typeof result.language).toBe('string')
      expect(result.durationMs).toBeGreaterThan(0)
    }
  }, 120_000)
})
