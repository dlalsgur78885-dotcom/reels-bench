/**
 * Lightweight toast component used by the Phase 3.3 prefill flow.
 *
 * Renders a floating notification top-right of the viewport with three
 * variants (info / success / error). Auto-dismisses after `durationMs`
 * (default 4 s) or when the user clicks it. No global provider needed —
 * mount this directly with the props you want to display.
 */
import { useEffect } from 'react'
import { accent, font, radius, shadow, space, surface, text } from '../theme/tokens'

export type ToastVariant = 'info' | 'success' | 'error'

export interface ToastProps {
  message: string
  variant?: ToastVariant
  /** Auto-dismiss in ms. 0 disables auto-dismiss (manual close only). */
  durationMs?: number
  onClose: () => void
}

// Backgrounds = soft tint of the variant accent; borders = stronger
// related color; text = readable contrast on the tint. Pulled from the
// shared token surface so future palette tweaks happen in one file.
const VARIANT_BG: Record<ToastVariant, string> = {
  info: surface[2],
  success: accent.greenTint,
  error: accent.redTint
}
const VARIANT_BORDER: Record<ToastVariant, string> = {
  info: surface.borderStrong,
  success: '#065f46', // green-700, between greenTint and green
  error: '#4a1f1f' // red-900, between redTint and red
}
const VARIANT_COLOR: Record<ToastVariant, string> = {
  info: text.secondary,
  success: '#86efac', // green-300 — readable on greenTint
  error: '#fca5a5' // red-300 — readable on redTint
}

export function Toast({
  message,
  variant = 'info',
  durationMs,
  onClose
}: ToastProps): JSX.Element {
  // Error toasts default to manual-dismiss (durationMs=0) so a user who
  // looks away doesn't miss the failure — common AI failure modes
  // (autoedit error, STT model download fail, export fail) all funnel
  // through here. Info / success stay at 4s.
  const effectiveDuration =
    typeof durationMs === 'number' ? durationMs : variant === 'error' ? 0 : 4000

  useEffect(() => {
    if (effectiveDuration <= 0) return
    const t = setTimeout(() => onClose(), effectiveDuration)
    return () => clearTimeout(t)
  }, [effectiveDuration, onClose])

  // role="alert" + aria-live="assertive" so screen readers INTERRUPT for
  // failures (WCAG 4.1.3). Info / success stay polite via role="status".
  const isError = variant === 'error'

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
      onClick={onClose}
      data-testid={`toast-${variant}`}
      data-toast-variant={variant}
      data-toast-duration={effectiveDuration}
      style={{
        position: 'fixed',
        top: space[4],
        right: space[4],
        zIndex: 9999,
        minWidth: 240,
        maxWidth: 420,
        padding: `${space[3]}px ${space[4]}px`,
        borderRadius: radius.lg,
        background: VARIANT_BG[variant],
        border: `1px solid ${VARIANT_BORDER[variant]}`,
        color: VARIANT_COLOR[variant],
        fontFamily: font.family,
        fontSize: font.size.md,
        lineHeight: 1.4,
        boxShadow: shadow.toast,
        cursor: 'pointer',
        whiteSpace: 'pre-wrap'
      }}
    >
      {message}
    </div>
  )
}
