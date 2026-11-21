import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

// Override both to run a second copy beside the default one, e.g. against another worker.
const workerTarget = process.env.SHUTTLE_WORKER_URL ?? 'http://127.0.0.1:8790'
const webPort = Number(process.env.SHUTTLE_WEB_PORT ?? 5180)

/** `/sessions/:id` and `/playbook` are app routes too; page loads stay with the SPA. */
const api: ProxyOptions = {
  target: workerTarget,
  bypass: (req) => (req.headers.accept?.includes('text/html') ? '/index.html' : undefined),
}

/** GitHub App install/setup are worker redirects — never serve the SPA for HTML navigations. */
const githubApi: ProxyOptions = {
  target: workerTarget,
}

export default defineConfig({
  root,
  base: '/',
  define: {
    // The embedded browser loads sandbox previews straight from the worker, so it needs its port.
    'import.meta.env.VITE_SHUTTLE_WORKER_PORT': JSON.stringify(new URL(workerTarget).port || '80'),
  },
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
    // Bind IPv4 so SHUTTLE_WEB_URL (http://127.0.0.1:5180) works after GitHub redirects.
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/definitions': api,
      '/health': api,
      '/capabilities': api,
      '/operations': api,
      '/runs': { ...api, ws: true },
      '/sessions': { ...api, ws: true },
      '/playbook': api,
      '/timings': api,
      '/workspace': api,
      '/firehose': { ...api, ws: true },
      // Local sandbox runners connect here, as the desktop app's own page origin.
      '/runners': { ...api, ws: true },
      '/github': githubApi,
      // Sign-in. OAuth callbacks are browser navigations, so these never fall back to the SPA.
      '/api/auth': githubApi,
      '/auth': api,
      '/me': api,
    },
  },
})
