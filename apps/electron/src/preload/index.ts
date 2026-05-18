import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent
} from 'electron'
import {
  IPC_CHANNELS,
  type ElectronApi,
  type FfmpegCapabilities,
  type FfmpegRunSpec,
  type FilePickerFilter,
  type JobResult,
  type ParsedCaptionCue,
  type PickFileOptions,
  type ProgressEvent
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
      ipcRenderer.invoke(IPC_CHANNELS.media.readThumbnail, thumbnailPath)
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
  }
}

try {
  contextBridge.exposeInMainWorld('electron', api)
} catch (err) {
  console.error('[preload] failed to expose electron api', err)
}
