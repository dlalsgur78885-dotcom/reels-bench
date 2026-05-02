import { useSearchParams } from 'react-router-dom'
import Users from './Users'
import Secrets from './Secrets'

type Tab = 'users' | 'secrets'

const TABS: { key: Tab; label: string }[] = [
  { key: 'users', label: '직원 관리' },
  { key: 'secrets', label: '시크릿' },
]

export default function Settings() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = (params.get('tab') as Tab) === 'secrets' ? 'secrets' : 'users'

  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params)
    p.set('tab', next)
    setParams(p, { replace: true })
  }

  return (
    <>
      <div
        className="segment-group"
        role="tablist"
        aria-label="설정 영역"
        style={{ marginBottom: 16 }}
      >
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            role="tab"
            className={`btn-segment${tab === t.key ? ' active' : ''}`}
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
          >{t.label}</button>
        ))}
      </div>

      {tab === 'users' ? <Users /> : <Secrets />}
    </>
  )
}
