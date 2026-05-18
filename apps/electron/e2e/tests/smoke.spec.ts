import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-1-smoke electron app boot', () => {
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

  test('app launches within 10s and main window is visible', async () => {
    if (!launched) throw new Error('launch failed')
    const { app, page } = launched
    // page.firstWindow already resolved within the helper's 10s budget. The
    // window is created with show:false and revealed on `ready-to-show`. Wait
    // for that event by polling isVisible() on the main side.
    await expect
      .poll(
        async () =>
          await app.evaluate(({ BrowserWindow }) => {
            const wins = BrowserWindow.getAllWindows()
            if (wins.length === 0) return false
            const win = wins[0]
            return win.isVisible() && !win.isDestroyed()
          }),
        { timeout: 10_000, intervals: [200, 500, 1000] }
      )
      .toBe(true)
    // Sanity-check the page is a renderer window with our HTML loaded.
    await expect(page.locator('#root')).toBeAttached()
  })

  test('renderer page title is "Reels Studio"', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await expect(page).toHaveTitle('Reels Studio')
  })

  test('renderer console has no errors after boot', async () => {
    if (!launched) throw new Error('launch failed')
    const { page, consoleErrors, pageErrors } = launched
    // Settle: wait for React to mount and the optional dev panel's capabilities
    // call to either complete or be skipped.
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    // Give microtasks one more tick.
    await page.waitForTimeout(500)
    expect(pageErrors, `pageerror: ${pageErrors.map((e) => e.message).join('\n')}`)
      .toHaveLength(0)
    expect(consoleErrors, `console.error: ${consoleErrors.join('\n')}`)
      .toHaveLength(0)
  })

  test('preload bridge surface is fully populated', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    const shape = await page.evaluate(() => {
      const w = window as unknown as {
        electron?: {
          ffmpeg?: unknown
          fs?: unknown
          auth?: unknown
        }
      }
      return {
        hasElectron: !!w.electron,
        hasFfmpeg: !!w.electron?.ffmpeg,
        hasFs: !!w.electron?.fs,
        hasAuth: !!w.electron?.auth
      }
    })
    expect(shape).toEqual({
      hasElectron: true,
      hasFfmpeg: true,
      hasFs: true,
      hasAuth: true
    })
  })

  test('ffmpeg bridge exposes only allowlisted methods', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.ffmpeg, null, { timeout: 5_000 })
    const keys = await page.evaluate(() => {
      const ff = (window as unknown as { electron: { ffmpeg: Record<string, unknown> } })
        .electron.ffmpeg
      return Object.keys(ff).sort()
    })
    // Per shared/ipc.ts ElectronApi.ffmpeg
    expect(keys).toEqual(['cancel', 'capabilities', 'onProgress', 'run'])
  })
})
