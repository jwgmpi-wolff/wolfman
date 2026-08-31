import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { WolfmanDataProvider } from './WolfmanDataProvider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WolfmanDataProvider>
      <App />
    </WolfmanDataProvider>
  </StrictMode>,
)
