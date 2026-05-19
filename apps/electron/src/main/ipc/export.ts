/**
 * Export pipeline (Phase 2.6 — Reels Studio capstone).
 *
 * Takes a project snapshot + preset key and produces a single mp4 file via
 * ffmpeg's filter_complex graph engine.
 *
 * Pipeline overview:
 *   1. Walk video tracks → collect media clips in timeline order.
 *   2. For each clip build a filter chain:
 *        trim → setpts → atempo → filter preset → scale + blur-bg pad →
 *        drawtext captions (if any caption clip overlaps).
 *   3. Stitch adjacent clips with xfade for transitions, concat otherwise.
 *   4. Audio: each audio-bearing clip (video tracks too) → trim → atempo →
 *      volume → afade → afade_in/out for transitions.
 *      Per-track amix; bgm-track ducked via sidechaincompress against voice;
 *      final amix.
 *   5. Spawn ffmpeg through the existing runner with the assembled filter
 *      graph + map flags via extraArgs / scale / etc.
 *
 * The graph is written to `userData/exports/last-export-cmd.txt` before each
 * run for post-mortem diagnostics.
 */
import { app, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  IPC_CHANNELS,
  type ExportBuildPlanResult,
  type ExportPresetKey,
  type ExportRunOptions,
  type ExportRunResult,
  type FfmpegRunSpec
} from '../../shared/ipc'
import {
  filterPresetToFfmpeg,
  transitionKindToXfade
} from '../../shared/filterPresets'
import {
  DEFAULT_DUCKING_DB,
  DEFAULT_TRANSITION_MS,
  isCaptionClip,
  isMediaClip,
  type CaptionClip,
  type Project,
  type Track,
  type VideoAudioClip
} from '../../shared/project'
import { resolveFfmpegPath } from '../ffmpeg/binary'
import { allowPath, assertPathAllowed } from '../ffmpeg/security'

// ---------------------------------------------------------------------------
// Preset table (kept in sync with renderer's exportPresets.ts — main-process
// copy lets the IPC validate without round-tripping the renderer's bundle).
// ---------------------------------------------------------------------------
interface MainPreset {
  width: number
  height: number
  fps: number
  vBitrateKbps: number
  aBitrateKbps: number
  codec: 'libx264'
  preset:
    | 'ultrafast'
    | 'superfast'
    | 'veryfast'
    | 'faster'
    | 'fast'
    | 'medium'
    | 'slow'
    | 'slower'
    | 'veryslow'
}

const PRESETS: Record<ExportPresetKey, MainPreset> = {
  'instagram-reels': {
    width: 1080,
    height: 1920,
    fps: 30,
    vBitrateKbps: 8000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  tiktok: {
    width: 1080,
    height: 1920,
    fps: 30,
    vBitrateKbps: 8000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  'youtube-shorts': {
    width: 1080,
    height: 1920,
    fps: 30,
    vBitrateKbps: 8000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  'instagram-feed': {
    width: 1080,
    height: 1080,
    fps: 30,
    vBitrateKbps: 6000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  'high-quality': {
    width: 1080,
    height: 1920,
    fps: 60,
    vBitrateKbps: 12000,
    aBitrateKbps: 192,
    codec: 'libx264',
    preset: 'slow'
  }
}

// ---------------------------------------------------------------------------
// Filter availability probe. The bundled ffmpeg can be old; xfade landed in
// 4.3 (2020). When absent, we fall back to plain concat (no visible blend).
// ---------------------------------------------------------------------------
let xfadeAvailableCache: boolean | null = null

// Per-path audio-presence cache. ffmpeg 6 rejects the `[N:a:0?]` "optional
// stream" syntax inside filter_complex (`Invalid stream specifier: a:0?`).
// Instead of relying on `?`, we probe each input upfront and only emit an
// audio chain for inputs that actually carry an audio stream.
const audioPresenceCache = new Map<string, boolean>()

function probeHasAudio(ffmpegPath: string, filePath: string): Promise<boolean> {
  const cached = audioPresenceCache.get(filePath)
  if (cached !== undefined) return Promise.resolve(cached)
  return new Promise<boolean>((resolve) => {
    // `ffmpeg -i <file>` prints stream info to stderr then exits with code 1
    // because no output was specified. We grep that for a line that starts
    // with `Stream #X:Y...Audio:` — present iff the file has an audio stream.
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 128 * 1024) stderr = stderr.slice(-128 * 1024)
    })
    const settle = (val: boolean): void => {
      audioPresenceCache.set(filePath, val)
      resolve(val)
    }
    proc.on('error', () => settle(false))
    proc.on('close', () => {
      const has = /Stream #\d+:\d+[^\n]*Audio:/.test(stderr)
      settle(has)
    })
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      if (!audioPresenceCache.has(filePath)) settle(false)
    }, 5_000)
  })
}

