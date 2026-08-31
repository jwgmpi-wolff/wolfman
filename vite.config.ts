import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['jarvis-icon.svg'],
      manifest: {
        name: 'Jarvis Financial & Personal Assistant',
        short_name: 'Jarvis',
        description: 'A private, analytical command center for money, goals, tasks, and habits.',
        theme_color: '#244d39',
        background_color: '#f1f3ee',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'jarvis-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'jarvis-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
