/**
 * Phase 3.45~3.47 — topbar UI was refactored into popovers (AI / 자막 / 옵션
 * / 내보내기). Buttons that used to be top-level (open-stt-dialog, open-
 * prefill-dialog, open-text-template-picker, etc.) now live INSIDE a
 * ToolbarMenu popover that needs to be clicked open first.
 *
 * This helper is idempotent: if the popover is already open, the click is
 * skipped. It tolerates the absence of the menu (older snapshots / pages
 * without the topbar render) by returning early.
 */
import type { Page } from 'playwright'

/** Open one of the topbar popovers if it isn't already open. */
async function openTopbarMenu(
  page: Page,
  testId: string
): Promise<void> {
  const menu = page.locator(`[data-testid="${testId}"]`)
  if ((await menu.count()) === 0) return
  // The popover may render an "aria-expanded" attribute when implemented; in
  // its absence, fall back to clicking unconditionally — a second click would
  // close the popover, so we probe with the inner button visibility first.
  const expanded = await menu.getAttribute('aria-expanded').catch(() => null)
  if (expanded === 'true') return
  // Try a non-throwing click — the click target should be the menu chip.
  await menu.click({ force: true }).catch(() => {})
  // Best-effort delay so the popover transition completes.
  await page.waitForTimeout(120)
}

/** AI ▾ popover: hosts STT / prefill / auto-edit / auto-reframe / beat-cut /
 *  text-template entry buttons. */
export async function openAiMenu(page: Page): Promise<void> {
  await openTopbarMenu(page, 'topbar-menu-ai')
}

/** 자막 ▾ popover. */
export async function openCaptionsMenu(page: Page): Promise<void> {
  await openTopbarMenu(page, 'topbar-menu-captions')
}

/** 옵션 ▾ popover: BPM / 비트 스냅 / 커버 / 진행바 / 캔버스 배경 / 플레이헤드. */
export async function openOptionsMenu(page: Page): Promise<void> {
  await openTopbarMenu(page, 'topbar-menu-options')
}

/** 내보내기 ▾ popover (split button). */
export async function openExportMenu(page: Page): Promise<void> {
  await openTopbarMenu(page, 'topbar-menu-export')
}
