import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-2-smoke editor view + media library', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
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

  test('Editor button opens the editor view and back returns home', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })

    // From home, the Editor button is rendered (data-testid="open-editor-button").
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await expect(page.locator('[data-testid="project-name-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="aspect-ratio-select"]')).toBeVisible()
    // Phase 2.2 replaced the placeholders with real components.
    await expect(page.locator('[data-testid="preview-area"]')).toBeVisible()
    await expect(page.locator('[data-testid="timeline"]')).toBeVisible()

    // Back to home.
    await page.locator('[data-testid="editor-back-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="open-editor-button"]')).toBeVisible()
  })

  test('media bridge surface is exposed', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.media, null, { timeout: 5_000 })
    const keys = await page.evaluate(() => {
      const m = (window as unknown as { electron: { media: Record<string, unknown> } })
        .electron.media
      return Object.keys(m).sort()
    })
    expect(keys).toEqual(['generateThumbnail', 'probe', 'readThumbnail'])
  })

  test('aspect ratio change updates canvas dimensions', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()

    const select = page.locator('[data-testid="aspect-ratio-select"]')
    await select.selectOption('1:1')
    // The hint text in the topbar reflects width×height.
    await expect(page.locator('text=1080×1080')).toBeVisible()

    await select.selectOption('16:9')
    await expect(page.locator('text=1920×1080')).toBeVisible()
  })

  test('fs.writeProject + fs.readProject round-trips', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })

    const roundTrip = await page.evaluate(async () => {
      const now = Date.now()
      const sample = {
        id: 'test-project-id',
        name: 'persistence smoke',
        aspectRatio: '9:16' as const,
        width: 1080,
        height: 1920,
        fps: 30,
        tracks: [],
        media: {
          'media-1': {
            id: 'media-1',
            path: 'C:/tmp/fake.mp4',
            kind: 'video' as const,
            durationMs: 5000,
            width: 320,
            height: 240,
            importedAt: now,
            fileName: 'fake.mp4',
            fileSizeBytes: 0
          }
        },
        createdAt: now,
        updatedAt: now
      }
      await window.electron.fs.writeProject(sample)
      const loaded = await window.electron.fs.readProject()
      return loaded
    })

    expect(roundTrip).not.toBeNull()
    expect(roundTrip?.name).toBe('persistence smoke')
    expect(roundTrip?.media['media-1']?.fileName).toBe('fake.mp4')
  })

  test('media probe + thumbnail import flow works on the fixture mp4', async () => {
    if (!launched) throw new Error('launch failed')
    const { app, page } = launched

    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set — globalSetup failed')

    // Whitelist the fixture path on the main side (in real use, fs.pickFile
    // does this; in the test we bypass the dialog).
    await app.evaluate(async (_electron, fixturePath: string) => {
      // The renderer can ask main to allow a path via the bridge; do that.
      // (Using the exposed IPC channel keeps us testing the actual surface.)
      void _electron
      void fixturePath
    }, fixture)

    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()

    // Drive the import flow via the bridge directly (bypass the OS dialog).
    const probeResult = await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const thumb = await window.electron.media.generateThumbnail(filePath, {
        atMs: 1000,
        mediaId: 'e2e-test'
      })
      return {
        probe,
        thumbHasDataUri: thumb.dataUri.startsWith('data:image/jpeg;base64,'),
        thumbPath: thumb.path
      }
    }, fixture)

    expect(probeResult.probe.kind).toBe('video')
    expect(probeResult.probe.width).toBe(320)
    expect(probeResult.probe.height).toBe(240)
    expect(probeResult.probe.durationMs).toBeGreaterThanOrEqual(4500)
    expect(probeResult.probe.durationMs).toBeLessThanOrEqual(5500)
    expect(probeResult.thumbHasDataUri).toBe(true)
    expect(probeResult.thumbPath).toMatch(/e2e-test\.jpg$/)
  })
})
