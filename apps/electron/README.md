# Reels Studio — Electron shell

Internal-use desktop shell for the Reels Studio video editor. Phase 1: boot foundation only (no ffmpeg, no auth, no OpenCut yet).

## Stack
- Electron 32 + electron-vite (Vite + HMR)
- React 18 + TypeScript
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`

## Dev
```bash
cd apps/electron
pnpm install        # or: npm install
pnpm dev            # or: npm run dev
```
A window titled "Reels Studio" opens with three placeholder buttons (Analysis / Script / Editor) that log to the renderer devtools.

## Build
```bash
pnpm build          # bundles main/preload/renderer into ./out
pnpm start          # previews the built output
```

## Package (Windows installer)
Produces a real `.exe` installer + portable build under `./release/` via [electron-builder](https://www.electron.build/).

```bash
npm run package           # full Windows build → NSIS installer + portable
npm run package:portable  # portable-only (single-file .exe, no install)
```

Outputs (after a successful run):
- `release/Reels Studio Setup 0.1.0.exe` — NSIS installer (~120 MB). Installs to `C:\Program Files\Reels Studio\` (configurable), creates Start Menu + Desktop shortcuts.
- `release/Reels Studio 0.1.0.exe` — portable single-file build (~120 MB). No install, just run.
- `release/win-unpacked/Reels Studio.exe` — unpacked dev build (useful for smoke-testing without re-installing).

App identity:
- `appId`: `com.reelsbench.reelsstudio` (also set as Windows `AppUserModelId` in `src/main/index.ts` for taskbar grouping / toast notifications).
- Icon source: `build/icon.png` (1024×1024) → `build/icon.ico` (multi-resolution: 16, 24, 32, 48, 64, 128, 256). Regenerate with `python` + `Pillow` (script lives in commit history).

ffmpeg / ffprobe bundling:
- Both binaries are `asarUnpack`ed to `release/win-unpacked/resources/app.asar.unpacked/node_modules/`:
  - `ffmpeg-static/ffmpeg.exe`
  - `@ffprobe-installer/win32-x64/ffprobe.exe`
- They're executable in-place — no install-time fix-up required.

### Known limitations (internal-use only)
- **No code signing** — `signAndEditExecutable: false`, Windows SmartScreen will warn on first run ("Windows protected your PC → More info → Run anyway"). Expected; the build is for the internal team only.
- **Windows x64 only** — `package` builds for `win --x64`. Mac / Linux builds are deferred (cross-compile from Windows hits symlink issues in the Mac signing toolchain).
- The build pipeline disables Apple/Windows code-sign discovery via `signAndEditExecutable: false` + `CSC_IDENTITY_AUTO_DISCOVERY=false` so it works without admin / dev-mode on Windows.

### Bundle size (approx., gzipped on disk)
- NSIS installer .exe: ~120 MB
- Portable .exe: ~120 MB
- win-unpacked/ tree: ~330 MB (Electron 32 runtime + Chromium + ffmpeg/ffprobe)

Largest contributors: Electron+Chromium runtime (~200 MB), bundled ffmpeg.exe (~79 MB), ffprobe.exe (~78 MB), renderer bundle (~1.1 MB).

## Auto-update publishing (Phase 4.7)

The app checks for updates 5 minutes after launch via `electron-updater`'s
generic provider, configured to read from a Supabase Storage bucket:

```
https://mrpbovbxtablvawszhey.supabase.co/storage/v1/object/public/electron-releases/win/latest.yml
```

When a newer version is found, the package downloads in the background and the
renderer shows a non-intrusive banner ("새 버전 X.Y.Z 다운로드 완료") with two
actions: "지금 재시작" (calls `autoUpdater.quitAndInstall()`) and "나중에"
(install runs automatically on next quit).

### One-time bucket setup
1. In Supabase dashboard → Storage, create a **public** bucket named
   `electron-releases`.
2. Allow public anonymous reads (the default for public buckets is fine).
3. (Optional) Set a Storage policy that restricts writes to the service-role
   key only — this is the default if you skip explicit policies.
4. CORS: GET from any origin is already the default for public buckets.

### Required env vars on the build/publish machine
```
$env:SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOi...<service role key>"
```
The service-role key lives in Supabase dashboard → Project Settings → API.
It is **never** shipped in the binary — only the publish script uses it.

### Releasing a new version
```powershell
pwsh apps/electron/scripts/publish-release.ps1 -Version 0.1.1
```
The script:
1. Bumps `package.json` version to `0.1.1`.
2. Runs `npm run build && electron-builder --win --x64 --publish never`.
3. Uploads `release/latest.yml`, `release/Reels Studio Setup 0.1.1.exe`,
   and the `.blockmap` to `electron-releases/win/`.

Within ~5 minutes of next launch, existing 0.1.0 installs will:
- check `latest.yml`, see 0.1.1 is newer,
- download the installer (delta-update via blockmap when possible),
- pop the in-app banner once download completes.

### Useful publish-script flags
- `-SkipBuild` reuses whatever's already in `release/` (faster iteration).
- `-DryRun` prints the upload plan without making any network calls.

### Verifying the manifest after publish
```powershell
curl https://mrpbovbxtablvawszhey.supabase.co/storage/v1/object/public/electron-releases/win/latest.yml
```
You should see a `version: 0.1.1` block. If you get a 400, the bucket doesn't
exist or isn't public; double-check step 1 above.

## Bundled ffmpeg
- Provider: [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) `^5.3.0`
- Bundled binary: **ffmpeg 6.1.1** (Windows: gyan.dev essentials build; macOS/Linux: ffmpeg-static prebuilds via the same release tag `b6.1.1`)
- ffprobe: kept on `@ffprobe-installer/ffprobe ^2.1.2` (2023-02 gyan.dev build)
- License: GPL-3.0 (the build enables `libx264`/`libx265`, which require GPL; the previous 2018 bundle was the same GPL flavour, so this isn't a license regression)
- Approx unpacked size, Windows: **79 MB** for ffmpeg + 78 MB for ffprobe (was 62 MB + 78 MB → **+17 MB delta**)
- Features unlocked by the upgrade vs. the 2018 build:
  - `xfade` video transitions (introduced in 4.3) — the export pipeline now actually crossfades when a `transitionIn` is set, previously it fell back to plain `concat`.
  - `libharfbuzz` for proper `drawtext` shaping
  - Modern hardware encoder paths (`h264_nvenc`/`h264_qsv`/`h264_amf`) re-validated at startup via `capabilities.ts`
  - `out_time_ms` still emits microseconds (per ffmpeg's long-standing quirk) — the progress parser was already dividing by 1000 and stays unchanged

The exact bundled version is also logged to the main-process console at startup as `[ffmpeg] bundled: ffmpeg version 6.1.1-...` for debugging.

## Layout
```
src/
  main/      Electron main process (lifecycle, BrowserWindow, IPC registration)
    ipc/     Stubbed handlers — ffmpeg, fs, auth (throw 'Not implemented')
  preload/   contextBridge → window.electron (typed)
  shared/    IPC channel constants + TypeScript contracts
  renderer/  React app (Vite root)
```

## Security defaults (do not loosen)
- Renderer CSP locked to `self` + Supabase / Vercel domains
- All filesystem and ffmpeg access must go through main-process IPC
- External links open only if host matches the whitelist in `src/main/window.ts`

## Follow-ups for next agents
- `ffmpeg-native-engineer`: fill in `src/main/ipc/ffmpeg.ts` and `fs.ts`
- `auth-deeplink-engineer`: fill in `src/main/ipc/auth.ts` + register `reels-studio://` protocol
- `shared-ui-architect`: when `packages/shared-ui/` lands, swap renderer imports
