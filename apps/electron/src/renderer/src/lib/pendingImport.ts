/**
 * Bridges drag-and-drop from the import panel's remote tabs (영상 라이브러리,
 * TTS, 내부 영상, 사운드, 효과음, AI 영상) into the timeline.
 *
 * Why this exists: a remote tile doesn't have a local mediaId yet at the
 * moment the user grabs it — that id only exists AFTER download + ingest.
 * HTML5 drag events are synchronous (no async setData), so we kick the
 * import off in onDragStart, stash the in-flight Promise under a tempId,
 * and Timeline.onDrop awaits the resolution before creating the clip at
 * the drop position.
 */
import type { MediaAsset } from '../../../shared/project'

export const PENDING_MEDIA_DRAG_MIME = 'application/x-reels-pending-media'

interface PendingEntry {
  promise: Promise<MediaAsset | null>
  /** Human-readable label for UI hints during the import. */
  displayName: string
}

const pending = new Map<string, PendingEntry>()
let counter = 0

export function newPendingId(): string {
  counter += 1
  return `pending_${Date.now().toString(36)}_${counter}`
}

export function registerPending(
  tempId: string,
  promise: Promise<MediaAsset | null>,
  displayName: string
): void {
  pending.set(tempId, { promise, displayName })
  // Auto-cleanup once consumed (resolve or reject).
  promise.finally(() => {
    // Defer one tick so the consumer has a chance to await it after the
    // drop fires. 30s grace covers slow networks.
    setTimeout(() => pending.delete(tempId), 30_000)
  })
}

export function awaitPending(tempId: string): Promise<MediaAsset | null> {
  const entry = pending.get(tempId)
  if (!entry) return Promise.resolve(null)
  return entry.promise
}

export function pendingDisplayName(tempId: string): string | undefined {
  return pending.get(tempId)?.displayName
}

if (typeof window !== 'undefined') {
  ;(window as unknown as {
    __PENDING_IMPORT_FOR_TEST__?: {
      mime: string
      newPendingId: typeof newPendingId
      registerPending: typeof registerPending
    }
  }).__PENDING_IMPORT_FOR_TEST__ = {
    mime: PENDING_MEDIA_DRAG_MIME,
    newPendingId,
    registerPending
  }
}
