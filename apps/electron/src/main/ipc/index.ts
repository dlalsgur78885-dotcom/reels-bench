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
import { registerBrandKitHandlers } from './brand-kit'
import { registerCaptionFontHandlers } from './caption-fonts'
import { registerOverlayHandlers } from './overlay'
import { registerPreviewWindowHandlers } from './preview-window'

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
  registerBrandKitHandlers()
  registerCaptionFontHandlers()
  registerOverlayHandlers()
  registerPreviewWindowHandlers()
}
