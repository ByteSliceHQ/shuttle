import { expect, test } from 'bun:test'

import { httpsRedirect, withHsts } from './https'

test('sends plain http to the same address on https', () => {
  const response = httpsRedirect(new Request('http://shuttle.example/download/mac?x=1'))

  expect(response?.status).toBe(301)
  expect(response?.headers.get('location')).toBe('https://shuttle.example/download/mac?x=1')
})

test('leaves https and local development alone', () => {
  expect(httpsRedirect(new Request('https://shuttle.example/'))).toBeNull()
  expect(httpsRedirect(new Request('http://localhost:8790/'))).toBeNull()
  expect(httpsRedirect(new Request('http://127.0.0.1:5180/me'))).toBeNull()
  expect(httpsRedirect(new Request('http://app.localhost:3000/'))).toBeNull()
})

test('marks a response so browsers return over https, except in development', () => {
  const live = withHsts(new Request('https://shuttle.example/'), new Response('ok'))

  expect(live.headers.get('strict-transport-security')).toBe('max-age=31536000')

  const local = withHsts(new Request('http://localhost:8790/'), new Response('ok'))

  expect(local.headers.has('strict-transport-security')).toBe(false)
})
