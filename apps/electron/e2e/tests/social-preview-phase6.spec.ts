import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 6 — SNS 플랫폼 미리보기 e2e suite.
 *
 * Verification items:
 *  1. social-preview-select renders inside the preview area with 4 options; default = 'none' (없음)
 *  2. 'none' state — social-preview-overlay is absent from DOM
 *  3. TikTok selection — social-overlay-tiktok renders inside social-preview-layer;
 *     action-stack, caption-block, safezones are present
 *  4. YouTube Shorts selection — social-overlay-youtube renders; action-stack, caption-block, safezones present
 *  5. Instagram 릴스 selection — social-overlay-instagram renders; action-stack, caption-block, safezones present
 *  6. Overlay is non-interactive — pointer-events: none on social-preview-overlay root
 *  7. Switching back to 'none' removes the overlay from DOM
 *  8. Store state reflects UI selection via __TIMELINE_UI_FOR_TEST__
 *  9. Regression — social-preview-layer always exists in DOM (even when platform is none)
 * 10. Regression — PreviewCanvas still renders preview-canvas, preview-fitted-rect,
 *     caption-overlay-layer, overlay-layer after Phase 6 changes
 *
 * Tag: @phase-6-social-preview
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TimelineUiStore = {
  getState: () => {
    socialPreviewPlatform: 'none' | 'tiktok' | 'youtube' | 'instagram'
    setSocialPreviewPlatform: (p: string) => void
  }
}

async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.locator('[data-testid="open-editor-button"]').click()
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible({ timeout: 8_000 })
  await page.waitForFunction(
    () => !!(window as unknown as { __TIMELINE_UI_FOR_TEST__?: unknown }).__TIMELINE_UI_FOR_TEST__,
    null,
    { timeout: 5_000 }
  )
  // Reset social preview platform to none (guard against test bleed).
  await page.evaluate(() => {
    const ui = (
      window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
    ).__TIMELINE_UI_FOR_TEST__
    ui.getState().setSocialPreviewPlatform('none')
  })
  await page.waitForTimeout(100)
}

async function getSocialPlatformFromStore(launched: LaunchedApp): Promise<string> {
  return launched.page.evaluate(() => {
    const ui = (
      window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
    ).__TIMELINE_UI_FOR_TEST__
    return ui.getState().socialPreviewPlatform
  })
}

/** Select a platform via the <select> element and wait for React to re-render. */
async function selectPlatform(
  launched: LaunchedApp,
  value: 'none' | 'tiktok' | 'youtube' | 'instagram'
): Promise<void> {
  const sel = launched.page.locator('[data-testid="social-preview-select"]')
  await sel.selectOption({ value })
  await launched.page.waitForTimeout(150)
}

// ===========================================================================
// Suite
// ===========================================================================

