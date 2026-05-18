import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type ElectronApi,
  type FfmpegCapabilities,
  type FfmpegRunSpec,
  type FilePickerFilter,
  type JobResult,
  type ProgressEvent
} from '../shared/ipc'

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
    saveFile: (defaultName?: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.saveFile, defaultName)
  },
  auth: {
    startDeeplinkFlow: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.auth.startDeeplinkFlow),
    onTokenReceived: (cb: (token: string) => void): (() => void) => {
      const listener = (_ev: IpcRendererEvent, token: string): void => cb(token)
      ipcRenderer.on(IPC_CHANNELS.auth.tokenReceived, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.auth.tokenReceived, listener)
    }
  }
}

try {
  contextBridge.exposeInMainWorld('electron', api)
} catch (err) {
  console.error('[preload] failed to expose electron api', err)
}
