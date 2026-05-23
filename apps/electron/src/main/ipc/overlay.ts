/**
 * Overlay assets — emoji / sticker library (Phase 3.25).
 *
 * The renderer rasterizes an emoji/sticker to a PNG (it cannot write files
 * directly under the sandbox), then hands the raw PNG bytes to main. Main
 * writes them into `userData/sticker-assets/<assetId>.png` and registers the
 * path on the ffmpeg allowlist so the standard media:// preview / overlay /
 * export pipeline accepts the sticker exactly like any imported file.
 *
 * Security:
 *   - The renderer NEVER supplies a path — only a constrained `assetId` token.
 *     `assetId` must match `/^[a-z0-9-]{1,64}$/`; this regex is the security
 *     boundary that keeps the filename free of `..`, separators, etc.
 *   - As belt-and-suspenders, the composed path is asserted to stay inside
 *     the `sticker-assets` directory before any write.
 *   - A hard size cap defends against a runaway/oversized payload.
 *   - The handler never throws across IPC — all failures return {ok:false}.
 *
 * Dedupe: the PNG for a given `assetId` is deterministic, so an existing file
 * is reused as-is (allowlisted + returned with `reused:true`) without a
 * rewrite.
 */
import { app, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { IPC_CHANNELS, type SaveStickerResult } from '../../shared/ipc'
import { allowPath } from '../ffmpeg/security'

/** Hard cap on a single sticker PNG payload (4 MB). */
const MAX_BYTES = 4 * 1024 * 1024

/**
 * The security boundary: a sticker `assetId` is a short lowercase token of
 * `[a-z0-9-]` only. No separators, no `..`, no extension — so it cannot
 * escape the `sticker-assets` directory once composed into a filename.
 */
const ASSET_ID_RE = /^[a-z0-9-]{1,64}$/

function stickerAssetsDir(): string {
  return path.join(app.getPath('userData'), 'sticker-assets')
}

export function registerOverlayHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.overlay.saveSticker,
    async (
      _event,
      rawAssetId: unknown,
      rawBytes: unknown
    ): Promise<SaveStickerResult> => {
      try {
        // --- 1. Validate assetId — the security boundary. -------------------
        if (typeof rawAssetId !== 'string' || !ASSET_ID_RE.test(rawAssetId)) {
          return { ok: false, error: 'invalid_asset_id' }
        }
        const assetId = rawAssetId

        // --- 2. Coerce bytes to a Buffer (ArrayBuffer or typed-array view). -
        let buf: Buffer
        if (rawBytes instanceof ArrayBuffer) {
          buf = Buffer.from(rawBytes)
        } else if (ArrayBuffer.isView(rawBytes)) {
          buf = Buffer.from(
            rawBytes.buffer,
            rawBytes.byteOffset,
            rawBytes.byteLength
          )
        } else {
          return { ok: false, error: 'invalid_bytes' }
        }
        if (buf.byteLength === 0) {
          return { ok: false, error: 'invalid_bytes' }
        }
        if (buf.byteLength > MAX_BYTES) {
          return { ok: false, error: 'too_large' }
        }

        // --- 3. Compose path (main-computed) + escape assertion. -----------
        const dir = stickerAssetsDir()
        const destPath = path.join(dir, `${assetId}.png`)
        // Belt-and-suspenders: the resolved dest must stay inside `dir`.
        if (
          !path.resolve(destPath).startsWith(path.resolve(dir) + path.sep)
        ) {
          return { ok: false, error: 'path_escape' }
        }

        // --- 4. Dedupe — deterministic PNG per assetId, reuse existing. ----
        if (existsSync(destPath)) {
          allowPath(destPath)
          return { ok: true, path: destPath, reused: true }
        }

        // --- 5. Write. ----------------------------------------------------
        await mkdir(dir, { recursive: true })
        await writeFile(destPath, buf)

        // --- 6. Allowlist for media:// preview / overlay / export reads. --
        allowPath(destPath)

        // --- 7. Done. -----------------------------------------------------
        return { ok: true, path: destPath, reused: false }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
}
