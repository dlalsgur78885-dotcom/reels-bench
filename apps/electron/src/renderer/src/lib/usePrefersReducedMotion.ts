/**
 * usePrefersReducedMotion — single `matchMedia` listener that returns the
 * current value of `(prefers-reduced-motion: reduce)` and re-renders when
 * the OS-level preference flips. Used by motion-heavy components (AudioMeter,
 * UpdateBanner, App progress bar, future animation work) to drop / weaken
 * animations when the user has asked for less motion (WCAG 2.3.3).
 *
 * Returns `false` in non-browser environments (SSR safety guard).
 */
import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function readNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  try {
    return window.matchMedia(QUERY).matches
  } catch {
    return false
  }
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readNow)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mq = window.matchMedia(QUERY)
    const handler = (e: MediaQueryListEvent): void => setReduced(e.matches)
    // Sync once on mount in case the OS pref changed between SSR and hydrate.
    setReduced(mq.matches)
    // Older Safari supports only addListener / removeListener; newer browsers
    // use addEventListener. Guard so both paths work.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
    mq.addListener(handler)
    return () => mq.removeListener(handler)
  }, [])

  return reduced
}
