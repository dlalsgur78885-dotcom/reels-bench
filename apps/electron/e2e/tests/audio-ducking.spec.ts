/**
 * Phase 3.55 — audio ducking (sidechain compressor on BGM ← voice).
 *
 * Data model + export pipeline were already wired (Track.duckTarget +
 * sidechaincompress in export.ts). This phase adds:
 *   - `setTrackDucking(trackId, target, db?)` store action (validated +
 *     dB-clamped to [-30, -1]; audio-only; idempotent).
 *   - TrackContextMenu ducking row with a toggle + dB slider (audio tracks
 *     only).
 *   - Timeline wires the menu's onSetDucking to the new store action.
 *
 * Layer A (store) — store-only behavior:
 *   A-1 setTrackDucking('voice') on an audio track → role=bgm, duckTarget=
 *       'voice', duckingDb=DEFAULT_DUCKING_DB (-12)
 *   A-2 setTrackDucking(null) → duckTarget cleared; role left as-is
 *   A-3 dB clamp: 0 → -1; -100 → -30; NaN → DEFAULT
 *   A-4 non-audio track → no-op
 *   A-5 invalid target ('foo') → no-op (defensive)
 *
 * Layer B (UI) — TrackContextMenu rendering + click flow:
 *   B-1 audio track context menu shows the ducking row + status "꺼짐"
 *   B-2 video track context menu does NOT show the ducking row
 *   B-3 clicking the ducking toggle writes role=bgm + duckTarget=voice
 *
 * @phase-3-55-audio-ducking
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

const DEFAULT_DUCK_DB = -12

type TrackLite = {
  id: string
  kind: 'video' | 'audio' | 'caption' | 'overlay'
  role?: 'voice' | 'bgm' | 'submix' | string
  duckTarget?: 'voice' | null
  duckingDb?: number
  name?: string
}

type ProjectStoreState = {
  project: { tracks: TrackLite[] }
  setTrackDucking: (
    trackId: string,
    target: 'voice' | null,
    db?: number
  ) => void
  createNew: () => void
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStoreState }
    __reelsStore: {
      state: () => ProjectStoreState
      setTrackDucking: (
        tid: string,
        target: 'voice' | null,
        db?: number
      ) => void
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
    }
  }
}

test.describe('@phase-3-55-audio-ducking audio ducking — store + UI', () => {
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

  async function getTrack(trackId: string): Promise<TrackLite | null> {
    if (!launched) throw new Error('launch failed')
    return launched.page.evaluate((tid: string) => {
      const tr = window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks
      return (tr.find((t) => t.id === tid) as TrackLite | undefined) ?? null
    }, trackId)
  }

  async function getFirstTrack(kind: TrackLite['kind']): Promise<TrackLite> {
    if (!launched) throw new Error('launch failed')
    const tr = await launched.page.evaluate((k: string) => {
      const tracks = window.__PROJECT_STORE_FOR_TEST__.getState().project
        .tracks
      return (
        (tracks.find((t) => t.kind === k) as TrackLite | undefined) ?? null
      )
    }, kind)
    if (!tr) throw new Error(`no ${kind} track found`)
    return tr
  }

  // =========================================================================
  // LAYER A — store
  // =========================================================================
  test('A-1 setTrackDucking voice → role=bgm, duckTarget=voice, duckingDb=DEFAULT', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const audio = await getFirstTrack('audio')
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setTrackDucking(id, 'voice')
    }, audio.id)
    const after = await getTrack(audio.id)
    expect(after?.role).toBe('bgm')
    expect(after?.duckTarget).toBe('voice')
    expect(after?.duckingDb).toBe(DEFAULT_DUCK_DB)
  })

  test('A-2 setTrackDucking null clears duckTarget (role left intact)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const audio = await getFirstTrack('audio')
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setTrackDucking(id, 'voice', -12)
      window.__reelsStore.setTrackDucking(id, null)
    }, audio.id)
    const after = await getTrack(audio.id)
    expect(after?.duckTarget).toBeUndefined()
    // role was set to 'bgm' on the prior call — left as-is by clear.
    expect(after?.role).toBe('bgm')
  })

  test('A-3 dB clamps: 0 → -1, -100 → -30, NaN → DEFAULT', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const audio = await getFirstTrack('audio')
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setTrackDucking(id, 'voice', 0)
    }, audio.id)
    expect((await getTrack(audio.id))?.duckingDb).toBe(-1)
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setTrackDucking(id, 'voice', -100)
    }, audio.id)
    expect((await getTrack(audio.id))?.duckingDb).toBe(-30)
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setTrackDucking(id, 'voice', Number.NaN)
    }, audio.id)
    expect((await getTrack(audio.id))?.duckingDb).toBe(DEFAULT_DUCK_DB)
  })

  test('A-4 non-audio track → no-op (duckTarget stays undefined)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const video = await getFirstTrack('video')
    await launched.page.evaluate((id: string) => {
      window.__reelsStore.setTrackDucking(id, 'voice')
    }, video.id)
    const after = await getTrack(video.id)
    expect(after?.duckTarget).toBeUndefined()
  })

  test('A-5 invalid target rejected — store ignores unknown target string', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const audio = await getFirstTrack('audio')
    // Smuggle an invalid target through testBridge.
    await launched.page.evaluate((id: string) => {
      ;(
        window.__reelsStore.setTrackDucking as unknown as (
          tid: string,
          target: unknown
        ) => void
      )(id, 'foo')
    }, audio.id)
    const after = await getTrack(audio.id)
    expect(after?.duckTarget).toBeUndefined()
  })

  // =========================================================================
  // LAYER B — UI
  // =========================================================================
  test('B-1 audio track context menu shows ducking row + initial 꺼짐 status', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await getFirstTrack('audio')
    // Right-click the first audio-kind track header.
    const header = page.locator('[data-testid="track-header-audio"]').first()
    await header.click({ button: 'right', force: true })
    await expect(
      page.locator('[data-testid="track-context-menu"]')
    ).toBeVisible({ timeout: 3_000 })
    const duckingRow = page.locator('[data-testid="track-menu-ducking"]')
    await expect(duckingRow).toBeVisible()
    await expect(
      page.locator('[data-testid="track-menu-ducking-status"]')
    ).toContainText('꺼짐')
  })

  test('B-2 video track context menu does NOT show ducking row', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await getFirstTrack('video')
    const header = page.locator('[data-testid="track-header-video"]').first()
    await header.click({ button: 'right', force: true })
    await expect(
      page.locator('[data-testid="track-context-menu"]')
    ).toBeVisible({ timeout: 3_000 })
    await expect(
      page.locator('[data-testid="track-menu-ducking"]')
    ).toHaveCount(0)
  })

  test('B-3 clicking the ducking toggle in the panel writes BGM ducking to the store', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const audio = await getFirstTrack('audio')
    const header = page.locator('[data-testid="track-header-audio"]').first()
    await header.click({ button: 'right', force: true })
    await expect(
      page.locator('[data-testid="track-context-menu"]')
    ).toBeVisible({ timeout: 3_000 })
    // Open the ducking panel (rename-style expand).
    await page.locator('[data-testid="track-menu-ducking"]').click()
    await expect(
      page.locator('[data-testid="track-menu-ducking-panel"]')
    ).toBeVisible()
    // Tick the checkbox.
    await page.locator('[data-testid="track-menu-ducking-toggle"]').check()
    await page.waitForTimeout(150)
    const after = await getTrack(audio.id)
    expect(after?.role).toBe('bgm')
    expect(after?.duckTarget).toBe('voice')
    expect(after?.duckingDb).toBe(DEFAULT_DUCK_DB)
  })
})