test.describe('@phase-6-social-preview SNS 플랫폼 미리보기 (Phase 6)', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await openEditor(launched)
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

  // =========================================================================
  // 1. Selector renders in preview area; 4 options; default = '없음' (none)
  // =========================================================================
  test('[1] social-preview-select renders with 4 options and defaults to none (없음)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // The selector label wrapper must be visible.
    const selectorLabel = page.locator('[data-testid="social-preview-selector"]')
    await expect(selectorLabel).toBeVisible({ timeout: 5_000 })

    // The <select> itself.
    const sel = page.locator('[data-testid="social-preview-select"]')
    await expect(sel).toBeVisible()

    // Exactly 4 options.
    const options = sel.locator('option')
    await expect(options).toHaveCount(4)

    // Options have correct data-testid and value attributes.
    await expect(sel.locator('[data-testid="social-preview-option-none"]')).toHaveCount(1)
    await expect(sel.locator('[data-testid="social-preview-option-tiktok"]')).toHaveCount(1)
    await expect(sel.locator('[data-testid="social-preview-option-youtube"]')).toHaveCount(1)
    await expect(sel.locator('[data-testid="social-preview-option-instagram"]')).toHaveCount(1)

    // Default selected value must be 'none'.
    const selectedVal = await sel.inputValue()
    expect(selectedVal).toBe('none')

    // Option labels match the spec wording.
    const noneOption = sel.locator('[data-testid="social-preview-option-none"]')
    await expect(noneOption).toHaveText('없음')
    const tiktokOption = sel.locator('[data-testid="social-preview-option-tiktok"]')
    await expect(tiktokOption).toHaveText('TikTok')
    const ytOption = sel.locator('[data-testid="social-preview-option-youtube"]')
    await expect(ytOption).toHaveText('YouTube Shorts')
    const igOption = sel.locator('[data-testid="social-preview-option-instagram"]')
    await expect(igOption).toHaveText('Instagram 릴스')
  })

  // =========================================================================
  // 2. 'none' — overlay absent from DOM
  // =========================================================================
  test('[2] "없음" state: social-preview-overlay is absent from DOM', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Default is already 'none'.
    const storeVal = await getSocialPlatformFromStore(launched)
    expect(storeVal).toBe('none')

    // The overlay element must NOT be in the DOM.
    await expect(page.locator('[data-testid="social-preview-overlay"]')).toHaveCount(0)
  })

  // =========================================================================
  // 3. TikTok — overlay + sub-elements present
  // =========================================================================
  test('[3] TikTok: social-overlay-tiktok renders with action-stack, caption-block, safezones', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await selectPlatform(launched, 'tiktok')

    // The wrapper must exist in the social-preview-layer.
    const layer = page.locator('[data-testid="social-preview-layer"]')
    await expect(layer).toBeVisible()

    // Top-level overlay.
    const overlay = page.locator('[data-testid="social-preview-overlay"]')
    await expect(overlay).toBeVisible({ timeout: 3_000 })
    await expect(overlay).toHaveAttribute('data-platform', 'tiktok')

    // TikTok chrome div.
    const chrome = page.locator('[data-testid="social-overlay-tiktok"]')
    await expect(chrome).toBeVisible()

    // Action stack (right-side buttons).
    const actionStack = chrome.locator('[data-testid="social-overlay-action-stack"]')
    await expect(actionStack).toBeVisible()

    // Caption block (bottom-left content block).
    const captionBlock = chrome.locator('[data-testid="social-overlay-caption-block"]')
    await expect(captionBlock).toBeVisible()

    // Safezones — both top and bottom bands.
    const safeTop = chrome.locator('[data-testid="social-overlay-safezone-top"]')
    await expect(safeTop).toBeAttached()
    const safeBottom = chrome.locator('[data-testid="social-overlay-safezone-bottom"]')
    await expect(safeBottom).toBeAttached()

    // Music row unique to TikTok.
    const musicRow = chrome.locator('[data-testid="social-overlay-music-row"]')
    await expect(musicRow).toBeVisible()

    // Store reflects the change.
    const storeVal = await getSocialPlatformFromStore(launched)
    expect(storeVal).toBe('tiktok')
  })

  // =========================================================================
  // 4. YouTube Shorts — overlay + sub-elements present
  // =========================================================================
  test('[4] YouTube Shorts: social-overlay-youtube renders with action-stack, caption-block, safezones', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await selectPlatform(launched, 'youtube')

    const overlay = page.locator('[data-testid="social-preview-overlay"]')
    await expect(overlay).toBeVisible({ timeout: 3_000 })
    await expect(overlay).toHaveAttribute('data-platform', 'youtube')

    const chrome = page.locator('[data-testid="social-overlay-youtube"]')
    await expect(chrome).toBeVisible()

    // Action stack.
    await expect(chrome.locator('[data-testid="social-overlay-action-stack"]')).toBeVisible()

    // Caption block (YouTube uses a custom layout but still carries testid).
    await expect(chrome.locator('[data-testid="social-overlay-caption-block"]')).toBeVisible()

    // Safezones.
    await expect(chrome.locator('[data-testid="social-overlay-safezone-top"]')).toBeAttached()
    await expect(chrome.locator('[data-testid="social-overlay-safezone-bottom"]')).toBeAttached()

    // Subscribe pill unique to YouTube.
    await expect(chrome.locator('[data-testid="social-overlay-subscribe"]')).toBeVisible()

    const storeVal = await getSocialPlatformFromStore(launched)
    expect(storeVal).toBe('youtube')
  })

  // =========================================================================
  // 5. Instagram 릴스 — overlay + sub-elements present
  // =========================================================================
  test('[5] Instagram 릴스: social-overlay-instagram renders with action-stack, caption-block, safezones', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await selectPlatform(launched, 'instagram')

    const overlay = page.locator('[data-testid="social-preview-overlay"]')
    await expect(overlay).toBeVisible({ timeout: 3_000 })
    await expect(overlay).toHaveAttribute('data-platform', 'instagram')

    const chrome = page.locator('[data-testid="social-overlay-instagram"]')
    await expect(chrome).toBeVisible()

    await expect(chrome.locator('[data-testid="social-overlay-action-stack"]')).toBeVisible()
    await expect(chrome.locator('[data-testid="social-overlay-caption-block"]')).toBeVisible()

    await expect(chrome.locator('[data-testid="social-overlay-safezone-top"]')).toBeAttached()
    await expect(chrome.locator('[data-testid="social-overlay-safezone-bottom"]')).toBeAttached()

    // Music row (Instagram also shows it).
    await expect(chrome.locator('[data-testid="social-overlay-music-row"]')).toBeVisible()

    // Rotating audio thumbnail unique to Instagram.
    await expect(chrome.locator('[data-testid="social-action-audio"]')).toBeVisible()

    const storeVal = await getSocialPlatformFromStore(launched)
    expect(storeVal).toBe('instagram')
  })

  // =========================================================================
  // 6. Overlay non-interactive — pointer-events: none on overlay root
  // =========================================================================
  test('[6] social-preview-overlay has pointer-events: none (non-interactive)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await selectPlatform(launched, 'tiktok')

    const overlay = page.locator('[data-testid="social-preview-overlay"]')
    await expect(overlay).toBeVisible({ timeout: 3_000 })

    // Read the computed pointer-events style.
    const pointerEvents = await overlay.evaluate(
      (el) => window.getComputedStyle(el).pointerEvents
    )
    expect(pointerEvents).toBe('none')

    // Also verify the wrapper layer (social-preview-layer) has pointer-events: none.
    const layer = page.locator('[data-testid="social-preview-layer"]')
    const layerPointerEvents = await layer.evaluate(
      (el) => window.getComputedStyle(el).pointerEvents
    )
    expect(layerPointerEvents).toBe('none')
  })

  // =========================================================================
  // 7. Switching back to 'none' removes overlay
  // =========================================================================
  test('[7] switching back to none removes social-preview-overlay from DOM', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // First switch to Instagram.
    await selectPlatform(launched, 'instagram')
    await expect(page.locator('[data-testid="social-preview-overlay"]')).toBeVisible({
      timeout: 3_000
    })

    // Switch back to none.
    await selectPlatform(launched, 'none')
    await expect(page.locator('[data-testid="social-preview-overlay"]')).toHaveCount(0)

    const storeVal = await getSocialPlatformFromStore(launched)
    expect(storeVal).toBe('none')
  })

  // =========================================================================
  // 8. Store reflects UI selection (store-driven update renders correctly)
  // =========================================================================
  test('[8] setting socialPreviewPlatform via store renders the correct overlay', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Drive state directly from the store (bypassing the <select>).
    await page.evaluate(() => {
      const ui = (
        window as unknown as { __TIMELINE_UI_FOR_TEST__: TimelineUiStore }
      ).__TIMELINE_UI_FOR_TEST__
      ui.getState().setSocialPreviewPlatform('youtube')
    })
    await page.waitForTimeout(200)

    // Selector UI must reflect the store.
    const sel = page.locator('[data-testid="social-preview-select"]')
    await expect(sel).toHaveValue('youtube')

    // YouTube overlay must appear.
    await expect(page.locator('[data-testid="social-overlay-youtube"]')).toBeVisible({
      timeout: 3_000
    })

    // TikTok / Instagram overlays must NOT be present.
    await expect(page.locator('[data-testid="social-overlay-tiktok"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="social-overlay-instagram"]')).toHaveCount(0)
  })

  // =========================================================================
  // 9. Regression — social-preview-layer always exists (even when none)
  // =========================================================================
  test('[9] regression: social-preview-layer is always present in DOM regardless of platform', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // None — layer wrapper must still exist.
    await expect(page.locator('[data-testid="social-preview-layer"]')).toBeAttached()

    // TikTok.
    await selectPlatform(launched, 'tiktok')
    await expect(page.locator('[data-testid="social-preview-layer"]')).toBeAttached()

    // Back to none.
    await selectPlatform(launched, 'none')
    await expect(page.locator('[data-testid="social-preview-layer"]')).toBeAttached()
  })

  // =========================================================================
  // 10. Regression — PreviewCanvas core structure survives Phase 6 changes
  // =========================================================================
  test('[10] regression: PreviewCanvas renders its core layers after Phase 6 changes', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Core containers from PreviewCanvas.
    await expect(page.locator('[data-testid="preview-canvas"]')).toBeVisible()
    await expect(page.locator('[data-testid="preview-fitted-rect"]')).toBeAttached()

    // Overlay layer (Phase 3.8) — always present even when empty.
    await expect(page.locator('[data-testid="overlay-layer"]')).toBeAttached()

    // Caption layer — always present even with no captions.
    await expect(page.locator('[data-testid="caption-overlay-layer"]')).toBeAttached()

    // Social preview layer (Phase 6) — present above caption layer.
    await expect(page.locator('[data-testid="social-preview-layer"]')).toBeAttached()

    // Verify layer order (z-index): caption < social-preview.
    // We read the inline zIndex from both layers and confirm social > caption.
    const captionZ = await page
      .locator('[data-testid="caption-overlay-layer"]')
      .evaluate((el) => parseInt(getComputedStyle(el).zIndex || '0', 10))
    const socialZ = await page
      .locator('[data-testid="social-preview-layer"]')
      .evaluate((el) => parseInt(getComputedStyle(el).zIndex || '0', 10))

    expect(socialZ).toBeGreaterThan(captionZ)

    // Switching platform must NOT remove any core canvas layers.
    await selectPlatform(launched, 'instagram')
    await expect(page.locator('[data-testid="preview-canvas"]')).toBeVisible()
    await expect(page.locator('[data-testid="overlay-layer"]')).toBeAttached()
    await expect(page.locator('[data-testid="caption-overlay-layer"]')).toBeAttached()

    await selectPlatform(launched, 'none')
    await expect(page.locator('[data-testid="preview-canvas"]')).toBeVisible()
  })

  // =========================================================================
  // 11. Only one platform chrome renders at a time
  // =========================================================================
  test('[11] only the selected platform chrome is rendered; others are absent', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    const platforms = ['tiktok', 'youtube', 'instagram'] as const

    for (const platform of platforms) {
      await selectPlatform(launched, platform)

      // Chosen platform must be present.
      await expect(
        page.locator(`[data-testid="social-overlay-${platform}"]`)
      ).toBeVisible({ timeout: 3_000 })

      // The other two must NOT be present.
      for (const other of platforms) {
        if (other === platform) continue
        await expect(
          page.locator(`[data-testid="social-overlay-${other}"]`)
        ).toHaveCount(0)
      }
    }
  })

  // =========================================================================
  // 12. No renderer crashes across all platform switches
  // =========================================================================
  test('[12] no page errors across all platform switches', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Cycle through all platforms.
    for (const p of ['tiktok', 'youtube', 'instagram', 'none', 'tiktok', 'none'] as const) {
      await selectPlatform(launched, p)
    }

    // Filter out errors unrelated to our component.
    const criticalErrors = launched.pageErrors.filter(
      (e) => !/supabase|auth|fetch|network/i.test(e.message)
    )
    expect(criticalErrors).toHaveLength(0)

    const criticalConsoleErrors = launched.consoleErrors.filter(
      (msg) => !/supabase|auth|fetch|network|401|403/i.test(msg)
    )
    expect(criticalConsoleErrors).toHaveLength(0)
  })
})
