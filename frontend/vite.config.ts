import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Builds the SPA into ./dist, which the Worker serves via the ASSETS binding
// (see wrangler.*.toml [assets]). During local dev, /api and /auth are proxied
// to the Worker on :8787.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
    },
  },
})
