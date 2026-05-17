// TTS 복사용 헬퍼 — direction에 박힌 영문 감정 + %를 한국어로 변환
// 예: "curious 70%" → "호기심", "친근하게 묻듯" → 그대로

const EMO_KO: Record<string, string> = {
  curious: '호기심',
  proud: '자랑스럽게',
  calm: '차분하게',
  cheerful: '밝게',
  happy: '행복하게',
  sad: '슬프게',
  surprised: '놀란듯',
  confident: '확신',
  friendly: '친근하게',
  excited: '신난듯',
  warm: '따뜻하게',
  sincere: '진심으로',
  confused: '의아하게',
  empathetic: '공감하듯',
  emphatic: '강조',
  persuasive: '설득',
  serious: '진지하게',
  playful: '장난스럽게',
  caring: '다정하게',
  neutral: '평온하게',
  reassuring: '안심시키듯',
  determined: '단호하게',
  whisper: '속삭이듯',
  nostalgic: '향수에 잠긴',
  hopeful: '희망에 차서',
  angry: '화남',
  nervous: '긴장',
  amused: '즐거워하며',
  bored: '심심한듯',
  thoughtful: '생각에 잠긴',
  passionate: '열정적으로',
  shocked: '놀라서',
  optimistic: '긍정적으로',
  encouraging: '격려하듯',
  informative: '안내하듯',
  enthusiastic: '신나서',
}

export function normalizeDirection(raw: string | undefined | null): string {
  const s = (raw || '').trim()
  if (!s) return ''
  // 1) 한국어 문구가 이미 들어있으면 그대로 (가나다 포함)
  if (/[가-힣]/.test(s)) return s
  // 2) "curious 70%" / "curious 70" / "curious70%" → emotion 단어만 추출
  const m = s.match(/^([a-zA-Z_]+)(?:\s*\d+\s*%?)?$/)
  const word = (m ? m[1] : s).toLowerCase()
  return EMO_KO[word] || word
}

type PhraseLike = { text?: string; tag?: string; direction?: string }
type SentenceLike = { text?: string; direction?: string; phrases?: PhraseLike[] }

export function buildTtsText(sentences: Array<SentenceLike>, fallback?: string): string {
  if (!sentences || !sentences.length) return fallback || ''
  return sentences.map(s => {
    const phrases = s.phrases || []
    if (phrases.length) {
      // 어절 모드 — phrase마다 tag/direction inline 박음
      // ElevenLabs로 전송될 형태와 동일하게: '(tag) text (tag) text ...'
      return phrases.map(p => {
        const pTag = (p.tag || '').trim()  // 이미 '(...)' 형식
        const pDir = normalizeDirection(p.direction)
        const cue = pTag || (pDir ? `(${pDir})` : '')
        const pTxt = (p.text || '').trim()
        return cue ? `${cue} ${pTxt}` : pTxt
      }).join(' ')
    }
    // 일반 모드 — sentence direction만
    const dir = normalizeDirection(s.direction)
    const txt = (s.text || '').trim()
    return dir ? `(${dir}) ${txt}` : txt
  }).join('\n')
}
