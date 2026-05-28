/**
 * Build the Reels Studio Windows installer for manual web download.
 *
 * This project no longer uses Electron auto-update for production delivery.
 * Users download the latest NSIS Setup .exe from /editor, so the release
 * artifact we care about is exactly one file:
 *
 *   release/Reels Studio Setup <version>.exe
 *
 * electron-builder may still emit helper files such as latest.yml/blockmap;
 * remove them after the build so they cannot be uploaded by mistake.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptDir, '..')
const releaseDir = path.join(electronDir, 'release')
const pkg = JSON.parse(
  await import('node:fs/promises').then((fs) =>
    fs.readFile(path.join(electronDir, 'package.json'), 'utf8')
  )
)
const version = pkg.version

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: electronDir,
    stdio: 'inherit',
    shell: true
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('npx', ['electron-vite', 'build'])
run('npx', ['electron-builder', '--win', 'nsis', '--x64', '--publish', 'never'])

const installerName = `Reels Studio Setup ${version}.exe`
const installerPath = path.join(releaseDir, installerName)
if (!existsSync(installerPath)) {
  console.error(`[package-installer] missing installer: ${installerPath}`)
  process.exit(1)
}

for (const name of readdirSync(releaseDir)) {
  const shouldRemove =
    name === 'latest.yml' ||
    name.endsWith('.blockmap') ||
    /^Reels Studio \d+\.\d+\.\d+.*\.exe$/.test(name)
  if (shouldRemove) {
    rmSync(path.join(releaseDir, name), { force: true })
  }
}

const size = statSync(installerPath).size
const baseUrl = (process.env.EDITOR_INSTALLER_BASE_URL || '').replace(/\/+$/, '')
const publicFileName = installerName.replaceAll(' ', '-')
const downloadUrl = baseUrl ? `${baseUrl}/${encodeURIComponent(publicFileName)}` : ''
const manifest = {
  version,
  filename: publicFileName,
  local_filename: installerName,
  download_url: downloadUrl,
  release_date: new Date().toISOString(),
  size,
  platform: 'win32'
}
writeFileSync(
  path.join(releaseDir, 'editor-download.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
)

console.log('[package-installer] ready:')
console.log(`  installer: ${installerPath}`)
console.log(`  size: ${size}`)
console.log(`  manifest: ${path.join(releaseDir, 'editor-download.json')}`)
if (!downloadUrl) {
  console.log('  download_url: not set (set EDITOR_INSTALLER_BASE_URL before packaging to fill it)')
}

