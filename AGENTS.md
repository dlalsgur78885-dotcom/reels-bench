# Reels Bench Agent Notes

## Commit And Release Rule

When committing Electron editor work, do all of the following in the same release pass:

1. Bump the Electron app version in:
   - `apps/electron/package.json`
   - `apps/electron/package-lock.json`
2. Update the web editor download display in:
   - `web/src/pages/DownloadEditor.tsx`
   - `CURRENT_EDITOR_VERSION`
   - `CURRENT_EDITOR_COMMIT_AT`
3. Commit only the files related to the task. Do not stage unrelated dirty files.
4. Push the branch.
5. Deploy the web frontend to Vercel production.
6. Build the Electron installer with:
   - `cd apps/electron`
   - `npm run package:installer`
7. Upload only the generated NSIS installer to the configured direct download host:
   - `apps/electron/release/Reels Studio Setup <version>.exe`
8. Update the production environment used by `/api/editor/latest`:
   - `EDITOR_DOWNLOAD_URL` (actual storage URL; `/editor/download` redirects here)
   - `EDITOR_DOWNLOAD_PUBLIC_URL` (optional; defaults to `/editor/download`)
   - `EDITOR_DOWNLOAD_VERSION`
   - `EDITOR_DOWNLOAD_FILENAME`
   - `EDITOR_DOWNLOAD_SIZE`
   - `EDITOR_RELEASE_DATE`
9. Verify `https://reels-bench.vercel.app/editor` returns HTML 200 and the download button points at `https://reels-bench.vercel.app/editor/download`.
10. Verify the downloaded installer installs the new version, or at minimum verify the installed `app.asar` package version and target renderer code.

Do not treat Vercel deployment alone as an Electron release. The web page only shows the download UI; the actual app users download is the installer file hosted at `EDITOR_DOWNLOAD_URL`, with `/editor/download` acting as the stable same-origin URL.

Automatic app updates are intentionally disabled. Do not publish `latest.yml`, blockmaps, or portable builds unless that policy changes.
