import { create } from 'zustand'
import { getGroupMembers } from '../../../shared/project'
import { useProjectStore } from './project'

/**
 * Transient UI state for the timeline (selection model + playback state +
 * zoom). NOT persisted to disk — this is purely UI ephemera.
 *
 * Phase 2.3 introduced single-select; the model exposes a Set so we can
 * future-proof for multi-select (Ctrl/Shift-click) without an interface
 * break. Phase 2.2 (this milestone) adds playback (playheadMs/playing) and
 * zoom (pps).
 */
export interface TimelineUiStore {
  // ----- Selection (Phase 2.3) -----
  /** Selected clip ids. Single-select today; Set forward-compat. */
  selectedClipIds: Set<string>
  /** Replace the selection with a single clip id (or clear if null). */
  selectClip(clipId: string | null): void
  /** Add or remove a clip id without disturbing the rest (multi-select hook). */
  toggleClipSelected(clipId: string): void
  /** Clear all selection. */
  clearSelection(): void

  // ----- Adjustment-layer selection (Phase 3.32) -----
  /**
   * The currently selected adjustment layer id, or null. Mutually exclusive
   * with `selectedClipIds` — selecting a layer clears the clip selection and
   * vice versa, so the EffectsPanel shows exactly one grade editor.
   */
  selectedAdjustmentLayerId: string | null
  /**
   * Select an adjustment layer (or clear when null). Selecting a non-null id
   * clears the clip selection (mutually exclusive selection).
   */
  setSelectedAdjustmentLayerId(layerId: string | null): void

  // ----- Playback (Phase 2.2) -----
  /** Playhead position in milliseconds (>= 0). */
  playheadMs: number
  /** True while the transport is playing (rAF loop is ticking). */
  playing: boolean
  /** Move the playhead. Floored to int ms, clamped at 0. */
  setPlayheadMs(ms: number): void
  /** Set the playing flag explicitly. */
  setPlaying(playing: boolean): void
  /** Flip the playing flag. */
  togglePlaying(): void

  // ----- Zoom (Phase 2.2) -----
  /** Pixels-per-second. Default 60. Clamped to [MIN_PPS, MAX_PPS]. */
  pps: number
  /** Update pixels-per-second; out-of-range values are clamped. */
  setPps(pps: number): void

  // ----- Beat snap (Phase 2.5) -----
  /** Whether snapping to beats is enabled. */
  beatSnapEnabled: boolean
  /** Beat positions in ms (timeline-absolute). */
  beats: number[]
  /** Manual BPM (used by computed-beats helper). */
  bpm: number
  /**
   * Origin of the current `beats[]`. `'metronome'` = generated from BPM by the
   * Editor's effect (regenerated on bpm/duration change). `'detected'` = real
   * timestamps from analysis prefill — should NOT be overwritten by the
   * metronome generator. Defaults to `'metronome'`.
   */
  beatsSource: 'metronome' | 'detected'
  setBeatSnapEnabled(enabled: boolean): void
  /** Replace beats. Optional source defaults to `'detected'` so explicit external callers don't accidentally fall under metronome auto-regen. The metronome effect passes `'metronome'`. */
  setBeats(beats: number[], source?: 'metronome' | 'detected'): void
  setBpm(bpm: number): void
  /** Mark the next beats[] regen as `'metronome'`-sourced (used when the user touches the BPM input). */
  markBeatsAsMetronome(): void

  // ----- Waveform cache (Phase 2.5) -----
  /** Map media id → data: URI for the rendered waveform PNG. */
  waveformUris: Record<string, string>
  setWaveformUri(mediaId: string, uri: string): void

  // ----- Toolbar: tool mode (Phase 5) -----
  /**
   * Active timeline interaction tool.
   *   'select' — default; clicking a clip selects it.
   *   'split'  — clicking inside a clip splits it at the click point.
   */
  toolMode: 'select' | 'split'
  setToolMode(mode: 'select' | 'split'): void

  // ----- Toolbar: snap toggle (Phase 5) -----
  /**
   * Persistent edge/second snap toggle. When false, drags behave as if Alt
   * were held (snap disabled). Holding Alt at drag time still disables snap
   * regardless of this flag.
   */
  snapEnabled: boolean
  setSnapEnabled(enabled: boolean): void

  // ----- Toolbar: A/V link toggle (Phase 5) -----
  /**
   * When true, linked video+audio clips move together. Best-effort: the
   * underlying link data model is not yet implemented, so today this is only
   * a UI toggle that future work can read.
   */
  avLinkEnabled: boolean
  setAvLinkEnabled(enabled: boolean): void

  // ----- Toolbar: markers (Phase 5) -----
  /** Timeline markers (absolute ms positions), kept as transient UI state. */
  markers: TimelineMarker[]
  /** Add a marker at `atMs` (deduped within 1ms). Returns the marker id. */
  addMarker(atMs: number, label?: string): string
  /** Remove a marker by id. */
  removeMarker(markerId: string): void
  /** Remove every marker. */
  clearMarkers(): void

