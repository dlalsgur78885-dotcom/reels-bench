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
  type AllowedCodec,
  type ExportBuildPlanResult,
  type ExportPresetKey,
  type ExportRunOptions,
  type ExportRunResult,
  type FfmpegRunSpec
} from '../../shared/ipc'
import { probeCapabilities } from '../ffmpeg/capabilities'
import {
  filterPresetToFfmpeg,
  transitionKindToXfade
} from '../../shared/filterPresets'
import {
  DEFAULT_DUCKING_DB,
  DEFAULT_TRANSITION_MS,
  isCaptionClip,
  isMediaClip,
  getClipTransform,
  isIdentityTransform,
  hasTransformKeyframes,
  MAX_TRANSFORM_OFFSET,
  MAX_TRANSFORM_ROTATION,
  MAX_TRANSFORM_SCALE,
  MIN_TRANSFORM_OFFSET,
  MIN_TRANSFORM_ROTATION,
  MIN_TRANSFORM_SCALE,
  type CaptionClip,
  type ClipTransform,
  type Project,
  type Track,
  type TransformKeyframe,
  type VideoAudioClip
} from '../../shared/project'
import { resolveFfmpegPath } from '../ffmpeg/binary'
import { allowPath, assertPathAllowed } from '../ffmpeg/security'
import {
  renderCaptionToFile,
  resetCaptionRenderStats,
  getCaptionRenderStats
} from '../captions/render'

// ---------------------------------------------------------------------------
// Preset table (kept in sync with renderer's exportPresets.ts — main-process
// copy lets the IPC validate without round-tripping the renderer's bundle).
// ---------------------------------------------------------------------------
type Libx264Preset =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
  | 'veryslow'

interface MainPreset {
  width: number
  height: number
  fps: number
  vBitrateKbps: number
  aBitrateKbps: number
  codec: 'libx264'
  preset: Libx264Preset
}

/**
 * Map a libx264-style preset name to the equivalent for a given encoder. HW
 * encoders advertise their own preset vocabularies; using the wrong one is
 * either rejected at session init or silently ignored (depending on the
 * encoder). See README/Phase 4.2 notes for the source mapping.
 *
 * Returns `null` to mean "do not pass -preset at all" (used by VideoToolbox).
 */
export function mapPresetForCodec(
  preset: Libx264Preset,
  codec: AllowedCodec
): string | null {
  switch (codec) {
    case 'libx264':
    case 'libx265':
      return preset
    case 'h264_amf':
    case 'hevc_amf': {
      // amf usage: -quality {quality|balanced|speed}
      if (preset === 'slow' || preset === 'slower' || preset === 'veryslow') {
        return 'quality'
      }
      if (
        preset === 'veryfast' ||
        preset === 'superfast' ||
        preset === 'ultrafast' ||
        preset === 'faster' ||
        preset === 'fast'
      ) {
        return 'speed'
      }
      return 'balanced'
    }
    case 'h264_nvenc':
    case 'hevc_nvenc': {
      // nvenc usage: -preset p1..p7 (p7 = highest quality / slowest)
      if (preset === 'ultrafast' || preset === 'superfast') return 'p1'
      if (preset === 'veryfast') return 'p1'
      if (preset === 'faster') return 'p2'
      if (preset === 'fast') return 'p3'
      if (preset === 'medium') return 'p4'
      if (preset === 'slow') return 'p7'
      if (preset === 'slower') return 'p7'
      if (preset === 'veryslow') return 'p7'
      return 'p4'
    }
    case 'h264_qsv':
    case 'hevc_qsv':
      // qsv accepts x264-style preset names natively (veryfast..veryslow).
      return preset
    case 'h264_videotoolbox':
    case 'hevc_videotoolbox':
      // VideoToolbox doesn't accept -preset; quality is set via -q:v instead.
      return null
    default:
      return preset
  }
}

/**
 * AMD AMF expects `-quality {...}` rather than `-preset {...}`. Returns the
 * argv flag that should precede the mapped preset string. Most encoders use
 * `-preset`, AMF (and only AMF) uses `-quality`.
 */
export function presetFlagForCodec(codec: AllowedCodec): '-preset' | '-quality' {
  if (codec === 'h264_amf' || codec === 'hevc_amf') return '-quality'
  return '-preset'
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
  /**
   * Caption overlays whose time range intersects this clip (any caption
   * track). NOTE: when the PNG-overlay path is in use (sharp available),
   * captions are composited *after* segment stitching using ffmpeg's
   * `overlay` filter — see `stitchCaptions()`. We still keep this array on
   * the segment for the drawtext fallback path, which applies captions
   * inside each segment chain via `drawtext`.
   */
  captions: CaptionClip[]
  /** Time-on-timeline of segment start/end (clip.startMs / clip.endMs copy). */
  startMs: number
  endMs: number
  /** Transition window with previous segment (used by both video and audio). */
  transitionInMs: number
  transitionKind: string
  /**
   * Layer (video track) index: 0 = bottom-most video track, increasing upward.
   * Used to decide whether the blurred-background subgraph is emitted (base
   * layer only) vs. transparent-pad path (upper layers).
   */
  layerIndex: number
}

/**
 * Mapping from `caption.id` → pre-rendered PNG path + assigned ffmpeg input
 * index. When this map is non-empty, the export pipeline uses the PNG-overlay
 * path; when empty, the drawtext fallback runs (which is the legacy code path
 * preserved for fontconfig-only systems or when sharp's native binding is
 * unavailable).
 */
interface CaptionPng {
  pngPath: string
  inputIdx: number
  /** From the original caption clip — preserved for overlay positioning. */
  startMs: number
  endMs: number
  cached: boolean
}

