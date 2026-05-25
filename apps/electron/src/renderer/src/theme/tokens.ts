/**
 * Design tokens — Phase: ui-design-tokens.
 *
 * Why this file exists: audit `_audits/audit-electron-sweep-20260525.md` #7
 * counted 695 hex literals across 32 files and zero design tokens. The
 * symptom: 3 shades of "subtle border" (#2a2a2a / #334155 / #374151), 3
 * shades of "success green" (#10b981 / #22c55e / #34d399), and similar
 * drift everywhere. Without a token surface, future components fork the
 * palette again on every PR.
 *
 * Migration plan: this file is the source of truth. Migrate Toast +
 * Transport + Editor topbar FIRST as the reference (audit recommendation),
 * then refactor remaining components incrementally as they're touched.
 * Components that haven't migrated stay byte-identical.
 *
 * Why TypeScript instead of CSS custom properties: components already use
 * inline `style={{}}` objects ubiquitously, so importing typed constants
 * gives us autocomplete + dead-token detection at compile time. We can
 * always add a CSS-var layer later for theming runtime.
 */

/** Surface layers — darkest to lightest. Editor background = surface[0]. */
export const surface = {
  /** App background — body / window chrome. */
  0: '#0d0d0d',
  /** Panel / sidebar / popover. */
  1: '#1f2937',
  /** Raised — clip block, toast bg, menu item bg. */
  2: '#1e293b',
  /** Border on raised surfaces. Default "subtle border". */
  border: '#2a2a2a',
  /** Stronger border — input focus inner, divider. */
  borderStrong: '#334155'
} as const

/** Text colors against `surface.*`. */
export const text = {
  /** Body copy on dark surface. */
  primary: '#e2e8f0',
  /** Less important — captions, helper text. */
  secondary: '#cbd5e1',
  /** Muted — labels, units, disabled hints. */
  muted: '#94a3b8'
} as const

/** Semantic accents. Each has a base + a soft "bg-tint" for backgrounds. */
export const accent = {
  blue: '#60a5fa',
  blueTint: '#1e3a8a',
  green: '#22c55e',
  greenTint: '#064e3b',
  amber: '#fbbf24',
  amberTint: '#451a03',
  red: '#ef4444',
  redTint: '#3b0d0d'
} as const

/** Spacing scale (px). 0=0, 1=4, 2=8, 3=12, 4=16, 5=20, 6=24, 7=32, 8=40, 9=48. */
export const space = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48] as const

/** Type scale (px). */
export const font = {
  size: {
    xs: 10,
    sm: 11,
    base: 12,
    md: 13,
    lg: 14,
    xl: 16,
    '2xl': 20
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    black: 900
  },
  family: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
} as const

/** Standard border radius. */
export const radius = {
  sm: 2,
  base: 4,
  md: 6,
  lg: 8,
  xl: 12,
  full: 9999
} as const

/** Shadows. */
export const shadow = {
  toast: '0 8px 32px rgba(0, 0, 0, 0.4)',
  popover: '0 4px 12px rgba(0, 0, 0, 0.5)'
} as const

/** Convenience aggregate for compatibility with components that prefer a
 * single import. */
export const tokens = {
  surface,
  text,
  accent,
  space,
  font,
  radius,
  shadow
} as const
