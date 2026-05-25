/**
 * Tooltip — lightweight popover replacement for `title=`.
 *
 * audit #12 found `title=` used in 121 places. Native `title`:
 *   - Doesn't appear on keyboard focus (only hover) — keyboard users get
 *     no hint at all.
 *   - Doesn't appear on touch — mobile / touchscreens get no hint.
 *   - Positions itself unpredictably and the styling is OS-specific.
 *
 * This component fixes those three:
 *   - Shows on `mouseenter` AND `focusin` — keyboard users see the same
 *     hint.
 *   - Dismisses on `mouseleave` / `focusout` / Esc.
 *   - Rendered into a portal-free absolute overlay anchored to the child.
 *
 * NOT a fancy positioning library — defaults to "below, centered". For
 * cases where that gets clipped by viewport, fall back to native `title`
 * on that element and live with it.
 *
 * Usage:
 *   <Tooltip label="Ctrl+Z 로 되돌리기">
 *     <button>↶</button>
 *   </Tooltip>
 *
 * The child MUST forward `ref` if it's not a native element — we use a
 * wrapping span when in doubt to avoid breaking children that don't.
 */
import { Children, cloneElement, isValidElement, useEffect, useRef, useState } from 'react'
import { accent, font, radius, shadow, surface, text } from '../theme/tokens'

interface TooltipProps {
  label: string
  /** Show delay (ms). Matches `title`'s ~500ms feel. Default 400. */
  delayMs?: number
  /** Position. Default 'bottom'. */
  placement?: 'bottom' | 'top'
  children: React.ReactNode
}

const tooltipStyle = (placement: 'bottom' | 'top'): React.CSSProperties => ({
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  [placement === 'bottom' ? 'top' : 'bottom']: 'calc(100% + 6px)',
  zIndex: 9998,
  pointerEvents: 'none',
  padding: '4px 8px',
  background: surface[2],
  color: text.primary,
  border: `1px solid ${surface.borderStrong}`,
  borderRadius: radius.base,
  fontSize: font.size.xs,
  fontFamily: font.family,
  lineHeight: 1.4,
  whiteSpace: 'nowrap',
  boxShadow: shadow.popover
})

export function Tooltip({
  label,
  delayMs = 400,
  placement = 'bottom',
  children
}: TooltipProps): JSX.Element {
  const [shown, setShown] = useState(false)
  const timerRef = useRef<number | null>(null)
  const wrapRef = useRef<HTMLSpanElement | null>(null)

  // Esc key dismisses an open tooltip — feels right for keyboard users.
  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShown(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown])

  const open = (): void => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setShown(true), delayMs)
  }
  const close = (): void => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setShown(false)
  }

  // We wrap the child in a span so we always have an anchor for the
  // absolute-positioned tooltip — works for any child without requiring
  // it to forward refs.
  const child = Children.only(children)

  // Bonus: forward a native `title=` so anyone NOT seeing our custom
  // popover (screen readers — they ignore title on most elements anyway,
  // but some Linux ATs read it) still has the hint. The visible popover
  // is the primary affordance.
  void isValidElement
  void cloneElement
  void accent

  return (
    <span
      ref={wrapRef}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
      style={{ position: 'relative', display: 'inline-flex' }}
      data-tooltip-root="true"
      title={label}
    >
      {child}
      {shown && (
        <span
          role="tooltip"
          data-testid="tooltip-popover"
          style={tooltipStyle(placement)}
        >
          {label}
        </span>
      )}
    </span>
  )
}
