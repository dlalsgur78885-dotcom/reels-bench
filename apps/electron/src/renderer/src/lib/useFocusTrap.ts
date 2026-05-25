/**
 * useFocusTrap — keyboard focus management for modal dialogs.
 *
 * audit `_audits/audit-electron-sweep-20260525.md` #4 follow-up. The 3rd
 * cycle added role="dialog" + aria-modal so screen readers announce
 * dialogs, but Tab still leaks to the background. This hook closes that
 * loop:
 *
 *   - On mount (`enabled=true`): focus the FIRST focusable inside the
 *     container, BUT only if focus isn't already inside (so reopening a
 *     dialog that auto-focused an input doesn't fight that).
 *   - While mounted: intercept Tab / Shift+Tab on the container and wrap
 *     the focus around the first/last focusable. Background elements
 *     stay unreachable via keyboard.
 *   - On unmount: restore focus to the element that opened the dialog
 *     (`document.activeElement` at mount time).
 *
 * Usage:
 *   const ref = useFocusTrap<HTMLDivElement>(open)
 *   return open ? <div ref={ref} role="dialog">...</div> : null
 *
 * Why a hook rather than a `<Modal>` component: the existing dialogs each
 * have their own backdrop / busy-guard / close logic. Wrapping them all
 * in a shared component is a bigger refactor than fits one cycle — the
 * hook is opt-in, one line per dialog.
 */
import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.offsetParent !== null
  )
}

export function useFocusTrap<T extends HTMLElement>(
  enabled: boolean
): React.RefObject<T> {
  const ref = useRef<T>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!enabled) return
    const container = ref.current
    if (!container) return

    // Remember who had focus so we can return it on unmount.
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null

    // Auto-focus the first focusable — but only if focus isn't already
    // inside the dialog (e.g. an autofocused input would have moved focus
    // before our effect ran).
    if (!container.contains(document.activeElement)) {
      const focusables = focusableWithin(container)
      focusables[0]?.focus()
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const focusables = focusableWithin(container)
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      // Forward tab off the last → wrap to first
      if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
      // Shift+tab off the first → wrap to last
      else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      }
      // Tab fired while focus is outside the dialog (background) → pull back
      else if (active && !container.contains(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    container.addEventListener('keydown', onKey)
    return () => {
      container.removeEventListener('keydown', onKey)
      // Restore focus to opener if it's still in the DOM.
      const r = restoreRef.current
      if (r && document.body.contains(r)) {
        try {
          r.focus()
        } catch {
          /* ignore */
        }
      }
      restoreRef.current = null
    }
  }, [enabled])

  return ref
}
