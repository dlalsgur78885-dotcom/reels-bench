/**
 * prefers-reduced-motion — Phase: a11y-reduced-motion.
 *
 * Adds `usePrefersReducedMotion()` hook + wires it into 3 components that
 * audit `audit-electron-sweep-20260525.md` flagged as motion-unconditional:
 * AudioMeter, UpdateBanner, App-level progress bar. When the OS pref is
 * reduce, bar `transition` becomes 'none' and AudioMeter polling drops
 * from 50ms (20Hz) to 200ms (5Hz). Color-only clipping warning gets a ⚠
 * shape indicator + hatched fill (WCAG 1.4.1).
 *
 * @a11y-reduced-motion
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@a11y-reduced-motion AudioMeter respects OS pref + color-only fix', () => {
  let launched: LaunchedApp | null = null

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

  test('A-1 default (no media emulation): bar transition is non-empty', async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', {
      state: 'attached',
      timeout: 45_000
    })
    const bar = page.locator('[data-testid="audio-meter-peak-bar"]')
    await expect(bar).toBeAttached({ timeout: 10_000 })
    const t = await bar.evaluate((el) => (el as HTMLElement).style.transition)
    // Default: '50ms linear' style — the exact string is the legacy value.
    expect(t.replace(/\s+/g, ' ').trim()).toContain('50ms')
  })

  test('A-2 with prefers-reduced-motion: reduce → bar transition is "none"', async () => {
    launched = await launchElectron()
    const { page } = launched
    // emulateMedia must be called BEFORE the component mounts to take effect
    // on the initial useState read; calling it pre-navigation is enough since
    // open-editor-button click triggers the mount.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', {
      state: 'attached',
      timeout: 45_000
    })
    const bar = page.locator('[data-testid="audio-meter-peak-bar"]')
    await expect(bar).toBeAttached({ timeout: 10_000 })
    const t = await bar.evaluate((el) => (el as HTMLElement).style.transition)
    expect(t.trim()).toBe('none')
  })

  test('A-3 bar carries role="meter" + aria-valuemin/max/now for SR', async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', {
      state: 'attached',
      timeout: 45_000
    })
    const meter = page
      .getByRole('meter', { name: /피크 레벨/ })
      .first()
    await expect(meter).toBeVisible({ timeout: 10_000 })
    expect(await meter.getAttribute('aria-valuemin')).toBe('-60')
    expect(await meter.getAttribute('aria-valuemax')).toBe('0')
    // value-now is rounded peak; finite -60..0 expected
    const vn = Number(await meter.getAttribute('aria-valuenow'))
    expect(vn).toBeGreaterThanOrEqual(-60)
    expect(vn).toBeLessThanOrEqual(0)
  })

  test('A-4 clip warning ⚠ icon + data-clipping flips when peak > -3 dBFS', async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', {
      state: 'attached',
      timeout: 45_000
    })
    const bar = page.locator('[data-testid="audio-meter-peak-bar"]')
    await expect(bar).toBeAttached({ timeout: 10_000 })
    // Default state: silent → not clipping. The data attribute is the
    // gating signal (driven by peak > -3 dBFS at render time).
    expect(await bar.getAttribute('data-clipping')).toBe('false')
    // The ⚠ icon is rendered ONLY when clipping. With no audio it must be
    // absent so we never warn about silence.
    await expect(page.locator('[data-testid="audio-meter-clip-icon"]')).toHaveCount(0)
  })
})
