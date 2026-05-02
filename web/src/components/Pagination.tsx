import { fmtNum } from '../utils'

interface Props {
  currentPage: number
  totalPages: number
  total: number
  onChange: (p: number) => void
}

export default function Pagination({ currentPage, totalPages, total, onChange }: Props) {
  const pages: (number | 'gap')[] = []
  const push = (p: number) => { if (!pages.includes(p)) pages.push(p) }
  push(1)
  if (currentPage - 2 > 2) pages.push('gap')
  for (let p = Math.max(2, currentPage - 1); p <= Math.min(totalPages - 1, currentPage + 1); p++) push(p)
  if (currentPage + 2 < totalPages - 1) pages.push('gap')
  if (totalPages > 1) push(totalPages)

  return (
    <nav className="pagination" aria-label="페이지 이동">
      <button
        type="button"
        className="pagination-btn"
        aria-label="이전 페이지"
        onClick={() => onChange(currentPage - 1)}
        disabled={currentPage <= 1}
      >‹</button>
      {pages.map((p, i) => p === 'gap'
        ? <span key={`g${i}`} className="pagination-gap" aria-hidden="true">…</span>
        : (
          <button
            key={p}
            type="button"
            className={`pagination-btn${p === currentPage ? ' active' : ''}`}
            aria-label={`${p}페이지`}
            aria-current={p === currentPage ? 'page' : undefined}
            onClick={() => onChange(p)}
          >{p}</button>
        ))}
      <button
        type="button"
        className="pagination-btn"
        aria-label="다음 페이지"
        onClick={() => onChange(currentPage + 1)}
        disabled={currentPage >= totalPages}
      >›</button>
      <span className="pagination-meta">
        {fmtNum(total)}개 · {currentPage}/{totalPages}쪽
      </span>
    </nav>
  )
}
