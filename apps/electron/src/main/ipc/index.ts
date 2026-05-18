import { registerFfmpegHandlers } from './ffmpeg'
import { registerFsHandlers } from './fs'
import { registerAuthHandlers } from './auth'

export function registerIpcHandlers(): void {
  registerFfmpegHandlers()
  registerFsHandlers()
  registerAuthHandlers()
}
