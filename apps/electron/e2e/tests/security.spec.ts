import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@phase-1-security sandbox & contextIsolation', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
  })

  test.afterEach(async () => {
    if (launched) {
      try {
        await launched.app.close()
      } catch {
        /* ignore */
      }
      launched = null
    }
  })

  test('window.require is undefined', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const hasRequire = await page.evaluate(() => {
      return typeof (window as unknown as { require?: unknown }).require !== 'undefined'
    })
    expect(hasRequire).toBe(false)
  })

  test('window.process is undefined (node integration off)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const hasProcess = await page.evaluate(() => {
      return typeof (window as unknown as { process?: unknown }).process !== 'undefined'
    })
    expect(hasProcess).toBe(false)
  })

  test('window.electron does not expose eval-like passthrough methods', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    const danger = await page.evaluate(() => {
      const w = window as unknown as { electron: Record<string, unknown> }
      const all: string[] = []
      const walk = (obj: unknown, prefix: string): void => {
        if (!obj || typeof obj !== 'object') return
        for (const k of Object.keys(obj as Record<string, unknown>)) {
          all.push(`${prefix}${k}`)
          walk((obj as Record<string, unknown>)[k], `${prefix}${k}.`)
        }
      }
      walk(w.electron, '')
      const banned = ['eval', 'exec', 'spawn', 'require', 'shell', 'invoke']
      return all.filter((name) =>
        banned.some((b) => name.toLowerCase().endsWith(b))
      )
    })
    expect(danger, `Unexpected dangerous keys: ${danger.join(', ')}`).toEqual([])
  })
})
