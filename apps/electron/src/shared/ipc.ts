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
    pickDirectory: 'fs:pickDirectory',
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
    readWaveform: 'media:readWaveform',
    copyToImports: 'media:copyToImports'
  },
  auth: {
    startDeeplinkFlow: 'auth:startDeeplinkFlow',
    tokenReceived: 'auth:tokenReceived'
  },
  captions: {
    importSrt: 'captions:importSrt',
    parseSrtString: 'captions:parseSrtString',
    exportSubtitle: 'captions:exportSubtitle',
    /** E2E-only: call buildCaptionSvg in main process. Registered only when REELS_E2E=1. */
    buildSvg: 'captions:buildSvg'
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
  },
  recording: {
    saveAudio: 'recording:saveAudio'
  },
  updater: {
    installNow: 'updater:installNow',
    /** Renderer → main: trigger an out-of-cycle check now ("지금 확인" 버튼). */
    checkNow: 'updater:checkNow',
    /** Renderer → main: read current app version. */
    getVersion: 'updater:getVersion',
    downloadProgress: 'updater:download-progress',
    downloaded: 'updater:downloaded',
    /** Pushed when a check completes with no update — UI can flash "최신입니다". */
    notAvailable: 'updater:not-available',
    /** Pushed when a check / download errors so UI can show a one-line note. */
    error: 'updater:error'
  },
  stt: {
    transcribe: 'stt:transcribe',
    cancel: 'stt:cancel',
    progress: 'stt:progress',
    modelStatus: 'stt:modelStatus'
  },
  brandKit: {
    read: 'brandKit:read',
    write: 'brandKit:write',
    importLogo: 'brandKit:importLogo',
    removeLogo: 'brandKit:removeLogo'
  },
  overlay: {
    saveSticker: 'overlay:saveSticker'
  }
} as const

/**
 * Phase 3.25 — result of persisting a renderer-rasterized emoji/sticker PNG to
 * `userData/sticker-assets/`. The renderer supplies PNG bytes + a stable
 * `assetId` (the library id); main composes `sticker-assets/<assetId>.png`,
 * dedupes (reuses an existing file), allowlists it, returns the absolute path.
 */
export type SaveStickerResult =
  | { ok: true; path: string; reused: boolean }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Brand Kit — app-level, persisted to userData/brand-kit.json (not project data).
// ---------------------------------------------------------------------------
export type BrandLogoVariant = 'light' | 'dark'

export interface BrandLogo {
  variant: BrandLogoVariant
  /** Absolute app-managed path inside userData/brand/. */
  path: string
  naturalWidth: number
  naturalHeight: number
}

export interface BrandKit {
  version: 1
  /** 0..2 entries, at most one per variant. */
  logos: BrandLogo[]
  /** Lowercase #rrggbb hex, deduped, capped at 24. */
  colors: string[]
  /** Optional brand font family NAME (no file shipped). */
  fontFamily?: string
}

/** Renderer-writable subset — logos are mutated only via importLogo/removeLogo. */
export interface BrandKitWriteInput {
  colors: string[]
  fontFamily?: string
}

export type BrandKitImportLogoResult =
  | { ok: true; logo: BrandLogo }
  | { ok: false; error: string }

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

/** Result of `captions.exportSubtitle` (Phase 3.34). */
export type SubtitleExportResult =
  | { ok: true; path: string; bytesWritten: number }
  | { ok: false; error: string }

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
  /**
   * Phase 3.28 — animated GIF. Implemented as a 2-pass add-on: pass 0 is the
   * unmodified mp4 composite export to a temp file; pass 1 converts it to a
   * `.gif` via palettegen/paletteuse. `buildExportPlan` is NEVER called with
   * `'gif'` — the GIF branch intercepts in `runExport` — so the 5 mp4 presets'
   * export graph stays byte-identical.
   */
  | 'gif'

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
  /**
   * Phase 3.27 — absolute path to the standalone cover image written next to
   * the mp4 (`<name>_cover.jpg`). Best-effort: omitted if the cover extract
   * failed — the main mp4 export still succeeds regardless.
   */
  coverPath?: string
}

