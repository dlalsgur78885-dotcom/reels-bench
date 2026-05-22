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
  type PickFileOptions,
  type ProgressEvent,
  type SaveRecordingResult,
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
      ipcRenderer.invoke(IPC_CHANNELS.media.readWaveform, waveformPath)
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
      ipcRenderer.invoke(IPC_CHANNELS.captions.parseSrtString, raw)
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
    }
  }
}

try {
  contextBridge.exposeInMainWorld('electron', api)
} catch (err) {
  console.error('[preload] failed to expose electron api', err)
}
