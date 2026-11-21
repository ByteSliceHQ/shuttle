import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

// What is the backend's goes to a Shuttle Worker running on this machine.
const api: ProxyOptions = {
  target: 'http://127.0.0.1:8790',
  bypass: (req) => (req.headers.accept?.includes('text/html') ? '/index.html' : undefined),
}

const paths = [
  '/capabilities',
  '/definitions',
  '/operations',
  '/playbook',
  '/workspace',
  '/github',
  '/api/auth',
  '/auth',
  '/me',
  '/connections',
  '/sandbox',
  '/runners',
]

const sockets = ['/runs', '/sessions', '/firehose']

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      ...Object.fromEntries(paths.map((path) => [path, api])),
      ...Object.fromEntries(sockets.map((path) => [path, { ...api, ws: true }])),
    },
  },
})
