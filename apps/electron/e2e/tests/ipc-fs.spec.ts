import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-1-ipc-fs fs bridge surface', () => {
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

  test('fs.pickFile and fs.saveFile are invocable functions', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    const shape = await page.evaluate(() => {
      const fs = window.electron.fs
      return {
        pickFileIsFn: typeof fs.pickFile === 'function',
        saveFileIsFn: typeof fs.saveFile === 'function',
        keys: Object.keys(fs).sort()
      }
    })
    expect(shape.pickFileIsFn).toBe(true)
    expect(shape.saveFileIsFn).toBe(true)
    // Phase 2.1 expanded the fs surface (project persistence, drop-allowlist,
    // multi-select). The two originals must still be present; we assert as
    // superset rather than exact equality.
    expect(shape.keys).toEqual(expect.arrayContaining(['pickFile', 'saveFile']))
  })

  test('fs.pickFile returns null when dialog is cancelled (mocked)', async () => {
    if (!launched) throw new Error('launch failed')
    const { app, page } = launched
    // Inject a dialog stub on the main side to avoid spawning a real open
    // dialog. Playwright's electron `app.evaluate` runs in the main process.
    await app.evaluate(async ({ dialog }) => {
      const cancelled = { canceled: true, filePaths: [] as string[] }
      ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () =>
        cancelled
    })
    const result = await page.evaluate(async () => {
      return await window.electron.fs.pickFile([
        { name: 'Video', extensions: ['mp4'] }
      ])
    })
    expect(result).toBeNull()
  })

  test('fs.saveFile returns null when dialog is cancelled (mocked)', async () => {
    if (!launched) throw new Error('launch failed')
    const { app, page } = launched
    await app.evaluate(async ({ dialog }) => {
      ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
        canceled: true,
        filePath: undefined as string | undefined
      })
    })
    const result = await page.evaluate(async () => {
      return await window.electron.fs.saveFile('out.mp4')
    })
    expect(result).toBeNull()
  })
})