function probeXfadeAvailable(ffmpegPath: string): Promise<boolean> {
  if (xfadeAvailableCache !== null) return Promise.resolve(xfadeAvailableCache)
  return new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-filters'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-256 * 1024)
    })
    proc.on('error', () => {
      xfadeAvailableCache = false
      resolve(false)
    })
    proc.on('close', () => {
      // Match a line like " ... xfade            VV->V       ..."
      const has = /\bxfade\b\s+VV->V/.test(stdout)
      xfadeAvailableCache = has
      resolve(has)
    })
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      if (xfadeAvailableCache === null) {
        xfadeAvailableCache = false
        resolve(false)
      }
    }, 3_000)
  })
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

interface VideoSegment {
  clip: VideoAudioClip
  track: Track
  /** Input index in the ffmpeg argv. */
  inputIdx: number
  /** Caption overlays whose time range intersects this clip (any caption track). */
  captions: CaptionClip[]
  /** Time-on-timeline of segment start/end (clip.startMs / clip.endMs copy). */
  startMs: number
  endMs: number
  /** Transition window with previous segment (used by both video and audio). */
  transitionInMs: number
  transitionKind: string
}

interface AudioSegment {
  clip: VideoAudioClip
  track: Track
  inputIdx: number
  /** True if this is the audio of a video-track clip (uses same input but 0:a stream). */
  fromVideoTrack: boolean
}

/**
 * Collect media clips from all video tracks (ordered by startMs) and assign
 * input indices. Each unique input file maps to one ffmpeg `-i`; if the same
 * media file is referenced by multiple clips we still re-add it because
 * different trim windows make stream cloning fragile.
 */
function collectSegments(
  project: Project
): { videoSegments: VideoSegment[]; audioSegments: AudioSegment[]; inputs: string[] } {
  const inputs: string[] = []
  const videoSegments: VideoSegment[] = []
  const audioSegments: AudioSegment[] = []

  // Video tracks in declared order; clips sorted by startMs.
  const videoTracks = project.tracks.filter((t) => t.kind === 'video')
  const allCaptionClips: CaptionClip[] = []
  for (const t of project.tracks) {
    if (t.kind !== 'caption') continue
    for (const c of t.clips) {
      if (isCaptionClip(c)) allCaptionClips.push(c)
    }
  }

  // Build a flat ordered list of media clips across all video tracks.
  // We use a single composite video track in the output (timeline-ordered).
  const flat: { clip: VideoAudioClip; track: Track }[] = []
  for (const t of videoTracks) {
    for (const c of t.clips) {
      if (!isMediaClip(c)) continue
      const media = project.media[c.mediaId]
      if (!media) continue
      flat.push({ clip: c, track: t })
    }
  }
  flat.sort((a, b) => a.clip.startMs - b.clip.startMs)

  for (let i = 0; i < flat.length; i++) {
    const { clip, track } = flat[i]
    const media = project.media[clip.mediaId]
    if (!media) continue
    const inputIdx = inputs.length
    inputs.push(media.path)

    // Captions overlapping this clip's timeline range.
    const captions = allCaptionClips.filter(
      (c) => c.endMs > clip.startMs && c.startMs < clip.endMs
    )

    // Transition: defined on this clip (transitionIn) — only valid if there's
    // a previous segment.
    const prev = i > 0 ? flat[i - 1].clip : null
    let transitionInMs = 0
    let transitionKind = 'none'
    if (prev && clip.transitionIn && clip.transitionIn.kind !== 'none') {
      const want = Math.max(
        100,
        Math.min(
          clip.transitionIn.durationMs ?? DEFAULT_TRANSITION_MS,
          // can't exceed either clip's duration
          (clip.endMs - clip.startMs) - 1,
          (prev.endMs - prev.startMs) - 1
        )
      )
      transitionInMs = want
      transitionKind = clip.transitionIn.kind
    }

    videoSegments.push({
      clip,
      track,
      inputIdx,
      captions,
      startMs: clip.startMs,
      endMs: clip.endMs,
      transitionInMs,
      transitionKind
    })
  }

  // Audio: collect from audio tracks AND from video-track clips (they carry
  // embedded audio). Each gets the same input index as the corresponding
  // video clip when possible — but for simplicity in MVP we re-add inputs.
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio')
  for (const t of audioTracks) {
    for (const c of t.clips) {
      if (!isMediaClip(c)) continue
      const media = project.media[c.mediaId]
      if (!media) continue
      const inputIdx = inputs.length
      inputs.push(media.path)
      audioSegments.push({ clip: c, track: t, inputIdx, fromVideoTrack: false })
    }
  }
  // Embedded audio from video clips. We reuse the same input index — the
  // video clip's input #N also exposes audio at [N:a:0] (if present).
  for (const seg of videoSegments) {
    audioSegments.push({
      clip: seg.clip,
      track: seg.track,
      inputIdx: seg.inputIdx,
      fromVideoTrack: true
    })
  }

  return { videoSegments, audioSegments, inputs }
}

/** Escape text for ffmpeg `drawtext` text= option. */
function escapeDrawtext(s: string): string {
  // ffmpeg drawtext quirks:
  //   - backslash is the escape char (must be first to avoid double-escaping)
  //   - colon separates options
  //   - single quote terminates the text arg
  //   - percent introduces format specifiers
  //   - newlines should be replaced with explicit \n inside the string
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ')
}

