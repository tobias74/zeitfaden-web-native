import { traceStartup } from './lib/startupTrace'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'ol/ol.css'
import './index.css'
import App from './App.tsx'

traceStartup('[startup]', 'main module evaluated')
const rootElement = document.getElementById('root')!
traceStartup('[startup]', 'root element resolved', {
  hasRoot: Boolean(rootElement),
})
const root = createRoot(rootElement)
traceStartup('[startup]', 'react root created')
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
)
traceStartup('[startup]', 'react render requested')
