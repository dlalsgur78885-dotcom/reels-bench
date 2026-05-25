/**
 * publish-supabase — upload electron-builder artifacts to Supabase Storage.
 *
 * Source: `apps/electron/release/` after `npm run package`.
 *   - `Reels Studio Setup <ver>.exe`   ← NSIS installer
 *   - `Reels Studio-<ver>-portable.exe` ← portable build
 *   - `latest.yml`                     ← electron-updater manifest
 *   - `*.blockmap`                     ← differential update map
 *
 * Destination: Supabase Storage bucket `electron-releases`, key prefix
 * `win/` so it matches `electron-builder.json`'s publish.url:
 *   https://<project>.supabase.co/storage/v1/object/public/electron-releases/win/<file>
 *
 * Auth: requires `SUPABASE_SERVICE_ROLE_KEY` in the environment (loaded
 * from repo-root .env if present). Service role is needed for Storage
 * uploads — anon/publishable can only read.
 *
 * Usage:
 *   cd apps/electron
 *   npm run publish:supabase
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mrpbovbxtablvawszhey.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BUCKET = 'electron-releases'
const KEY_PREFIX = 'win/'
const RELEASE_DIR = path.resolve(process.cwd(), 'release')

if (!SERVICE_KEY) {
  console.error(
    '[publish] SUPABASE_SERVICE_ROLE_KEY not set. Add it to apps/electron/.env or export it before running.'
  )
  process.exit(1)
}

// What to upload. NSIS exes, portable exes, latest.yml, blockmaps.
const PATTERNS = [
  /\.exe$/i,
  /^latest\.yml$/i,
  /\.blockmap$/i
]

function listArtifacts() {
  let entries
  try {
    entries = readdirSync(RELEASE_DIR)
  } catch (err) {
    console.error(`[publish] cannot read ${RELEASE_DIR} — did 'npm run package' succeed?`)
    process.exit(1)
  }
  return entries
    .filter((name) => PATTERNS.some((re) => re.test(name)))
    .map((name) => path.join(RELEASE_DIR, name))
    .filter((p) => statSync(p).isFile())
}

function contentType(p) {
  if (p.endsWith('.exe')) return 'application/octet-stream'
  if (p.endsWith('.yml')) return 'text/yaml'
  if (p.endsWith('.blockmap')) return 'application/octet-stream'
  return 'application/octet-stream'
}

async function upload(filePath) {
  const fileName = path.basename(filePath)
  const key = `${KEY_PREFIX}${fileName}`
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`
  const body = readFileSync(filePath)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      'Content-Type': contentType(filePath),
      // overwrite — we always publish a fresh build under the same name
      'x-upsert': 'true'
    },
    body
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`upload ${fileName} failed ${res.status}: ${text.slice(0, 300)}`)
  }
  return { fileName, size: body.length, key }
}

async function main() {
  const files = listArtifacts()
  if (files.length === 0) {
    console.error(`[publish] no artifacts in ${RELEASE_DIR}`)
    process.exit(1)
  }
  console.log(`[publish] uploading ${files.length} file(s) → ${BUCKET}/${KEY_PREFIX}`)
  for (const f of files) {
    try {
      const r = await upload(f)
      console.log(
        `  ✓ ${r.fileName} (${(r.size / 1024 / 1024).toFixed(2)} MB)`
      )
    } catch (err) {
      console.error(`  ✗ ${path.basename(f)}: ${err.message}`)
      process.exitCode = 1
    }
  }
  console.log('[publish] done. Reels Studio clients will pick up the new')
  console.log('  version on their next boot (≤ 5 min after launch).')
}

main().catch((err) => {
  console.error('[publish] fatal:', err)
  process.exit(1)
})
