import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  IPC_CHANNELS,
  type FilePickerFilter,
  type PickFileOptions,
  type ProjectListItem
} from '../../shared/ipc'
import type { Project } from '../../shared/project'
import { allowPath } from '../ffmpeg/security'

let lastDir: string | null = null

function rememberDir(p: string): void {
  try {
    lastDir = path.dirname(p)
  } catch {
    // ignore
  }
}

function sanitizeFilters(filters: unknown): FilePickerFilter[] {
  if (!Array.isArray(filters)) return []
  return filters
    .filter(
      (f): f is FilePickerFilter =>
        !!f &&
        typeof (f as FilePickerFilter).name === 'string' &&
        Array.isArray((f as FilePickerFilter).extensions) &&
        (f as FilePickerFilter).extensions.every((e) => typeof e === 'string')
    )
    .slice(0, 8)
}

function projectFilePath(): string {
  return path.join(app.getPath('userData'), 'project.json')
}

function projectsDir(): string {
  return path.join(app.getPath('userData'), 'projects')
}

function projectArchivePath(projectId: string): string {
  return path.join(projectsDir(), `${projectId}.json`)
}

function isSafeProjectId(projectId: unknown): projectId is string {
  return typeof projectId === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(projectId)
}

function allowProjectMedia(project: Project): void {
  if (project.media && typeof project.media === 'object') {
    for (const asset of Object.values(project.media)) {
      if (asset && typeof asset.path === 'string') allowPath(asset.path)
      if (asset && typeof asset.thumbnailPath === 'string') {
        allowPath(asset.thumbnailPath)
      }
    }
  }
}

function projectSummary(project: Project): ProjectListItem {
  let clipCount = 0
  let captionCount = 0
  for (const t of project.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (c.kind === 'caption') captionCount += 1
      else clipCount += 1
    }
  }
  return {
    id: project.id,
    name: project.name || '제목 없는 프로젝트',
    aspectRatio: project.aspectRatio,
    updatedAt:
      typeof project.updatedAt === 'number' && Number.isFinite(project.updatedAt)
        ? project.updatedAt
        : 0,
    clipCount,
    captionCount
  }
}

async function writeProjectArchive(project: Project): Promise<void> {
  if (!project || typeof project !== 'object' || !isSafeProjectId(project.id)) {
    throw new Error('[fs] archiveProject: invalid project payload')
  }
  const target = projectArchivePath(project.id)
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify(project, null, 2), 'utf-8')
  await rename(tmp, target)
}

async function readProjectFromPath(filePath: string): Promise<Project | null> {
  const raw = await readFile(filePath, 'utf-8')
  const parsed = JSON.parse(raw) as Project
  if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
    return null
  }
  allowProjectMedia(parsed)
  return parsed
}

export function registerFsHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.fs.pickFile,
    async (event, filters?: FilePickerFilter[]) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const safeFilters = sanitizeFilters(filters)

      const opts = {
        properties: ['openFile'] as Array<'openFile'>,
        filters: safeFilters,
        defaultPath: lastDir ?? undefined
      }

      const result = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts)

      if (result.canceled || result.filePaths.length === 0) return null
      const picked = result.filePaths[0]
      rememberDir(picked)
      allowPath(picked)
      return picked
    }
  )

  // New: multi-select aware variant. Always returns string[] (possibly empty).
  ipcMain.handle(
    IPC_CHANNELS.fs.pickFile + ':multi',
    async (event, options?: PickFileOptions) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const safeFilters = sanitizeFilters(options?.filters)
      const multi = Boolean(options?.multi)

      const properties: Array<'openFile' | 'multiSelections'> = ['openFile']
      if (multi) properties.push('multiSelections')

      const opts = {
        properties,
        filters: safeFilters,
        defaultPath: lastDir ?? undefined
      }

      const result = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts)

      if (result.canceled || result.filePaths.length === 0) return []
      const picked = result.filePaths.slice(0, 64) // cap
      rememberDir(picked[0])
      for (const p of picked) allowPath(p)
      return picked
    }
  )

  // Pick an existing directory (Phase 3.20 batch export). Returns the picked
  // directory path, or null when the dialog is cancelled.
  ipcMain.handle(IPC_CHANNELS.fs.pickDirectory, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined

    const opts = {
      properties: ['openDirectory', 'createDirectory'] as Array<
        'openDirectory' | 'createDirectory'
      >,
      defaultPath: lastDir ?? undefined
    }

    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)

    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]
    // A directory pick must remember *itself*, not its parent — so set lastDir
    // directly instead of routing through rememberDir (which does path.dirname).
    lastDir = dir
    // Allow-list the directory so batch export's auto-named child files
    // (`<dir>/<name>.mp4`) pass the path-allow check inside runExport — the
    // security model allow-lists directory prefixes (see isPathAllowed).
    allowPath(dir)
    return dir
  })

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

  // --- Project persistence -------------------------------------------------
  // Stored at userData/project.json (which is in the allowed-roots tree).
  ipcMain.handle(IPC_CHANNELS.fs.readProject, async () => {
    try {
      return await readProjectFromPath(projectFilePath())
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return null
      console.error('[fs] readProject failed', err)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.fs.readProjectById, async (_event, projectId: unknown) => {
    if (!isSafeProjectId(projectId)) return null
    try {
      return await readProjectFromPath(projectArchivePath(projectId))
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return null
      console.error('[fs] readProjectById failed', err)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.fs.writeProject, async (_event, project: Project) => {
    if (!project || typeof project !== 'object' || typeof project.id !== 'string') {
      throw new Error('[fs] writeProject: invalid project payload')
    }
    const target = projectFilePath()
    const dir = path.dirname(target)
    await mkdir(dir, { recursive: true })
    // Atomic write — write to a sibling tmp file then rename.
    const tmp = target + '.tmp'
    await writeFile(tmp, JSON.stringify(project, null, 2), 'utf-8')
    await rename(tmp, target)
    await writeProjectArchive(project)
  })

  ipcMain.handle(IPC_CHANNELS.fs.archiveProject, async (_event, project: Project) => {
    await writeProjectArchive(project)
  })

  ipcMain.handle(IPC_CHANNELS.fs.listProjects, async () => {
    const found = new Map<string, ProjectListItem>()
    const ingest = async (filePath: string): Promise<void> => {
      try {
        const project = await readProjectFromPath(filePath)
        if (project && isSafeProjectId(project.id)) {
          found.set(project.id, projectSummary(project))
        }
      } catch {
        // Ignore corrupt project snapshots; the active project reader handles
        // its own diagnostics.
      }
    }

    await ingest(projectFilePath())
    try {
      const files = await readdir(projectsDir(), { withFileTypes: true })
      await Promise.all(
        files
          .filter((f) => f.isFile() && f.name.endsWith('.json'))
          .slice(0, 500)
          .map((f) => ingest(path.join(projectsDir(), f.name)))
      )
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') console.error('[fs] listProjects failed', err)
    }
    return Array.from(found.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  })

  // Drag-and-drop allowlist: renderer extracts a path via webUtils and asks
  // the main process to mark it allowed before any ffmpeg/probe IO.
  ipcMain.handle(IPC_CHANNELS.fs.allowPath, async (_event, p: unknown) => {
    if (typeof p !== 'string' || p.length === 0 || p.length > 4096) {
      throw new Error('[fs] allowPath: bad path')
    }
    allowPath(p)
  })
}