  // ----- Social preview (Phase 6) -----
  /**
   * Which SNS platform chrome to mock over the preview. Purely a visual guide
   * — it never touches the project, undo history, or the export pipeline.
   * `'none'` (default) renders no overlay.
   */
  socialPreviewPlatform: SocialPreviewPlatform
  setSocialPreviewPlatform(platform: SocialPreviewPlatform): void
}

/**
 * SNS platform whose UI chrome the preview mocks over the video. Transient
 * UI state only — Phase 6 "SNS 플랫폼 미리보기".
 */
export type SocialPreviewPlatform = 'none' | 'tiktok' | 'youtube' | 'instagram'

/** A single timeline marker pinned to an absolute ms position. */
export interface TimelineMarker {
  id: string
  atMs: number
  label?: string
}

/** Default pixels-per-second for the timeline ruler. */
export const DEFAULT_PPS = 60
/** Lower bound for zoom-out. */
export const MIN_PPS = 10
/** Upper bound for zoom-in. */
export const MAX_PPS = 400

/** Default BPM used when the user hasn't entered a custom tempo yet. */
export const DEFAULT_BPM = 120
/** Snap-to-beat tolerance in milliseconds. */
export const BEAT_SNAP_TOLERANCE_MS = 80

export const useTimelineUi = create<TimelineUiStore>((set, get) => ({
  selectedClipIds: new Set<string>(),
  selectedAdjustmentLayerId: null,
  playheadMs: 0,
  playing: false,
  pps: DEFAULT_PPS,
  beatSnapEnabled: false,
  beats: [],
  bpm: DEFAULT_BPM,
  beatsSource: 'metronome',
  waveformUris: {},
  toolMode: 'select',
  snapEnabled: true,
  avLinkEnabled: false,
  markers: [],
  socialPreviewPlatform: 'none',

  selectClip(clipId: string | null): void {
    const current = get().selectedClipIds
    const hadLayer = get().selectedAdjustmentLayerId !== null
    if (clipId === null) {
      if (current.size === 0 && !hadLayer) return
      set({ selectedClipIds: new Set(), selectedAdjustmentLayerId: null })
      return
    }
    // Phase 3.33 — selecting a grouped clip selects ALL its group members.
    // The project state lives in a separate store; no import cycle exists
    // (project.ts never imports timelineUi.ts), so reading it here is safe.
    const project = useProjectStore.getState().project
    let ids: string[] = [clipId]
    for (const t of project.tracks) {
      const c = t.clips.find((cc) => cc.id === clipId)
      if (c) {
        if (c.groupId) {
          ids = getGroupMembers(project, c.groupId).map((m) => m.id)
        }
        break
      }
    }
    // Skip the no-op set only when the selection is already exactly `ids`.
    if (
      !hadLayer &&
      current.size === ids.length &&
      ids.every((id) => current.has(id))
    ) {
      return
    }
    // Selecting a clip clears any adjustment-layer selection (mutually exclusive).
    set({ selectedClipIds: new Set(ids), selectedAdjustmentLayerId: null })
  },
  toggleClipSelected(clipId: string): void {
    const next = new Set(get().selectedClipIds)
    if (next.has(clipId)) next.delete(clipId)
    else next.add(clipId)
    set({ selectedClipIds: next, selectedAdjustmentLayerId: null })
  },
  clearSelection(): void {
    if (get().selectedClipIds.size === 0 && get().selectedAdjustmentLayerId === null) {
      return
    }
    set({ selectedClipIds: new Set(), selectedAdjustmentLayerId: null })
  },

  setSelectedAdjustmentLayerId(layerId: string | null): void {
    if (layerId === null) {
      if (get().selectedAdjustmentLayerId === null) return
      set({ selectedAdjustmentLayerId: null })
      return
    }
    // Selecting a layer clears the clip selection (mutually exclusive).
    if (
      get().selectedAdjustmentLayerId === layerId &&
      get().selectedClipIds.size === 0
    ) {
      return
    }
    set({ selectedAdjustmentLayerId: layerId, selectedClipIds: new Set() })
  },

  setPlayheadMs(ms: number): void {
    const v = Math.max(0, Math.floor(ms))
    if (v !== get().playheadMs) set({ playheadMs: v })
  },
  setPlaying(playing: boolean): void {
    if (playing !== get().playing) set({ playing })
  },
  togglePlaying(): void {
    set({ playing: !get().playing })
  },

  setPps(pps: number): void {
    const clamped = Math.max(MIN_PPS, Math.min(MAX_PPS, pps))
    if (clamped !== get().pps) set({ pps: clamped })
  },

  setBeatSnapEnabled(enabled: boolean): void {
    const v = Boolean(enabled)
    if (v !== get().beatSnapEnabled) set({ beatSnapEnabled: v })
  },
  setBeats(beats: number[], source: 'metronome' | 'detected' = 'detected'): void {
    if (!Array.isArray(beats)) return
    const clean = beats
      .map((b) => Math.max(0, Math.round(Number(b))))
      .filter((b) => Number.isFinite(b))
      .sort((a, b) => a - b)
    set({ beats: clean, beatsSource: source })
  },
  setBpm(bpm: number): void {
    const n = Number(bpm)
    if (!Number.isFinite(n)) return
    const clamped = Math.max(30, Math.min(300, Math.round(n)))
    if (clamped !== get().bpm) set({ bpm: clamped })
  },
  markBeatsAsMetronome(): void {
    if (get().beatsSource !== 'metronome') set({ beatsSource: 'metronome' })
  },
  setWaveformUri(mediaId: string, uri: string): void {
    if (!mediaId || !uri) return
    const cur = get().waveformUris
    if (cur[mediaId] === uri) return
    set({ waveformUris: { ...cur, [mediaId]: uri } })
  },

  setToolMode(mode: 'select' | 'split'): void {
    if (mode !== 'select' && mode !== 'split') return
    if (mode !== get().toolMode) set({ toolMode: mode })
  },

  setSnapEnabled(enabled: boolean): void {
    const v = Boolean(enabled)
    if (v !== get().snapEnabled) set({ snapEnabled: v })
  },

  setAvLinkEnabled(enabled: boolean): void {
    const v = Boolean(enabled)
    if (v !== get().avLinkEnabled) set({ avLinkEnabled: v })
  },

  addMarker(atMs: number, label?: string): string {
    const at = Math.max(0, Math.round(Number(atMs) || 0))
    const cur = get().markers
    // Dedupe — a marker already within 1ms wins (return its id).
    const existing = cur.find((m) => Math.abs(m.atMs - at) < 1)
    if (existing) return existing.id
    const id = `mk_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 7)}`
    const marker: TimelineMarker = { id, atMs: at }
    if (typeof label === 'string' && label.trim()) marker.label = label.trim()
    set({
      markers: [...cur, marker].sort((a, b) => a.atMs - b.atMs)
    })
    return id
  },

  removeMarker(markerId: string): void {
    const cur = get().markers
    const next = cur.filter((m) => m.id !== markerId)
    if (next.length !== cur.length) set({ markers: next })
  },

  clearMarkers(): void {
    if (get().markers.length > 0) set({ markers: [] })
  },

  setSocialPreviewPlatform(platform: SocialPreviewPlatform): void {
    const valid: SocialPreviewPlatform[] = [
      'none',
      'tiktok',
      'youtube',
      'instagram'
    ]
    if (!valid.includes(platform)) return
    if (platform !== get().socialPreviewPlatform) {
      set({ socialPreviewPlatform: platform })
    }
  }
}))

