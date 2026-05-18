import { app, ipcMain } from 'electron'
import { IPC_CHANNELS, type FfmpegRunSpec } from '../../shared/ipc'
import { probeCapabilities } from '../ffmpeg/capabilities'
import {
  cancelFfmpegJob,
  runFfmpegJob,
  shutdownAllJobs
} from '../ffmpeg/runner'

let cleanupRegistered = false

export function registerFfmpegHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ffmpeg.capabilities, async () => {
    return probeCapabilities()
  })

  ipcMain.handle(IPC_CHANNELS.ffmpeg.run, async (_event, spec: FfmpegRunSpec) => {
    return runFfmpegJob(spec)
  })

  ipcMain.handle(IPC_CHANNELS.ffmpeg.cancel, async (_event, jobId: string) => {
    await cancelFfmpegJob(jobId, 'user')
  })

  if (!cleanupRegistered) {
    cleanupRegistered = true
    app.on('before-quit', () => {
      // Best-effort: kill children. We don't await — Electron will quit fast.
      void shutdownAllJobs()
    })
  }
}
