import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent
} from 'electron'
import {
  IPC_CHANNELS,
  type BeatDetectOptions,
  type BeatMarker,
  type BrandKit,
  type BrandKitImportLogoResult,
  type BrandKitWriteInput,
  type BrandLogoVariant,
  type DownloadResult,
  type ElectronApi,
  type ExportBuildPlanResult,
  type ExportPresetKey,
  type ExportRunOptions,
  type ExportRunResult,
  type FfmpegCapabilities,
  type FfmpegRunSpec,
  type FilePickerFilter,
  type JobResult,
  type ParsedCaptionCue,
  type SubtitleExportResult,
  type PickFileOptions,
  type ProgressEvent,
  type SaveRecordingResult,
  type SaveStickerResult,
  type SilenceDetectOptions,
  type SilenceRange,
  type SttModelKey,
  type SttModelStatus,
  type SttProgress,
  type SttResult,
  type SttTranscribeOptions,
  type UpdateDownloadedPayload,
  type UpdateDownloadProgressPayload,
  type WaveformOptions,
  type WaveformResult
} from '../shared/ipc'
import type {
  ProbeResult,
  Project,
  ThumbnailOptions,
  ThumbnailResult
} from '../shared/project'

const api: ElectronApi = {
  ffmpeg: {
    capabilities: (): Promise<FfmpegCapabilities> =>
      ipcRenderer.invoke(IPC_CHANNELS.ffmpeg.capabilities),
    run: (spec: FfmpegRunSpec): Promise<JobResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.ffmpeg.run, spec),
    cancel: (jobId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.ffmpeg.cancel, jobId),
    onProgress: (cb: (e: ProgressEvent) => void): (() => void) => {
      const listener = (_ev: IpcRendererEvent, payload: ProgressEvent): void => cb(payload)
      ipcRenderer.on(IPC_CHANNELS.ffmpeg.progress, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.ffmpeg.progress, listener)
    }
  },
  fs: {
    pickFile: (filter?: FilePickerFilter[]): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.pickFile, filter),
    pickFiles: (options?: PickFileOptions): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.pickFile + ':multi', options),
    pickDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.pickDirectory),
    saveFile: (defaultName?: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.saveFile, defaultName),
    readProject: (): Promise<Project | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.readProject),
    writeProject: (project: Project): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.writeProject, project),
    allowPath: (p: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.allowPath, p)
  },
  media: {
    probe: (filePath: string): Promise<ProbeResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.media.probe, filePath),
    generateThumbnail: (
      filePath: string,
      options?: ThumbnailOptions
    ): Promise<ThumbnailResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.media.generateThumbnail, filePath, options),
    readThumbnail: (thumbnailPath: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.media.readThumbnail, thumbnailPath),
    generateWaveform: (
      filePath: string,
      options?: WaveformOptions
    ): Promise<WaveformResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.media.generateWaveform, filePath, options),
    readWaveform: (waveformPath: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.media.readWaveform, waveformPath),
    copyToImports: (srcPath: string, mediaId: string): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.media.copyToImports, srcPath, mediaId)
  },
  audio: {
    detectSilence: (
      filePath: string,
      options?: SilenceDetectOptions
    ): Promise<SilenceRange[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.audio.detectSilence, filePath, options),
    detectBeats: (
      filePath: string,
      options?: BeatDetectOptions
    ): Promise<BeatMarker[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.audio.detectBeats, filePath, options)
  },
  // Electron 32+: extract the absolute path of a drag-dropped File. The raw
  // File.path property is hidden under sandbox:true.
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  auth: {
    startDeeplinkFlow: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.auth.startDeeplinkFlow),
    onTokenReceived: (cb: (token: string) => void): (() => void) => {
      const listener = (_ev: IpcRendererEvent, token: string): void => cb(token)
      ipcRenderer.on(IPC_CHANNELS.auth.tokenReceived, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.auth.tokenReceived, listener)
    }
  },
  captions: {
    importSrt: (filePath: string): Promise<ParsedCaptionCue[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.captions.importSrt, filePath),
    parseSrtString: (raw: string): Promise<ParsedCaptionCue[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.captions.parseSrtString, raw),
    exportSubtitle: (
      path: string,
      content: string
    ): Promise<SubtitleExportResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.captions.exportSubtitle, path, content),
    /** E2E-only: invoke main-process buildCaptionSvg. Returns SVG string. */
    buildSvg: (
      caption: unknown,
      canvasWidth: number,
      canvasHeight: number
    ): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.captions.buildSvg, caption, canvasWidth, canvasHeight)
  },
  exporter: {
    run: (project, options: ExportRunOptions): Promise<ExportRunResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.exporter.run, project, options),
    buildPlan: (
      project,
      presetKey: ExportPresetKey,
      outputPath: string
    ): Promise<ExportBuildPlanResult> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.exporter.buildPlan,
        project,
        presetKey,
        outputPath
      ),
    revealFile: (filePath: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.exporter.revealFile, filePath),
    openFile: (filePath: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.exporter.openFile, filePath)
  },
  download: {
    downloadVideoToTemp: (
      url: string,
      suggestedName?: string
    ): Promise<DownloadResult> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.download.downloadVideoToTemp,
        url,
        suggestedName
      )
  },
  recording: {
    saveAudio: (
      bytes: ArrayBuffer | Uint8Array,
      ext: string
    ): Promise<SaveRecordingResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.recording.saveAudio, bytes, ext)
  },
  brandKit: {
    read: (): Promise<BrandKit> =>
      ipcRenderer.invoke(IPC_CHANNELS.brandKit.read),
    write: (input: BrandKitWriteInput): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.brandKit.write, input),
    importLogo: (
      variant: BrandLogoVariant,
      sourcePath: string
    ): Promise<BrandKitImportLogoResult> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.brandKit.importLogo,
        variant,
        sourcePath
      ),
    removeLogo: (variant: BrandLogoVariant): Promise<BrandKit> =>
      ipcRenderer.invoke(IPC_CHANNELS.brandKit.removeLogo, variant)
  },
  overlay: {
    saveSticker: (
      assetId: string,
      pngBytes: ArrayBuffer | Uint8Array
    ): Promise<SaveStickerResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.overlay.saveSticker, assetId, pngBytes)
  },
  stt: {
    transcribe: (opts: SttTranscribeOptions): Promise<SttResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.stt.transcribe, opts),
    cancel: (jobId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.stt.cancel, jobId),
    modelStatus: (model?: SttModelKey): Promise<SttModelStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.stt.modelStatus, model),
    onProgress: (cb: (e: SttProgress) => void): (() => void) => {
      const listener = (_ev: IpcRendererEvent, payload: SttProgress): void => cb(payload)
      ipcRenderer.on(IPC_CHANNELS.stt.progress, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.stt.progress, listener)
    }
  },
  updater: {
    installNow: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.updater.installNow),
    checkNow: () => ipcRenderer.invoke(IPC_CHANNELS.updater.checkNow),
    getVersion: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.updater.getVersion),
    onDownloaded: (
      cb: (payload: UpdateDownloadedPayload) => void
    ): (() => void) => {
      const listener = (
        _ev: IpcRendererEvent,
        payload: UpdateDownloadedPayload
      ): void => cb(payload)
      ipcRenderer.on(IPC_CHANNELS.updater.downloaded, listener)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.updater.downloaded, listener)
    },
    onDownloadProgress: (
      cb: (payload: UpdateDownloadProgressPayload) => void
    ): (() => void) => {
      const listener = (
        _ev: IpcRendererEvent,
        payload: UpdateDownloadProgressPayload
      ): void => cb(payload)
      ipcRenderer.on(IPC_CHANNELS.updater.downloadProgress, listener)
      return () =>
        ipcRenderer.removeListener(
          IPC_CHANNELS.updater.downloadProgress,
          listener
        )
    },
    onNotAvailable: (cb: (current: string) => void): (() => void) => {
      const listener = (_ev: IpcRendererEvent, current: string): void => cb(current)
      ipcRenderer.on(IPC_CHANNELS.updater.notAvailable, listener)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.updater.notAvailable, listener)
    },
    onError: (cb: (message: string) => void): (() => void) => {
      const listener = (_ev: IpcRendererEvent, message: string): void => cb(message)
      ipcRenderer.on(IPC_CHANNELS.updater.error, listener)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.updater.error, listener)
    }
  },
  // pptx10 슬라이드 17 — Application Menu(Edit) click → renderer dispatch.
  appMenu: {
    onAction: (cb: (action: string) => void): (() => void) => {
      const listener = (_ev: IpcRendererEvent, action: string): void => cb(action)
      ipcRenderer.on('app-menu:action', listener)
      return () => ipcRenderer.removeListener('app-menu:action', listener)
    }
  },
  // pptx10 슬라이드 13 (확장) — 진짜 별도 BrowserWindow 분리 + state sync.
  previewWindow: {
    openDetached: (): Promise<boolean> => ipcRenderer.invoke('preview:openDetached'),
    closeDetached: (): Promise<boolean> => ipcRenderer.invoke('preview:closeDetached'),
    isDetached: (): Promise<boolean> => ipcRenderer.invoke('preview:isDetached'),
    broadcast: (payload: unknown): void => {
      ipcRenderer.send('preview-sync:broadcast', payload)
    },
    onSyncApply: (cb: (payload: unknown) => void): (() => void) => {
      const listener = (_ev: IpcRendererEvent, payload: unknown): void => cb(payload)
      ipcRenderer.on('preview-sync:apply', listener)
      return () => ipcRenderer.removeListener('preview-sync:apply', listener)
    },
    // Reels 11 슬라이드 13 — OS-level 컨트롤.
    setAlwaysOnTop: (flag: boolean): Promise<boolean> =>
      ipcRenderer.invoke('preview:setAlwaysOnTop', flag),
    minimize: (): Promise<boolean> => ipcRenderer.invoke('preview:minimize'),
    isAlwaysOnTop: (): Promise<boolean> =>
      ipcRenderer.invoke('preview:isAlwaysOnTop')
  }
}

try {
  contextBridge.exposeInMainWorld('electron', api)
} catch (err) {
  console.error('[preload] failed to expose electron api', err)
}
