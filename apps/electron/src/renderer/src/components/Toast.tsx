/**
 * Lightweight toast component used by the Phase 3.3 prefill flow.
 *
 * Renders a floating notification top-right of the viewport with three
 * variants (info / success / error). Auto-dismisses after `durationMs`
 * (default 4 s) or when the user clicks it. No global provider needed —
 * mount this directly with the props you want to display.
 */
import { useEffect } from 'react'

export type ToastVariant = 'info' | 'success' | 'error'

export interface ToastProps {
  message: string
  variant?: ToastVariant
  /** Auto-dismiss in ms. 0 disables auto-dismiss (manual close only). */
  durationMs?: number
  onClose: () => void
}

const VARIANT_BG: Record<ToastVariant, string> = {
  info: '#1e293b',
  success: '#064e3b',
  error: '#3b0d0d'
}
const VARIANT_BORDER: Record<ToastVariant, string> = {
  info: '#334155',
  success: '#065f46',
  error: '#4a1f1f'
}
const VARIANT_COLOR: Record<ToastVariant, string> = {
  info: '#cbd5e1',
  success: '#86efac',
  error: '#fca5a5'
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
        top: 16,
        right: 16,
        zIndex: 9999,
        minWidth: 240,
        maxWidth: 420,
        padding: '12px 16px',
        borderRadius: 8,
        background: VARIANT_BG[variant],
        border: `1px solid ${VARIANT_BORDER[variant]}`,
        color: VARIANT_COLOR[variant],
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: 13,
        lineHeight: 1.4,
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
        cursor: 'pointer',
        whiteSpace: 'pre-wrap'
      }}
    >
      {message}
    </div>
  )
}
