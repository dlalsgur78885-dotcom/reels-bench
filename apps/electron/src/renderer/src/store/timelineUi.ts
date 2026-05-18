import { create } from 'zustand'

/**
 * Transient UI state for the timeline + preview. NOT persisted to disk.
 */
export interface TimelineUiStore {
  /** Pixels-per-second zoom. */
  pps: number
  /** Playhead position in milliseconds. */
  playheadMs: number
  /** Is the transport playing? */
  playing: boolean

  setPps(pps: number): void
  setPlayheadMs(ms: number): void
  setPlaying(playing: boolean): void
  togglePlaying(): void
}

export const DEFAULT_PPS = 50
export const MIN_PPS = 10
export const MAX_PPS = 400

export const useTimelineUi = create<TimelineUiStore>((set, get) => ({
  pps: DEFAULT_PPS,
  playheadMs: 0,
  playing: false,

  setPps(pps: number): void {
    const clamped = Math.max(MIN_PPS, Math.min(MAX_PPS, pps))
    if (clamped !== get().pps) set({ pps: clamped })
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
  }
}))
