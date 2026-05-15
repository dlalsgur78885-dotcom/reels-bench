import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { NewVersionToast } from './NewVersionToast'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <App />
        <NewVersionToast />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
)
