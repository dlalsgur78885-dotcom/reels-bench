/**
 * DEMO — dogfood the editor by assembling a 9:16 shorts mp4.
 *
 * Pipeline:
 *   1. Launch editor + create new project
 *   2. Set 9:16 canvas (1080×1920) — Shorts/Reels native
 *   3. Import the fixture mp4 (5s testsrc2+sine) 3× back-to-back → 15s base
 *   4. Apply a transition (crossfade) between each pair of clips
 *   5. Add a punch-in zoom keyframe to clip 1
 *   6. Insert 5 caption clips matching a mock TTS script
 *   7. Set fade in/out on the audio so the cuts aren't abrupt
 *   8. Export at instagram-reels preset → mp4
 *   9. Report the resulting path + size so the human can play it
 *
 * Use `npx playwright test --grep "@demo-shorts"` to run.
 */
import { expect, test } from '@playwright/test'
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Real Korean script — mirrors what /my-scripts → "SRT 다운로드" produces.
// SRT timestamps are HH:MM:SS,mmm. The captions render via PNG path which
// embeds Pretendard + falls back to system Korean fonts, so Korean text just
// works end-to-end (no drawtext fontfile workaround needed).
// ---------------------------------------------------------------------------
const KOREAN_SRT = [
  '1',
  '00:00:00,200 --> 00:00:03,200',
  '잠깐, 이거 보고 가세요',
  '',
  '2',
  '00:00:03,300 --> 00:00:06,300',
  '에디터 직접 만들었습니다',
  '',
  '3',
  '00:00:06,400 --> 00:00:09,400',
  '자동 자막, 트랜지션, 줌인까지',
  '',
  '4',
  '00:00:09,500 --> 00:00:12,500',
  '쇼츠 한 번에 끝',
  '',
  '5',
  '00:00:12,600 --> 00:00:14,800',
  '구독은 사랑입니다',
  ''
].join('\n')

type AnyClip = { id: string; kind: string }
type ParsedCaptionCue = {
  startMs: number
  endMs: number
  words?: Array<{ text: string }>
  text?: string
}

declare global {
  interface Window {
    __reelsStore: {
      state: () => {
        project: {
          tracks: Array<{ id: string; kind: string; clips: AnyClip[] }>
        }
      }
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      addCaption: (c: unknown) => void
      newId: () => string
      setClipFade: (id: string, fin: number, fout: number) => void
      setClipTransitionIn: (id: string, kind: string, dur: number) => void
      addTransformKeyframe: (
        id: string,
        atMs: number,
        partial?: { scale?: number }
      ) => void
    }
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: unknown
        createNew: () => void
        setAspectRatio: (r: string) => void
      }
    }
  }
}

