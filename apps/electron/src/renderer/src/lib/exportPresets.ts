/**
 * Export presets — target codec / container / bitrate / dimensions for each
 * platform. Selected by the user in the ExportDialog and passed through to
 * the main-process export pipeline.
 *
 * All presets target H.264 in an mp4 container with AAC audio. The "preset"
 * name is the standard libx264 preset (also accepted by HW encoders).
 */
import type { AllowedCodec, AllowedPreset, ExportPresetKey } from '../../../shared/ipc'

export interface ExportPreset {
  /** UI label, Korean. */
  label: string
  /** Short description for the UI (Korean). */
  description: string
  width: number
  height: number
  fps: number
  vBitrateKbps: number
  aBitrateKbps: number
  codec: Extract<AllowedCodec, 'libx264'>
  preset: AllowedPreset
}

export const EXPORT_PRESETS: Record<ExportPresetKey, ExportPreset> = {
  'instagram-reels': {
    label: 'Instagram Reels',
    description: '9:16 · 1080×1920 · 30fps · 8 Mbps',
    width: 1080,
    height: 1920,
    fps: 30,
    vBitrateKbps: 8000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  tiktok: {
    label: 'TikTok',
    description: '9:16 · 1080×1920 · 30fps · 8 Mbps',
    width: 1080,
    height: 1920,
    fps: 30,
    vBitrateKbps: 8000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  'youtube-shorts': {
    label: 'YouTube Shorts',
    description: '9:16 · 1080×1920 · 30fps · 8 Mbps',
    width: 1080,
    height: 1920,
    fps: 30,
    vBitrateKbps: 8000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  'instagram-feed': {
    label: 'Instagram Feed (1:1)',
    description: '1:1 · 1080×1080 · 30fps · 6 Mbps',
    width: 1080,
    height: 1080,
    fps: 30,
    vBitrateKbps: 6000,
    aBitrateKbps: 128,
    codec: 'libx264',
    preset: 'medium'
  },
  'high-quality': {
    label: '고화질 (60fps)',
    description: '9:16 · 1080×1920 · 60fps · 12 Mbps · slow',
    width: 1080,
    height: 1920,
    fps: 60,
    vBitrateKbps: 12000,
    aBitrateKbps: 192,
    codec: 'libx264',
    preset: 'slow'
  },
  /**
   * Phase 3.28 — animated GIF. width/height/fps are display values only; the
   * main process owns the real GIF sizing (longest edge → 480px) and frame
   * rate. vBitrate/aBitrate/codec are unused for GIF — they exist purely to
   * satisfy the `ExportPreset` shape.
   */
  gif: {
    label: 'GIF (애니메이션)',
    description: '움직이는 GIF · 480px · 15fps · 무음',
    width: 480,
    height: 854,
    fps: 15,
    vBitrateKbps: 0,
    aBitrateKbps: 0,
    codec: 'libx264',
    preset: 'medium'
  }
}

export const EXPORT_PRESET_KEYS: readonly ExportPresetKey[] = [
  'instagram-reels',
  'tiktok',
  'youtube-shorts',
  'instagram-feed',
  'high-quality',
  'gif'
]

/**
 * Phase 3.28 — GIF export parameters for renderer-side UI text (e.g. the
 * duration-cap warning in ExportDialog). The main process holds its own
 * authoritative copy of these numbers; this is only for display.
 */
export const GIF_EXPORT = {
  fps: 15,
  maxEdge: 480,
  durationCapMs: 30000
} as const

/**
 * Output-filename suffix per preset, used by batch export so each preset's
 * file is uniquely named. Dimensions/fps mirror the actual `EXPORT_PRESETS`
 * entry. The full batch filename is `<projectSlug>_<suffix>.mp4`.
 */
export const PRESET_SUFFIX: Record<ExportPresetKey, string> = {
  'instagram-reels': 'reels_1080x1920',
  tiktok: 'tiktok_1080x1920',
  'youtube-shorts': 'shorts_1080x1920',
  'instagram-feed': 'feed_1080x1080',
  'high-quality': 'hq_1080x1920_60fps',
  gif: 'gif_480'
}

/**
 * Slugify a project name for use in an output filename. Same rule as
 * ExportDialog's `defaultOutputName`: non-word / non-dash runs → `_`,
 * capped at 64 chars, falls back to `export` for an empty name.
 */
export function projectSlug(name: string): string {
  return (name || 'export').replace(/[^\w\-]+/g, '_').slice(0, 64)
}

/** Naive size estimate (bytes) from bitrate × duration. ±15% is normal. */
export function estimateFileSizeBytes(
  presetKey: ExportPresetKey,
  durationMs: number
): number {
  // GIF size is unpredictable (palette + LZW); callers render 0 as "크기 가변".
  if (presetKey === 'gif') return 0
  const p = EXPORT_PRESETS[presetKey]
  if (!p || durationMs <= 0) return 0
  const totalKbps = p.vBitrateKbps + p.aBitrateKbps
  const seconds = durationMs / 1000
  // kbps × seconds / 8 = kilobytes; × 1024 = bytes.
  return Math.round((totalKbps * seconds * 1024) / 8)
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatDurationMs(ms: number): string {
  if (ms <= 0) return '0:00'
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