type CaptionPngMap = Map<string, CaptionPng>

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
 *
 * Returns per-track grouped layers (videoTrackLayers[i] = sorted segments for
 * video track i, layerIndex 0 = bottom). A flat `videoSegments` convenience
 * accessor (all segments across all layers) is also returned for callers that
 * just need the count or audio wiring.
 *
 * IMPORTANT: transitionIn is resolved against the PREVIOUS CLIP ON THE SAME
 * TRACK — not a global ordering — so multi-track layouts don't cross-pollinate.
 */
function collectSegments(
  project: Project
): {
  videoTrackLayers: VideoSegment[][]
  videoSegments: VideoSegment[]
  audioSegments: AudioSegment[]
  inputs: string[]
} {
  const inputs: string[] = []
  const audioSegments: AudioSegment[] = []

  // Video tracks in declared order; clips sorted by startMs within each track.
  const videoTracks = project.tracks.filter((t) => t.kind === 'video')
  const allCaptionClips: CaptionClip[] = []
  for (const t of project.tracks) {
    if (t.kind !== 'caption') continue
    for (const c of t.clips) {
      if (isCaptionClip(c)) allCaptionClips.push(c)
    }
  }

  // Build per-track segment lists; each track gets its own layerIndex.
  const videoTrackLayers: VideoSegment[][] = []

  for (let layerIndex = 0; layerIndex < videoTracks.length; layerIndex++) {
    const t = videoTracks[layerIndex]
    const trackClips: { clip: VideoAudioClip; track: Track }[] = []
    for (const c of t.clips) {
      if (!isMediaClip(c)) continue
      const media = project.media[c.mediaId]
      if (!media) continue
      trackClips.push({ clip: c, track: t })
    }
    // Sort within this track by timeline start.
    trackClips.sort((a, b) => a.clip.startMs - b.clip.startMs)

    const layerSegments: VideoSegment[] = []
    for (let i = 0; i < trackClips.length; i++) {
      const { clip, track } = trackClips[i]
      const media = project.media[clip.mediaId]
      if (!media) continue
      const inputIdx = inputs.length
      inputs.push(media.path)

      // Captions overlapping this clip's timeline range.
      const captions = allCaptionClips.filter(
        (c) => c.endMs > clip.startMs && c.startMs < clip.endMs
      )

      // Transition: defined on this clip (transitionIn) — only valid if there
      // is a previous segment ON THE SAME TRACK (not a global predecessor).
      const prev = i > 0 ? trackClips[i - 1].clip : null
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

      layerSegments.push({
        clip,
        track,
        inputIdx,
        captions,
        startMs: clip.startMs,
        endMs: clip.endMs,
        transitionInMs,
        transitionKind,
        layerIndex
      })
    }
    videoTrackLayers.push(layerSegments)
  }

  // Flat view (all segments, sorted globally by startMs then layerIndex for
  // determinism) — used for audio wiring and videoSegmentCount.
  const videoSegments: VideoSegment[] = videoTrackLayers
    .flat()
    .sort((a, b) => a.startMs - b.startMs || a.layerIndex - b.layerIndex)

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

  return { videoTrackLayers, videoSegments, audioSegments, inputs }
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

// ---------------------------------------------------------------------------
// Phase 3.5 — keyframe expression compiler.
// ---------------------------------------------------------------------------

/**
 * Compile a sorted keyframe list into a piecewise-linear ffmpeg expression
 * string for a single transform property.
 *
 * The time variable `varName` (default `'t'`) is the filter-local time in
 * seconds. For zoompan the caller passes `'time'`; for rotate/pad/geq the
 * caller passes `'t'`.
 *
 * Output form (N keyframes at local seconds s0 < s1 < ... < s_{n-1}):
 *   if(lt(VAR,s0), v0,
 *     if(lt(VAR,s1), v0+(v1-v0)*(VAR-s0)/(s1-s0),
 *       ... v_{n-1}))
 *
 * Optimisation — when ALL interpolated values are equal the bare constant is
 * returned (no if() nesting). Callers use this to skip animated filters
 * entirely and fall back to the Phase 3 static snippet, keeping non-animated
 * properties free of the `geq`/`zoompan` performance cost.
 *
 * Guard: zero-width segments (duplicate timestamps) are skipped to prevent
 * divide-by-zero in the interpolation expression. The project arrives over IPC
 * unvalidated so this guard is safety-critical, not cosmetic.
 *
 * NOTE: MAX_KEYFRAMES_PER_CLIP=24 caps the nested-if depth at 23 levels — well
 * within ffmpeg's expression evaluator limits for typical usage.
 */
export function keyframeExpr(
  kfs: TransformKeyframe[],
  pick: (t: ClipTransform) => number,
  varName = 't'
): string {
  // Sort ascending and deduplicate zero-gap pairs defensively (store should
  // have already enforced MIN_KEYFRAME_GAP_MS >= 30, but IPC is untrusted).
  const sorted = [...kfs].sort((a, b) => a.atMs - b.atMs)

  // Build de-duplicated list: keep first occurrence when two keyframes are
  // within 1 ms (floating-point safe threshold).
  const deduped: TransformKeyframe[] = []
  for (const kf of sorted) {
    if (
      deduped.length === 0 ||
      kf.atMs - deduped[deduped.length - 1].atMs >= 1
    ) {
      deduped.push(kf)
    }
  }

  // Collect values.
  const vals = deduped.map((kf) => pick(kf.transform))
  const secs = deduped.map((kf) => kf.atMs / 1000)

  // Constant-skip: all values equal → bare constant.
  if (vals.every((v) => Math.abs(v - vals[0]) < 1e-9)) {
    return vals[0].toFixed(6)
  }

  // Build right-to-left nested if() expression.
  // Start from the final (hold-last) value, wrap in if(lt(...), interp, rest)
  // for each interval from the right.
  let expr = vals[vals.length - 1].toFixed(6)

  for (let i = deduped.length - 2; i >= 0; i--) {
    const s0 = secs[i]
    const s1 = secs[i + 1]
    const v0 = vals[i]
    const v1 = vals[i + 1]

    // Guard: skip zero-width segment (safety; should not occur after dedup).
    const span = s1 - s0
    if (span < 1e-6) continue

    // Linear interpolation: v0 + (v1-v0)*(VAR-s0)/(s1-s0)
    const dv = v1 - v0
    let interp: string
    if (Math.abs(dv) < 1e-9) {
      // Flat segment — avoid emitting a divide for zero slope.
      interp = v0.toFixed(6)
    } else {
      interp = `${v0.toFixed(6)}+${dv.toFixed(6)}*(${varName}-${s0.toFixed(4)})/${span.toFixed(4)}`
    }

    // Hold-first before s0.
    if (i === 0) {
      expr = `if(lt(${varName},${s0.toFixed(4)}),${v0.toFixed(6)},if(lt(${varName},${s1.toFixed(4)}),${interp},${expr}))`
    } else {
      expr = `if(lt(${varName},${s1.toFixed(4)}),${interp},${expr})`
    }
  }

  return expr
}

/**
 * Build the per-clip video filter chain (excluding the xfade join).
 *
 * When `captionPngMap` is provided AND contains the caption's id, the
 * drawtext fallback is skipped for that caption — the PNG overlay path
 * handles it post-stitching in `stitchCaptions()`. Captions absent from the
 * map fall back to drawtext (this lets a mixed scenario work: e.g. sharp
 * succeeded for 3 of 5 captions, failed for 2 — those 2 still render via
 * drawtext rather than vanishing).
 *
 * `isBaseLayer` — when true (layerIndex === 0) the blurred-bg opaque canvas
 * subgraph is emitted (legacy behaviour, preserved exactly for single-track
 * projects). When false (upper layers) a transparent-pad canvas frame is used
 * instead so lower layers show through.
 */
function buildVideoSegmentChain(
  seg: VideoSegment,
  preset: MainPreset,
  captionPngMap?: CaptionPngMap,
  isBaseLayer = true
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
  // 3. fps normalization (so xfade durations line up cleanly, and all layers
  //    share the same timebase before overlay).
  parts.push(`fps=${preset.fps}`)

  const W = preset.width
  const H = preset.height
  const labelIn = `pre${seg.inputIdx}`
  const preChain = parts.join(',')

  let fragment: string

  if (isBaseLayer) {
    // 4-BASE. Aspect-correct scale + blurred-background pad. Two-stage subgraph:
    //   main (object-fit: contain) and bg (cover + blur) merged via overlay.
    //   Opaque black canvas — same as original single-track path.
    const labelBg = `bg${seg.inputIdx}`
    const labelMain = `main${seg.inputIdx}`

    fragment =
      `[${seg.inputIdx}:v]${preChain}[${labelIn}];` +
      `[${labelIn}]split=2[${labelMain}src][${labelBg}src];` +
      `[${labelBg}src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:1,eq=brightness=-0.2[${labelBg}];` +
      `[${labelMain}src]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0[${labelMain}];` +
      `[${labelBg}][${labelMain}]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1`
  } else {
    // 4-UPPER. Transparent-pad canvas frame: scale to contain, then pad with
    // transparent gutters to fill canvas dimensions. Lower layers show through
    // the transparent area.
    fragment =
      `[${seg.inputIdx}:v]${preChain}[${labelIn}];` +
      `[${labelIn}]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1`
  }

  // 5. Caption drawtext overlays. Each caption clip becomes one drawtext
  //    filter that's only enabled during its time-on-timeline (relative to
  //    this segment after we reset PTS, segment_t = timeline_t - clip.startMs).
  //    Captions handled by the PNG-overlay path (captionPngMap) are skipped
  //    here — they'll be composited onto the stitched final video.
  //
  //    NOTE: drawtext captions are applied BEFORE the transform sub-chain so
  //    they move and scale with the clip. This matches the mental model that
  //    captions "belong" to the clip content.
  if (seg.captions.length > 0) {
    const drawtexts: string[] = []
    for (const cap of seg.captions) {
      if (captionPngMap && captionPngMap.has(cap.id)) continue
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

  // 6. Transform sub-chain.
  //
  //    CRITICAL INVARIANT (spec 3.1): a clip with !hasTransformKeyframes(clip)
  //    MUST produce a BYTE-IDENTICAL filter graph to the pre-Phase-3.5 code.
  //    The two branches below are structurally exclusive — the keyframe path
  //    is entered ONLY when hasTransformKeyframes returns true; otherwise the
  //    original Phase 3 static code runs COMPLETELY UNCHANGED.

  if (hasTransformKeyframes(seg.clip)) {
    // -----------------------------------------------------------------------
    // Phase 3.5 animated sub-chain.
    //
    // The keyframe list is clamped main-side before building expressions.
    // The project arrives over IPC unvalidated; renderer clamping is not
    // trusted (a finite-but-extreme value would OOM ffmpeg). Mirror exactly
    // the same MIN/MAX constants used by the Phase 3 static path.
    //
    // Segment-local time: PTS was reset (setpts=PTS-STARTPTS) and optionally
    // divided by speed (setpts=PTS/speed). After those two setpts filters the
    // filter-local `t` (or `time` for zoompan) runs 0..segDurSec on the
    // OUTPUT timeline. Keyframe `atMs` is CLIP-RELATIVE ms — dividing by 1000
    // gives the matching local seconds directly, with no speed factor needed.
    // -----------------------------------------------------------------------
    const clampField = (v: number, lo: number, hi: number): number =>
      Math.min(hi, Math.max(lo, v))

    // Re-clamp every keyframe's transform. Build a clean sorted array.
    const rawKfs = (seg.clip.transformKeyframes as TransformKeyframe[])
    const kfs: TransformKeyframe[] = rawKfs
      .slice()
      .sort((a, b) => a.atMs - b.atMs)
      .map((kf) => ({
        // atMs is untrusted (IPC) — coerce non-finite/negative so a corrupt
        // project JSON can't put "NaN"/"Infinity" into the ffmpeg expression
        // via secs=atMs/1000. Valid renderer atMs (>=0, finite) passes through.
        atMs: Number.isFinite(kf.atMs) ? Math.max(0, kf.atMs) : 0,
        transform: {
          x: clampField(Number.isFinite(kf.transform.x) ? kf.transform.x : 0, MIN_TRANSFORM_OFFSET, MAX_TRANSFORM_OFFSET),
          y: clampField(Number.isFinite(kf.transform.y) ? kf.transform.y : 0, MIN_TRANSFORM_OFFSET, MAX_TRANSFORM_OFFSET),
          scale: clampField(Number.isFinite(kf.transform.scale) ? kf.transform.scale : 1, MIN_TRANSFORM_SCALE, MAX_TRANSFORM_SCALE),
          rotation: clampField(Number.isFinite(kf.transform.rotation) ? kf.transform.rotation : 0, MIN_TRANSFORM_ROTATION, MAX_TRANSFORM_ROTATION),
          opacity: clampField(Number.isFinite(kf.transform.opacity) ? kf.transform.opacity : 1, 0, 1)
        }
      }))

    // Per-property constant-skip: compute the expression and check whether it
    // resolved to a bare constant (all values equal → keyframeExpr returns
    // a number string, no `if(` present). We use this to decide whether to
    // emit the animated filter or fall back to the cheaper static snippet.
    const scaleExpr    = keyframeExpr(kfs, (t) => t.scale,    'time')
    const rotExpr      = keyframeExpr(kfs, (t) => t.rotation * Math.PI / 180, 't')
    const xExpr        = keyframeExpr(kfs, (t) => t.x * W,    't')
    const yExpr        = keyframeExpr(kfs, (t) => t.y * H,    't')
    const opacityExpr  = keyframeExpr(kfs, (t) => t.opacity,  't')

    const isConstExpr = (e: string): boolean => !e.includes('(')

    // Constant fallback values (first keyframe, already clamped).
    const firstT = kfs[0].transform
    const constScale    = firstT.scale
    const constRotRad   = firstT.rotation * Math.PI / 180
    const constX        = firstT.x
    const constY        = firstT.y
    const constOpacity  = firstT.opacity

    // 6a. format=rgba — always emitted for the animated path.
    fragment += `,format=rgba`

    // 6b. SCALE (animated via zoompan, or static snippet when constant).
    //
    // zoompan is used for animated scale because it is the only ffmpeg filter
    // that evaluates a per-frame zoom expression while keeping output dimensions
    // fixed. It uses variable name `time` (seconds).
    //
    // LIMITATION: zoompan internally quantises zoom to float precision on each
    // output frame; very slow zooms (< ~0.001 zoom-unit/frame) may exhibit
    // integer-step banding on some ffmpeg builds. This is a known zoompan
    // limitation and is documented here for the e2e tester.
    //
    // d=1 = one output frame per input frame (pass-through cadence).
    if (isConstExpr(scaleExpr)) {
      // Constant scale — Phase 3 static snippet.
      if (Math.abs(constScale - 1) > 1e-5) {
        fragment += `,scale=iw*${constScale.toFixed(6)}:ih*${constScale.toFixed(6)}`
        if (constScale > 1) {
          fragment += `,crop=${W}:${H}`
        } else {
          fragment += `,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`
        }
      }
    } else {
      // Animated scale via zoompan.
      // zoompan centres the zoom on (iw/2, ih/2) by default when
      // x='iw/2-(iw/zoom/2)' y='ih/2-(ih/zoom/2)'.
      fragment += `,zoompan=z='${scaleExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${preset.fps}`
    }

    // 6c. ROTATION (animated via rotate filter; uses variable `t`).
    if (isConstExpr(rotExpr)) {
      // Constant rotation — Phase 3 static snippet.
      if (Math.abs(constRotRad) > 1e-5) {
        fragment += `,rotate=${constRotRad.toFixed(6)}:c=black@0:ow=${W}:oh=${H}`
      }
    } else {
      fragment += `,rotate=a='${rotExpr}':c=black@0:ow=${W}:oh=${H}`
    }

    // 6d. TRANSLATION (animated).
    //
    // TRANSLATE PATH CHOSEN: split + overlay (NOT pad).
    //
    // Rationale: ffmpeg's `pad` filter evaluates its x/y expressions at
    // filter-graph initialisation time (once), NOT per frame, so passing a
    // `t`-expression to pad produces a static offset equal to t=0. This is a
    // long-standing ffmpeg limitation that applies to all bundled builds.
    // The `overlay` filter evaluates x/y per frame and is universally
    // supported. We therefore route animated translation through:
    //   split=2[base][content] →
    //   [base]pad=W:H:0:0:black@0[bg] →
    //   [bg][content]overlay=x='<xExpr>+(W-iw)/2':y='<yExpr>+(H-ih)/2'
    //
    // The centre-origin convention (x/y as fraction of canvas) is preserved:
    //   xPxExpr = keyframeExpr(t => t.x * W) + (W-iw)/2
    //   yPxExpr = keyframeExpr(t => t.y * H) + (H-ih)/2
    //
    // For constant translation we still use the Phase 3 pad+crop snippet to
    // avoid the split+overlay overhead on static clips.
    if (isConstExpr(xExpr) && isConstExpr(yExpr)) {
      // Constant translation — Phase 3 static snippet.
      if (Math.abs(constX) > 1e-6 || Math.abs(constY) > 1e-6) {
        const xPx = Math.round(constX * W)
        const yPx = Math.round(constY * H)
        fragment += `,pad=${W}:${H}:${xPx}+(ow-iw)/2:${yPx}+(oh-ih)/2:color=black@0`
        fragment += `,crop=${W}:${H}:0:0`
      }
    } else {
      // Animated translation via split + overlay.
      const splitLbl  = `xt_split_${seg.inputIdx}`
      const bgLbl     = `xt_bg_${seg.inputIdx}`
      const contentLbl = `xt_content_${seg.inputIdx}`
      // End current chain, split into bg + content, build transparent bg,
      // then overlay with animated position.
      const overlayX = `${xExpr}+(${W}-iw)/2`
      const overlayY = `${yExpr}+(${H}-ih)/2`
      fragment += `,split=2[${splitLbl}_bg][${splitLbl}_fg]`
      // Append sub-fragments as separate filter graph statements.
      fragment += `;[${splitLbl}_bg]pad=${W}:${H}:0:0:color=black@0[${bgLbl}]`
      fragment += `;[${bgLbl}][${splitLbl}_fg]overlay=x='${overlayX}':y='${overlayY}'[${contentLbl}]`
      // Swap current chain label to contentLbl so the final `[${out}]` suffix
      // attaches correctly below.  We do this by closing the current pad of
      // the chain and continuing from contentLbl.
      fragment += `;[${contentLbl}]null`
    }

    // 6e. OPACITY (animated via geq; uses variable `t`).
    //
    // geq evaluates per pixel per frame — it is the most CPU-intensive filter
    // in this chain. The constant-skip optimisation is critical: a clip where
    // opacity never changes must NOT emit geq. A constant non-1 opacity uses
    // the cheaper colorchannelmixer static snippet.
    if (isConstExpr(opacityExpr)) {
      // Constant opacity — Phase 3 static snippet.
      if (Math.abs(constOpacity - 1) > 1e-5) {
        fragment += `,colorchannelmixer=aa=${constOpacity.toFixed(6)}`
      }
    } else {
      // Animated opacity via geq (passes through R/G/B unchanged, scales A).
      fragment += `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${opacityExpr}*alpha(X,Y)'`
    }

  } else {
    // -----------------------------------------------------------------------
    // Phase 3 static step-6 — UNCHANGED from pre-Phase-3.5.
    // This block must remain byte-for-byte identical to the original so that
    // regression test (11) (concat=n=2, no eof_action=pass) and all Phase 1/2
    // tests continue to pass.
    // -----------------------------------------------------------------------

    // 6. Transform sub-chain — only when the clip has a non-identity transform.
    //    ALWAYS use getClipTransform() — never read clip.transform directly.
    //    Gated by isIdentityTransform so legacy/unmodified clips have zero
    //    overhead and single-track identity graphs remain byte-identical.
    //    getClipTransform coerces non-finite values to identity; we ALSO
    //    range-clamp here because the `project` arg arrives over IPC unvalidated
    //    — the main process must not trust the renderer to have clamped (a
    //    finite-but-extreme scale would otherwise OOM ffmpeg). Same MIN/MAX
    //    constants as the renderer store's setClipTransform clamp.
    const rawXform = getClipTransform(seg.clip)
    const clampField = (v: number, lo: number, hi: number): number =>
      Math.min(hi, Math.max(lo, v))
    const xform = {
      x: clampField(rawXform.x, MIN_TRANSFORM_OFFSET, MAX_TRANSFORM_OFFSET),
      y: clampField(rawXform.y, MIN_TRANSFORM_OFFSET, MAX_TRANSFORM_OFFSET),
      scale: clampField(rawXform.scale, MIN_TRANSFORM_SCALE, MAX_TRANSFORM_SCALE),
      rotation: clampField(
        rawXform.rotation,
        MIN_TRANSFORM_ROTATION,
        MAX_TRANSFORM_ROTATION
      ),
      opacity: clampField(rawXform.opacity, 0, 1)
    }
    if (!isIdentityTransform(xform)) {
      const { x, y, scale, rotation, opacity } = xform
      // 6a. Convert to RGBA so rotation corners and opacity blend correctly.
      fragment += `,format=rgba`

      // 6b. Scale: scale then crop/pad back to canvas size.
      if (Math.abs(scale - 1) > 1e-5) {
        fragment += `,scale=iw*${scale.toFixed(6)}:ih*${scale.toFixed(6)}`
        if (scale > 1) {
          // Scaled beyond canvas — crop centred to canvas dimensions.
          fragment += `,crop=${W}:${H}`
        } else {
          // Scaled below canvas — pad with transparent gutters.
          fragment += `,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`
        }
      }

      // 6c. Rotation (degrees → radians; transparent fill for corners).
      if (Math.abs(rotation) > 1e-5) {
        const rad = (rotation * Math.PI) / 180
        fragment += `,rotate=${rad.toFixed(6)}:c=black@0:ow=${W}:oh=${H}`
      }

      // 6d. Translation: x/y are fractions of canvas dimensions, centre-origin.
      //     We bake the offset into a pad filter then crop to clamp back to canvas.
      if (Math.abs(x) > 1e-6 || Math.abs(y) > 1e-6) {
        const xPx = Math.round(x * W)
        const yPx = Math.round(y * H)
        // pad moves the frame right/down by the offset; (ow-iw)/2 centres first.
        fragment += `,pad=${W}:${H}:${xPx}+(ow-iw)/2:${yPx}+(oh-ih)/2:color=black@0`
        // Crop back to canvas size from origin to clamp.
        fragment += `,crop=${W}:${H}:0:0`
      }

      // 6e. Opacity.
      if (Math.abs(opacity - 1) > 1e-5) {
        fragment += `,colorchannelmixer=aa=${opacity.toFixed(6)}`
      }
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
 * Stitch a single video track's segments into one labelled timeline stream.
 *
 * Uses xfade when transitions are present (and xfade is available), concat
 * otherwise. The `prevEndSec` xfade accumulator is LOCAL to this track —
 * it must reset per track, which is why this is a per-track helper.
 *
 * Returns the output label and all filter graph fragments for this track.
 * The output label is `vtrack${layerIndex}`.
 */
function stitchVideoTrack(
  segments: VideoSegment[],
  layerIndex: number,
  preset: MainPreset,
  xfadeAvailable: boolean,
  captionPngMap?: CaptionPngMap
): { fragments: string[]; trackLabel: string } {
  const isBase = layerIndex === 0
  const fragments: string[] = []
  const segOutputs: string[] = []

  for (const seg of segments) {
    const { out, fragment } = buildVideoSegmentChain(seg, preset, captionPngMap, isBase)
    fragments.push(fragment)
    segOutputs.push(out)
  }

  const trackLabel = `vtrack${layerIndex}`

  if (segments.length === 0) {
    // Empty layer — emit a silent transparent frame so overlay doesn't choke.
    // (Rare: an empty video track shouldn't reach this path.)
    fragments.push(
      `color=c=black@0:s=${preset.width}x${preset.height}:d=0.001:r=${preset.fps}[${trackLabel}]`
    )
    return { fragments, trackLabel }
  }

  if (segments.length === 1) {
    // Single segment: just alias the segment output to the track label.
    fragments.push(`[${segOutputs[0]}]null[${trackLabel}]`)
    return { fragments, trackLabel }
  }

  // Multi-segment: build sequential xfade or concat.
  const anyTransition =
    xfadeAvailable &&
    segments.some(
      (s, i) => i > 0 && s.transitionInMs > 0 && s.transitionKind !== 'none'
    )

  if (!anyTransition) {
    // Simple concat: [v0][v1]...concat=n=N:v=1:a=0[vtrackN]
    const inputPads = segOutputs.map((l) => `[${l}]`).join('')
    fragments.push(`${inputPads}concat=n=${segments.length}:v=1:a=0[${trackLabel}]`)
    return { fragments, trackLabel }
  }

  // xfade chain: pairwise reduce.
  // prevEndSec RESETS per track — this is the key correctness requirement.
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
    const newLabel = `vxf${layerIndex}_${i}`
    fragments.push(
      `[${prevLabel}][${segOutputs[i]}]xfade=transition=${xfadeKind}:duration=${safeDur}:offset=${safeOffset}[${newLabel}]`
    )
    prevLabel = newLabel
    prevEndSec = prevEndSec + thisDurSec - (seg.transitionInMs > 0 ? transSec : 0)
  }
  // Rename final xfade label to the track label.
  fragments.push(`[${prevLabel}]null[${trackLabel}]`)
  return { fragments, trackLabel }
}

/**
 * Composite multiple per-track labels bottom→top using `overlay`.
 *
 * Returns new filter graph fragments + the final composited label.
 * If only one track, no overlay is emitted — the base track label IS the
 * final label.
 *
 * overlay options:
 *   - `overlay=0:0` — transform was baked into each segment, so fixed origin.
 *   - `eof_action=pass` — when an upper layer ends, base continues undisturbed.
 *   - `shortest=0` — composite length follows the base layer, not the shortest.
 *   - `format=auto` — lets ffmpeg handle RGBA→yuv alpha flattening correctly.
 */
function compositeLayers(
  trackLabels: string[]
): { fragments: string[]; compositeLabel: string } {
  if (trackLabels.length === 1) {
    return { fragments: [], compositeLabel: trackLabels[0] }
  }

  const fragments: string[] = []
  // Start with base (layer 0) — it is the opaque bottom.
  let prevLabel = trackLabels[0]
  for (let i = 1; i < trackLabels.length; i++) {
    const newLabel = i === trackLabels.length - 1 ? 'vcomp' : `vcomp${i}`
    fragments.push(
      `[${prevLabel}][${trackLabels[i]}]overlay=0:0:eof_action=pass:shortest=0:format=auto[${newLabel}]`
    )
    prevLabel = newLabel
  }
  return { fragments, compositeLabel: prevLabel }
}

/**
 * Stitch all video track layers into a single final video stream.
 *
 * STAGE A: each track's segments are stitched via `stitchVideoTrack` (xfade or
 * concat, per-track, with per-track xfade offset accumulator reset).
 * STAGE B: per-track labels are composited bottom→top via `overlay`.
 *
 * Single video track with identity transforms → output is structurally
 * identical to the old code (concat/xfade, same label `vfinal`), preserving
 * byte-identical filter graphs for legacy projects.
 */
function stitchVideo(
  videoTrackLayers: VideoSegment[][],
  preset: MainPreset,
  xfadeAvailable = true,
  captionPngMap?: CaptionPngMap
): { graph: string; finalLabel: string } {
  const allFragments: string[] = []

  if (videoTrackLayers.length === 0 || videoTrackLayers.every((l) => l.length === 0)) {
    // Should be caught earlier — render a 1-second black frame as a fallback.
    allFragments.push(
      `color=c=black:s=${preset.width}x${preset.height}:d=1:r=${preset.fps}[vfinal]`
    )
    return { graph: allFragments.join(';'), finalLabel: 'vfinal' }
  }

  // STAGE A — per-track stitch. Skip empty layers.
  const trackLabels: string[] = []
  for (let layerIndex = 0; layerIndex < videoTrackLayers.length; layerIndex++) {
    const layerSegs = videoTrackLayers[layerIndex]
    if (layerSegs.length === 0) continue

    const { fragments, trackLabel } = stitchVideoTrack(
      layerSegs,
      layerIndex,
      preset,
      xfadeAvailable,
      captionPngMap
    )
    for (const f of fragments) allFragments.push(f)
    trackLabels.push(trackLabel)
  }

  if (trackLabels.length === 0) {
    allFragments.push(
      `color=c=black:s=${preset.width}x${preset.height}:d=1:r=${preset.fps}[vfinal]`
    )
    return { graph: allFragments.join(';'), finalLabel: 'vfinal' }
  }

  // STAGE B — composite layers. Single-layer: no overlay emitted.
  const { fragments: compFragments, compositeLabel } = compositeLayers(trackLabels)
  for (const f of compFragments) allFragments.push(f)

  // Always expose as `vfinal` for downstream consumers.
  const finalLabel = 'vfinal'
  allFragments.push(`[${compositeLabel}]null[${finalLabel}]`)

  return { graph: allFragments.join(';'), finalLabel }
}

/**
 * Append a chain of `overlay` filters that composite caption PNGs onto the
 * stitched video. Each caption is sourced from its own ffmpeg input (`-i
 * captionN.png`) and gated by `enable='between(t,startSec,endSec)'`.
 *
 * The PNG is full-canvas — caption position was baked into the SVG during
 * rendering, so the overlay simply pastes at (0,0).
 *
 * Returns the new final label + filter fragments. When the map is empty,
 * returns the input label unchanged (no-op chain).
 */
function stitchCaptions(
  inputVideoLabel: string,
  captionPngMap: CaptionPngMap
): { graph: string; finalLabel: string } {
  if (captionPngMap.size === 0) {
    return { graph: '', finalLabel: inputVideoLabel }
  }
  const fragments: string[] = []
  let prevLabel = inputVideoLabel
  // Sort caption inputs by inputIdx for deterministic graph output (helps
  // diffing in last-export-cmd.txt and matches the order they were added to
  // the inputs[] array).
  const ordered = Array.from(captionPngMap.values()).sort(
    (a, b) => a.inputIdx - b.inputIdx
  )
  for (let i = 0; i < ordered.length; i++) {
    const cap = ordered[i]
    const startSec = (cap.startMs / 1000).toFixed(3)
    const endSec = (cap.endMs / 1000).toFixed(3)
    const newLabel = i === ordered.length - 1 ? 'vcaptioned' : `vcap${i}`
    fragments.push(
      `[${prevLabel}][${cap.inputIdx}:v]overlay=0:0:enable='between(t,${startSec},${endSec})'[${newLabel}]`
    )
    prevLabel = newLabel
  }
  return { graph: fragments.join(';'), finalLabel: prevLabel }
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
    /**
     * Override the video encoder. Default = preset.codec (libx264). When
     * set to a HW encoder (h264_amf/nvenc/qsv/videotoolbox), the argv is
     * adjusted: preset name is mapped, and we switch from CRF to VBR. Even
     * the CPU path uses VBR today (the original code never set CRF), so the
     * change is encoder-specific only around -preset / -q:v.
     */
    codec?: AllowedCodec
    /**
     * Pre-rendered caption PNGs keyed by `caption.id`. Each entry contributes
     * a `-loop 1 -t <dur> -i <pngPath>` input followed by an `overlay` filter
     * (see `stitchCaptions`). The map's `inputIdx` MUST match the actual
     * argv input ordering — the caller is responsible for assigning indices
     * based on `inputs.length` BEFORE registering them here. The plan-only
     * IPC omits this map (drawtext fallback path runs).
     */
    captionPngs?: CaptionPngMap
  } = {}
): ExportPlan {
  const preset = PRESETS[presetKey]
  if (!preset) throw new Error(`[export] unknown preset: ${presetKey}`)

  const { videoTrackLayers, videoSegments, audioSegments, inputs } = collectSegments(project)
  if (videoSegments.length === 0) {
    throw new Error('[export] no video clips on timeline')
  }

  const xfadeAvailable = options.xfadeAvailable ?? true
  const captionPngs = options.captionPngs
  const { graph: videoGraph, finalLabel: stitchedVideoLabel } = stitchVideo(
    videoTrackLayers,
    preset,
    xfadeAvailable,
    captionPngs
  )
  // Composite caption PNGs onto the stitched video. No-op when captionPngs
  // is undefined / empty — in that case all captions used the drawtext path
  // and are already baked into per-segment frames.
  const { graph: captionGraph, finalLabel: videoLabel } = captionPngs
    ? stitchCaptions(stitchedVideoLabel, captionPngs)
    : { graph: '', finalLabel: stitchedVideoLabel }
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
  if (captionGraph) filterFragments.push(captionGraph)
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
  const codec: AllowedCodec = options.codec ?? preset.codec
  const mappedPreset = mapPresetForCodec(preset.preset, codec)
  const presetFlag = presetFlagForCodec(codec)

  const argv: string[] = []
  argv.push('-hide_banner', '-y', '-nostdin')
  for (const p of inputs) {
    argv.push('-i', p)
  }
  // Caption PNG inputs. Each PNG is treated as a 1-frame still that we loop
  // with `-loop 1` so ffmpeg generates a video stream from it; `-t <dur>`
  // bounds how long the loop is sourced for. The actual visibility window
  // is enforced by the overlay's `enable=between(t,...)` expression, so the
  // -t value just needs to be ≥ the caption's endMs to avoid stream EOF
  // before the overlay's last enabled frame. We use the caption's endSec to
  // keep things tight (a much larger value works too but wastes nothing).
  if (captionPngs) {
    // Sort by inputIdx so argv matches expected ordering.
    const ordered = Array.from(captionPngs.values()).sort(
      (a, b) => a.inputIdx - b.inputIdx
    )
    for (const cap of ordered) {
      const durSec = Math.max(0.1, cap.endMs / 1000)
      argv.push('-loop', '1', '-t', durSec.toFixed(3), '-i', cap.pngPath)
    }
  }
  argv.push('-filter_complex', filterGraph)
  argv.push('-map', `[${videoLabel}]`)
  argv.push('-map', `[${useAudioLabel}]`)
  argv.push('-c:v', codec)
  if (mappedPreset !== null) {
    argv.push(presetFlag, mappedPreset)
  } else if (codec === 'h264_videotoolbox' || codec === 'hevc_videotoolbox') {
    // VideoToolbox uses -q:v 1-100 (lower = better). Map x264 preset roughly:
    //   veryfast → 70, medium → 60, slow → 50. Default 60.
    let qv = 60
    if (
      preset.preset === 'veryfast' ||
      preset.preset === 'faster' ||
      preset.preset === 'fast' ||
      preset.preset === 'superfast' ||
      preset.preset === 'ultrafast'
    ) {
      qv = 70
    } else if (preset.preset === 'slow' || preset.preset === 'slower' || preset.preset === 'veryslow') {
      qv = 50
    }
    argv.push('-q:v', String(qv))
  }
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

  // Decide encoder. If the renderer asked for HW accel, probe capabilities
  // and use the preferred HW encoder; otherwise stick with libx264. We also
  // fall back to libx264 when the probe says the preferred encoder IS
  // libx264 (no HW found) — so the renderer can flip the flag freely.
  let chosenCodec: AllowedCodec = 'libx264'
  if (options.useHardwareAccel) {
    try {
      const caps = await probeCapabilities()
      chosenCodec = caps.preferred ?? 'libx264'
    } catch {
      chosenCodec = 'libx264'
    }
  }

  const xfadeAvailable = await probeXfadeAvailable(ffmpegPath)

  // Probe each unique input path for audio presence. We do this in the
  // runtime path (not in buildPlan) because the plan-only IPC just needs
  // a representative filter graph for UI inspection; the real run, however,
  // must avoid `[N:a:0?]` (rejected by ffmpeg 6) and only emit chains for
  // inputs that actually have an audio stream.
  const { inputs: probedInputs } = collectSegments(project) as { inputs: string[] }
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

  // Pre-render caption PNGs. Each PNG is canvas-sized and includes the
  // caption baked into its final visual position. Failures degrade
  // gracefully — captions whose render failed (or all captions when sharp
  // is unavailable) fall back to drawtext via the legacy code path. The
  // PNG inputs are appended AFTER the media inputs so the existing input
  // indices for video/audio segments remain stable.
  resetCaptionRenderStats()
  const captionPngs: CaptionPngMap = new Map()
  try {
    const preset = PRESETS[options.presetKey]
    if (preset) {
      const canvasW = preset.width
      const canvasH = preset.height
      // Gather all caption clips from all caption tracks.
      const allCaptions: CaptionClip[] = []
      for (const t of project.tracks) {
        if (t.kind !== 'caption') continue
        for (const c of t.clips) {
          if (isCaptionClip(c)) allCaptions.push(c)
        }
      }
      // Caption inputs follow media inputs. Walk in deterministic order.
      let nextInputIdx = probedInputs.length
      for (const cap of allCaptions) {
        const result = await renderCaptionToFile(cap, canvasW, canvasH)
        if (!result) continue // sharp unavailable / render error — drawtext fallback
        // Allow the rendered PNG path so ffmpeg's security layer accepts it.
        allowPath(result.pngPath)
        captionPngs.set(cap.id, {
          pngPath: result.pngPath,
          inputIdx: nextInputIdx++,
          startMs: cap.startMs,
          endMs: cap.endMs,
          cached: result.cached
        })
      }
    }
  } catch (err) {
    // Render-side errors must NEVER fail the whole export. Log + continue
    // with the empty map (drawtext fallback handles every caption).
    console.warn(
      '[export] caption pre-render encountered an error; falling back to drawtext:',
      err instanceof Error ? err.message : String(err)
    )
    captionPngs.clear()
  }
  if (captionPngs.size > 0) {
    const stats = getCaptionRenderStats()
    console.log(
      `[export] captions: ${captionPngs.size} rendered, cacheHits=${stats.cacheHits}, misses=${stats.cacheMisses}, errors=${stats.errors}`
    )
  }

  let plan: ExportPlan
  try {
    plan = buildExportPlan(project, options.presetKey, safeOutput, {
      xfadeAvailable,
      inputsWithAudio,
      codec: chosenCodec,
      captionPngs: captionPngs.size > 0 ? captionPngs : undefined
    })
  } catch (err) {
    return {
      jobId: options.jobId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      usedEncoder: chosenCodec
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
      debugLogPath: logPath,
      usedEncoder: chosenCodec
    }
  }
  if (!existsSync(safeOutput)) {
    return {
      jobId: options.jobId,
      ok: false,
      error: 'output file missing after run',
      debugLogPath: logPath,
      usedEncoder: chosenCodec
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
    debugLogPath: logPath,
    usedEncoder: chosenCodec
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
  keyframeExpr,
  collectSegments,
  stitchVideo,
  stitchVideoTrack,
  compositeLayers,
  stitchAudio,
  stitchCaptions,
  mapPresetForCodec,
  presetFlagForCodec
}