/** Compute atempo filter chain for a given speed, in 0.5..2 range steps. */
function atempoChain(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0 || Math.abs(speed - 1) < 1e-3) {
    return ''
  }
  // atempo accepts 0.5..100 in modern ffmpeg, but 0.5..2 is the historical
  // safe range and tools like older HW assume that. Chain multiple if needed.
  let s = speed
  const parts: string[] = []
  while (s > 2) {
    parts.push('atempo=2.0')
    s /= 2
  }
  while (s < 0.5) {
    parts.push('atempo=0.5')
    s *= 2
  }
  parts.push(`atempo=${s.toFixed(4)}`)
  return parts.join(',')
}

/** Build the per-clip video filter chain (excluding the xfade join). */
function buildVideoSegmentChain(
  seg: VideoSegment,
  preset: MainPreset
): {
  /** Filter chain label (output pad name). */
  out: string
  /** Filter graph fragment ending with `[<out>]`. */
  fragment: string
} {
  const out = `v${seg.inputIdx}`
  const speed = seg.clip.speed ?? 1
  const segDurSec = Math.max(0.001, (seg.endMs - seg.startMs) / 1000)
  const trimInSec = seg.clip.trimInMs / 1000
  // source-time duration consumed
  const srcDurSec = (segDurSec * speed)

  const parts: string[] = []
  // 1. Trim the source window. We use the `trim=` filter (not -ss) since the
  //    filter graph needs explicit cut points after we've already mapped the
  //    input. setpts resets the PTS so frames start at 0.
  parts.push(`trim=start=${trimInSec.toFixed(4)}:duration=${srcDurSec.toFixed(4)}`)
  parts.push('setpts=PTS-STARTPTS')
  if (Math.abs(speed - 1) > 1e-3) {
    parts.push(`setpts=PTS/${speed.toFixed(4)}`)
  }
  // 2. Filter preset (eq/hue chain).
  const fp = filterPresetToFfmpeg(seg.clip.filterPreset, seg.clip.filterIntensity ?? 1)
  if (fp) parts.push(fp)
  // 3. fps normalization (so xfade durations line up cleanly).
  parts.push(`fps=${preset.fps}`)

  // 4. Aspect-correct scale + blurred-background pad. Two-stage subgraph:
  //    main (object-fit: contain) and bg (cover + blur) merged via overlay.
  //    We use a single chain via split:
  //      [v]split=2[mainSrc][bgSrc];
  //      [bgSrc]scale=W:H:force_original_aspect_ratio=increase,crop=W:H,boxblur=20:1,eq=brightness=-0.2[bg];
  //      [mainSrc]scale=W:H:force_original_aspect_ratio=decrease[main];
  //      [bg][main]overlay=(W-w)/2:(H-h)/2,setsar=1[outLabel]
  const W = preset.width
  const H = preset.height
  const labelIn = `pre${seg.inputIdx}`
  const labelBg = `bg${seg.inputIdx}`
  const labelMain = `main${seg.inputIdx}`
  const preChain = parts.join(',')

  // The "decorated" sub-fragment ends with [labelIn] then split→bg+main+overlay.
  let fragment =
    `[${seg.inputIdx}:v]${preChain}[${labelIn}];` +
    `[${labelIn}]split=2[${labelMain}src][${labelBg}src];` +
    `[${labelBg}src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:1,eq=brightness=-0.2[${labelBg}];` +
    `[${labelMain}src]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0[${labelMain}];` +
    `[${labelBg}][${labelMain}]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1`

  // 5. Caption drawtext overlays. Each caption clip becomes one drawtext
  //    filter that's only enabled during its time-on-timeline (relative to
  //    this segment after we reset PTS, segment_t = timeline_t - clip.startMs).
  if (seg.captions.length > 0) {
    const drawtexts: string[] = []
    for (const cap of seg.captions) {
      // Compute the visible window relative to this segment's local time (0..segDurSec).
      const localStart = Math.max(0, (cap.startMs - seg.startMs) / 1000)
      const localEnd = Math.min(segDurSec, (cap.endMs - seg.startMs) / 1000)
      if (localEnd <= localStart) continue
      const txt = escapeDrawtext(
        cap.spans.map((sp) => sp.text).join(' ').slice(0, 500)
      )
      if (!txt) continue
      // Scale font from style.fontSize (referenced against a 1920-tall canvas).
      const fontSize = Math.max(
        16,
        Math.round((cap.style.fontSize * H) / 1920)
      )
      // Vertical position: yPosition is 0(top)..1(bottom). Anchor is baseline.
      const yPx = Math.round((1 - (1 - cap.style.yPosition)) * H - fontSize)
      const yExpr = `${Math.max(0, Math.min(H - fontSize, yPx))}`
      // Background pill (box=1) — approximation of the React preview.
      const hasBox = cap.style.background === 'solid' || cap.style.background === 'pill'
      const drawArgs = [
        `text='${txt}'`,
        `fontsize=${fontSize}`,
        `fontcolor=white`,
        `borderw=2`,
        `bordercolor=black@0.7`,
        `x=(w-text_w)/2`,
        `y=${yExpr}`,
        `enable='between(t,${localStart.toFixed(3)},${localEnd.toFixed(3)})'`
      ]
      if (hasBox) {
        drawArgs.push(`box=1`, `boxcolor=black@0.55`, `boxborderw=10`)
      }
      drawtexts.push(`drawtext=${drawArgs.join(':')}`)
    }
    if (drawtexts.length > 0) {
      fragment += ',' + drawtexts.join(',')
    }
  }

  fragment += `[${out}]`
  return { out, fragment }
}

