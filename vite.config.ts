import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const projectRoot = process.cwd().replaceAll('\\', '/')

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  server: {
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        `${projectRoot}/.git/**`,
      ],
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['wolfman-icon.svg'],
      manifest: {
        name: 'Wolfman Financial & Personal Assistant',
        short_name: 'Wolfman',
        description: 'A private, analytical command center for money, goals, tasks, and habits.',
        theme_color: '#244d39',
        background_color: '#f1f3ee',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'wolfman-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'wolfman-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
