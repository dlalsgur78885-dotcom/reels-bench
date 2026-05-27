/**
 * @file _sfx-our-library-real.spec.ts
 *
 * "우리 라이브러리" 진열 확인 — 26개 빌트인 효과음이 실제로 그리드에 뜨는지.
 * 라이브 DB row를 사전에 Management API로 받아와서 fetch stub으로 주입.
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import path from 'node:path'
import fs from 'node:fs'

const SCREENS = path.resolve(__dirname, '..', 'screens', 'sfx-click')

// 라이브 DB의 26개 row를 server.py `_sfx_row_to_dict` 형태로 사전 변환해 둠.
// (스크립트로 dump 가능하지만 spec 안에서 깔끔하게 가져오기 위해 인라인.)
const OUR_LIB_ROWS = [
  { id: 'r01', name: '스우시 — Swoosh', tags: ['swoosh','transition','whoosh'], duration_ms: 5310, url: 'https://stub/sfx/r01.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:00Z' },
  { id: 'r02', name: '롱 스우시 — Woosh', tags: ['swoosh','transition','whoosh'], duration_ms: 560,  url: 'https://stub/sfx/r02.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:01Z' },
  { id: 'r03', name: '소프트 스우시 — digital_whoosh_soft', tags: ['swoosh','soft','transition'], duration_ms: 950, url: 'https://stub/r03.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:02Z' },
  { id: 'r04', name: '팝 (UI) — Click Pop', tags: ['pop','ui','tap'], duration_ms: 500, url: 'https://stub/r04.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:03Z' },
  { id: 'r05', name: '버블 팝 — TOONY pops', tags: ['pop','bubble','cute'], duration_ms: 360, url: 'https://stub/r05.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:04Z' },
  { id: 'r06', name: '알림 딩 — Triangle Open', tags: ['ding','notification','bell'], duration_ms: 4030, url: 'https://stub/r06.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:05Z' },
  { id: 'r07', name: '검열 비프 — Beep 1 sec', tags: ['beep','censor','tv'], duration_ms: 1010, url: 'https://stub/r07.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:06Z' },
  { id: 'r08', name: '캐시 레지스터 — Dusty Cash Register', tags: ['cash','money','sale'], duration_ms: 1460, url: 'https://stub/r08.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:07Z' },
  { id: 'r09', name: '버튼 클릭 — hint', tags: ['click','ui','button'], duration_ms: 270, url: 'https://stub/r09.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:08Z' },
  { id: 'r10', name: '반짝 스파클 — Mysterious Sparkle Flourish', tags: ['sparkle','magic','shimmer'], duration_ms: 3950, url: 'https://stub/r10.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:09Z' },
  { id: 'r11', name: '카메라 셔터 — Vintage Camera', tags: ['camera','shutter','photo'], duration_ms: 2800, url: 'https://stub/r11.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:10Z' },
  { id: 'r12', name: '타이핑 — keyboard5', tags: ['typing','keyboard','mechanical'], duration_ms: 400, url: 'https://stub/r12.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:11Z' },
  { id: 'r13', name: '임팩트 — PUNCH-BOXING', tags: ['impact','boom','hit'], duration_ms: 4010, url: 'https://stub/r13.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:12Z' },
  { id: 'r14', name: '도장 — stamp_4presses_paper', tags: ['stamp','approved','seal'], duration_ms: 5150, url: 'https://stub/r14.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:13Z' },
  { id: 'r15', name: '박수 — Cheer 2', tags: ['applause','cheer','crowd'], duration_ms: 4130, url: 'https://stub/r15.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:14Z' },
  { id: 'r16', name: '째깍 — Ticking Clock', tags: ['clock','tick','timer'], duration_ms: 3660, url: 'https://stub/r16.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:15Z' },
  { id: 'r17', name: '헉 — Shocked gasp', tags: ['gasp','shock','reaction'], duration_ms: 1900, url: 'https://stub/r17.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:16Z' },
  { id: 'r18', name: '정답 — correct', tags: ['correct','quiz','ding'], duration_ms: 320, url: 'https://stub/r18.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:17Z' },
  { id: 'r19', name: '오답 — Buzzer Wrong', tags: ['wrong','buzzer','quiz'], duration_ms: 2770, url: 'https://stub/r19.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:18Z' },
  { id: 'r20', name: '동전 — Coin Spill', tags: ['coin','money','drop'], duration_ms: 4360, url: 'https://stub/r20.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:19Z' },
  { id: 'r21', name: '경고음 — hint short', tags: ['alert','beep','warning'], duration_ms: 270, url: 'https://stub/r21.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:20Z' },
  { id: 'r22', name: '후웅 임팩트 — Blocking Arm', tags: ['whoosh','impact','reveal'], duration_ms: 430, url: 'https://stub/r22.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:21Z' },
  { id: 'r23', name: '팝업 알림 — game fx 2', tags: ['notification','pop','alert'], duration_ms: 3430, url: 'https://stub/r23.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:22Z' },
  { id: 'r24', name: '두구두구 — drumroll', tags: ['drum','roll','suspense'], duration_ms: 5970, url: 'https://stub/r24.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:23Z' },
  { id: 'r25', name: '짜잔 — Success Fanfare Trumpets', tags: ['fanfare','reveal','magic'], duration_ms: 4440, url: 'https://stub/r25.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:24Z' },
  { id: 'r26', name: '라이저 — sweep', tags: ['riser','buildup','tension'], duration_ms: 3050, url: 'https://stub/r26.mp3', license: 'CC0', source: 'builtin', created_at: '2026-05-24T00:00:25Z' }
]

test('@sfx-our-real 우리 라이브러리 26개 진열 확인', async () => {
  fs.mkdirSync(SCREENS, { recursive: true })
  const launched: LaunchedApp = await launchElectron()
  const { page } = launched
  try {
    await page.evaluate((rows) => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/sfx') && !url.includes('/freesound')) {
          return Promise.resolve(new Response(JSON.stringify(rows), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          }))
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    }, OUR_LIB_ROWS)

    await page.locator('[data-testid="open-editor-button"]').click()
    await page.locator('[data-testid="import-tab-sfx"]').click()
    await page.locator('[data-testid="sfx-search-btn"]').click()

    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 10_000 })

    // 26개 카드 전부 보이는지
    for (const r of OUR_LIB_ROWS) {
      await expect(page.locator(`[data-testid="sfx-card-ours-${r.id}"]`)).toBeVisible()
    }

    // 첫 카드 이름이 한국어로 보이는지 (스우시 — Swoosh)
    const firstCardName = page.locator(`[data-testid="sfx-card-ours-r01"]`)
    await expect(firstCardName).toContainText('스우시')

    await page.screenshot({ path: path.join(SCREENS, '07_our_library_26_seeded.png'), fullPage: true })

    // 한 번 더 스크롤 끝 카드(짜잔, 라이저)도 확인
    await page.locator('[data-testid="sfx-card-ours-r25"]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(SCREENS, '08_our_library_scroll_bottom.png'), fullPage: true })
  } finally {
    await launched.app.close()
  }
})
