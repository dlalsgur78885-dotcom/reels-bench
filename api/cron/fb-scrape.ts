// Vercel daily cron: 자동 등록된 fb_advertisers 중 24h+ 미스크랩 광고주를
// Render fb-ads-web의 /trigger로 위임 (Vercel Lambda는 Playwright + 헤드리스 브라우저
// 실행이 무거워 Render free-tier worker가 처리).
// 동시에 광고 author_username 중 fb_advertisers 미등록 광고주를 자동 등록.

import type { VercelRequest, VercelResponse } from '@vercel/node'

export const config = { maxDuration: 60 }

async function autoRegisterAdvertisers(supaUrl: string, key: string): Promise<number> {
  const h: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
  // 광고 메타에서 author_username 집계
  const metaResp = await fetch(
    `${supaUrl}/rest/v1/reels_metadata?shortcode=like.fb_*&select=author_username&limit=5000`,
    { headers: h },
  )
  if (!metaResp.ok) return 0
  const metaRows = (await metaResp.json()) as Array<{ author_username: string | null }>
  const authors = new Set<string>()
  for (const m of metaRows) {
    const a = (m.author_username || '').trim()
    if (a && !a.startsWith('[검색]')) authors.add(a)
  }
  // 이미 등록된 광고주
  const advResp = await fetch(
    `${supaUrl}/rest/v1/fb_advertisers?select=page_name&limit=5000`,
    { headers: h },
  )
  if (!advResp.ok) return 0
  const advRows = (await advResp.json()) as Array<{ page_name: string }>
  const registered = new Set(advRows.map(r => r.page_name))
  // 미등록만 일괄 INSERT
  const toAdd = Array.from(authors).filter(a => !registered.has(a))
  if (toAdd.length === 0) return 0
  const payload = toAdd.map(a => ({
    page_name: a,
    page_url: `https://www.facebook.com/${encodeURIComponent(a)}`,
    description: '자동 등록 (광고에서 감지)',
    is_active: true,
  }))
  const ins = await fetch(`${supaUrl}/rest/v1/fb_advertisers`, {
    method: 'POST',
    headers: { ...h, Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify(payload),
  })
  return ins.ok ? toAdd.length : 0
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supaUrl = process.env.SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  const fbWeb = process.env.FB_ADS_WEB_URL || 'https://fb-ads-web.onrender.com'
  const triggerSecret = process.env.TRIGGER_SECRET || ''

  if (!supaUrl || !key) {
    return res.status(500).json({ error: 'SUPABASE env not set' })
  }

  const out: any = { ok: true, ts: new Date().toISOString() }

  // 1. 광고에서 발견된 광고주 자동 등록
  try {
    out.auto_registered = await autoRegisterAdvertisers(supaUrl, key)
  } catch (e: any) {
    out.auto_register_error = e?.message || String(e)
  }

  // 2. Render fb-ads-web의 /trigger 호출 (pending 광고주 처리)
  //    limit=50으로 다수 광고주를 한 번에 처리하도록 요청
  try {
    const params = new URLSearchParams({ limit: '50' })
    if (triggerSecret) params.set('key', triggerSecret)
    const triggerUrl = `${fbWeb}/trigger?${params.toString()}`
    const r = await fetch(triggerUrl, { method: 'GET' })
    out.render_trigger_status = r.status
    out.render_trigger_body = await r.text().then(t => t.slice(0, 200)).catch(() => '')
  } catch (e: any) {
    out.render_trigger_error = e?.message || String(e)
  }

  return res.json(out)
}
