/**
 * Caption font family picker — Phase: caption-font-family.
 *
 * Adds a user-selectable font (8-item catalog) to CaptionStyle. The picked
 * family wins in both:
 *   - the live editor preview (PreviewCanvas overrides the preset's hardcoded
 *     fontFamily once style.fontFamilyId is set)
 *   - the exported PNG (main/captions/render.ts resolveFontFamily appends the
 *     picked stack ahead of the Pretendard + Korean fallback chain)
 *
 * Korean glyphs always survive because Pretendard (embedded) and system
 * Korean fonts sit at the tail of every resolved stack.
 *
 * @caption-font-family
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

type AnyClip = { id: string; kind: string; style?: { fontFamilyId?: string } }

declare global {
  interface Window {
    __reelsStore: {
      state: () => {
        project: {
          tracks: Array<{ id: string; kind: string; clips: AnyClip[] }>
        }
      }
      addCaption: (c: unknown) => void
      newId: () => string
      updateCaption: (id: string, partial: unknown) => void
    }
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: {
          tracks: Array<{ id: string; kind: string; clips: AnyClip[] }>
        }
        createNew: () => void
      }
    }
  }
}

test.describe('@caption-font-family CaptionStyle.fontFamilyId', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched!
    await page.locator('[data-testid="open-editor-button"]').click({
      timeout: 30_000
    })
    await page.waitForSelector('[data-testid="editor-page"]', {
      state: 'attached',
      timeout: 45_000
    })
    await page.waitForFunction(
      () =>
        !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 8_000 }
    )
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
      await new Promise((r) => setTimeout(r, 500))
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

  async function seedCaption(): Promise<string> {
    return launched!.page.evaluate(() => {
      const reels = window.__reelsStore
      const captionTrack = reels
        .state()
        .project.tracks.find((t) => t.kind === 'caption')
      if (!captionTrack) throw new Error('no caption track')
      const cid = reels.newId()
      reels.addCaption({
        id: cid,
        kind: 'caption',
        trackId: captionTrack.id,
        startMs: 0,
        endMs: 2000,
        spans: [{ text: '폰트' }, { text: '테스트' }],
        style: {
          preset: 'block-bold',
          fontSize: 64,
          align: 'center',
          yPosition: 0.5,
          background: 'none'
        }
      })
      return cid
    })
  }

  function getClipStyle(cid: string): Promise<{ fontFamilyId?: string } | null> {
    return launched!.page.evaluate((id: string) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project
        .tracks) {
        for (const c of t.clips) {
          if (c.id === id) return c.style ?? null
        }
      }
      return null
    }, cid)
  }

  test('A-1 smoke: caption seeds with NO fontFamilyId (legacy default)', async () => {
    const cid = await seedCaption()
    const style = await getClipStyle(cid)
    expect(style?.fontFamilyId).toBeUndefined()
  })

  test('A-2 updateCaption with fontFamilyId persists on the clip', async () => {
    const cid = await seedCaption()
    await launched!.page.evaluate((id: string) => {
      const reels = window.__reelsStore
      const cap = reels
        .state()
        .project.tracks.find((t) => t.kind === 'caption')!
        .clips.find((c) => c.id === id)
      if (!cap) throw new Error('clip not found')
      reels.updateCaption(id, {
        style: { ...(cap.style ?? {}), fontFamilyId: 'impact' }
      })
    }, cid)
    const style = await getClipStyle(cid)
    expect(style?.fontFamilyId).toBe('impact')
  })

  test('A-3 PreviewCanvas applies picked font (Impact) to caption-overlay', async () => {
    const cid = await seedCaption()
    // Switch to Impact.
    await launched!.page.evaluate((id: string) => {
      const reels = window.__reelsStore
      const cap = reels
        .state()
        .project.tracks.find((t) => t.kind === 'caption')!
        .clips.find((c) => c.id === id)!
      reels.updateCaption(id, {
        style: { ...(cap.style ?? {}), fontFamilyId: 'impact' }
      })
    }, cid)
    // Move playhead to caption window so the overlay mounts.
    await launched!.page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: 'Home' })
      window.dispatchEvent(ev)
    })
    await launched!.page.waitForTimeout(200)
    const overlay = launched!.page.locator(
      `[data-testid="caption-overlay"][data-caption-id="${cid}"]`
    )
    await expect(overlay).toBeAttached({ timeout: 5_000 })
    const fontFamily = await overlay.evaluate(
      (el) => getComputedStyle(el).fontFamily
    )
    // The resolved font-family stack must contain "Impact" (picked) AND
    // "Pretendard" (Korean fallback). Browser may quote-strip — just check
    // substring.
    expect(fontFamily.toLowerCase()).toContain('impact')
    expect(fontFamily.toLowerCase()).toContain('pretendard')
  })

  test('A-4 round-trip: switching family clears + re-applies on preview', async () => {
    const cid = await seedCaption()
    const setFamily = (fid: string | undefined): Promise<void> =>
      launched!.page.evaluate(
        ([id, family]) => {
          const reels = window.__reelsStore
          const cap = reels
            .state()
            .project.tracks.find((t) => t.kind === 'caption')!
            .clips.find((c) => c.id === id)!
          reels.updateCaption(id, {
            style: { ...(cap.style ?? {}), fontFamilyId: family }
          })
        },
        [cid, fid] as [string, string | undefined]
      )
    const readFontFamily = (): Promise<string> =>
      launched!.page
        .locator(`[data-testid="caption-overlay"][data-caption-id="${cid}"]`)
        .evaluate((el) => getComputedStyle(el).fontFamily)
    await setFamily('georgia')
    await launched!.page.waitForTimeout(100)
    expect((await readFontFamily()).toLowerCase()).toContain('georgia')
    await setFamily('courier')
    await launched!.page.waitForTimeout(100)
    const ff2 = (await readFontFamily()).toLowerCase()
    expect(ff2).toContain('courier')
    expect(ff2).not.toContain('georgia')
  })

  test('A-5 slide 15: Korean font picks put distinctive Hangul fallback before Pretendard', async () => {
    const cid = await seedCaption()
    await launched!.page.evaluate((id: string) => {
      const reels = window.__reelsStore
      const cap = reels
        .state()
        .project.tracks.find((t) => t.kind === 'caption')!
        .clips.find((c) => c.id === id)!
      reels.updateCaption(id, {
        style: { ...(cap.style ?? {}), fontFamilyId: 'noto-serif-kr' }
      })
    }, cid)
    await launched!.page.waitForTimeout(100)

    const overlay = launched!.page.locator(
      `[data-testid="caption-overlay"][data-caption-id="${cid}"]`
    )
    await expect(overlay).toBeAttached({ timeout: 5_000 })
    const previewFamily = (
      await overlay.evaluate((el) => getComputedStyle(el).fontFamily)
    ).toLowerCase()
    expect(previewFamily).toContain('noto serif kr')
    expect(previewFamily).toContain('batang')
    expect(previewFamily.indexOf('batang')).toBeLessThan(
      previewFamily.indexOf('pretendard')
    )

    const svg = await launched!.page.evaluate(async () => {
      return (
        window as unknown as {
          electron: {
            captions: {
              buildSvg: (caption: unknown, width: number, height: number) => Promise<string>
            }
          }
        }
      ).electron.captions.buildSvg(
        {
          spans: [{ text: '치루화된' }],
          style: {
            preset: 'block-bold',
            fontSize: 80,
            align: 'center',
            yPosition: 0.8,
            background: 'none',
            fontFamilyId: 'noto-serif-kr'
          }
        },
        1080,
        1920
      )
    })
    const fontFamilyDecl = /\.t\{font-family:([^;]+);/i.exec(svg)?.[1].toLowerCase()
    expect(fontFamilyDecl).toBeTruthy()
    expect(fontFamilyDecl!).toContain('noto serif kr')
    expect(fontFamilyDecl!).toContain('batang')
    expect(fontFamilyDecl!.indexOf('batang')).toBeLessThan(
      fontFamilyDecl!.indexOf('pretendard')
    )
  })

  test('A-6 slide 18: picked fonts are registered for preview and export', async () => {
    const cid = await seedCaption()
    await launched!.page.evaluate((id: string) => {
      const reels = window.__reelsStore
      const cap = reels
        .state()
        .project.tracks.find((t) => t.kind === 'caption')!
        .clips.find((c) => c.id === id)!
      reels.updateCaption(id, {
        style: { ...(cap.style ?? {}), fontFamilyId: 'noto-sans-kr' }
      })
    }, cid)
    await launched!.page.waitForTimeout(150)

    const overlay = launched!.page.locator(
      `[data-testid="caption-overlay"][data-caption-id="${cid}"]`
    )
    await expect(overlay).toBeAttached({ timeout: 5_000 })
    const previewFamily = (
      await overlay.evaluate((el) => getComputedStyle(el).fontFamily)
    ).toLowerCase()
    expect(previewFamily).toContain('reelsnotosanskr')

    const svg = await launched!.page.evaluate(async () => {
      return (
        window as unknown as {
          electron: {
            captions: {
              buildSvg: (caption: unknown, width: number, height: number) => Promise<string>
            }
          }
        }
      ).electron.captions.buildSvg(
        {
          spans: [{ text: '치루화된' }],
          style: {
            preset: 'block-bold',
            fontSize: 80,
            align: 'center',
            yPosition: 0.8,
            background: 'none',
            fontFamilyId: 'noto-sans-kr'
          }
        },
        1080,
        1920
      )
    })
    expect(svg).toContain("@font-face{font-family:'ReelsNotoSansKR'")
    expect(svg.toLowerCase()).toContain('reelsnotosanskr')
  })
})
