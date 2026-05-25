/**
 * cleanup-supabase — delete stale electron-update artifacts from Supabase
 * Storage (we migrated to GitHub Releases in 0.2.0). The bucket still
 * carries `latest.yml` + a blockmap pointing at .exe paths that aren't
 * uploaded, so 0.1.x clients that hardcode the Supabase publish.url keep
 * 404'ing in the background. Wiping the manifest stops the retry loop.
 *
 * Auto-loads SUPABASE_SERVICE_ROLE_KEY from repo-root .env if not in env.
 * Idempotent: missing objects return 404 from Supabase, which we log and
 * keep going.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

function loadEnvFromFile(p) {
  if (!existsSync(p)) return
  for (const raw of readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}
for (const c of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '..', '.env')
]) loadEnvFromFile(c)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mrpbovbxtablvawszhey.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_KEY) {
  console.error('[cleanup] SUPABASE_SERVICE_ROLE_KEY not set.')
  process.exit(1)
}

const BUCKET = 'electron-releases'
// Explicit allow-list — only files this script may touch. No wildcards,
// no recursion. Keeps blast radius tiny.
const TARGETS = [
  'win/latest.yml',
  'win/Reels Studio Setup 0.2.0.exe.blockmap'
]

async function del(key) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(key)}`
  const r = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY
    }
  })
  const txt = await r.text().catch(() => '')
  return { status: r.status, body: txt.slice(0, 200) }
}

console.log(`[cleanup] deleting ${TARGETS.length} stale object(s) from ${BUCKET}`)
for (const t of TARGETS) {
  try {
    const { status, body } = await del(t)
    const tag = status === 200 ? '✓' : status === 404 ? '○ (already gone)' : '✗'
    console.log(`  ${tag} [${status}] ${t} ${body && status !== 200 ? '→ ' + body : ''}`)
  } catch (err) {
    console.error(`  ✗ ${t}: ${err.message}`)
    process.exitCode = 1
  }
}
console.log('[cleanup] done.')
