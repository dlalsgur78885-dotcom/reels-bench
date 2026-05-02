interface Props {
  src?: string
  url?: string
  shortcode?: string
  style?: React.CSSProperties
  className?: string
}

export default function Thumb({ src, url, style, className }: Props) {
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

  return <img src={imgSrc} alt="" className={className} style={style} loading="lazy" decoding="async"
    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
}
