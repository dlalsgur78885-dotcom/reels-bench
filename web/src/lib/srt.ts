// TTS 결과 → SRT 자막 생성 유틸. TtsGen·MyScriptDetail 공용.

export type SrtSentence = { start?: number; end?: number; text?: string }

export function formatSrtTime(sec: number): string {
  const t = Math.max(0, sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const ms = Math.round((t - Math.floor(t)) * 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`
}

export function buildSrt(sentences: SrtSentence[], totalDuration = 0): string {
  const blocks: string[] = []
  let idx = 1
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]
    const text = (s.text || '').trim()
    if (!text) continue
    let start = Number.isFinite(s.start) ? (s.start as number) : 0
    let end = Number.isFinite(s.end) ? (s.end as number) : start
    // end가 비정상(<=start)이면 다음 sentence.start 또는 total로 폴백
    if (end <= start) {
      const next = sentences[i + 1]
      end = next && Number.isFinite(next.start)
        ? (next.start as number)
        : Math.max(start + 1, totalDuration)
    }
    blocks.push(`${idx}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}\n`)
    idx++
  }
  return blocks.join('\n')
}

export function downloadTextFile(filename: string, content: string, mime = 'text/plain') {
  // UTF-8 BOM — Windows 메모장/일부 플레이어 호환
  const blob = new Blob(['﻿', content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// 윈도우 금지문자 제거 — 파일명 안전화
export function safeFileName(base: string, fallback: string): string {
  return (base || fallback).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || fallback
}
