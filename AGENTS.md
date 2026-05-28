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
6. Publish the Electron installer with:
   - `cd apps/electron`
   - `npm run publish -- --no-reinstall`
7. Verify the GitHub Release has all required assets for the new version:
   - `latest.yml`
   - `Reels-Studio-<version>.exe`
   - `Reels-Studio-Setup-<version>.exe`
   - `Reels-Studio-Setup-<version>.exe.blockmap`
8. Verify `https://reels-bench.vercel.app/editor` returns HTML 200.
9. Verify the downloaded installer installs the new version, or at minimum verify the installed `app.asar` package version and target renderer code.

Do not treat Vercel deployment alone as an Electron release. The web page only shows the download UI; the actual app users download comes from GitHub Releases.

