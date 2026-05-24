/**
 * Phase 3.53 — transition library expansion (6 → 35 kinds, 8 categories).
 *
 * Layer A (pure, no Electron launch): kind enum × xfade native mapping × label
 * coverage × category coverage.
 *
 * Layer B (UI, with Electron launch): EffectsPanel 전환 tab renders one section
 * per category, all 35 kinds expose `effects-transition-preset-{kind}` testid,
 * clicking a category preset writes `transitionIn = { kind, durationMs }` to
 * the clip, and the 'none' chip resets `transitionIn` to undefined.
 *
 * @phase-3-53-transition-library
 */

import { expect, test } from '@playwright/test'
import {
  TRANSITION_CATEGORIES,
  TRANSITION_KINDS,
  type TransitionKind
} from '../../src/shared/project'
import {
  TRANSITION_LABELS,
  transitionKindToXfade
} from '../../src/shared/filterPresets'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// xfade native names (ffmpeg ≥ 4.3). Every non-'none' kind MUST map to one.
// Source: ffmpeg.org/ffmpeg-filters.html#xfade — full list of transition= values.
// ---------------------------------------------------------------------------
const XFADE_NATIVE = new Set<string>([
  'fade',
  'fadeblack',
  'fadewhite',
  'fadegrays',
  'distance',
  'dissolve',
  'pixelize',
  'radial',
  'hblur',
  'hlslice',
  'hrslice',
  'vuslice',
  'vdslice',
  'hlwind',
  'hrwind',
  'vuwind',
  'vdwind',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'wipetl',
  'wipetr',
  'wipebl',
  'wipebr',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'smoothleft',
  'smoothright',
  'smoothup',
  'smoothdown',
  'coverleft',
  'coverright',
  'coverup',
  'coverdown',
  'revealleft',
  'revealright',
  'revealup',
  'revealdown',
  'circleopen',
  'circleclose',
  'horzopen',
  'horzclose',
  'vertopen',
  'vertclose',
  'rectcrop',
  'circlecrop',
  'diagtl',
  'diagtr',
  'diagbl',
  'diagbr',
  'squeezeh',
  'squeezev',
  'zoomin',
  'fadefast',
  'fadeslow'
])

// ===========================================================================
// LAYER A — pure (no Electron)
// ===========================================================================
test.describe('@phase-3-53-transition-library Layer A — pure', () => {
  test('A-1 every non-none kind maps to a native ffmpeg xfade transition name', () => {
    for (const k of TRANSITION_KINDS) {
      if (k === 'none') continue
      const xfade = transitionKindToXfade(k)
      expect(typeof xfade, `kind ${k}`).toBe('string')
      expect(
        XFADE_NATIVE.has(xfade),
        `kind ${k} → ${xfade} not in ffmpeg xfade native list`
      ).toBe(true)
    }
  })

  test('A-2 TRANSITION_LABELS covers every kind (no missing 라벨)', () => {
    for (const k of TRANSITION_KINDS) {
      const label = TRANSITION_LABELS[k]
      expect(label, `label for ${k}`).toBeTruthy()
      expect(typeof label).toBe('string')
    }
  })

  test('A-3 TRANSITION_CATEGORIES union exactly equals TRANSITION_KINDS minus none, with no duplicates', () => {
    const seen = new Set<TransitionKind>()
    let dupCount = 0
    for (const cat of TRANSITION_CATEGORIES) {
      for (const k of cat.kinds) {
        if (seen.has(k)) dupCount += 1
        seen.add(k)
      }
    }
    expect(dupCount, 'a kind is duplicated across categories').toBe(0)
    const nonNone = TRANSITION_KINDS.filter((k) => k !== 'none')
    expect(seen.size).toBe(nonNone.length)
    for (const k of nonNone) {
      expect(seen.has(k), `kind ${k} not assigned to any category`).toBe(true)
    }
  })

  test('A-4 grew from the legacy 6 kinds — total count ≥ 30 and 8 categories', () => {
    const nonNone = TRANSITION_KINDS.filter((k) => k !== 'none')
    expect(nonNone.length).toBeGreaterThanOrEqual(30)
    expect(TRANSITION_CATEGORIES.length).toBe(8)
  })

  test('A-5 directional kinds map to matching directional xfade names', () => {
    const dirs: Array<[TransitionKind, string]> = [
      ['slide-left', 'slideleft'],
      ['slide-right', 'slideright'],
      ['slide-up', 'slideup'],
      ['slide-down', 'slidedown'],
      ['wipe-left', 'wipeleft'],
      ['wipe-right', 'wiperight'],
      ['wipe-up', 'wipeup'],
      ['wipe-down', 'wipedown'],
      ['cover-left', 'coverleft'],
      ['cover-right', 'coverright'],
      ['reveal-left', 'revealleft'],
      ['reveal-right', 'revealright'],
      ['diag-top-left', 'diagtl'],
      ['diag-bottom-right', 'diagbr']
    ]
    for (const [k, expected] of dirs) {
      expect(transitionKindToXfade(k), `${k} mapping`).toBe(expected)
    }
  })

  test('A-6 backwards-compat: legacy 6 kinds still map to their pre-3.53 xfade names', () => {
    expect(transitionKindToXfade('crossfade')).toBe('fade')
    expect(transitionKindToXfade('slide-left')).toBe('slideleft')
    expect(transitionKindToXfade('slide-right')).toBe('slideright')
    expect(transitionKindToXfade('fade-to-black')).toBe('fadeblack')
    expect(transitionKindToXfade('zoom-in')).toBe('zoomin')
    expect(transitionKindToXfade('glitch')).toBe('pixelize')
  })
})

