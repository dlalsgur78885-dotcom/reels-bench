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
  }
}

export const EXPORT_PRESET_KEYS: readonly ExportPresetKey[] = [
  'instagram-reels',
  'tiktok',
  'youtube-shorts',
  'instagram-feed',
  'high-quality'
]

/** Naive size estimate (bytes) from bitrate × duration. ±15% is normal. */
export function estimateFileSizeBytes(
  presetKey: ExportPresetKey,
  durationMs: number
): number {
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
