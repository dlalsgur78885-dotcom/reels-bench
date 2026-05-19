<#
.SYNOPSIS
  Build + publish a Reels Studio Electron release to Supabase Storage.

.DESCRIPTION
  Drives the full Phase 4.7 release flow:

    1. Bumps `version` in package.json to the value passed via -Version.
    2. Runs `npm run build && electron-builder --win --x64 --publish never`
       so we never accidentally upload to a wrong provider.
    3. Uploads the produced artifacts (.exe installer + latest.yml + blockmap)
       to the Supabase Storage bucket `electron-releases/win/` using a curl
       call authenticated with $env:SUPABASE_SERVICE_ROLE_KEY.

  After this script finishes successfully, any running 0.1.0 install will see
  the new version on its next launch (~5 min check delay).

.PARAMETER Version
  New semantic version, e.g. "0.1.1". REQUIRED.

.PARAMETER SkipBuild
  If set, skip the build step and just upload whatever's already in /release.
  Useful when iterating on the upload portion without re-building (~2 min).

.PARAMETER DryRun
  If set, print what WOULD be uploaded but don't actually call Supabase.

.NOTES
  Required env vars:
    SUPABASE_SERVICE_ROLE_KEY   service-role key for the Supabase project
                                (NOT the anon key — service-role can write
                                to storage buckets regardless of RLS).

  Optional env vars:
    SUPABASE_PROJECT_URL        defaults to
                                https://mrpbovbxtablvawszhey.supabase.co
                                (matches web/src/supabase.ts)
    SUPABASE_BUCKET             defaults to "electron-releases"

.EXAMPLE
  pwsh apps/electron/scripts/publish-release.ps1 -Version 0.1.1

.EXAMPLE
  # Re-upload artifacts from a previous build (e.g. after a Supabase blip).
  pwsh apps/electron/scripts/publish-release.ps1 -Version 0.1.1 -SkipBuild

.EXAMPLE
  # See what would be uploaded without making any network calls.
  pwsh apps/electron/scripts/publish-release.ps1 -Version 0.1.1 -DryRun
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$')]
  [string]$Version,

  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Resolve repo + apps/electron paths from the script's own location so
# callers don't have to cd in first.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$ReleaseDir = Join-Path $ElectronDir 'release'
$PackageJsonPath = Join-Path $ElectronDir 'package.json'

$SupabaseUrl = if ($env:SUPABASE_PROJECT_URL) { $env:SUPABASE_PROJECT_URL } else { 'https://mrpbovbxtablvawszhey.supabase.co' }
$Bucket = if ($env:SUPABASE_BUCKET) { $env:SUPABASE_BUCKET } else { 'electron-releases' }
$ServiceKey = $env:SUPABASE_SERVICE_ROLE_KEY

Write-Host "==> Reels Studio release publish" -ForegroundColor Cyan
Write-Host "    target version : $Version"
Write-Host "    electron dir   : $ElectronDir"
Write-Host "    supabase       : $SupabaseUrl"
Write-Host "    bucket         : $Bucket/win/"
Write-Host "    skip build     : $($SkipBuild.IsPresent)"
Write-Host "    dry run        : $($DryRun.IsPresent)"
Write-Host ""

if (-not $DryRun -and -not $ServiceKey) {
  throw "SUPABASE_SERVICE_ROLE_KEY env var is required (set via PowerShell: `$env:SUPABASE_SERVICE_ROLE_KEY = '...'`)"
}

# ---------------------------------------------------------------------------
# 1) Bump package.json version (skip if it already matches).
# ---------------------------------------------------------------------------
$pkg = Get-Content -Raw -Path $PackageJsonPath | ConvertFrom-Json
if ($pkg.version -eq $Version) {
  Write-Host "package.json already at $Version — skipping bump" -ForegroundColor Yellow
}
else {
  Write-Host "Bumping package.json: $($pkg.version) -> $Version"
  $pkg.version = $Version
  # ConvertTo-Json strips trailing newline + uses 4-space indent on PS 7+.
  # Match repo style (2-space) by post-processing.
  $json = $pkg | ConvertTo-Json -Depth 12
  $json = ($json -replace '(?m)^( +)', { $args[0].Groups[1].Value.Substring(0, $args[0].Groups[1].Value.Length / 2) })
  Set-Content -Path $PackageJsonPath -Value ($json + "`n") -Encoding utf8 -NoNewline
}

# ---------------------------------------------------------------------------
# 2) Build (npm run build + electron-builder).
# ---------------------------------------------------------------------------
if (-not $SkipBuild) {
  Write-Host ""
  Write-Host "==> npm run build" -ForegroundColor Cyan
  Push-Location $ElectronDir
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }

    Write-Host ""
    Write-Host "==> electron-builder --win --x64 --publish never" -ForegroundColor Cyan
    npx electron-builder --win --x64 --publish never
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed (exit $LASTEXITCODE)" }
  }
  finally {
    Pop-Location
  }
}
else {
  Write-Host "SkipBuild set — using existing $ReleaseDir contents" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 3) Collect artifacts. electron-updater (generic provider) needs:
#       latest.yml                — manifest with version + sha512 + path
#       Reels Studio Setup X.Y.Z.exe  — the actual installer
#       Reels Studio Setup X.Y.Z.exe.blockmap  — delta-update support
# ---------------------------------------------------------------------------
$LatestYml = Join-Path $ReleaseDir 'latest.yml'
$InstallerExe = Join-Path $ReleaseDir "Reels Studio Setup $Version.exe"
$BlockMap = "$InstallerExe.blockmap"

$artifacts = @($LatestYml, $InstallerExe, $BlockMap)
foreach ($a in $artifacts) {
  if (-not (Test-Path $a)) {
    throw "Missing artifact: $a (did the build succeed?)"
  }
}

Write-Host ""
Write-Host "==> Uploading to $SupabaseUrl/storage/v1/object/$Bucket/win/" -ForegroundColor Cyan
foreach ($a in $artifacts) {
  $fileName = Split-Path -Leaf $a
  $destPath = "win/$fileName"
  $url = "$SupabaseUrl/storage/v1/object/$Bucket/$destPath"
  $size = (Get-Item $a).Length

  Write-Host "  - $fileName ($([math]::Round($size / 1MB, 2)) MB) -> $destPath"

  if ($DryRun) { continue }

  # Use curl directly so the binary upload is straightforward. -X PUT with
  # x-upsert:true so re-uploads overwrite, which is what we want for latest.yml.
  $contentType = if ($fileName -like '*.yml') { 'text/yaml' }
                 elseif ($fileName -like '*.blockmap') { 'application/octet-stream' }
                 else { 'application/octet-stream' }

  curl.exe `
    --silent --show-error --fail `
    -X POST `
    -H "Authorization: Bearer $ServiceKey" `
    -H "x-upsert: true" `
    -H "Content-Type: $contentType" `
    --data-binary "@$a" `
    "$url"
  if ($LASTEXITCODE -ne 0) {
    throw "Upload failed for $fileName (curl exit $LASTEXITCODE)"
  }
  Write-Host "    ok" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Existing installs will pick up $Version within ~5 min of next launch." -ForegroundColor Green
Write-Host "Public latest.yml: $SupabaseUrl/storage/v1/object/public/$Bucket/win/latest.yml"
