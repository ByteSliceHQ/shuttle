import { describe, expect, test } from 'bun:test'

import { isWebAppRequest } from './web-app'

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`https://shuttle.example${path}`, { method, headers })

const page = { accept: 'text/html,application/xhtml+xml' }

describe('telling the web app from the API', () => {
  test('the app shell and its files are the web app', () => {
    expect(isWebAppRequest(get('/', page))).toBe(true)
    expect(isWebAppRequest(get('/assets/index-abc.js'))).toBe(true)
    expect(isWebAppRequest(get('/connections', page))).toBe(true)
  })

  test('a path that is both is a page when navigated to and the API when fetched', () => {
    expect(isWebAppRequest(get('/sessions/abc', page))).toBe(true)
    expect(isWebAppRequest(get('/sessions/abc', { accept: 'application/json' }))).toBe(false)
    expect(isWebAppRequest(get('/playbook', page))).toBe(true)
    expect(isWebAppRequest(get('/playbook'))).toBe(false)
  })

  test('sign-in callbacks and GitHub redirects are never a page', () => {
    expect(isWebAppRequest(get('/api/auth/callback/github', page))).toBe(false)
    expect(isWebAppRequest(get('/github/setup', page))).toBe(false)
  })

  test('writes and sockets are the API', () => {
    expect(isWebAppRequest(get('/sessions/abc/say', page, 'POST'))).toBe(false)
    expect(isWebAppRequest(get('/runners/connect', { ...page, upgrade: 'websocket' }))).toBe(false)
    expect(isWebAppRequest(get('/me'))).toBe(false)
  })
})
