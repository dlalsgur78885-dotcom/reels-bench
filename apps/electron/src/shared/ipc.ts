// Typed IPC channel contracts shared between main, preload, and renderer.

import type {
  Project,
  ProbeResult,
  ThumbnailOptions,
  ThumbnailResult
} from './project'

export const IPC_CHANNELS = {
  ffmpeg: {
    capabilities: 'ffmpeg:capabilities',
    run: 'ffmpeg:run',
    cancel: 'ffmpeg:cancel',
    progress: 'ffmpeg:progress'
  },
  fs: {
    pickFile: 'fs:pickFile',
    saveFile: 'fs:saveFile',
    readProject: 'fs:readProject',
    writeProject: 'fs:writeProject',
    allowPath: 'fs:allowPath'
  },
  media: {
    probe: 'media:probe',
    generateThumbnail: 'media:generateThumbnail',
    readThumbnail: 'media:readThumbnail',
    generateWaveform: 'media:generateWaveform',
    readWaveform: 'media:readWaveform'
  },
  auth: {
    startDeeplinkFlow: 'auth:startDeeplinkFlow',
    tokenReceived: 'auth:tokenReceived'
  },
  captions: {
    importSrt: 'captions:importSrt',
    parseSrtString: 'captions:parseSrtString'
  },
  audio: {
    detectSilence: 'audio:detectSilence',
    detectBeats: 'audio:detectBeats'
  },
  exporter: {
    run: 'exporter:run',
    buildPlan: 'exporter:buildPlan',
    revealFile: 'exporter:revealFile',
    openFile: 'exporter:openFile'
  },
  download: {
    downloadVideoToTemp: 'download:downloadVideoToTemp'
  }
} as const

// ---------------------------------------------------------------------------
// Audio analysis types (Phase 2.5).
// ---------------------------------------------------------------------------
export interface SilenceRange {
  startMs: number
  endMs: number
  durationMs: number
}

export interface SilenceDetectOptions {
  /** Noise floor in dB, default -30. */
  noiseDb?: number
  /** Minimum silence duration in ms, default 400. */
  minMs?: number
}

export interface BeatMarker {
  timeMs: number
}

export interface BeatDetectOptions {
  /** Manual BPM override; required for the MVP stub. */
  bpm?: number
  /** Offset of the first beat from the source start. Default 0. */
  startOffsetMs?: number
  /** Length of the analysed range in ms. Default = full media duration. */
  durationMs?: number
}

export interface WaveformResult {
  /** Absolute path of the generated waveform PNG. */
  path: string
  /** data: URI for direct CSS background use (img-src + base64-encoded). */
  dataUri: string
  width: number
  height: number
}

export interface WaveformOptions {
  /** Output pixel width (default 1200). */
  width?: number
  /** Output pixel height (default 80). */
  height?: number
  /** Override output path. */
  outPath?: string
  /** Used to compute default outPath = userData/waveforms/<mediaId>.png. */
  mediaId?: string
}

/** Result of parsing an SRT/VTT file: caller maps to CaptionClip with a trackId. */
export interface ParsedCaptionCue {
  /** Optional cue id from the source file (line above the timestamp arrow). */
  id?: string
  startMs: number
  endMs: number
  /** Plain text, lines collapsed to single spaces. */
  text: string
}

// --- ffmpeg allow-lists -----------------------------------------------------
// Renderer is NEVER trusted to supply raw ffmpeg args. It may only choose
// from these allowlisted values; the main process composes the final argv.

export const ALLOWED_CODECS = [
  'libx264',
  'libx265',
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv',
  'hevc_qsv',
  'h264_amf',
  'hevc_amf',
  'h264_videotoolbox',
  'hevc_videotoolbox'
] as const
export type AllowedCodec = (typeof ALLOWED_CODECS)[number]

// libx264 presets share names across most encoders; for HW encoders we map
// to their native equivalents in the main-process job builder.
export const ALLOWED_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow'
] as const
export type AllowedPreset = (typeof ALLOWED_PRESETS)[number]

