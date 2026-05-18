import { app } from 'electron'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const allowedRoots = new Set<string>()
const dynamicAllowedFiles = new Map<string, number>()

const DYNAMIC_TTL_MS = 30 * 60 * 1000
const DYNAMIC_MAX_ENTRIES = 64

function addRoot(p: string | undefined): void {
  if (!p) return
  try {
    allowedRoots.add(path.resolve(p))
  } catch {
    // ignore
  }
}

let initialized = false
function ensureInitialized(): void {
  if (initialized) return
  initialized = true
  addRoot(app.getPath('userData'))
  addRoot(app.getPath('temp'))
  addRoot(os.tmpdir())
}

function pruneExpired(): void {
  const now = Date.now()
  for (const [p, expiresAt] of dynamicAllowedFiles) {
    if (expiresAt <= now) dynamicAllowedFiles.delete(p)
  }
}

/**
 * Register a dialog-picked path as allowed for ffmpeg I/O. Entry auto-expires
 * after DYNAMIC_TTL_MS; oldest entry evicted when the set exceeds the cap.
 */
export function allowPath(p: string): void {
  ensureInitialized()
  let resolved: string
  try {
    resolved = path.resolve(p)
  } catch {
    return
  }
  pruneExpired()
  if (
    !dynamicAllowedFiles.has(resolved) &&
    dynamicAllowedFiles.size >= DYNAMIC_MAX_ENTRIES
  ) {
    let oldestKey: string | null = null
    let oldestExp = Number.POSITIVE_INFINITY
    for (const [k, exp] of dynamicAllowedFiles) {
      if (exp < oldestExp) {
        oldestExp = exp
        oldestKey = k
      }
    }
    if (oldestKey) dynamicAllowedFiles.delete(oldestKey)
  }
  dynamicAllowedFiles.set(resolved, Date.now() + DYNAMIC_TTL_MS)
}

export function isPathAllowed(p: string): boolean {
  ensureInitialized()
  pruneExpired()
  let resolved: string
  try {
    resolved = path.resolve(p)
  } catch {
    return false
  }
  if (dynamicAllowedFiles.has(resolved)) return true
  for (const root of allowedRoots) {
    if (resolved === root) return true
    if (resolved.startsWith(root + path.sep)) return true
  }
  return false
}

export function assertPathAllowed(p: string, role: 'input' | 'output'): string {
  const resolved = path.resolve(p)
  if (!isPathAllowed(resolved)) {
    throw new Error(`[ffmpeg] ${role} path not in allowed roots: ${resolved}`)
  }
  if (role === 'input' && !existsSync(resolved)) {
    throw new Error(`[ffmpeg] input file does not exist: ${resolved}`)
  }
  return resolved
}

export function validateFilterGraph(g: string): string {
  if (g.length > 4096) throw new Error('[ffmpeg] filterGraph too long')
  if (!/^[\w\s=,:.[\]\-+*@/\\%']+$/.test(g)) {
    throw new Error('[ffmpeg] filterGraph contains disallowed characters')
  }
  return g
}

const SAFE_EXTRA_FLAGS = new Set<string>([
  '-r',
  '-pix_fmt',
  '-g',
  '-keyint_min',
  '-b:v',
  '-maxrate',
  '-bufsize',
  '-profile:v',
  '-level',
  '-movflags',
  '-shortest',
  '-an',
  '-vn',
  '-sn',
  '-map_metadata',
  '-tune',
  '-rc',
  '-cq'
])

export function validateExtraArgs(args: string[] | undefined): string[] {
  if (!args || args.length === 0) return []
  if (args.length > 32) throw new Error('[ffmpeg] too many extraArgs')
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (typeof arg !== 'string') throw new Error('[ffmpeg] extraArgs must be strings')
    if (arg.length > 256) throw new Error('[ffmpeg] extraArg too long')
    if (/[`$|;&<>\n\r]/.test(arg)) throw new Error('[ffmpeg] extraArg has metachar')
    if (arg.startsWith('-')) {
      if (!SAFE_EXTRA_FLAGS.has(arg)) {
        throw new Error(`[ffmpeg] extraArg flag not allowed: ${arg}`)
      }
      out.push(arg)
    } else {
      out.push(arg)
    }
  }
  return out
}
