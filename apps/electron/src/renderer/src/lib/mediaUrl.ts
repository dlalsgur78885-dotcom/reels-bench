/**
 * Build the `media://` URL for a local absolute path. The main process
 * registers this scheme (see src/main/mediaProtocol.ts) and gates access via
 * the ffmpeg/probe allowlist.
 */
export function toMediaUrl(absPath: string): string {
  if (!absPath) return ''
  return `media:///${encodeURIComponent(absPath)}`
}
