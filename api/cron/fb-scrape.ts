// 단계별 디버그 — 어디서 실패하는지 확인
import type { VercelRequest, VercelResponse } from '@vercel/node'

export const config = { maxDuration: 300 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const debug: any = { step: 'start' }
  try {
    debug.step = 'env'
    debug.has_supa_url = !!process.env.SUPABASE_URL
    debug.has_supa_key = !!process.env.SUPABASE_SERVICE_ROLE_KEY
    debug.node = process.version

    debug.step = 'import_chromium'
    const chromium = (await import('@sparticuz/chromium')).default
    debug.chromium_loaded = true

    debug.step = 'import_playwright'
    const { chromium: pwChromium } = await import('playwright-core')
    debug.playwright_loaded = true

    debug.step = 'executable_path'
    const execPath = await chromium.executablePath()
    debug.exec_path = execPath

    debug.step = 'launch'
    const browser = await pwChromium.launch({
      args: chromium.args,
      executablePath: execPath,
      headless: true,
    })
    debug.browser_launched = true

    debug.step = 'context'
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto('https://example.com', { timeout: 30000 })
    const title = await page.title()
    debug.title = title

    await browser.close()
    debug.step = 'done'
    return res.json({ ok: true, debug })
  } catch (e: any) {
    return res.status(500).json({
      error: e?.message || 'unknown',
      stack: (e?.stack || '').slice(0, 1000),
      debug,
    })
  }
}