// ===========================================================================
// LAYER B — UI (Electron launched)
// ===========================================================================
type ProjectStoreState = {
  project: {
    tracks: Array<{
      id: string
      kind: string
      clips: Array<Record<string, unknown>>
    }>
    media: Record<string, unknown>
  }
  setClipTransitionIn: (
    clipId: string,
    kind: TransitionKind,
    durationMs: number
  ) => void
  createNew: () => void
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => ProjectStoreState
    }
    __reelsStore: {
      state: () => ProjectStoreState
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
    }
    __reelsTimelineUi: {
      getState: () => {
        setPlayheadMs: (ms: number) => void
        selectClip: (id: string) => void
      }
    }
  }
}

test.describe('@phase-3-53-transition-library Layer B — UI', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched!
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
    })
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
      await new Promise((r) => setTimeout(r, 900))
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

  async function openEditor(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
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
  }

  async function addClipFromFixture(): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4!
    return launched.page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = window.__reelsStore
      const mid = reels.newId()
      reels.addMedia({
        id: mid,
        path: filePath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width ?? 1080,
        height: probe.height ?? 1920,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      const track = reels
        .state()
        .project.tracks.find((t) => t.kind === 'video')!
      const cid = reels.newId()
      reels.addClip({
        id: cid,
        kind: 'media',
        mediaId: mid,
        trackId: track.id,
        startMs: 0,
        endMs: probe.durationMs,
        trimInMs: 0,
        trimOutMs: probe.durationMs,
        speed: 1
      })
      return cid
    }, fixture)
  }

  async function selectClip(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const block = page
      .locator(
        `[data-testid="media-clip-block"][data-clip-id="${clipId}"]`
      )
      .first()
    if ((await block.count()) > 0) {
      await block.click({ force: true })
      await page.waitForTimeout(200)
      return
    }
    await page.evaluate((id) => {
      window.__reelsTimelineUi.getState().selectClip(id)
    }, clipId)
    await page.waitForTimeout(150)
  }

  async function openTransitionTab(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await selectClip(clipId)
    const toggleBtn = page.locator('[data-testid="toggle-effects-panel"]')
    const panelCount = await page
      .locator('[data-testid="effects-panel"]')
      .count()
    if (panelCount === 0) {
      await toggleBtn.click()
      await expect(
        page.locator('[data-testid="effects-panel"]')
      ).toBeVisible({ timeout: 5_000 })
    }
    const tab = page.locator('[data-testid="effects-tab-transition"]')
    if ((await tab.count()) > 0) {
      const pressed = await tab.getAttribute('aria-pressed')
      if (pressed !== 'true') {
        await tab.click()
        await page.waitForTimeout(150)
      }
    }
    await expect(
      page.locator('[data-testid="effects-section-transition"]')
    ).toBeVisible({ timeout: 5_000 })
  }

  async function getClipState(
    clipId: string
  ): Promise<Record<string, unknown> | null> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate((cid) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project
        .tracks) {
        for (const c of t.clips) {
          if ((c as Record<string, unknown>).id === cid) return c
        }
      }
      return null
    }, clipId)
  }

  test('B-1 all 8 categories + all 35 non-none kind presets render in the panel', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const cid = await addClipFromFixture()
    await openTransitionTab(cid)

    for (const cat of TRANSITION_CATEGORIES) {
      await expect(
        page.locator(`[data-testid="effects-transition-category-${cat.id}"]`)
      ).toBeVisible()
      for (const k of cat.kinds) {
        await expect(
          page.locator(`[data-testid="effects-transition-preset-${k}"]`)
        ).toBeVisible()
      }
    }
    // 'none' chip is rendered above the grid.
    await expect(
      page.locator('[data-testid="effects-transition-preset-none"]')
    ).toBeVisible()
  })

  test('B-2 clicking a new-category preset (wipe-up) writes transitionIn to the clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const cid = await addClipFromFixture()
    await openTransitionTab(cid)

    await page
      .locator('[data-testid="effects-transition-preset-wipe-up"]')
      .click()
    await page.waitForTimeout(150)
    const clip = await getClipState(cid)
    expect(clip).not.toBeNull()
    const tIn = (clip as { transitionIn?: { kind: string; durationMs: number } })
      .transitionIn
    expect(tIn?.kind).toBe('wipe-up')
    expect(typeof tIn?.durationMs).toBe('number')
    expect((tIn?.durationMs ?? 0) > 0).toBe(true)
  })

  test('B-3 clicking circle-open then none resets transitionIn to absent / kind=none', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const cid = await addClipFromFixture()
    await openTransitionTab(cid)

    await page
      .locator('[data-testid="effects-transition-preset-circle-open"]')
      .click()
    await page.waitForTimeout(150)
    let clip = await getClipState(cid)
    expect(
      (clip as { transitionIn?: { kind: string } }).transitionIn?.kind
    ).toBe('circle-open')

    await page
      .locator('[data-testid="effects-transition-preset-none"]')
      .click()
    await page.waitForTimeout(150)
    clip = await getClipState(cid)
    const finalKind = (clip as { transitionIn?: { kind: string } }).transitionIn
      ?.kind
    // Store implementations may either delete the field or store kind 'none' —
    // both are byte-identical at export (the xfade builder gates on
    // kind !== 'none'). Accept either.
    expect(finalKind === undefined || finalKind === 'none').toBe(true)
  })
})
