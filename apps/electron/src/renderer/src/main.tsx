import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTestBridge } from './lib/testBridge'
import { useAuthStore } from './store/auth'

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

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
