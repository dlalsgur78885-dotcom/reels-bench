import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null; info: ErrorInfo | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info)
    this.setState({ info })
    // 새 배포로 청크 hash 변경 → 옛 페이지에서 lazy import 실패 → 자동 reload
    // 시간 기반: 마지막 reload로부터 30초 이내면 skip (무한 loop 방지), 30초 지나면 또 OK
    const msg = String(error?.message || '')
    if (/Failed to fetch dynamically imported module|Loading chunk \d+ failed|Importing a module script failed/i.test(msg)) {
      const k = 'rb_chunk_reload'
      const last = Number(sessionStorage.getItem(k) || 0)
      if (Date.now() - last > 30_000) {
        sessionStorage.setItem(k, String(Date.now()))
        window.location.reload()
      }
    }
  }

  reset = () => this.setState({ error: null, info: null })

  reload = () => window.location.reload()

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, maxWidth: 800, margin: '0 auto', fontFamily: 'inherit' }}>
          <h2 style={{ color: 'var(--error)', fontSize: 18, marginBottom: 8 }}>⚠ 화면 렌더링 오류</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
            컴포넌트가 예외를 던졌습니다. 콘솔에 상세 로그가 출력됐습니다.
          </p>
          <pre style={{
            fontSize: 11, padding: 12, background: 'var(--bg-elevated)',
            border: '1px solid var(--border)', borderRadius: 6,
            overflow: 'auto', maxHeight: 240, whiteSpace: 'pre-wrap',
          }}>
            {String(this.state.error?.message || this.state.error)}
            {this.state.info?.componentStack ? '\n\n' + this.state.info.componentStack : ''}
          </pre>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={this.reset}
              style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600,
                background: 'var(--accent)', color: '#fff', border: 'none',
                borderRadius: 6, cursor: 'pointer' }}>
              다시 시도
            </button>
            <button onClick={this.reload}
              style={{ padding: '6px 14px', fontSize: 12,
                background: 'transparent', color: 'var(--text-body)',
                border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}>
              새로고침
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
