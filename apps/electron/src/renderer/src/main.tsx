import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTestBridge } from './lib/testBridge'
import { useAuthStore } from './store/auth'
import './global.css'

const container = document.getElementById('root')
if (!container) throw new Error('root container missing')

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
