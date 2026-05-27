import { app, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  IPC_CHANNELS,
  type CaptionFontImportResult,
  type CustomCaptionFont
} from '../../shared/ipc'
import { allowPath, assertPathAllowed } from '../ffmpeg/security'

const MAX_FONT_BYTES = 30 * 1024 * 1024
const ALLOWED_FONT_EXTS = new Set(['.otf', '.ttf', '.woff', '.woff2'])

function fontsDir(): string {
  return path.join(app.getPath('userData'), 'caption-fonts')
}

function manifestPath(): string {
  return path.join(app.getPath('userData'), 'caption-fonts.json')
}

function fontFormat(ext: string): CustomCaptionFont['format'] | null {
  switch (ext.toLowerCase()) {
    case '.otf':
      return 'opentype'
    case '.ttf':
      return 'truetype'
    case '.woff':
      return 'woff'
    case '.woff2':
      return 'woff2'
    default:
      return null
  }
}

function sanitizeLabel(raw: string): string {
  const stem = path.basename(raw, path.extname(raw)).trim()
  const cleaned = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 80) || '사용자 폰트'
}

function sanitizeManifest(raw: unknown): CustomCaptionFont[] {
  if (!Array.isArray(raw)) return []
  const out: CustomCaptionFont[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.id !== 'string' || !/^custom:[a-f0-9]{12,32}$/.test(r.id)) continue
    if (typeof r.label !== 'string' || r.label.trim().length === 0) continue
    if (typeof r.familyName !== 'string' || !/^ReelsCustomFont_[a-f0-9]{12,32}$/.test(r.familyName)) continue
    if (typeof r.path !== 'string' || !existsSync(r.path)) continue
    const ext = path.extname(r.path).toLowerCase()
    const format = fontFormat(ext)
    if (!format || r.format !== format) continue
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({
      id: r.id as `custom:${string}`,
      label: r.label.slice(0, 80),
      familyName: r.familyName,
      path: r.path,
      format,
      importedAt: Number.isFinite(Number(r.importedAt)) ? Number(r.importedAt) : 0
    })
  }
  return out.slice(0, 100)
}

async function loadFonts(): Promise<CustomCaptionFont[]> {
  try {
    const raw = await readFile(manifestPath(), 'utf-8')
    const fonts = sanitizeManifest(JSON.parse(raw))
    for (const font of fonts) allowPath(font.path)
    return fonts
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') console.warn('[caption-fonts] read failed:', err)
    return []
  }
}

async function saveFonts(fonts: CustomCaptionFont[]): Promise<void> {
  const target = manifestPath()
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify(fonts, null, 2), 'utf-8')
  await rename(tmp, target)
}

export function registerCaptionFontHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.captionFonts.list, async (): Promise<CustomCaptionFont[]> => {
    return loadFonts()
  })

  ipcMain.handle(
    IPC_CHANNELS.captionFonts.importFont,
    async (_event, sourcePath: unknown): Promise<CaptionFontImportResult> => {
      try {
        if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
          return { ok: false, error: 'bad-path' }
        }
        assertPathAllowed(sourcePath, 'input')
        const ext = path.extname(sourcePath).toLowerCase()
        const format = fontFormat(ext)
        if (!format || !ALLOWED_FONT_EXTS.has(ext)) {
          return { ok: false, error: 'unsupported-font' }
        }
        const st = await stat(sourcePath)
        if (!st.isFile()) return { ok: false, error: 'not-file' }
        if (st.size <= 0 || st.size > MAX_FONT_BYTES) {
          return { ok: false, error: 'font-too-large' }
        }
        const seed = `${path.resolve(sourcePath).toLowerCase()}|${st.size}|${Math.floor(st.mtimeMs)}`
        const hash = createHash('sha256').update(seed).digest('hex').slice(0, 16)
        const id = `custom:${hash}` as const
        const familyName = `ReelsCustomFont_${hash}`
        const fileName = `${hash}${ext}`
        const destPath = path.join(fontsDir(), fileName)
        await mkdir(fontsDir(), { recursive: true })

        const fonts = await loadFonts()
        const existing = fonts.find((f) => f.id === id)
        if (existing && existsSync(existing.path)) {
          allowPath(existing.path)
          return { ok: true, font: existing, reused: true }
        }

        await copyFile(sourcePath, destPath)
        allowPath(destPath)
        const font: CustomCaptionFont = {
          id,
          label: sanitizeLabel(sourcePath),
          familyName,
          path: destPath,
          format,
          importedAt: Date.now()
        }
        await saveFonts([...fonts.filter((f) => f.id !== id), font])
        return { ok: true, font, reused: false }
      } catch (err) {
        console.error('[caption-fonts] import failed', err)
        return { ok: false, error: 'import-failed' }
      }
    }
  )
}
