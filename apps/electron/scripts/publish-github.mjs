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
process.exit(result.status ?? 1)
