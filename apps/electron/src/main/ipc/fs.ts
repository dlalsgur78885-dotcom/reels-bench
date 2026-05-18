import { BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { IPC_CHANNELS, type FilePickerFilter } from '../../shared/ipc'
import { allowPath } from '../ffmpeg/security'

let lastDir: string | null = null

function rememberDir(p: string): void {
  try {
    lastDir = path.dirname(p)
  } catch {
    // ignore
  }
}

export function registerFsHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.fs.pickFile,
    async (event, filters?: FilePickerFilter[]) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const safeFilters: FilePickerFilter[] = Array.isArray(filters)
        ? filters
            .filter(
              (f): f is FilePickerFilter =>
                !!f &&
                typeof f.name === 'string' &&
                Array.isArray(f.extensions) &&
                f.extensions.every((e) => typeof e === 'string')
            )
            .slice(0, 8)
        : []

      const result = win
        ? await dialog.showOpenDialog(win, {
            properties: ['openFile'],
            filters: safeFilters,
            defaultPath: lastDir ?? undefined
          })
        : await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: safeFilters,
            defaultPath: lastDir ?? undefined
          })

      if (result.canceled || result.filePaths.length === 0) return null
      const picked = result.filePaths[0]
      rememberDir(picked)
      allowPath(picked)
      return picked
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.fs.saveFile,
    async (event, defaultName?: string) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const safeName =
        typeof defaultName === 'string' && /^[\w\-. ]{1,128}$/.test(defaultName)
          ? defaultName
          : 'output.mp4'

      const result = win
        ? await dialog.showSaveDialog(win, {
            defaultPath: lastDir ? path.join(lastDir, safeName) : safeName
          })
        : await dialog.showSaveDialog({
            defaultPath: lastDir ? path.join(lastDir, safeName) : safeName
          })

      if (result.canceled || !result.filePath) return null
      rememberDir(result.filePath)
      allowPath(result.filePath)
      return result.filePath
    }
  )
}
