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
