/**
 * Phase 4.7 — updater IPC handlers.
 *
 * Invoke channels:
 *   - `updater:installNow` → restart + install the downloaded build
 *   - `updater:checkNow`   → manual "지금 업데이트 확인" trigger
 *   - `updater:getVersion` → app.getVersion() for 설정/About display
 *
 * Push events (`updater:downloaded`, `updater:download-progress`,
 * `updater:not-available`, `updater:error`) are sent from `auto-update.ts`
 * directly via `webContents.send`.
 */
import { app, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import { checkForUpdateNow, installUpdate } from '../auto-update'

export function registerUpdaterHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.updater.installNow, async (): Promise<boolean> => {
    return installUpdate()
  })
  ipcMain.handle(IPC_CHANNELS.updater.checkNow, async () => {
    return checkForUpdateNow()
  })
  ipcMain.handle(IPC_CHANNELS.updater.getVersion, async (): Promise<string> => {
    return app.getVersion()
  })
}
