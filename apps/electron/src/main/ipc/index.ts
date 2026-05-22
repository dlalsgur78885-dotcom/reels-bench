import { registerFfmpegHandlers } from './ffmpeg'
import { registerFsHandlers } from './fs'
import { registerAuthHandlers } from './auth'
import { registerMediaHandlers } from './media'
import { registerCaptionHandlers } from './captions'
import { registerAudioHandlers } from './audio'
import { registerExportHandlers } from './export'
import { registerDownloadHandlers } from './download'
import { registerUpdaterHandlers } from './updater'
import { registerSttHandlers } from './stt'
import { registerRecordingHandlers } from './recording'

export function registerIpcHandlers(): void {
  registerFfmpegHandlers()
  registerFsHandlers()
  registerMediaHandlers()
  registerAuthHandlers()
  registerCaptionHandlers()
  registerAudioHandlers()
  registerExportHandlers()
  registerDownloadHandlers()
  registerUpdaterHandlers()
  registerSttHandlers()
  registerRecordingHandlers()
}
