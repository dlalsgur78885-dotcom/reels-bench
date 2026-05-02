// 한국식 단위(만/억)로 큰 수를 짧게 표기.
//   1만 = 10,000, 1억 = 100,000,000
//   9,999 이하: 그대로 (천 단위 콤마)
//   1만 ~ 99.9만: 1자리 소수 (예: 1.2만, 99.9만)
//   100만 ~ 9,999만: 정수 (예: 123만, 1,234만)
//   1억+: 1자리 소수 (예: 1.2억, 12.3억)
export function fmtNum(n: number | null | undefined): string {
  if (n == null) return '-'
  const fmt = (v: number, max: number) =>
    v.toLocaleString('ko-KR', { maximumFractionDigits: max })
  const abs = Math.abs(n)

  if (abs >= 100_000_000) return `${fmt(n / 100_000_000, 1)}억`
  if (abs >= 10_000) {
    const v = n / 10_000
    // 9,999.5만 이상은 사실상 1억으로 라운드
    if (Math.abs(v) >= 9999.5) return `${fmt(n / 100_000_000, 1)}억`
    if (Math.abs(v) >= 100) return `${fmt(v, 0)}만`
    return `${fmt(v, 1)}만`
  }
  return n.toLocaleString('ko-KR')
}

export function engagementRate(likes: number, plays: number): number {
  if (!plays || !likes) return 0
  return Math.round((likes / plays) * 10000) / 100
}

export function erColor(er: number): string {
  if (er >= 5) return '#10B981'
  if (er >= 2) return '#307df0'
  if (er >= 1) return '#8B94A9'
  return '#EF4444'
}

export function parseFrameAnalysis(text: string) {
  const frameLines: Record<number, string> = {}
  const summaryLines: string[] = []

  for (const line of text.split('\n')) {
    const stripped = line.trim()
    if (stripped.startsWith('## 영상 프레임 분석')) continue
    if (stripped.startsWith('## ')) continue

    const m = stripped.match(/^\[?(\d+)\s*초?\]?\s*(.*)/)
    if (m) {
      frameLines[parseInt(m[1])] = m[2]
    } else if ((stripped.startsWith('-') || stripped.startsWith('*')) && stripped.length > 3) {
      summaryLines.push(stripped)
    }
  }

  const sortedSecs = Object.keys(frameLines).map(Number).sort((a, b) => a - b)

  const cutMarkers = sortedSecs.map(sec => {
    const info = frameLines[sec]
    const parts = info.split('|')
    for (const p of parts) {
      if (p.includes('컷전환') && p.includes('Y')) return 1
    }
    return 0
  })

  const cumulativeCuts: number[] = []
  let total = 0
  for (const c of cutMarkers) {
    total += c
    cumulativeCuts.push(total)
  }

  return { frameLines, summaryLines, sortedSecs, cutMarkers, cumulativeCuts }
}