test.describe('@demo-shorts dogfood — assemble a 9:16 shorts mp4', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
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
    await page.evaluate(async () => {
      const store = window.__PROJECT_STORE_FOR_TEST__.getState()
      store.createNew()
      store.setAspectRatio('9:16')
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

  test('assemble + export a 15s 9:16 shorts mp4 with 5 captions, transitions, zoom-in', async () => {
    test.setTimeout(180_000) // a real export takes ~30-60s
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const fixture = process.env.E2E_FIXTURE_MP4!

    // ----- Stage 1: import fixture 3× and chain them -----------------------
    const clipIds = await page.evaluate(async (filePath: string) => {
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
        // Override w/h so the 9:16 canvas needs a real cover-crop — exercises
        // every transform/aspect path in the export graph.
        width: probe.width ?? 320,
        height: probe.height ?? 240,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      const videoTrack = reels
        .state()
        .project.tracks.find((t) => t.kind === 'video')!
      const ids: string[] = []
      for (let i = 0; i < 3; i++) {
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: videoTrack.id,
          startMs: i * probe.durationMs,
          endMs: (i + 1) * probe.durationMs,
          trimInMs: 0,
          trimOutMs: probe.durationMs,
          speed: 1
        })
        ids.push(cid)
      }
      return ids
    }, fixture)
    expect(clipIds.length).toBe(3)

    // ----- Stage 2: transitions (crossfade between 1↔2 and 2↔3) -----------
    await page.evaluate((ids: string[]) => {
      window.__reelsStore.setClipTransitionIn(ids[1], 'crossfade', 500)
      window.__reelsStore.setClipTransitionIn(ids[2], 'slide-left', 500)
    }, clipIds)

    // ----- Stage 3: punch-in zoom on clip 1 -------------------------------
    await page.evaluate((id: string) => {
      window.__reelsStore.addTransformKeyframe(id, 0, { scale: 1 })
      window.__reelsStore.addTransformKeyframe(id, 4800, { scale: 1.15 })
    }, clipIds[0])

    // ----- Stage 4: audio fade in/out -------------------------------------
    await page.evaluate((ids: string[]) => {
      window.__reelsStore.setClipFade(ids[0], 600, 0)
      window.__reelsStore.setClipFade(ids[2], 0, 800)
    }, clipIds)

    // ----- Stage 5: Korean captions via SRT import path ----------------------
    // Write the SRT to disk (mirrors what /my-scripts SRT 다운로드 produces),
    // allow + parse via the same IPC the editor's "자막 import" button uses,
    // then push the cues onto the caption track with a styled preset +
    // pop/fade animation. The captions render via the PNG path (Pretendard
    // embed + system Korean font fallback), so 한글 just works.
    const srtPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      'demo-shorts',
      `_demo-${Date.now()}.srt`
    )
    writeFileSync(srtPath, KOREAN_SRT, 'utf-8')

    await page.evaluate(
      async (filePath: string) => {
        await window.electron.fs.allowPath(filePath)
        const cues: ParsedCaptionCue[] = await window.electron.captions.importSrt(filePath)
        if (!cues || cues.length === 0) throw new Error('SRT parsed 0 cues')
        const reels = window.__reelsStore
        const captionTrack = reels
          .state()
          .project.tracks.find((t) => t.kind === 'caption')
        if (!captionTrack) throw new Error('no caption track')
        for (const cue of cues) {
          const text = (cue.text ?? cue.words?.map((w) => w.text).join(' ') ?? '').trim()
          if (!text) continue
          const cid = reels.newId()
          reels.addCaption({
            id: cid,
            kind: 'caption',
            trackId: captionTrack.id,
            startMs: cue.startMs,
            endMs: cue.endMs,
            spans: text.split(/\s+/).map((w) => ({ text: w })),
            style: {
              preset: 'block-bold',
              fontSize: 78,
              align: 'center',
              yPosition: 0.5,
              background: 'none',
              textStroke: { color: '#000000', width: 8 },
              textShadow: { color: '#00e5ff', offsetX: 0, offsetY: 0, blur: 20 }
            },
            animation: {
              entrance: 'pop',
              exit: 'fade',
              inMs: 300,
              outMs: 300
            }
          })
        }
      },
      srtPath
    )

    // ----- Stage 6: export to mp4 -----------------------------------------
    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'demo-shorts')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `demo-shorts-${Date.now()}.mp4`)

    const result = await page.evaluate(
      async (target: string) => {
        await window.electron.fs.allowPath(target)
        const project = (
          window.__PROJECT_STORE_FOR_TEST__.getState() as { project: unknown }
        ).project
        // Build the plan first so failures surface the filter graph in the error.
        const plan = (await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          target
        )) as {
          ok: boolean
          error?: string
          argvPreview?: string
          filterGraph?: string
          inputs?: string[]
        }
        if (!plan.ok) {
          return {
            ok: false,
            error: `buildPlan failed: ${plan.error}`,
            plan
          }
        }
        const run = (await window.electron.exporter.run(project, {
          jobId: `demo-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath: target,
          useHardwareEncoder: false
        })) as { ok: boolean; error?: string }
        return { ...run, plan }
      },
      outPath
    )
    if (!result.ok) {
      const plan = (result as { plan?: { argvPreview?: string; filterGraph?: string; inputs?: string[] } }).plan
      // eslint-disable-next-line no-console
      console.log(
        '\n=== EXPORT FAILED ===\n',
        result.error,
        '\n=== INPUTS ===\n',
        plan?.inputs?.join('\n'),
        '\n=== FILTER GRAPH ===\n',
        plan?.filterGraph,
        '\n=== ARGV ===\n',
        plan?.argvPreview
      )
    }
    expect(result.ok, result.error ?? 'export failed').toBe(true)

    // ----- Stage 7: verify -----------------------------------------------
    expect(existsSync(outPath)).toBe(true)
    const stat = statSync(outPath)
    expect(stat.size).toBeGreaterThan(50_000) // sanity: > 50KB
    // eslint-disable-next-line no-console
    console.log(
      `\n  📺 demo shorts ready (${(stat.size / 1024).toFixed(1)} KB):\n     ${outPath}\n`
    )
  })
})