/**
 * Snap `desiredMs` to the nearest beat in `beats[]` within tolerance.
 * Returns `desiredMs` unchanged when no beat is close enough.
 */
export function snapToNearestBeat(
  desiredMs: number,
  beats: number[],
  toleranceMs = BEAT_SNAP_TOLERANCE_MS
): number {
  if (!beats || beats.length === 0) return desiredMs
  let bestDist = Infinity
  let best = desiredMs
  // Linear scan — beats arrays are small (< few hundred) in practice.
  for (const b of beats) {
    const d = Math.abs(b - desiredMs)
    if (d < bestDist) {
      bestDist = d
      best = b
    }
  }
  return bestDist <= toleranceMs ? best : desiredMs
}

/**
 * Phase 3.76 — magnet timeline. Snap `desiredMs` to the nearest clip
 * boundary (startMs / endMs) within tolerance. Pass `boundaries` as a flat
 * list of timeline-ms values; the caller is responsible for excluding the
 * clip currently being dragged (otherwise the drag would snap to its own
 * pre-edit position and never move).
 *
 * Returns `desiredMs` unchanged when no boundary is within tolerance, the
 * boundaries list is empty, or `desiredMs` is non-finite.
 */
export const CLIP_SNAP_TOLERANCE_MS = 80

export function snapToNearestClipBoundary(
  desiredMs: number,
  boundaries: number[],
  toleranceMs = CLIP_SNAP_TOLERANCE_MS
): number {
  if (!Number.isFinite(desiredMs)) return desiredMs
  if (!boundaries || boundaries.length === 0) return desiredMs
  let bestDist = Infinity
  let best = desiredMs
  for (const b of boundaries) {
    if (!Number.isFinite(b)) continue
    const d = Math.abs(b - desiredMs)
    if (d < bestDist) {
      bestDist = d
      best = b
    }
  }
  return bestDist <= toleranceMs ? best : desiredMs
}

/** Convenience: returns the currently selected single clip id, or null. */
export function getSelectedClipId(): string | null {
  const sel = useTimelineUi.getState().selectedClipIds
  if (sel.size === 0) return null
  return sel.values().next().value ?? null
}

// ---------------------------------------------------------------------------
// E2E hook: expose the store on window so Playwright can introspect state.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  ;(window as unknown as {
    __TIMELINE_UI_FOR_TEST__: typeof useTimelineUi
  }).__TIMELINE_UI_FOR_TEST__ = useTimelineUi
}