/** Build the per-clip audio filter chain (returns the output label). */
function buildAudioSegmentChain(
  seg: AudioSegment,
  options: { inputHasAudio?: (inputIdx: number) => boolean } = {}
): { out: string; fragment: string } | null {
  // ffmpeg 6 rejects the `[N:a:0?]` syntax in filter_complex — see top-of-file
  // comment near `probeHasAudio`. We instead skip the segment if its source
  // input has no audio stream, and use a plain `[N:a:0]` specifier otherwise.
  const hasAudio = options.inputHasAudio ? options.inputHasAudio(seg.inputIdx) : true
  if (!hasAudio) return null

  const out = `a${seg.fromVideoTrack ? 'v' : 't'}${seg.inputIdx}_${seg.clip.id.slice(-6)}`
  const speed = seg.clip.speed ?? 1
  const segDurSec = Math.max(0.001, (seg.clip.endMs - seg.clip.startMs) / 1000)
  const trimInSec = seg.clip.trimInMs / 1000
  const srcDurSec = segDurSec * speed
  const startDelayMs = seg.clip.startMs // delay on the FINAL timeline

  // Use a plain `N:a:0` specifier (no `?`). Audio presence was checked above;
  // for inputs without audio we never reach this point.
  const streamSpec = `${seg.inputIdx}:a:0`

  const parts: string[] = []
  parts.push(`atrim=start=${trimInSec.toFixed(4)}:duration=${srcDurSec.toFixed(4)}`)
  parts.push('asetpts=PTS-STARTPTS')
  const tempo = atempoChain(speed)
  if (tempo) parts.push(tempo)

  // Volume from gainDb / mute.
  const gainDb = seg.clip.gainDb ?? 0
  if (seg.clip.isMuted) {
    parts.push('volume=0')
  } else if (gainDb !== 0) {
    const linear = Math.pow(10, gainDb / 20)
    parts.push(`volume=${linear.toFixed(4)}`)
  }

  // Fades.
  const fadeIn = seg.clip.fadeInMs ?? 0
  const fadeOut = seg.clip.fadeOutMs ?? 0
  if (fadeIn > 0) {
    parts.push(`afade=t=in:st=0:d=${(fadeIn / 1000).toFixed(3)}`)
  }
  if (fadeOut > 0) {
    const startSec = Math.max(0, segDurSec - fadeOut / 1000)
    parts.push(`afade=t=out:st=${startSec.toFixed(3)}:d=${(fadeOut / 1000).toFixed(3)}`)
  }

  // adelay to place on the final timeline. adelay takes per-channel ms.
  if (startDelayMs > 0) {
    parts.push(`adelay=${startDelayMs}|${startDelayMs}`)
  }
  // Ensure stereo for amix consistency.
  parts.push('aformat=channel_layouts=stereo:sample_rates=44100')

  const fragment = `[${streamSpec}]${parts.join(',')}[${out}]`
  return { out, fragment }
}

/**
 * Stitch video segments together. Returns the final video output label and
 * the full filter graph for the video side.
 *
 * Strategy: if all transitions are 'none', use concat. If any transition is
 * set, use a sequential xfade chain — concat doesn't blend, so we accept
 * the cost of always falling back to xfade when at least one transition
 * is requested.
 */
