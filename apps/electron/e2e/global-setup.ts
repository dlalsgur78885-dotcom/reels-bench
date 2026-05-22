import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Global setup:
 *   1. Resolve the bundled ffmpeg from `ffmpeg-static` (formerly
 *      `@ffmpeg-installer/ffmpeg`; swapped to a modern 6.x build in 0.2.0).
 *   2. Generate a deterministic 5s test clip in a path that the main process's
 *      ffmpeg security layer already allows (os.tmpdir() is on the allowlist).
 *
 * We use lavfi sources (testsrc2 + sine) so the fixture is self-contained — no
 * external assets, no network, fully reproducible.
 *
 * The runner's allowed-roots set is initialized lazily in the main process; we
 * deliberately use `os.tmpdir()` here because it's part of that set.
 */
export default async function globalSetup(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ffmpegPath = require('ffmpeg-static') as string | null
  if (!ffmpegPath) {
    throw new Error(
      `[e2e setup] ffmpeg-static returned no path for ${process.platform}-${process.arch}`
    )
  }
  if (!existsSync(ffmpegPath)) {
    throw new Error(`[e2e setup] ffmpeg binary missing at ${ffmpegPath}`)
  }

  const e2eRoot = path.join(os.tmpdir(), 'reels-studio-e2e')
  if (!existsSync(e2eRoot)) mkdirSync(e2eRoot, { recursive: true })

  // Also keep a copy under e2e/fixtures so it's discoverable in the repo, but
  // tests will reference the tmp copy because that's the path actually allowed
  // by the runner's security layer.
  const repoFixturesDir = path.resolve(__dirname, 'fixtures')
  if (!existsSync(repoFixturesDir)) mkdirSync(repoFixturesDir, { recursive: true })

  const target = path.join(e2eRoot, 'test.mp4')
  if (existsSync(target)) {
    try {
      unlinkSync(target)
    } catch {
      /* ignore */
    }
  }

  await new Promise<void>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '5',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-shortest',
      target
    ]
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`fixture ffmpeg exited ${code}: ${stderr}`))
        return
      }
      if (!existsSync(target) || statSync(target).size < 1024) {
        reject(new Error(`fixture missing or too small at ${target}`))
        return
      }
      resolve()
    })
  })

  process.env.E2E_FIXTURE_MP4 = target
  process.env.E2E_TMP_ROOT = e2eRoot
  process.env.E2E_FFMPEG_PATH = ffmpegPath

  // Generate a 3s mp3 audio-only fixture (sine wave, no video stream).
  // Used by the Phase 2 audio-track-routing tests to verify that an audio
  // file probed with cover-art is classified as kind='audio' and lands on an
  // audio track, not a video track.
  const audioTarget = path.join(e2eRoot, 'test.mp3')
  if (existsSync(audioTarget)) {
    try {
      unlinkSync(audioTarget)
    } catch {
      /* ignore */
    }
  }

  await new Promise<void>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '3',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      audioTarget
    ]
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`audio fixture ffmpeg exited ${code}: ${stderr}`))
        return
      }
      if (!existsSync(audioTarget) || statSync(audioTarget).size < 512) {
        reject(new Error(`audio fixture missing or too small at ${audioTarget}`))
        return
      }
      resolve()
    })
  })

  process.env.E2E_FIXTURE_MP3 = audioTarget
}
