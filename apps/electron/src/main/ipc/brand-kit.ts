/**
 * Brand Kit — app-level brand assets (logo + colors + font), Spec section 3.
 *
 * Stored OUTSIDE project data, at `userData/brand-kit.json`, so the kit is
 * shared across every project. Logo image files are copied into
 * `userData/brand/` under MAIN-COMPUTED filenames — the renderer never gets to
 * pick a destination path.
 *
 * Persistence model:
 *   - `brand-kit.json` holds the small JSON manifest (version, logos, colors,
 *     fontFamily). It is written atomically (tmp + rename — mirrors the
 *     project.json write in fs.ts).
 *   - `brandKit:write` is a READ-MERGE-WRITE: it accepts ONLY colors +
 *     fontFamily and never touches `logos`, which are mutated solely via
 *     `importLogo` / `removeLogo`.
 *
 * Security:
 *   - Every IPC input is validated at the boundary (typeof / length / enum).
 *   - `importLogo` source path is run through `assertPathAllowed(p,'input')`.
 *   - Copied logo files are `allowPath`-ed so the standard media:// / export
 *     read paths accept them (also re-allowed on read, post-restart).
 *   - importLogo NEVER throws across IPC — all failures return {ok:false}.
 *
 * SVG logos are NOT accepted: `overlays/render.ts` only rasterizes SVG for the
 * built-in shape overlays via Sharp; there is no code path that rasterizes a
 * user-supplied SVG logo file, and ffmpeg's `overlay` filter cannot consume
 * SVG. Allowed set is raster-only: png / jpg / jpeg / webp.
 */
import { app, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import {
  IPC_CHANNELS,
  type BrandKit,
  type BrandKitImportLogoResult,
  type BrandKitWriteInput,
  type BrandLogo,
  type BrandLogoVariant
} from '../../shared/ipc'
import { allowPath, assertPathAllowed } from '../ffmpeg/security'

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/** Hard cap on a single imported logo image (~20 MB). */
const MAX_LOGO_BYTES = 20 * 1024 * 1024

/** Max number of brand colors kept (rest dropped). */
const MAX_COLORS = 24

/** Raster-only image extensions accepted for a logo (see file header re: SVG). */
const ALLOWED_LOGO_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/** Valid logo variants. */
const VARIANTS: ReadonlyArray<BrandLogoVariant> = ['light', 'dark']

/**
 * Conservative font-family-name pattern: letters / digits / spaces and the
 * punctuation a CSS font stack legitimately uses (`-`, `,`, quotes). No
 * angle brackets, braces, semicolons, etc. — keeps a hostile string from
 * later being interpolated somewhere unsafe.
 */
const FONT_NAME_RE = /^[A-Za-z0-9 ,_'"-]{1,128}$/

// ---------------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------------

function brandKitFilePath(): string {
  return path.join(app.getPath('userData'), 'brand-kit.json')
}

function brandDir(): string {
  return path.join(app.getPath('userData'), 'brand')
}

function defaultKit(): BrandKit {
  return { version: 1, logos: [], colors: [] }
}

// ---------------------------------------------------------------------------
// Sanitizers.
// ---------------------------------------------------------------------------

/**
 * Normalise one untrusted color string to a lowercase `#rrggbb`, expanding the
 * `#rgb` short form. Returns null when the value is not a valid hex color.
 */
function sanitizeColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(v)) return v
  if (/^#[0-9a-f]{3}$/.test(v)) {
    // Expand #rgb → #rrggbb.
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
  }
  return null
}

/** Sanitize an array of colors: drop invalid, dedupe, cap at MAX_COLORS. */
function sanitizeColors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const c = sanitizeColor(item)
    if (!c || seen.has(c)) continue
    seen.add(c)
    out.push(c)
    if (out.length >= MAX_COLORS) break
  }
  return out
}

/** Validate an optional font family name; returns undefined when invalid/absent. */
function sanitizeFontFamily(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim()
  if (v.length === 0 || v.length > 128) return undefined
  return FONT_NAME_RE.test(v) ? v : undefined
}

/**
 * Validate one logo entry coming from `brand-kit.json` on disk. Drops the
 * entry when the variant is unknown OR the backing file no longer exists.
 */
function sanitizeLogo(raw: unknown): BrandLogo | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.variant !== 'light' && r.variant !== 'dark') return null
  if (typeof r.path !== 'string' || r.path.length === 0) return null
  // Drop dead links — file removed out from under us.
  if (!existsSync(r.path)) return null
  const nw = Number(r.naturalWidth)
  const nh = Number(r.naturalHeight)
  return {
    variant: r.variant,
    path: r.path,
    naturalWidth: Number.isFinite(nw) && nw >= 0 ? nw : 0,
    naturalHeight: Number.isFinite(nh) && nh >= 0 ? nh : 0
  }
}

