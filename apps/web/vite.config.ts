import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

/** `/sessions/:id` and `/playbook` are app routes too; page loads stay with the SPA. */
const api: ProxyOptions = {
  target: 'http://127.0.0.1:8790',
  bypass: (req) => (req.headers.accept?.includes('text/html') ? '/index.html' : undefined),
}

export default defineConfig({
  root,
  base: '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/definitions': api,
      '/health': api,
      '/operations': api,
      '/runs': api,
      '/sessions': { ...api, ws: true },
      '/playbook': api,
      '/workspace': api,
      '/github': api,
    },
  },
})