export const ENCODER_PRIORITY: ReadonlyArray<AllowedCodec> = [
  'h264_nvenc',
  'h264_qsv',
  'h264_amf',
  'h264_videotoolbox',
  'libx264'
]

export type FfmpegJobKind = 'export' | 'proxy'

export interface FfmpegCapabilities {
  encoders: string[]
  preferred: AllowedCodec
}

export interface FfmpegRunSpec {
  jobId: string
  /** Single input convenience; the main process will widen to inputs:[]. */
  input?: string
  /** Multiple inputs (concat, overlays). When set, `input` is ignored. */
  inputs?: string[]
  /** Final output path (must be inside an allowed root). */
  output: string
  /** Optional ffmpeg -filter_complex string. Will be validated. */
  filterGraph?: string
  /** Encoder codec; must be from ALLOWED_CODECS. */
  codec?: AllowedCodec
  /** Encoder preset; must be from ALLOWED_PRESETS. */
  preset?: AllowedPreset
  /** Constant-rate-factor (libx264/libx265). 18–28 typical. */
  crf?: number
  /** Constant bitrate target (kbps) — for HW encoders. */
  bitrateKbps?: number
  /** Optional simple scaling, e.g. "-2:480" applied as -vf scale=... */
  scale?: string
  /** Trim. Both in seconds; emits -ss/-t. */
  startSec?: number
  durationSec?: number
  /** Optional explicit -t in seconds (alias of durationSec). */
  /** Audio: 'copy' | 'aac' | 'none' */
  audio?: 'copy' | 'aac' | 'none'
  /** Per-job timeout, default 600_000ms. */
  timeoutMs?: number
  /** 'export' counts against the export slot; 'proxy' against proxy slots. */
  kind?: FfmpegJobKind
  /**
   * Escape hatch: extra raw args. STRONGLY discouraged — every entry is
   * passed through a strict validator that only allows a small set of flags.
   */
  extraArgs?: string[]
}

export interface JobResult {
  jobId: string
  ok: boolean
  output?: string
  durationMs?: number
  error?: string
}

export interface ProgressEvent {
  jobId: string
  percent: number
  fps?: number
  speed?: number
  currentTimeMs?: number
  etaMs?: number
  message?: string
  cancelled?: boolean
  done?: boolean
}

export interface FilePickerFilter {
  name: string
  extensions: string[]
}

export interface PickFileOptions {
  filters?: FilePickerFilter[]
  /** Allow multi-select; returns string[]. */
  multi?: boolean
}

// ---------------------------------------------------------------------------
// Export pipeline types (Phase 2.6).
// ---------------------------------------------------------------------------
export type ExportPresetKey =
  | 'instagram-reels'
  | 'tiktok'
  | 'youtube-shorts'
  | 'instagram-feed'
  | 'high-quality'

export interface ExportRunOptions {
  /** Stable id for progress correlation. */
  jobId: string
  presetKey: ExportPresetKey
  outputPath: string
  /**
   * When true, the export pipeline will use the system's preferred hardware
   * encoder (e.g. h264_nvenc / h264_amf / h264_qsv / h264_videotoolbox) if
   * one is available. When false or omitted, the export falls back to the
   * libx264 CPU encoder. If true but no HW encoder is available, libx264 is
   * used silently (the result.usedEncoder field reflects the actual choice).
   */
  useHardwareAccel?: boolean
}

export interface ExportRunResult {
  jobId: string
  ok: boolean
  outputPath?: string
  durationMs?: number
  width?: number
  height?: number
  vBitrate?: number
  aBitrate?: number
  error?: string
  /** Path to the persisted last-export-cmd.txt for diagnostics. */
  debugLogPath?: string
  /**
   * The encoder actually used for this run, e.g. `h264_amf` or `libx264`.
   * Set even on failure (best-effort) so the UI can show what was attempted.
   */
  usedEncoder?: AllowedCodec
}

// ---------------------------------------------------------------------------
// Download pipeline (Phase 3.3 prefill).
// ---------------------------------------------------------------------------

