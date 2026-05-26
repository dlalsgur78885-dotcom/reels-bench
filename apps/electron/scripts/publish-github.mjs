/**
 * publish-github — package + publish to GitHub Releases via electron-builder.
 *
 * Why not Supabase Storage anymore: the project is on the Supabase Free tier
 * (50MB per-file limit). Our NSIS installer is ~130MB and can't be uploaded
 * even via TUS resumable. GitHub Releases supports 2GB per file, is free,
 * and electron-updater has first-class `github` provider support — so the
 * auto-update banner in `UpdateBanner.tsx` keeps working unchanged.
 *
 * Auth: needs a GitHub token with `repo` scope. We pull it from `gh auth
 * token` automatically (gh CLI must be authenticated), so no env-var dance
 * required by humans.
 *
 * Usage:
 *   cd apps/electron
 *   npm run publish
 *
 * Side effect: creates / updates the GitHub Release named `v<version>` on
 * `dlalsgur78885-dotcom/reels-bench` and uploads the .exe / latest.yml /
 * blockmap. The existing tag is reused if it already exists (we don't
 * force-push tags).
 */
import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

function getGhToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8' }).trim()
    if (out) return out
  } catch {
    /* fall through */
  }
  console.error('[publish] No GH_TOKEN / GITHUB_TOKEN env var, and `gh auth token` failed.')
  console.error('  Run `gh auth login` once, then re-run `npm run publish`.')
  process.exit(1)
}

const token = getGhToken()
const result = spawnSync(
  'npx',
  ['electron-builder', '--win', '--x64', '--publish', 'always'],
  {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, GH_TOKEN: token }
  }
)
if (result.status !== 0) process.exit(result.status ?? 1)

// ---------------------------------------------------------------------------
// Local reinstall — keep the dev PC's installed copy in lockstep with the
// just-published version. Without this, the auto-update banner can't fire on
// this PC (current install + new GitHub release are the same version when
// the in-app updater sees them both at `vX.Y.Z`). Skip with --no-reinstall
// if you only want to publish without touching the local install.
// ---------------------------------------------------------------------------
if (process.argv.includes('--no-reinstall')) {
  console.log('[publish] --no-reinstall — skipping local install upgrade')
  process.exit(0)
}
if (process.platform !== 'win32') {
  console.log('[publish] local reinstall hook supports win32 only — skipping')
  process.exit(0)
}

function reinstallLocal() {
  const cwd = process.cwd()
  const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf-8'))
  const version = pkg.version
  const setupExe = path.join(cwd, 'release', `Reels Studio Setup ${version}.exe`)
  if (!existsSync(setupExe)) {
    console.warn(`[publish] setup .exe missing — expected ${setupExe} — skipping local reinstall`)
    return
  }
  const localApp = process.env.LOCALAPPDATA
  const uninstaller = localApp
    ? path.join(localApp, 'Programs', 'Reels Studio', 'Uninstall Reels Studio.exe')
    : ''
  // Step 1 — silent uninstall (if a prior install exists). user-data dir is
  // untouched, so project.json survives.
  if (uninstaller && existsSync(uninstaller)) {
    console.log('[publish] uninstalling existing local copy...')
    const u = spawnSync(uninstaller, ['/currentuser', '/S'], {
      stdio: 'inherit',
      shell: false
    })
    if (u.status !== 0) {
      console.warn(`[publish] uninstall exited ${u.status} — continuing anyway`)
    }
    // NSIS spawns a child to delete itself; give it a few seconds.
    const wait = spawnSync('powershell', ['-Command', 'Start-Sleep -Seconds 4'], {
      stdio: 'ignore'
    })
    void wait
  } else {
    console.log('[publish] no prior install found — skipping uninstall')
  }
  // Step 2 — silent install of the freshly built setup .exe.
  console.log(`[publish] installing ${path.basename(setupExe)}...`)
  const i = spawnSync(setupExe, ['/S', '/currentuser'], {
    stdio: 'inherit',
    shell: false
  })
  if (i.status !== 0) {
    console.warn(`[publish] install exited ${i.status} — may need manual fix`)
    return
  }
  // Step 3 — verify by reading the installed app.asar's package.json.
  // CRITICAL: extract-file writes to CWD, and we previously followed up
  // with `del package.json` — which clobbered our own apps/electron/package.json
  // when cwd === apps/electron. Run the probe inside an isolated temp dir
  // so neither the extract nor the delete touches the repo.
  const asarPath = path.join(
    localApp,
    'Programs',
    'Reels Studio',
    'resources',
    'app.asar'
  )
  if (!existsSync(asarPath)) {
    console.warn('[publish] installed app.asar not found — install may have failed')
    return
  }
  const probeDir = path.join(
    process.env.TEMP || process.env.TMP || 'C:/Windows/Temp',
    `reels-publish-verify-${Date.now()}`
  )
  try {
    const fs2 = await import('node:fs')
    fs2.mkdirSync(probeDir, { recursive: true })
  } catch (e) {
    console.warn('[publish] cannot create probe dir:', e?.message ?? e)
    return
  }
  const probe = spawnSync(
    'npx',
    ['--yes', '@electron/asar', 'extract-file', asarPath, 'package.json'],
    { stdio: 'pipe', shell: true, cwd: probeDir }
  )
  if (probe.status === 0) {
    try {
      const pkgInstalled = JSON.parse(
        readFileSync(path.join(probeDir, 'package.json'), 'utf-8')
      )
      console.log(
        `[publish] verified installed version: ${pkgInstalled.version} (target ${version})`
      )
    } catch (e) {
      console.warn('[publish] verify read failed:', e?.message ?? e)
    }
  } else {
    console.warn('[publish] could not verify installed version (asar probe failed)')
  }
  // Cleanup probe dir — entire scoped temp, never touches the repo.
  try {
    const fs2 = await import('node:fs')
    fs2.rmSync(probeDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

reinstallLocal()