function stitchVideo(
  segments: VideoSegment[],
  preset: MainPreset,
  xfadeAvailable = true
): { graph: string; finalLabel: string } {
  const fragments: string[] = []
  const segOutputs: string[] = []
  for (const seg of segments) {
    const { out, fragment } = buildVideoSegmentChain(seg, preset)
    fragments.push(fragment)
    segOutputs.push(out)
  }
  if (segments.length === 0) {
    // Should be caught earlier — render a 1-second black frame as a fallback.
    fragments.push(
      `color=c=black:s=${preset.width}x${preset.height}:d=1:r=${preset.fps}[vfinal]`
    )
    return { graph: fragments.join(';'), finalLabel: 'vfinal' }
  }
  if (segments.length === 1) {
    return { graph: fragments.join(';'), finalLabel: segOutputs[0] }
  }

  // Multi-segment: build sequential xfade or concat.
  const anyTransition =
    xfadeAvailable &&
    segments.some(
      (s, i) => i > 0 && s.transitionInMs > 0 && s.transitionKind !== 'none'
    )

  if (!anyTransition) {
    // Simple concat: [v0][v1]...concat=n=N:v=1:a=0[vfinal]
    const inputs = segOutputs.map((l) => `[${l}]`).join('')
    fragments.push(`${inputs}concat=n=${segments.length}:v=1:a=0[vfinal]`)
    return { graph: fragments.join(';'), finalLabel: 'vfinal' }
  }

  // xfade chain: pairwise reduce. We need the cumulative output duration to
  // compute each xfade's offset. Each xfade reduces total duration by its
  // transition window (transitionInMs).
  let prevLabel = segOutputs[0]
  let prevEndSec = (segments[0].endMs - segments[0].startMs) / 1000
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]
    const thisDurSec = (seg.endMs - seg.startMs) / 1000
    const transSec = seg.transitionInMs / 1000
    const xfadeKind =
      seg.transitionInMs > 0 && seg.transitionKind !== 'none'
        ? transitionKindToXfade(seg.transitionKind)
        : 'fade'
    const offsetSec = prevEndSec - transSec
    const safeOffset = Math.max(0, offsetSec).toFixed(4)
    const safeDur =
      seg.transitionInMs > 0 ? Math.max(0.1, transSec).toFixed(4) : '0.001'
    const newLabel = `vxf${i}`
    fragments.push(
      `[${prevLabel}][${segOutputs[i]}]xfade=transition=${xfadeKind}:duration=${safeDur}:offset=${safeOffset}[${newLabel}]`
    )
    prevLabel = newLabel
    prevEndSec = prevEndSec + thisDurSec - (seg.transitionInMs > 0 ? transSec : 0)
  }
  // Rename final label to vfinal for consistency.
  fragments.push(`[${prevLabel}]null[vfinal]`)
  return { graph: fragments.join(';'), finalLabel: 'vfinal' }
}

/** Stitch all audio: per-segment chains then amix across the lot. */
function stitchAudio(
  segments: AudioSegment[],
  project: Project,
  options: { inputHasAudio?: (inputIdx: number) => boolean } = {}
): { graph: string; finalLabel: string | null } {
  if (segments.length === 0) return { graph: '', finalLabel: null }

  // Split into role buckets (voice / bgm / sfx / unrouted).
  const segByLabel: { label: string; role: string | null; isBgm: boolean }[] = []
  const fragments: string[] = []

  for (const seg of segments) {
    const isVoice = seg.track.role === 'voice'
    const isBgm = seg.track.role === 'bgm'
    const isMuted = seg.track.muted || seg.clip.isMuted
    if (isMuted) continue
    const built = buildAudioSegmentChain(seg, { inputHasAudio: options.inputHasAudio })
    if (!built) continue
    fragments.push(built.fragment)
    segByLabel.push({
      label: built.out,
      role: seg.track.role ?? null,
      isBgm: isBgm
    })
    void isVoice
  }

  if (segByLabel.length === 0) return { graph: '', finalLabel: null }

  // Mix voice tracks first (so we can use them as the sidechain).
  const voiceLabels = segByLabel.filter((s) => s.role === 'voice').map((s) => s.label)
  const bgmLabels = segByLabel.filter((s) => s.role === 'bgm').map((s) => s.label)
  const otherLabels = segByLabel
    .filter((s) => s.role !== 'voice' && s.role !== 'bgm')
    .map((s) => s.label)

  const mixed: string[] = []

  // Voice bus.
  let voiceBus: string | null = null
  if (voiceLabels.length === 1) {
    voiceBus = voiceLabels[0]
  } else if (voiceLabels.length > 1) {
    voiceBus = 'voicebus'
    fragments.push(
      `${voiceLabels.map((l) => `[${l}]`).join('')}amix=inputs=${voiceLabels.length}:duration=longest[${voiceBus}]`
    )
  }

  // BGM bus.
  let bgmBus: string | null = null
  if (bgmLabels.length === 1) {
    bgmBus = bgmLabels[0]
  } else if (bgmLabels.length > 1) {
    bgmBus = 'bgmbus'
    fragments.push(
      `${bgmLabels.map((l) => `[${l}]`).join('')}amix=inputs=${bgmLabels.length}:duration=longest[${bgmBus}]`
    )
  }

  // Sidechain ducking — only if both voice + bgm exist and any BGM track
  // declares duckTarget='voice'.
  const bgmTrack = project.tracks.find(
    (t) => t.role === 'bgm' && t.duckTarget === 'voice'
  )
  if (voiceBus && bgmBus && bgmTrack) {
    const duckDb = bgmTrack.duckingDb ?? DEFAULT_DUCKING_DB
    // sidechaincompress threshold/ratio approximation; we also explicitly
    // attenuate the BGM by the requested dB amount via `volume` post-mix
    // because sidechaincompress' makeup gain math is fiddly.
    const linear = Math.pow(10, duckDb / 20)
    fragments.push(
      // We need TWO copies of voice: one for the final mix and one as sidechain.
      `[${voiceBus}]asplit=2[voicemix][voicesc];` +
        `[${bgmBus}][voicesc]sidechaincompress=threshold=0.05:ratio=8:attack=10:release=200[bgmduck];` +
        `[bgmduck]volume=${linear.toFixed(4)}[bgmducked]`
    )
    mixed.push('voicemix', 'bgmducked')
  } else {
    if (voiceBus) mixed.push(voiceBus)
    if (bgmBus) mixed.push(bgmBus)
  }
  for (const l of otherLabels) mixed.push(l)

  // Final amix.
  let finalLabel: string
  if (mixed.length === 1) {
    finalLabel = mixed[0]
  } else {
    finalLabel = 'afinal'
    fragments.push(
      `${mixed.map((l) => `[${l}]`).join('')}amix=inputs=${mixed.length}:duration=longest[${finalLabel}]`
    )
  }

  return { graph: fragments.join(';'), finalLabel }
}

