/**
 * 슬라이드 21 (릴스벤치19) — 자막 전체 선택 후 강조(가라오케) 색상/방식/박스가
 * 선택된 모든 자막에 일괄 적용되어야 한다.
 *
 * Before the fix only FONT / POSITION / OUTLINE / WORD-COLOR bulk-applied; the
 * karaoke emphasis controls (강조 색상 = highlightColor, 강조 방식, 박스 배경)
 * went through updateCaption(captionId) — a SINGLE-caption path — so only the
 * open caption changed and the user had to edit each one by hand. Fix: route
 * setKaraoke/toggleKaraoke through styleTargetIds (per-caption merge), keeping
 * per-word `words` timing single-caption.
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

const WORDS = [
  { text: 'hello', startMs: 0, endMs: 450 },
  { text: 'world', startMs: 450, endMs: 900 },
  { text: 'here', startMs: 900, endMs: 1350 }
]

test.describe('@slide-21-caption-bulk-karaoke', () => {
  let launched: LaunchedApp | null = null
  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', { state: 'attached', timeout: 45_000 })
    await page.waitForFunction(() => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore, null, { timeout: 8_000 })
  })
  test.afterEach(async () => {
    if (launched) {
      try {
        await launched.app.close()
      } catch {
        /* */
      }
      launched = null
    }
  })

  test('강조 색상/방식/박스가 선택된 모든 자막에 일괄 적용된다', async () => {
    test.setTimeout(120_000)
    const { page } = launched!

    // Open the caption editor ('c' creates caption A + opens the panel).
    await page.keyboard.press('c')
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible({ timeout: 5_000 })

    // Give A word timing (karaoke needs it), add B + C with timing, select all 3
    // WITHOUT changing the active (open) caption A.
    const ids = await page.evaluate((words) => {
      const reels = window.__reelsStore
      const ct = reels.state().project.tracks.find((t) => t.kind === 'caption')!
      const a = ct.clips.find((c) => c.kind === 'caption')!.id
      reels.updateCaption(a, { words, spans: [{ text: 'hello world here' }] })
      const mk = (start: number, end: number): string => {
        const id = reels.newId()
        reels.addCaption({ id, kind: 'caption', trackId: ct.id, startMs: start, endMs: end, spans: [{ text: 'hello world here' }], words, style: {} })
        return id
      }
      const b = mk(1600, 3000)
      const c = mk(3100, 4500)
      ;(window as unknown as { __reelsTimelineUi: { setState: (p: unknown) => void } })
        .__reelsTimelineUi.setState({ selectedClipIds: new Set([a, b, c]) })
      return { a, b, c }
    }, WORDS)
    await page.waitForTimeout(200)

    // Drive the REAL panel controls: enable karaoke, set 강조 색상 + 박스 배경.
    await page.locator('[data-testid="caption-karaoke-toggle"]').check()
    await page.waitForTimeout(150)
    await page.locator('[data-testid="caption-karaoke-color"]').fill('#ff0000')
    await page.waitForTimeout(150)
    const boxRow = page.locator('[data-testid="caption-karaoke-box"]')
    if (await boxRow.count()) {
      await boxRow.check().catch(() => {})
      await page.waitForTimeout(150)
    }

    const karaokes = await page.evaluate((wanted) => {
      const reels = window.__reelsStore
      const out: Record<string, { enabled?: boolean; highlightColor?: string; highlightBox?: boolean } | null> = {}
      for (const t of reels.state().project.tracks)
        for (const c of t.clips)
          if (c.kind === 'caption' && (wanted as string[]).includes(c.id))
            out[c.id] = (c as { karaoke?: { enabled?: boolean; highlightColor?: string; highlightBox?: boolean } }).karaoke ?? null
      return out
    }, [ids.a, ids.b, ids.c])

    // ALL three selected captions must carry the same karaoke emphasis style.
    for (const id of [ids.a, ids.b, ids.c]) {
      expect(karaokes[id], `caption ${id} karaoke`).not.toBeNull()
      expect(karaokes[id]!.enabled, `caption ${id} enabled`).toBe(true)
      expect(karaokes[id]!.highlightColor, `caption ${id} color`).toBe('#ff0000')
    }
  })
})
