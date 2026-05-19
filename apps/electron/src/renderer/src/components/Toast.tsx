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
  durationMs = 4000,
  onClose
}: ToastProps): JSX.Element {
  useEffect(() => {
    if (durationMs <= 0) return
    const t = setTimeout(() => onClose(), durationMs)
    return () => clearTimeout(t)
  }, [durationMs, onClose])

  return (
    <div
      role="status"
      onClick={onClose}
      data-testid={`toast-${variant}`}
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
