import { registerFfmpegHandlers } from './ffmpeg'
import { registerFsHandlers } from './fs'
import { registerAuthHandlers } from './auth'
import { registerMediaHandlers } from './media'
import { registerCaptionHandlers } from './captions'

export function registerIpcHandlers(): void {
  registerFfmpegHandlers()
  registerFsHandlers()
  registerMediaHandlers()
  registerAuthHandlers()
  registerCaptionHandlers()
}
