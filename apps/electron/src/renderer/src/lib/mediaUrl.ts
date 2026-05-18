/**
 * Build the `media://` URL for a local absolute path. The main process
 * registers this scheme (see src/main/mediaProtocol.ts) and gates access via
 * the ffmpeg/probe allowlist.
 *
 * URL shape: `media:///<encodeURIComponent(absolutePath)>`. The whole path is
 * URI-encoded as one path segment so Windows drive letters and backslashes
 * survive the round-trip.
 */
export function toMediaUrl(absPath: string): string {
  if (!absPath) return ''
  return `media:///${encodeURIComponent(absPath)}`
}
