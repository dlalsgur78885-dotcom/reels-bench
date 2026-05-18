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
    readThumbnail: 'media:readThumbnail'
  },
  auth: {
    startDeeplinkFlow: 'auth:startDeeplinkFlow',
    tokenReceived: 'auth:tokenReceived'
  }
} as const

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
}

declare global {
  interface Window {
    electron: ElectronApi
  }
}