/**
 * Defensively validate a parsed `brand-kit.json` object into a clean BrandKit:
 * drop unknown fields, keep one logo per variant, sanitize colors + font.
 */
function sanitizeKit(raw: unknown): BrandKit {
  if (!raw || typeof raw !== 'object') return defaultKit()
  const r = raw as Record<string, unknown>

  const logos: BrandLogo[] = []
  const seenVariants = new Set<BrandLogoVariant>()
  if (Array.isArray(r.logos)) {
    for (const item of r.logos) {
      const logo = sanitizeLogo(item)
      if (!logo || seenVariants.has(logo.variant)) continue
      seenVariants.add(logo.variant)
      logos.push(logo)
    }
  }

  const kit: BrandKit = {
    version: 1,
    logos,
    colors: sanitizeColors(r.colors)
  }
  const font = sanitizeFontFamily(r.fontFamily)
  if (font) kit.fontFamily = font
  return kit
}

// ---------------------------------------------------------------------------
// Read / write helpers.
// ---------------------------------------------------------------------------

/**
 * Load + sanitize the kit from disk. On ENOENT / parse error returns the empty
 * default. `allowPath`s every surviving logo path so media:// / export reads
 * accept it after an app restart.
 */
async function loadKit(): Promise<BrandKit> {
  let kit: BrandKit
  try {
    const raw = await readFile(brandKitFilePath(), 'utf-8')
    kit = sanitizeKit(JSON.parse(raw))
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      console.warn('[brand-kit] read/parse failed — using default:', err)
    }
    kit = defaultKit()
  }
  for (const logo of kit.logos) allowPath(logo.path)
  return kit
}

/** Atomic write — tmp file then rename. Mirrors the project.json write in fs.ts. */
async function saveKit(kit: BrandKit): Promise<void> {
  const target = brandKitFilePath()
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify(kit, null, 2), 'utf-8')
  await rename(tmp, target)
}

// ---------------------------------------------------------------------------
// Logo image dimension probe — spawns the bundled ffprobe (same binary the
// media.ts probe uses). Best-effort: returns 0/0 on any failure so a logo
// import is never blocked by a probe hiccup.
// ---------------------------------------------------------------------------