/** Discriminated result of a video download to local userData/imports. */
export type DownloadResult =
  | { ok: true; localPath: string; sizeBytes: number }
  | { ok: false; error: string; httpStatus?: number }

export interface ExportBuildPlanResult {
  ok: boolean
  /** Final ffmpeg argv as a single string (debug-friendly). */
  argvPreview?: string
  /** Filter graph string (large; may be omitted from UI). */
  filterGraph?: string
  /** Input paths in order (input index = position in this array). */
  inputs?: string[]
  /** Number of media (video-track) clips on the timeline. */
  videoSegmentCount?: number
  error?: string
}

export interface ElectronApi {
  ffmpeg: {
    capabilities(): Promise<FfmpegCapabilities>
    run(spec: FfmpegRunSpec): Promise<JobResult>
    cancel(jobId: string): Promise<void>
    onProgress(cb: (e: ProgressEvent) => void): () => void
  }
  fs: {
    /**
     * Backward-compatible: a bare filter list returns a single path or null;
     * passing `{ multi: true }` returns string[] (possibly empty).
     */
    pickFile(filter?: FilePickerFilter[]): Promise<string | null>
    pickFiles(options?: PickFileOptions): Promise<string[]>
    saveFile(defaultName?: string): Promise<string | null>
    readProject(): Promise<Project | null>
    writeProject(project: Project): Promise<void>
    /** Register a path (from drag-drop) so ffmpeg/probe handlers accept it. */
    allowPath(p: string): Promise<void>
  }
  media: {
    probe(filePath: string): Promise<ProbeResult>
    generateThumbnail(
      filePath: string,
      options?: ThumbnailOptions
    ): Promise<ThumbnailResult>
    /** Read an existing thumbnail file into a data: URI (used on app restart). */
    readThumbnail(thumbnailPath: string): Promise<string | null>
    generateWaveform(
      filePath: string,
      options?: WaveformOptions
    ): Promise<WaveformResult>
    readWaveform(waveformPath: string): Promise<string | null>
  }
  audio: {
    detectSilence(
      filePath: string,
      options?: SilenceDetectOptions
    ): Promise<SilenceRange[]>
    detectBeats(
      filePath: string,
      options?: BeatDetectOptions
    ): Promise<BeatMarker[]>
  }
  /**
   * Electron 32+ — pull the real on-disk path out of a drag-and-drop File.
   * Implemented in preload via `electron.webUtils.getPathForFile`.
   */
  getPathForFile(file: File): string
  auth: {
    startDeeplinkFlow(): Promise<void>
    onTokenReceived(cb: (token: string) => void): () => void
  }
  captions: {
    /** Reads an SRT or VTT file from disk (path must be allowlisted). */
    importSrt(filePath: string): Promise<ParsedCaptionCue[]>
    /** Parses an in-memory SRT/VTT payload (used for tests + paste flow). */
    parseSrtString(raw: string): Promise<ParsedCaptionCue[]>
  }
  exporter: {
    /** Run a full export. Resolves when the underlying ffmpeg job exits. */
    run(
      project: Project,
      options: ExportRunOptions
    ): Promise<ExportRunResult>
    /**
     * Build & validate the filter graph + argv without running ffmpeg.
     * Used by tests and the "what would happen" diagnostic in the UI.
     */
    buildPlan(
      project: Project,
      presetKey: ExportPresetKey,
      outputPath: string
    ): Promise<ExportBuildPlanResult>
    /** Open the containing folder with the file selected. */
    revealFile(filePath: string): Promise<void>
    /** Open the file with the OS default player. */
    openFile(filePath: string): Promise<void>
  }
  download: {
    /**
     * Download a remote https video to `userData/imports/<sanitized>.mp4`.
     * Returns the local path on success; surfaces httpStatus for 403/etc.
     * Renderer should fall back to `getReelVideoUrl(shortcode)` re-scrape
     * when the URL expires (common for FB ad reels).
     */
    downloadVideoToTemp(
      url: string,
      suggestedName?: string
    ): Promise<DownloadResult>
  }
}

declare global {
  interface Window {
    electron: ElectronApi
  }
}