// ---------------------------------------------------------------------------
// Plan builder — combines video + audio graphs, returns argv + filterGraph.
// ---------------------------------------------------------------------------
interface ExportPlan {
  argv: string[]
  filterGraph: string
  inputs: string[]
  outputPath: string
  videoSegmentCount: number
}

function buildExportPlan(
  project: Project,
  presetKey: ExportPresetKey,
  outputPath: string,
  options: {
    xfadeAvailable?: boolean
    /**
     * Set of input indices (matching the assembled `inputs[]` order from
     * `collectSegments`) that carry an audio stream. When omitted, every
     * input is assumed to have audio — fine for the plan-only IPC, but
     * the runtime export path passes a probed set so ffmpeg 6's strict
     * stream-spec validation doesn't blow up.
     */
    inputsWithAudio?: Set<number>
  } = {}
): ExportPlan {
  const preset = PRESETS[presetKey]
  if (!preset) throw new Error(`[export] unknown preset: ${presetKey}`)

  const { videoSegments, audioSegments, inputs } = collectSegments(project)
  if (videoSegments.length === 0) {
    throw new Error('[export] no video clips on timeline')
  }

  const xfadeAvailable = options.xfadeAvailable ?? true
  const { graph: videoGraph, finalLabel: videoLabel } = stitchVideo(
    videoSegments,
    preset,
    xfadeAvailable
  )
  const inputsWithAudio = options.inputsWithAudio
  const inputHasAudio = inputsWithAudio
    ? (idx: number): boolean => inputsWithAudio.has(idx)
    : undefined
  const { graph: audioGraph, finalLabel: audioLabel } = stitchAudio(
    audioSegments,
    project,
    { inputHasAudio }
  )

  // Combine. If no audio, still emit a silent stream for compliance with
  // mobile players that expect both tracks.
  const filterFragments: string[] = []
  if (videoGraph) filterFragments.push(videoGraph)
  if (audioGraph) filterFragments.push(audioGraph)

  let useAudioLabel = audioLabel
  if (!useAudioLabel) {
    // Synthesize 0.5s of silence repeated forever — `anullsrc`.
    filterFragments.push(
      `anullsrc=channel_layout=stereo:sample_rate=44100[silentaudio]`
    )
    useAudioLabel = 'silentaudio'
  }

  const filterGraph = filterFragments.join(';')

  // Build argv directly — bypasses runner's buildArgv which doesn't support
  // multi-input + map flags. We invoke through runFfmpegJob with extraArgs
  // would be too constrained; instead we use the lower-level spawnFfmpeg.
  // → Actually: easier to invoke the runner with extra map args, but the
  // runner currently doesn't support them. So we craft a FfmpegRunSpec that
  // includes inputs[] + filterGraph and add an `-map` via extraArgs.
  //   But extraArgs allow-list rejects `-map`. We'll use an ad-hoc spawn
  // in runExport() that mirrors the runner's safety checks.
  // For the *plan* we just record argv-preview.
  const argv: string[] = []
  argv.push('-hide_banner', '-y', '-nostdin')
  for (const p of inputs) {
    argv.push('-i', p)
  }
  argv.push('-filter_complex', filterGraph)
  argv.push('-map', `[${videoLabel}]`)
  argv.push('-map', `[${useAudioLabel}]`)
  argv.push('-c:v', preset.codec)
  argv.push('-preset', preset.preset)
  argv.push('-b:v', `${preset.vBitrateKbps}k`)
  argv.push('-maxrate', `${Math.round(preset.vBitrateKbps * 1.2)}k`)
  argv.push('-bufsize', `${preset.vBitrateKbps * 2}k`)
  argv.push('-pix_fmt', 'yuv420p')
  argv.push('-r', String(preset.fps))
  argv.push('-c:a', 'aac')
  argv.push('-b:a', `${preset.aBitrateKbps}k`)
  argv.push('-movflags', '+faststart')
  argv.push('-progress', 'pipe:2', '-nostats')
  argv.push(outputPath)

  return {
    argv,
    filterGraph,
    inputs,
    outputPath,
    videoSegmentCount: videoSegments.length
  }
}

// ---------------------------------------------------------------------------
// Runtime: spawn ffmpeg directly. Mirrors runner.ts safety checks.
// (We can't reuse runFfmpegJob because it doesn't accept -map argv directly.)
// ---------------------------------------------------------------------------
async function ensureExportDir(): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'exports')
  await mkdir(dir, { recursive: true })
  return dir
}

