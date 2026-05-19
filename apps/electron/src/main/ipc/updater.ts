/**
 * Phase 4.7 — updater IPC handlers.
 *
 * Only one invoke channel: `updater:installNow`. Push events
 * (`updater:downloaded`, `updater:download-progress`) are sent from
 * `auto-update.ts` directly via `webContents.send`.
 */
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import { installUpdate } from '../auto-update'

export function registerUpdaterHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.updater.installNow, async (): Promise<boolean> => {
    return installUpdate()
  })
}
