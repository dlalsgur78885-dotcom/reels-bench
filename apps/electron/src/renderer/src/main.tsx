import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTestBridge } from './lib/testBridge'
import { useAuthStore } from './store/auth'
import './global.css'

const container = document.getElementById('root')
if (!container) throw new Error('root container missing')

// pptx13 slide 10 — View 메뉴의 기본 accelerator 만으로는 Windows
// Ctrl++ 입력이 누락될 수 있어 renderer keydown 도 main zoom IPC로 연결한다.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const key = e.key.toLowerCase()
  const code = e.code.toLowerCase()
  const isZoomIn =
    key === '+' ||
    key === '=' ||
    code === 'equal' ||
    code === 'numpadadd'
  const isZoomOut =
    key === '-' ||
    key === '_' ||
    code === 'minus' ||
    code === 'numpadsubtract'
  const isReset = key === '0' || code === 'digit0' || code === 'numpad0'
  if (!isZoomIn && !isZoomOut && !isReset) return
  e.preventDefault()
  e.stopPropagation()
  const command = isReset ? 'reset' : isZoomIn ? 'in' : 'out'
  void window.electron?.appMenu?.zoom?.(command)
}, { capture: true })

// Renderer-only test bridge — exposes editing actions on window for
// Playwright. Safe to install unconditionally (a few KB of refs).
installTestBridge()

// Hydrate auth ONCE before first render. The hydrate call is idempotent
// (internal `hydrateStarted` flag) and triggers the onAuthStateChange
// subscription that keeps the store in sync afterwards. We don't await
// here — `App` shows a splash while `initialized` is still false.
void useAuthStore.getState().hydrate()

// Expose the auth store on window for E2E — same pattern as
// __reelsStore (testBridge.ts). Tests can drive sign-in/out without
// touching real Supabase.
;(window as unknown as { __reelsAuth: typeof useAuthStore }).__reelsAuth =
  useAuthStore

// pptx10 슬라이드 13 (확장) — URL 에 `?previewOnly=1` 있으면 분리된
// BrowserWindow 안에서 실행. PreviewCanvas 만 render 하는 mini app 로
// 띄움 (full editor UI 는 main window 가 담당).
const isPreviewOnly = new URLSearchParams(window.location.search).get('previewOnly') === '1'

if (isPreviewOnly) {
  void import('./pages/PreviewOnly').then(({ PreviewOnly }) => {
    createRoot(container).render(
      <React.StrictMode>
        <PreviewOnly />
      </React.StrictMode>
    )
  })
} else {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
