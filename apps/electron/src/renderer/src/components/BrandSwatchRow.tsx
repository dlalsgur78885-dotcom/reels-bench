// BrandSwatchRow — a reusable horizontal row of brand-color swatches.
//
// Reads the brand kit's colors directly from `useBrandKit`. Renders NOTHING
// when no colors are stored, so users without a brand kit pay zero cost.
// Wired into the caption word-color picker and the shape fill/stroke pickers.
import { useBrandKit } from '../store/brandKit'

interface BrandSwatchRowProps {
  /** Called with the picked hex (already normalized #rrggbb). */
  onPick: (hex: string) => void
  /** Optional small label shown before the swatches. */
  label?: string
}

const styles = {
  wrap: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4
  } as React.CSSProperties,
  label: {
    fontSize: 10,
    color: '#64748b',
    marginRight: 2
  } as React.CSSProperties,
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 4,
    border: '1px solid #2a2a2a',
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0
  } as React.CSSProperties
}

export function BrandSwatchRow({
  onPick,
  label
}: BrandSwatchRowProps): JSX.Element | null {
  const colors = useBrandKit((s) => s.kit.colors)
  if (colors.length === 0) return null
  return (
    <div style={styles.wrap} data-testid="brand-swatch-row">
      {label && <span style={styles.label}>{label}</span>}
      {colors.map((hex) => (
        <button
          key={hex}
          type="button"
          title={hex}
          aria-label={`브랜드 컬러 ${hex}`}
          data-testid={`brand-swatch-${hex}`}
          style={{ ...styles.swatch, background: hex }}
          onClick={() => onPick(hex)}
        />
      ))}
    </div>
  )
}
