import type { CSSProperties, SyntheticEvent } from 'react'
import { thumbFallbackUrl } from '../api'

interface Props {
  src?: string
  url?: string
  shortcode?: string
  style?: CSSProperties
  className?: string
}

export default function Thumb({ src, url, shortcode, style, className }: Props) {
  const imgSrc = src || url

  if (!imgSrc) {
    return (
      <div className={className} style={{
        ...style, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-dim)', fontSize: 24, background: 'var(--bg-elevated)',
      }}>
        &#9654;
      </div>
    )
  }

  const handleError = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const fallback = shortcode ? thumbFallbackUrl(shortcode) : ''
    if (fallback && img.src !== new URL(fallback, window.location.origin).href) {
      img.src = fallback
      return
    }
    img.style.display = 'none'
    const parent = img.parentElement
    if (parent) parent.classList.add('thumb-missing')
  }

  return <img src={imgSrc} alt="" className={className} style={style} loading="lazy" decoding="async" onError={handleError} />
}
