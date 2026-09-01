import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: import.meta.dirname.replaceAll('\\', '/'),
  test: {
    environment: 'node',
  },
})
