import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTestBridge } from './lib/testBridge'

const container = document.getElementById('root')
if (!container) throw new Error('root container missing')

// Renderer-only test bridge — exposes editing actions on window for
// Playwright. Safe to install unconditionally (a few KB of refs).
installTestBridge()

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