async function writeDebugLog(argv: string[], filterGraph: string): Promise<string> {
  const dir = await ensureExportDir()
  const logPath = path.join(dir, 'last-export-cmd.txt')
  const text = [
    '# Last export command',
    `# ${new Date().toISOString()}`,
    '',
    '## argv',
    JSON.stringify(argv, null, 2),
    '',
    '## filter graph',
    filterGraph,
    ''
  ].join('\n')
  await writeFile(logPath, text, 'utf-8')
  return logPath
}

/**
 * Probe the output file for dimensions / duration / bitrate via ffprobe-like
 * parsing of ffmpeg's own `-i ...` output (we don't want a second native
 * binary dependency from this module). Best-effort: if parsing fails, the
 * fields are simply omitted.
 */
function probeOutput(
  ffmpegPath: string,
  filePath: string
): Promise<{
  durationMs?: number
  width?: number
  height?: number
  vBitrate?: number
  aBitrate?: number
}> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024)
    })
    proc.on('close', () => {
      const out: ReturnType<typeof probeOutput> extends Promise<infer R> ? R : never = {}
      const dm = /Duration:\s+(\d+):(\d+):([\d.]+)/.exec(stderr)
      if (dm) {
        const hh = Number(dm[1])
        const mm = Number(dm[2])
        const ss = Number(dm[3])
        out.durationMs = Math.round((hh * 3600 + mm * 60 + ss) * 1000)
      }
      const vm = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr)
      if (vm) {
        out.width = Number(vm[1])
        out.height = Number(vm[2])
      }
      const vb = /Video:.*?(\d+) kb\/s/.exec(stderr)
      if (vb) out.vBitrate = Number(vb[1])
      const ab = /Audio:.*?(\d+) kb\/s/.exec(stderr)
      if (ab) out.aBitrate = Number(ab[1])
      resolve(out as never)
    })
    proc.on('error', () => resolve({}))
  })
}