// ---------------------------------------------------------------------------
// Batch export (Phase 3.20) — the renderer runs N sequential `exporter:run`
// calls, one per preset. These types describe the aggregate; there is NO new
// `exporter:*` IPC channel — the batch is composed from existing single runs.
// ---------------------------------------------------------------------------

/** One preset's outcome within a batch export run. */
export interface BatchExportItemResult {
  presetKey: ExportPresetKey
  outputPath: string
  status: 'success' | 'failed' | 'cancelled' | 'skipped'
  error?: string
  durationMs?: number
  usedEncoder?: AllowedCodec
}

/** Aggregate result of a whole batch export run. */
export interface BatchExportResult {
  items: BatchExportItemResult[]
  successCount: number
  failedCount: number
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// Download pipeline (Phase 3.3 prefill).
// ---------------------------------------------------------------------------

/** Discriminated result of a video download to local userData/imports. */
export type DownloadResult =
  | { ok: true; localPath: string; sizeBytes: number }
  | { ok: false; error: string; httpStatus?: number }

// ---------------------------------------------------------------------------
// Voice recording (Phase 5 — timeline toolbar).
// ---------------------------------------------------------------------------

/**
 * Result of persisting a renderer-recorded audio blob to disk. The renderer
 * captures audio via MediaRecorder, hands the raw bytes to main, and main
 * writes them into `userData/recordings/<name>` and allowlists the path so
 * the standard media probe / ffmpeg pipeline accepts it.
 */
export type SaveRecordingResult =
  | { ok: true; localPath: string; sizeBytes: number }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Auto-update (Phase 4.7).
// ---------------------------------------------------------------------------

/**
 * Payload pushed to the renderer when electron-updater finishes downloading
 * a new package in the background. Mirrors the subset of fields the UI cares
 * about from electron-updater's `UpdateDownloadedEvent`. We keep this typed
 * narrow on purpose — renderer code should never have to import builder-util.
 */
export interface UpdateDownloadedPayload {
  version: string
  /** Optional human-readable release notes (string or html). */
  releaseNotes?: string
  /** ISO-8601 release date (if surfaced by the provider). */
  releaseDate?: string
}

/**
 * Periodic download-progress pushes while electron-updater pulls the
 * package. The renderer can use these for an optional progress indicator
 * before the "download complete" banner shows.
 */
export interface UpdateDownloadProgressPayload {
  /** 0–100 percent transferred. */
  percent: number
  /** Bytes transferred so far. */
  transferred: number
  /** Total bytes to transfer. */
  total: number
  /** Current throughput in bytes/sec. */
  bytesPerSecond: number
}

// ---------------------------------------------------------------------------
// Auto-caption STT (speech-to-text). Local whisper.cpp; ggml-base model is
// downloaded on first use into userData/models/.
// ---------------------------------------------------------------------------

/** STT model key. Only 'base' ships now; 'small' reserved for a future pass. */
export type SttModelKey = 'base'

/** Transcription language. 'auto' lets whisper detect. */
export type SttLanguage = 'ko' | 'en' | 'auto'

export interface SttTranscribeOptions {
  /** Renderer-generated ulid; correlates progress + cancel. */
  jobId: string
  /** Absolute path of the audio/video file to transcribe. Must be allow-listed. */
  sourcePath: string
  /** Optional sub-range of the source to transcribe, in ms. Omit = whole file. */
  startMs?: number
  endMs?: number
  /** Default 'auto'. */
  language?: SttLanguage
  /** Default 'base'. */
  model?: SttModelKey
  /**
   * Timestamp granularity (Phase 3.17). 'segment' (default) = legacy caption-
   * sized cues only. 'word' = whisper runs with `-ml 1 -sow` and `SttResult`
   * additionally carries `words[]` for text-based editing.
   */
  granularity?: 'segment' | 'word'
}

/** One transcribed cue. Shape-compatible with ParsedCaptionCue (sans id). */
export interface SttCue {
  startMs: number
  endMs: number
  text: string
  /**
   * Whisper segment confidence in [0, 1] (1 = highest). Optional — the main
   * process only populates it when the underlying transcriber exposes one
   * (e.g. whisper.cpp `avg_logprob` mapped through `Math.exp`). Absent =
   * unknown confidence; consumers must NOT treat that as "high" or "low".
   */
  confidence?: number
}

/** One transcribed word with source-time bounds (Phase 3.17, word granularity). */
export interface SttWord {
  text: string
  /** Absolute source-time bounds, ms (already offset-rebased for sub-ranges). */
  startMs: number
  endMs: number
  /** Per-word confidence in [0, 1] when the transcriber emits one. */
  confidence?: number
}

/** Threshold below which an STT cue is considered "low confidence" — drives a
 * visual hint on the resulting caption clip. Tuned conservatively: whisper.cpp
 * avg-logprob → exp() typically lands 0.85+ on clean speech; < 0.70 strongly
 * correlates with mistranscriptions in our hand-labeled set. */
export const STT_LOW_CONFIDENCE_THRESHOLD = 0.7

export type SttPhase =
  | 'preparing'
  | 'downloading-model'
  | 'extracting-audio'
  | 'transcribing'
  | 'done'
  | 'error'
  | 'cancelled'

export interface SttProgress {
  jobId: string
  phase: SttPhase
  /** 0..100 within the current phase. */
  percent: number
  message?: string
  /** Populated only on 'downloading-model'. */
  modelBytesDownloaded?: number
  modelBytesTotal?: number
}

export type SttErrorCode =
  | 'binary_missing'
  | 'model_missing'
  | 'model_download_failed'
  | 'model_checksum_failed'
  | 'no_audio'
  | 'path_not_allowed'
  | 'cancelled'
  | 'timeout'
  | 'parse_failed'
  | 'spawn_failed'
  | 'queue_full'
  | 'duplicate_jobId'
  | 'unsupported_platform'

export type SttResult =
  | {
      jobId: string
      ok: true
      cues: SttCue[]
      /** Populated only when `granularity: 'word'` was requested (Phase 3.17). */
      words?: SttWord[]
      language: string
      durationMs: number
    }
  | { jobId: string; ok: false; error: string; code: SttErrorCode }

export interface SttModelStatus {
  present: boolean
  model: SttModelKey
  sizeBytes?: number
}

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
    /** Pick an existing directory (Phase 3.20 batch export). null if cancelled. */
    pickDirectory(): Promise<string | null>
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
    /**
     * 0.2.9 — `srcPath` 의 파일을 `%APPDATA%/Reels Studio/imports/` 아래로
     * 복사하고 새 path를 반환. 원본은 그대로 둠. 이 안전 path가 우리
     * uninstall/install 사이클의 영향권 밖이라 publish hook이 install 폴더를
     * 통째 삭제해도 import한 video가 살아남음. 사용자가 install 폴더 안
     * `새 폴더/` 같은 곳에 둔 파일이 reinstall 시 lost 되던 문제(슬라이드 6
     * 추가 진단) 해결.
     */
    copyToImports(srcPath: string, mediaId: string): Promise<string>
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
    /**
     * Phase 3.34 — write a subtitle document to an allow-listed path (the
     * renderer obtains `path` from `fs.saveFile`, which allow-lists it).
     */
    exportSubtitle(path: string, content: string): Promise<SubtitleExportResult>
    /**
     * Phase 3.42 E2E-only — render a caption to SVG via the main-process
     * `buildCaptionSvg`. Registered only when `REELS_E2E=1`; in production
     * builds the handler is absent and the IPC will throw.
     */
    buildSvg(
      caption: unknown,
      canvasWidth: number,
      canvasHeight: number
    ): Promise<string>
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
     * Download a remote https media file to `userData/imports/<sanitized>`.
     * Handles video AND audio (`.mp3`/`.wav`/`.m4a` — `sanitizeName` preserves
     * the extension; the standard probe classifies audio): used by the music
     * library tab to fetch tracks as well as by the video import tabs.
     * Returns the local path on success; surfaces httpStatus for 403/etc.
     * Renderer should fall back to `getReelVideoUrl(shortcode)` re-scrape
     * when the URL expires (common for FB ad reels).
     */
    downloadVideoToTemp(
      url: string,
      suggestedName?: string
    ): Promise<DownloadResult>
  }
  updater: {
    /**
     * Trigger `autoUpdater.quitAndInstall()`. Called from the renderer when
     * the user clicks "지금 재시작" in the update banner. Resolves immediately;
     * the actual quit happens after the event loop returns.
     *
     * No-op in dev (`!app.isPackaged`) — returns false so the UI can decide
     * to hide the banner rather than spin forever.
     */
    installNow(): Promise<boolean>
    /**
     * Trigger a manual update check ("업데이트 확인" 버튼). Resolves with the
     * resolved status — useful so the UI can flash 최신/다운로드 시작/에러.
     * No-op in dev (returns 'dev-mode').
     */
    checkNow(): Promise<
      | 'checking'
      | 'available'
      | 'not-available'
      | 'error'
      | 'dev-mode'
    >
    /** Read app.getVersion() — for showing in 설정/About. */
    getVersion(): Promise<string>
    /**
     * Subscribe to the `updater:downloaded` event. Fires once per
     * downloaded update. Returns an unsubscribe function.
     */
    onDownloaded(cb: (payload: UpdateDownloadedPayload) => void): () => void
    /**
     * Subscribe to the periodic `updater:download-progress` events fired
     * while electron-updater pulls the package. Returns an unsubscribe fn.
     */
    onDownloadProgress(
      cb: (payload: UpdateDownloadProgressPayload) => void
    ): () => void
    /** Subscribe to "최신입니다" — fires after a check finds no update. */
    onNotAvailable(cb: (currentVersion: string) => void): () => void
    /** Subscribe to updater errors (manual check or background). */
    onError(cb: (message: string) => void): () => void
  }
  recording: {
    /**
     * Persist a renderer-captured audio recording (raw bytes from a
     * MediaRecorder blob) to `userData/recordings/`. The renderer supplies
     * the bytes and a desired file extension; main composes the path and
     * allowlists it. Returns the local path for the standard import pipeline.
     */
    saveAudio(
      bytes: ArrayBuffer | Uint8Array,
      ext: string
    ): Promise<SaveRecordingResult>
  }
  stt: {
    /** Transcribe a clip's / file's audio into timed caption cues. */
    transcribe(opts: SttTranscribeOptions): Promise<SttResult>
    /** Cancel an in-flight transcription job by id. */
    cancel(jobId: string): Promise<void>
    /** Check whether the STT model is present on disk. */
    modelStatus(model?: SttModelKey): Promise<SttModelStatus>
    /** Subscribe to streaming transcription progress. Returns an unsubscribe fn. */
    onProgress(cb: (e: SttProgress) => void): () => void
  }
  brandKit: {
    /** Read the brand kit (empty default when the file is missing). */
    read(): Promise<BrandKit>
    /** Persist colors + fontFamily (logos preserved on disk). */
    write(input: BrandKitWriteInput): Promise<void>
    /** Copy a picked image into userData/brand/ as the variant's logo. */
    importLogo(
      variant: BrandLogoVariant,
      sourcePath: string
    ): Promise<BrandKitImportLogoResult>
    /** Remove a logo variant; returns the updated kit. */
    removeLogo(variant: BrandLogoVariant): Promise<BrandKit>
  }
  overlay: {
    /**
     * Persist a renderer-rasterized emoji/sticker PNG (Phase 3.25). `assetId`
     * is the stable library id (`/^[a-z0-9-]{1,64}$/`) — dedupe key + filename
     * stem. Returns an absolute path inside userData/sticker-assets/,
     * allow-listed for media:// preview + export.
     */
    saveSticker(
      assetId: string,
      pngBytes: ArrayBuffer | Uint8Array
    ): Promise<SaveStickerResult>
  }
}

declare global {
  interface Window {
    electron: ElectronApi
  }
}