function resolveFfprobePath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const installer = require('@ffprobe-installer/ffprobe') as { path: string }
  let p = installer.path
  if (app.isPackaged) {
    const replaced = p.replace(
      /(.*?)[\\/]app\.asar[\\/](.*)/,
      (_match, root: string, rest: string) =>
        path.join(root, 'app.asar.unpacked', rest)
    )
    if (replaced !== p && existsSync(replaced)) {
      p = replaced
    } else if (!existsSync(p)) {
      const guess = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        '@ffprobe-installer',
        `${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
      )
      if (existsSync(guess)) p = guess
    }
  }
  if (!existsSync(p)) {
    throw new Error(`[brand-kit] ffprobe binary not found at ${p}`)
  }
  return p
}

interface ImageDimensions {
  naturalWidth: number
  naturalHeight: number
}

/** Probe an image file for its pixel dimensions. Returns 0/0 on any failure. */
function probeImageDimensions(filePath: string): Promise<ImageDimensions> {
  return new Promise((resolve) => {
    const fallback: ImageDimensions = { naturalWidth: 0, naturalHeight: 0 }
    let bin: string
    try {
      bin = resolveFfprobePath()
    } catch (err) {
      console.warn('[brand-kit] ffprobe unavailable:', err)
      resolve(fallback)
      return
    }
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      filePath
    ]
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    const STDOUT_LIMIT = 1 * 1024 * 1024
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      resolve(fallback)
    }, 15_000)
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > STDOUT_LIMIT) {
        clearTimeout(timer)
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        resolve(fallback)
      }
    })
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(fallback)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve(fallback)
        return
      }
      try {
        const json = JSON.parse(stdout) as {
          streams?: Array<{ codec_type?: string; width?: number; height?: number }>
        }
        const streams = Array.isArray(json.streams) ? json.streams : []
        const vid = streams.find((s) => s.codec_type === 'video') ?? streams[0]
        const w = Number(vid?.width)
        const h = Number(vid?.height)
        resolve({
          naturalWidth: Number.isFinite(w) && w > 0 ? w : 0,
          naturalHeight: Number.isFinite(h) && h > 0 ? h : 0
        })
      } catch {
        resolve(fallback)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// IPC registration.
// ---------------------------------------------------------------------------

export function registerBrandKitHandlers(): void {
  // --- read ----------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.brandKit.read, async (): Promise<BrandKit> => {
    return loadKit()
  })

  // --- write (colors + fontFamily ONLY; logos preserved) -------------------
  ipcMain.handle(
    IPC_CHANNELS.brandKit.write,
    async (_event, rawInput: unknown): Promise<void> => {
      if (!rawInput || typeof rawInput !== 'object') {
        throw new Error('[brand-kit] write: invalid input')
      }
      const input = rawInput as Partial<BrandKitWriteInput>
      if (!Array.isArray(input.colors)) {
        throw new Error('[brand-kit] write: colors must be an array')
      }
      const colors = sanitizeColors(input.colors)
      const fontFamily = sanitizeFontFamily(input.fontFamily)

      // READ-MERGE-WRITE: keep existing logos untouched.
      const existing = await loadKit()
      const next: BrandKit = {
        version: 1,
        logos: existing.logos,
        colors
      }
      if (fontFamily) next.fontFamily = fontFamily
      await saveKit(next)
    }
  )

  // --- importLogo ----------------------------------------------------------
  ipcMain.handle(
    IPC_CHANNELS.brandKit.importLogo,
    async (
      _event,
      rawVariant: unknown,
      rawSourcePath: unknown
    ): Promise<BrandKitImportLogoResult> => {
      try {
        // Boundary validation: variant enum.
        if (
          typeof rawVariant !== 'string' ||
          (rawVariant !== 'light' && rawVariant !== 'dark')
        ) {
          return { ok: false, error: 'invalid_variant' }
        }
        const variant: BrandLogoVariant = rawVariant

        // Boundary validation: source path is a non-empty bounded string.
        if (
          typeof rawSourcePath !== 'string' ||
          rawSourcePath.length === 0 ||
          rawSourcePath.length > 4096
        ) {
          return { ok: false, error: 'invalid_source_path' }
        }

        // Must be inside an allowed root and exist on disk.
        let sourcePath: string
        try {
          sourcePath = assertPathAllowed(rawSourcePath, 'input')
        } catch {
          return { ok: false, error: 'source_not_allowed' }
        }

        // Extension allow-list (raster only — SVG rejected; see file header).
        const ext = path.extname(sourcePath).toLowerCase()
        if (!ALLOWED_LOGO_EXTS.has(ext)) {
          return { ok: false, error: 'unsupported_image_type' }
        }

        // Size cap.
        let srcStat
        try {
          srcStat = await stat(sourcePath)
        } catch {
          return { ok: false, error: 'source_unreadable' }
        }
        if (!srcStat.isFile()) {
          return { ok: false, error: 'source_not_a_file' }
        }
        if (srcStat.size === 0) {
          return { ok: false, error: 'source_empty' }
        }
        if (srcStat.size > MAX_LOGO_BYTES) {
          return { ok: false, error: 'logo_too_large' }
        }

        // Copy (not move) to a MAIN-COMPUTED filename inside userData/brand/.
        const dir = brandDir()
        await mkdir(dir, { recursive: true })
        const destName = `logo-${variant}-${Date.now()}${ext}`
        const destPath = path.join(dir, destName)
        await copyFile(sourcePath, destPath)

        // Probe dimensions (best-effort; 0/0 on failure).
        const dims = await probeImageDimensions(destPath)

        // Allowlist the copied file for media:// / export reads.
        allowPath(destPath)

        const logo: BrandLogo = {
          variant,
          path: destPath,
          naturalWidth: dims.naturalWidth,
          naturalHeight: dims.naturalHeight
        }

        // READ-MERGE-WRITE: replace any existing entry for this variant.
        const existing = await loadKit()
        const oldEntry = existing.logos.find((l) => l.variant === variant)
        const logos = existing.logos.filter((l) => l.variant !== variant)
        logos.push(logo)
        const next: BrandKit = {
          version: 1,
          logos,
          colors: existing.colors
        }
        if (existing.fontFamily) next.fontFamily = existing.fontFamily
        await saveKit(next)

        // Best-effort cleanup of the previous logo file (if path differs).
        if (oldEntry && oldEntry.path !== destPath) {
          try {
            await unlink(oldEntry.path)
          } catch {
            /* ignore — file may already be gone */
          }
        }

        return { ok: true, logo }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  // --- removeLogo ----------------------------------------------------------
  ipcMain.handle(
    IPC_CHANNELS.brandKit.removeLogo,
    async (_event, rawVariant: unknown): Promise<BrandKit> => {
      if (
        typeof rawVariant !== 'string' ||
        (rawVariant !== 'light' && rawVariant !== 'dark')
      ) {
        throw new Error('[brand-kit] removeLogo: invalid variant')
      }
      const variant: BrandLogoVariant = rawVariant

      const existing = await loadKit()
      const removed = existing.logos.find((l) => l.variant === variant)
      const logos = existing.logos.filter((l) => l.variant !== variant)
      const next: BrandKit = {
        version: 1,
        logos,
        colors: existing.colors
      }
      if (existing.fontFamily) next.fontFamily = existing.fontFamily
      await saveKit(next)

      // Best-effort delete of the backing file.
      if (removed) {
        try {
          await unlink(removed.path)
        } catch {
          /* ignore — file may already be gone */
        }
      }
      return next
    }
  )
}