async function runExport(
  project: Project,
  options: ExportRunOptions
): Promise<ExportRunResult> {
  const ffmpegPath = resolveFfmpegPath()

  // Allow + validate all media input paths and the output path.
  for (const m of Object.values(project.media)) {
    if (m && typeof m.path === 'string') allowPath(m.path)
  }
  allowPath(options.outputPath)
  const safeOutput = assertPathAllowed(options.outputPath, 'output')

  const xfadeAvailable = await probeXfadeAvailable(ffmpegPath)

  // Probe each unique input path for audio presence. We do this in the
  // runtime path (not in buildPlan) because the plan-only IPC just needs
  // a representative filter graph for UI inspection; the real run, however,
  // must avoid `[N:a:0?]` (rejected by ffmpeg 6) and only emit chains for
  // inputs that actually have an audio stream.
  const { inputs: probedInputs } = collectSegments(project)
  const inputsWithAudio = new Set<number>()
  for (let i = 0; i < probedInputs.length; i++) {
    const p = probedInputs[i]
    try {
      const hasAudio = await probeHasAudio(ffmpegPath, p)
      if (hasAudio) inputsWithAudio.add(i)
    } catch {
      // On probe failure, conservatively assume no audio — better to drop
      // the audio chain than to fail the entire export.
    }
  }

  let plan: ExportPlan
  try {
    plan = buildExportPlan(project, options.presetKey, safeOutput, {
      xfadeAvailable,
      inputsWithAudio
    })
  } catch (err) {
    return {
      jobId: options.jobId,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }

  // Allow + validate each input.
  for (const i of plan.inputs) {
    allowPath(i)
    assertPathAllowed(i, 'input')
  }

  const logPath = await writeDebugLog(plan.argv, plan.filterGraph)

  // Use the existing runner — it accepts inputs[] + filterGraph and emits
  // progress events. We pass an extraArgs subset of map flags via a small
  // shim: temporarily insert `-map` argv before spawning. Since runner's
  // buildArgv doesn't accept arbitrary -map, we spawn ourselves but reuse
  // the runner's progress-event infrastructure by going through it.
  //
  // → After review: runner.ts is rigid. For Phase 2.6 we accept duplication
  //   and spawn here directly. We still emit `ffmpeg:progress` events on the
  //   same channel so the UI binds without extra wiring.
  const result = await spawnFfmpegDirect(ffmpegPath, plan.argv, options.jobId)
  if (!result.ok) {
    return {
      jobId: options.jobId,
      ok: false,
      error: result.error ?? 'export failed',
      debugLogPath: logPath
    }
  }
  if (!existsSync(safeOutput)) {
    return {
      jobId: options.jobId,
      ok: false,
      error: 'output file missing after run',
      debugLogPath: logPath
    }
  }
  const probe = await probeOutput(ffmpegPath, safeOutput)
  return {
    jobId: options.jobId,
    ok: true,
    outputPath: safeOutput,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    vBitrate: probe.vBitrate,
    aBitrate: probe.aBitrate,
    debugLogPath: logPath
  }
}

// ---------------------------------------------------------------------------
// Direct spawn — emits ffmpeg:progress events on the existing channel.
// ---------------------------------------------------------------------------
const activeExportJobs = new Map<string, ReturnType<typeof spawn>>()

function spawnFfmpegDirect(
  ffmpegPath: string,
  argv: string[],
  jobId: string
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    activeExportJobs.set(jobId, proc)
    let stderrLog = ''
    let stderrBuf = ''
    const STDERR_LOG_LIMIT = 32 * 1024
    let totalDurationMs: number | null = null
    let lastEmit = 0
    const EMIT_INTERVAL = 250
    let outTimeMs: number | undefined
    let fpsVal: number | undefined
    let speedVal: number | undefined

    const emit = (done = false, message?: string, cancelled = false): void => {
      const now = Date.now()
      if (!done && now - lastEmit < EMIT_INTERVAL) return
      lastEmit = now
      const percent =
        totalDurationMs && outTimeMs != null
          ? Math.min(100, Math.max(0, (outTimeMs / totalDurationMs) * 100))
          : 0
      try {
        // Lazy require avoids importing webContents at module load (saves
        // about 6KB and keeps unit testing simpler).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { webContents } = require('electron') as typeof import('electron')
        for (const wc of webContents.getAllWebContents()) {
          if (wc.isDestroyed()) continue
          wc.send(IPC_CHANNELS.ffmpeg.progress, {
            jobId,
            percent,
            fps: fpsVal,
            speed: speedVal,
            currentTimeMs: outTimeMs,
            done,
            cancelled,
            message
          })
        }
      } catch {
        // ignore
      }
    }

    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      stderrLog += chunk
      if (stderrLog.length > STDERR_LOG_LIMIT) {
        stderrLog = stderrLog.slice(-STDERR_LOG_LIMIT)
      }
      stderrBuf += chunk
      if (totalDurationMs == null) {
        const m = /Duration:\s+(\d+):(\d+):([\d.]+)/.exec(stderrBuf)
        if (m) {
          totalDurationMs = Math.round(
            (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
          )
        }
      }
      let idx: number
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).trim()
        stderrBuf = stderrBuf.slice(idx + 1)
        if (!line) continue
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const key = line.slice(0, eq).trim()
        const value = line.slice(eq + 1).trim()
        if (key === 'out_time_ms' || key === 'out_time_us') {
          const n = Number(value)
          if (Number.isFinite(n)) outTimeMs = Math.round(n / 1000)
        } else if (key === 'fps') {
          const n = Number(value)
          if (Number.isFinite(n)) fpsVal = n
        } else if (key === 'speed') {
          const m = /([\d.]+)x/.exec(value)
          if (m) speedVal = Number(m[1])
        }
        emit()
      }
    })
    proc.on('error', (err) => {
      activeExportJobs.delete(jobId)
      emit(true, err.message)
      resolve({ ok: false, error: err.message })
    })
    proc.on('close', (code, signal) => {
      activeExportJobs.delete(jobId)
      if (code === 0) {
        emit(true)
        resolve({ ok: true })
      } else {
        const tail = stderrLog.split(/\r?\n/).slice(-12).join('\n')
        const reason = signal ? `signal ${signal}` : `exit ${code}`
        emit(true, `ffmpeg failed (${reason})`)
        resolve({ ok: false, error: `ffmpeg failed (${reason}): ${tail}` })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// IPC registration.
// ---------------------------------------------------------------------------
export function registerExportHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.exporter.run,
    async (_event, project: Project, options: ExportRunOptions): Promise<ExportRunResult> => {
      if (!project || !options || !options.jobId || !options.outputPath) {
        return { jobId: options?.jobId ?? 'unknown', ok: false, error: 'bad arguments' }
      }
      try {
        return await runExport(project, options)
      } catch (err) {
        return {
          jobId: options.jobId,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.exporter.buildPlan,
    async (
      _event,
      project: Project,
      presetKey: ExportPresetKey,
      outputPath: string
    ): Promise<ExportBuildPlanResult> => {
      try {
        // Allow paths so assertPathAllowed in plan can pass.
        for (const m of Object.values(project.media)) {
          if (m && typeof m.path === 'string') allowPath(m.path)
        }
        allowPath(outputPath)
        const ffmpegPath = resolveFfmpegPath()
        const xfadeAvailable = await probeXfadeAvailable(ffmpegPath)
        const plan = buildExportPlan(project, presetKey, outputPath, {
          xfadeAvailable
        })
        return {
          ok: true,
          argvPreview: plan.argv.join(' '),
          filterGraph: plan.filterGraph,
          inputs: plan.inputs,
          videoSegmentCount: plan.videoSegmentCount
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.exporter.revealFile, async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return
    try {
      shell.showItemInFolder(filePath)
    } catch {
      // ignore
    }
  })

  ipcMain.handle(IPC_CHANNELS.exporter.openFile, async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return
    try {
      await shell.openPath(filePath)
    } catch {
      // ignore
    }
  })
}

// Test-only helpers (exported for unit / e2e via dynamic require). Keep these
// minimal so the production surface stays focused.
export const __test = {
  buildExportPlan,
  escapeDrawtext,
  atempoChain,
  collectSegments,
  stitchVideo,
  stitchAudio
}
