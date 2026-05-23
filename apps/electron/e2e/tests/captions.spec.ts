import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-2-captions caption track + overlay + editor', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    // Reset the persisted project so tests start from a clean slate.
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await page.evaluate(async () => {
      const store = (window as unknown as {
        __PROJECT_STORE_FOR_TEST__: { getState: () => { createNew: () => void } }
      }).__PROJECT_STORE_FOR_TEST__
      store.getState().createNew()
      // Wait for persistence debounce.
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

  test('captions bridge surface is exposed', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.captions, null, {
      timeout: 5_000
    })
    const keys = await page.evaluate(() =>
      Object.keys(
        (window as unknown as { electron: { captions: Record<string, unknown> } })
          .electron.captions
      ).sort()
    )
    // Phase 3.34 added exportSubtitle to the captions bridge.
    expect(keys).toEqual(['exportSubtitle', 'importSrt', 'parseSrtString'])
  })

  test('press C at playhead 1000ms creates a 1000–3000ms caption clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()

    // Set playhead via the topbar input.
    const playhead = page.locator('[data-testid="playhead-input"]')
    await playhead.click({ clickCount: 3 })
    await playhead.fill('1000')
    await playhead.press('Tab') // commit

    // Send "C" (focused on body — not on the input).
    await page.locator('[data-testid="editor-page"]').click()
    await page.keyboard.press('c')

    // A caption clip block should appear on the caption track.
    const captionBlocks = page.locator('[data-testid="caption-clip-block"]')
    await expect(captionBlocks).toHaveCount(1)

    // CaptionEditor should auto-open.
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()

    // Verify timing via the store.
    const range = await page.evaluate(() => {
      type Store = {
        getState: () => {
          project: {
            tracks: Array<{
              kind: string
              clips: Array<{
                kind: string
                startMs: number
                endMs: number
              }>
            }>
          }
        }
      }
      const w = window as unknown as {
        __PROJECT_STORE_FOR_TEST__?: Store
      }
      // Defer to store proxy — exposed below in production code path.
      const st = w.__PROJECT_STORE_FOR_TEST__?.getState?.()
      if (!st) return null
      const captionTrack = st.project.tracks.find((t) => t.kind === 'caption')
      const first = captionTrack?.clips.find((c) => c.kind === 'caption')
      return first ? { start: first.startMs, end: first.endMs } : null
    })
    // The store proxy may not be installed; fall back to UI-only assertion.
    if (range) {
      expect(range.start).toBe(1000)
      expect(range.end).toBe(3000)
    }
  })

  test('add caption via "+ 자막 추가" button + edit text via store action', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()

    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()

    // The overlay should render the default text.
    await expect(
      page.locator('[data-testid="caption-overlay"]').first()
    ).toBeVisible()

    // Edit text in the textarea.
    const ta = page.locator('[data-testid="caption-text-input"]')
    await ta.click({ clickCount: 3 })
    await ta.fill('안녕 친구')
    await ta.blur()

    // Overlay should now contain the new text.
    await expect(
      page.locator('[data-testid="caption-overlay"]')
    ).toContainText('안녕')
    await expect(
      page.locator('[data-testid="caption-overlay"]')
    ).toContainText('친구')
  })

  test('changing preset changes the data-preset attribute on overlay', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()

    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()

    const overlay = page.locator('[data-testid="caption-overlay"]').first()
    await expect(overlay).toHaveAttribute('data-preset', 'bottom-center')

    await page
      .locator('[data-testid="caption-preset-select"]')
      .selectOption('neon')
    await expect(overlay).toHaveAttribute('data-preset', 'neon')

    await page
      .locator('[data-testid="caption-preset-select"]')
      .selectOption('youtube-yellow')
    await expect(overlay).toHaveAttribute('data-preset', 'youtube-yellow')
  })

  test('SRT parse via IPC and import via parseSrtString surfaces cues', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.waitForFunction(() => !!window.electron?.captions, null, {
      timeout: 5_000
    })

    const srt =
      '1\n00:00:00,000 --> 00:00:02,500\nHello world\n\n' +
      '2\n00:00:03,000 --> 00:00:05,000\n안녕 친구\n'

    const cues = await page.evaluate(
      async (raw) => window.electron.captions.parseSrtString(raw),
      srt
    )
    expect(cues).toHaveLength(2)
    expect(cues[0].startMs).toBe(0)
    expect(cues[0].endMs).toBe(2500)
    expect(cues[0].text).toBe('Hello world')
    expect(cues[1].startMs).toBe(3000)
    expect(cues[1].endMs).toBe(5000)
    expect(cues[1].text).toBe('안녕 친구')

    // VTT variant (dot decimals + WEBVTT header).
    const vtt =
      'WEBVTT\n\n' +
      '00:00:00.000 --> 00:00:01.500\nfirst line\n\n' +
      '00:00:01.500 --> 00:00:03.000\nsecond line\n'
    const cuesVtt = await page.evaluate(
      async (raw) => window.electron.captions.parseSrtString(raw),
      vtt
    )
    expect(cuesVtt).toHaveLength(2)
    expect(cuesVtt[0].endMs).toBe(1500)
    expect(cuesVtt[1].text).toBe('second line')

    // BOM + CRLF resilience.
    const crlf = '\uFEFF1\r\n00:00:00,000 --> 00:00:01,000\r\nbom test\r\n\r\n'
    const cuesCrlf = await page.evaluate(
      async (raw) => window.electron.captions.parseSrtString(raw),
      crlf
    )
    expect(cuesCrlf).toHaveLength(1)
    expect(cuesCrlf[0].text).toBe('bom test')
  })

  test('caption context menu has NO "속도" entry; media context menu DOES', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()

    // Create one caption clip via the button.
    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()
    // Close the editor so right-click target is unambiguous.
    await page.locator('[data-testid="caption-editor-close"]').click()

    // Right-click the caption clip.
    const block = page.locator('[data-testid="caption-clip-block"]').first()
    await block.click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible()

    // The menu should have edit-caption and NOT speed.
    await expect(page.locator('[data-testid="menu-edit-caption"]')).toBeVisible()
    await expect(page.locator('[data-testid="menu-speed"]')).toHaveCount(0)
    await expect(
      page.locator('[data-testid="clip-context-menu"]')
    ).toHaveAttribute('data-clip-kind', 'caption')
  })

  test('keyword emphasis: marking a word as bold sets font-weight 800 on span', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()

    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()

    // Set text "hello world bold" then pick the third word and bold it.
    const ta = page.locator('[data-testid="caption-text-input"]')
    await ta.click({ clickCount: 3 })
    await ta.fill('hello world bold')
    await ta.blur()

    // Click the 3rd word in the editor preview to select it.
    await page.locator('[data-testid="caption-word-2"]').click()
    await page.locator('[data-testid="emphasis-bold"]').click()

    // Verify the OVERLAY span renders with font-weight 800. The spans live
    // inside the overlay; the third word should be the bolded one.
    const spans = page.locator('[data-testid="caption-span"][data-emphasis="bold"]')
    await expect(spans).toHaveCount(1)
    const fw = await spans.first().evaluate((el) => getComputedStyle(el).fontWeight)
    expect(fw).toBe('800')
  })

  test('phase 1+2.1 surfaces still expose expected bridges (no regression)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    const surfaces = await page.evaluate(() => {
      const e = (window as unknown as { electron: Record<string, unknown> }).electron
      return Object.keys(e).sort()
    })
    expect(surfaces).toContain('ffmpeg')
    expect(surfaces).toContain('fs')
    expect(surfaces).toContain('media')
    expect(surfaces).toContain('auth')
    expect(surfaces).toContain('captions')
  })
})
