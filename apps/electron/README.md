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
