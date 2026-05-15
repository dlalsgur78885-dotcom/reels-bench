import { lazy, ComponentType } from 'react'

/**
 * lazy() + retry — 청크 fetch 실패 시 자동 page reload (30초 throttle, 무한 loop 방지).
 * 새 vercel 배포 후 옛 페이지가 새 hash 청크 요청 시 404 → 한번 reload하면 새 build 받음.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
): ReturnType<typeof lazy> {
  return lazy(async () => {
    try {
      return await factory()
    } catch (e: any) {
      const msg = String(e?.message || '')
      if (/Failed to fetch dynamically imported module|Loading chunk \d+ failed|Importing a module script failed/i.test(msg)) {
        const k = 'rb_lazy_reload'
        const last = Number(sessionStorage.getItem(k) || 0)
        if (Date.now() - last > 30_000) {
          sessionStorage.setItem(k, String(Date.now()))
          window.location.reload()
          // reload 직후엔 promise pending — UI 깨지기 전 떠나기
          return new Promise<{ default: T }>(() => {})
        }
      }
      throw e
    }
  }) as ReturnType<typeof lazy>
}
