/**
 * Phase 4.7 — auto-update wiring.
 *
 * The full electron-updater flow can only run against a real prior install
 * (it needs an `app-update.yml` in the installed Resources dir + a live
 * `latest.yml` on the CDN). These tests therefore cover what we CAN check
 * in a packaged-but-not-installed test launch:
 *
 *   - preload bridge exposes `window.electron.updater` with the documented
 *     surface (installNow / onDownloaded / onDownloadProgress).
 *   - The renderer test bridge `window.__reelsUpdater` is wired, and
 *     emitting a fake `downloaded` event renders the banner with the
 *     correct version text.
 *   - Clicking "나중에" hides the banner.
 *   - `installNow()` is a no-op in dev/unpackaged (returns false) — proving
 *     the dev-guard in `auto-update.ts` does what it claims.
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-4-updater auto-update IPC + banner', () => {
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

  test('preload bridge exposes updater surface', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.updater, null, {
      timeout: 5_000
    })
    const keys = await page.evaluate(() => {
      const u = (window as unknown as {
        electron: { updater: Record<string, unknown> }
      }).electron.updater
      return Object.keys(u).sort()
    })
    // Object.keys().sort() — alphabetical, capital letters first then case-insensitive.
    // 'installNow' < 'onDownloadProgress' < 'onDownloaded' under default sort
    // (because 'P' (80) < 'e' (101)). Just check membership instead of order.
    expect(keys.slice().sort()).toEqual(
      ['installNow', 'onDownloadProgress', 'onDownloaded'].sort()
    )
  })

  test('renderer test bridge __reelsUpdater is installed', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.__reelsUpdater, null, {
      timeout: 5_000
    })
    const keys = await page.evaluate(() => {
      const u = (window as unknown as {
        __reelsUpdater: Record<string, unknown>
      }).__reelsUpdater
      return Object.keys(u).sort()
    })
    expect(keys.slice().sort()).toEqual(
      ['emitDownloaded', 'emitProgress', 'reset'].sort()
    )
  })

  test('emitting downloaded event renders banner with version', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.__reelsUpdater, null, {
      timeout: 5_000
    })

    // Simulate electron-updater "download finished" event.
    await page.evaluate(() => {
      window.__reelsUpdater?.emitDownloaded({
        version: '0.1.1',
        releaseNotes: 'Test release'
      })
    })

    const banner = page.locator('[data-testid="update-banner-downloaded"]')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('새 버전 0.1.1 다운로드 완료')
    await expect(banner).toContainText('재시작하면 적용됩니다.')
    await expect(
      page.locator('[data-testid="update-banner-install-now"]')
    ).toContainText('지금 재시작')
    await expect(
      page.locator('[data-testid="update-banner-later"]')
    ).toContainText('나중에')
  })

  test('clicking "나중에" hides the banner', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.__reelsUpdater, null, {
      timeout: 5_000
    })

    await page.evaluate(() => {
      window.__reelsUpdater?.emitDownloaded({ version: '0.1.2' })
    })

    const banner = page.locator('[data-testid="update-banner-downloaded"]')
    await expect(banner).toBeVisible()
    await page.locator('[data-testid="update-banner-later"]').click()
    await expect(banner).toBeHidden()
  })

  test('progress event renders downloading state with percentage', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.__reelsUpdater, null, {
      timeout: 5_000
    })

    await page.evaluate(() => {
      window.__reelsUpdater?.emitProgress({
        percent: 42,
        transferred: 42_000_000,
        total: 100_000_000,
        bytesPerSecond: 5_000_000
      })
    })

    const banner = page.locator('[data-testid="update-banner-downloading"]')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('새 버전 다운로드 중')
    await expect(banner).toContainText('42% 완료')
  })

  test('installNow() returns false in dev/unpackaged (no quit)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.updater, null, {
      timeout: 5_000
    })
    const result = await page.evaluate(() =>
      window.electron.updater.installNow()
    )
    expect(result).toBe(false)
  })

  test('idle state renders nothing (no banner before any event)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.__reelsUpdater, null, {
      timeout: 5_000
    })
    // Ensure no stray banner is visible after boot.
    await expect(
      page.locator('[data-testid="update-banner-downloaded"]')
    ).toHaveCount(0)
    await expect(
      page.locator('[data-testid="update-banner-downloading"]')
    ).toHaveCount(0)
  })
})
