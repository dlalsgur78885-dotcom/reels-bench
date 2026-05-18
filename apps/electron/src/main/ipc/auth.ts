import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'

// TODO(agent: auth-deeplink-engineer): implement reels-studio:// protocol
// registration via app.setAsDefaultProtocolClient, parse callback URL,
// and emit token to renderer via webContents.send(IPC_CHANNELS.auth.tokenReceived, token).

export function registerAuthHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.auth.startDeeplinkFlow, async () => {
    throw new Error('Not implemented — handled by phase 1/2 agents')
  })
}
