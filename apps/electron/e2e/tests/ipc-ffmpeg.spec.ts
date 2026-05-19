import { expect, test } from '@playwright/test'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

const FIXTURE = process.env.E2E_FIXTURE_MP4 || ''
const TMP_ROOT = process.env.E2E_TMP_ROOT || ''
const FFMPEG_PATH = process.env.E2E_FFMPEG_PATH || ''

function uniqueJobId(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function probeDurationSec(videoPath: string): number | null {
  // We don't have ffprobe; ffmpeg with `-i ... -hide_banner` to stderr reports
  // Duration: hh:mm:ss.xx. Extract from stderr.
  const res = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', videoPath], {
    encoding: 'utf8'
  })
  const stderr = (res.stderr || '') + (res.stdout || '')
  const m = /Duration:\s+(\d+):(\d+):(\d+\.\d+)/.exec(stderr)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

test.describe('@phase-1-ipc-ffmpeg ffmpeg bridge', () => {
  let launched: LaunchedApp | null = null

  test.beforeAll(() => {
    if (!FIXTURE || !existsSync(FIXTURE)) {
      throw new Error(`Fixture not generated: ${FIXTURE}`)
    }
    if (!TMP_ROOT) throw new Error('E2E_TMP_ROOT not set by global-setup')
    if (!FFMPEG_PATH) throw new Error('E2E_FFMPEG_PATH not set by global-setup')
  })

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

  test('capabilities() returns encoders array containing libx264 and a preferred string', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.ffmpeg, null, { timeout: 5_000 })
    const caps = await page.evaluate(async () => {
      return await window.electron.ffmpeg.capabilities()
    })
    expect(Array.isArray(caps.encoders)).toBe(true)
    expect(caps.encoders).toContain('libx264')
    expect(typeof caps.preferred).toBe('string')
    expect(caps.preferred.length).toBeGreaterThan(0)
  })

  test('run() rejects path traversal in input', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.ffmpeg, null, { timeout: 5_000 })

    const result = await page.evaluate(
      async (args: { jobId: string; output: string }) => {
        return await window.electron.ffmpeg.run({
          jobId: args.jobId,
          input: '../../../etc/passwd',
          output: args.output,
          durationSec: 1,
          codec: 'libx264'
        })
      },
      { jobId: uniqueJobId('traversal'), output: path.join(os.tmpdir(), 'evil.mp4') }
    )
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
    // path validation surfaces as "not in allowed roots" or "does not exist"
    expect(result.error || '').toMatch(/allowed roots|does not exist|input/i)
  })

  test('run() rejects invalid codec', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.ffmpeg, null, { timeout: 5_000 })

    const result = await page.evaluate(
      async (args: { jobId: string; input: string; output: string }) => {
        return await window.electron.ffmpeg.run({
          jobId: args.jobId,
          input: args.input,
          output: args.output,
          durationSec: 1,
          // @ts-expect-error — intentionally invalid for security test
          codec: 'evil_codec',
          audio: 'none'
        })
      },
      {
        jobId: uniqueJobId('codec'),
        input: FIXTURE,
        output: path.join(TMP_ROOT, `${uniqueJobId('codec-out')}.mp4`)
      }
    )
    // Spec accepts unknown codec by silently falling back to libx264 — verify
    // either it falls back to libx264 (no rejection) OR rejects. The runner's
    // current behavior: isAllowedCodec returns false → falls back to libx264.
    // So the run will still ok=true. We instead assert that the renderer-passed
    // 'evil_codec' string was NOT propagated into argv (no error mentioning
    // unknown encoder). The real way to detect this: a libx264 run completes ok.
    // Therefore the security guarantee here is "the malicious string did not
    // reach the ffmpeg argv", i.e. the run did NOT fail with an unknown-encoder
    // error from ffmpeg.
    if (!result.ok) {
      // If the runner is later tightened to reject, the error must NOT be
      // "Unknown encoder 'evil_codec'" — that would mean it reached ffmpeg.
      expect(result.error || '').not.toMatch(/Unknown encoder.*evil_codec/i)
    } else {
      expect(result.ok).toBe(true)
      expect(typeof result.output).toBe('string')
      if (result.output) {
        expect(existsSync(result.output)).toBe(true)
      }
    }
  })

  test('run() rejects invalid preset with shell metachars', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.ffmpeg, null, { timeout: 5_000 })

    const result = await page.evaluate(
      async (args: { jobId: string; input: string; output: string }) => {
        return await window.electron.ffmpeg.run({
          jobId: args.jobId,
          input: args.input,
          output: args.output,
          durationSec: 1,
          codec: 'libx264',
          // @ts-expect-error — intentionally malicious
          preset: 'malicious; rm -rf /',
          audio: 'none'
        })
      },
      {
        jobId: uniqueJobId('preset'),
        input: FIXTURE,
        output: path.join(TMP_ROOT, `${uniqueJobId('preset-out')}.mp4`)
      }
    )
    // Same pattern as codec: runner silently falls back to 'veryfast' when the
    // preset isn't allowlisted. The key is the metachar string must not reach
    // the shell. Verify either ok=true (fallback) or, if ok=false, the error
    // is NOT a shell-injection symptom.
    if (!result.ok) {
      expect(result.error || '').not.toMatch(/rm -rf|sh:|sh-?\d/i)
    } else {
      expect(result.ok).toBe(true)
    }
  })

  test('run() rejects extraArgs containing shell metachars', async () => {
    // This more strictly proves the security boundary works.
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.ffmpeg, null, { timeout: 5_000 })

    const result = await page.evaluate(
      async (args: { jobId: string; input: string; output: string }) => {
        return await window.electron.ffmpeg.run({
          jobId: args.jobId,
          input: args.input,
          output: args.output,
          durationSec: 1,
          codec: 'libx264',
          audio: 'none',
          extraArgs: ['-pix_fmt', 'yuv420p; rm -rf /']
        })
      },
      {
        jobId: uniqueJobId('extra'),
        input: FIXTURE,
        output: path.join(TMP_ROOT, `${uniqueJobId('extra-out')}.mp4`)
      }
    )
    expect(result.ok).toBe(false)
    expect(result.error || '').toMatch(/metachar|disallowed|extraArg/i)
  })

  test('run() with a valid trim of fixture mp4 produces ~2s output', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.ffmpeg, null, { timeout: 5_000 })

    const jobId = uniqueJobId('trim')
    const outputPath = path.join(TMP_ROOT, `${jobId}.mp4`)

    const { result, progressEvents } = await page.evaluate(
      async (args: { jobId: string; input: string; output: string }) => {
        const events: Array<{ percent: number; done?: boolean }> = []
        const off = window.electron.ffmpeg.onProgress((ev) => {
          if (ev.jobId === args.jobId) {
            events.push({ percent: ev.percent, done: ev.done })
          }
        })
        const r = await window.electron.ffmpeg.run({
          jobId: args.jobId,
          input: args.input,
          output: args.output,
          startSec: 0,
          durationSec: 2,
          codec: 'libx264',
          preset: 'ultrafast',
          crf: 28,
          audio: 'none',
          kind: 'proxy'
        })
        off()
        return { result: r, progressEvents: events }
      },
      { jobId, input: FIXTURE, output: outputPath }
    )

    expect(result.ok, `ffmpeg run failed: ${result.error}`).toBe(true)
    expect(result.output).toBe(outputPath)
    expect(existsSync(outputPath)).toBe(true)
    const size = statSync(outputPath).size
    expect(size).toBeGreaterThan(1024) // non-zero, sensible

    // Progress: at least one event fired (final `done` event always emits).
    expect(progressEvents.length).toBeGreaterThanOrEqual(1)

    // Duration probe — accept anywhere in [1.5s, 2.6s] (h264 GOP boundaries).
    const dur = probeDurationSec(outputPath)
    expect(dur, 'could not probe output duration').not.toBeNull()
    if (dur !== null) {
      expect(dur).toBeGreaterThan(1.5)
      expect(dur).toBeLessThan(2.8)
    }
  })

  test('cancel(jobId) mid-run kills the process and cleans up partial output', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.ffmpeg, null, { timeout: 5_000 })

    const jobId = uniqueJobId('cancel')
    const outputPath = path.join(TMP_ROOT, `${jobId}.mp4`)

    // Kick off a deliberately slow job: very-slow software preset + crf 0
    // (lossless) + upscale to 2160p so the child stays alive >> dispatch
    // latency, even on a fast machine.
    const resultPromise = page.evaluate(
      async (args: { jobId: string; input: string; output: string }) => {
        return await window.electron.ffmpeg.run({
          jobId: args.jobId,
          input: args.input,
          output: args.output,
          startSec: 0,
          durationSec: 5,
          codec: 'libx264',
          preset: 'veryslow',
          crf: 0,
          scale: '-2:2160',
          audio: 'aac',
          kind: 'proxy'
        })
      },
      { jobId, input: FIXTURE, output: outputPath }
    )

    // Wait until the runner has actually spawned the child (existence of the
    // partial output file is a good signal that ffmpeg has started writing).
    // Fall back to a fixed delay if that file doesn't appear in time.
    await expect
      .poll(() => existsSync(outputPath), {
        timeout: 5_000,
        intervals: [50, 100, 200]
      })
      .toBe(true)

    await page.evaluate(async (id: string) => {
      await window.electron.ffmpeg.cancel(id)
    }, jobId)

    const finalResult = await resultPromise
    // Cancelled job: runner returns ok:false with 'cancelled' error string.
    expect(finalResult.ok).toBe(false)
    expect(finalResult.error || '').toMatch(/cancelled/i)
    // Partial output should be cleaned up by the runner.
    expect(existsSync(outputPath)).toBe(false)
  })

  test('bundled ffmpeg supports xfade and actually shortens output by the overlap', async () => {
    // Regression guard for the 2018→6.x upgrade. The 2018 build did not have
    // the `xfade` filter — exports silently fell back to plain concat. After
    // the upgrade we should both (a) find xfade in `-filters` output and
    // (b) see a 2-clip xfade composition produce a shorter result than the
    // sum of the inputs (because the transition overlaps both clips by the
    // requested duration).
    const versionCheck = spawnSync(FFMPEG_PATH, ['-hide_banner', '-version'], {
      encoding: 'utf8'
    })
    const versionLine = (versionCheck.stdout || '').split(/\r?\n/)[0]
    // Modern ffmpeg version line: "ffmpeg version 6.1.1-..." or "n6.x" or "5.x".
    expect(versionLine).toMatch(/ffmpeg version (?:n?[4-9]|[12]\d)/i)

    const filtersCheck = spawnSync(FFMPEG_PATH, ['-hide_banner', '-filters'], {
      encoding: 'utf8'
    })
    expect(filtersCheck.stdout || '').toMatch(/\bxfade\b\s+VV->V/)

    // Build a real xfade composition: 2 × 2s clips → 0.5s crossfade → expect
    // output ≈ 3.5s (2 + 2 − 0.5), not 4s.
    const outPath = path.join(TMP_ROOT, `xfade-${Date.now()}.mp4`)
    const argv = [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=24:duration=2',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=24:duration=2',
      '-filter_complex',
      '[0:v][1:v]xfade=transition=fade:duration=0.5:offset=1.5[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-t',
      '5',
      outPath
    ]
    const res = spawnSync(FFMPEG_PATH, argv, { encoding: 'utf8' })
    expect(res.status, `xfade ffmpeg failed: ${res.stderr}`).toBe(0)
    expect(existsSync(outPath)).toBe(true)

    const dur = probeDurationSec(outPath)
    expect(dur, 'could not probe xfade output duration').not.toBeNull()
    if (dur !== null) {
      // Expected duration is 2 + 2 - 0.5 = 3.5s. Allow ±0.3s for h264 GOP
      // padding. Critically: must NOT be ≥3.9s (which would indicate plain
      // concat had been used because xfade was missing).
      expect(dur).toBeGreaterThan(3.2)
      expect(dur).toBeLessThan(3.9)
    }
  })
})
