import { describe, expect, test } from 'bun:test'

import { TEST_AUTH_ENV } from '../testing/auth'
import { migratedD1 } from '../testing/fake-d1'
import { createAuth, trustedWebOrigins } from './auth'

describe('trustedWebOrigins', () => {
  test('a local web app is trusted on both loopback names', () => {
    expect(trustedWebOrigins({ SHUTTLE_WEB_URL: 'http://127.0.0.1:5180' })).toEqual([
      'http://127.0.0.1:5180',
      'http://localhost:5180',
    ])

    expect(trustedWebOrigins({ SHUTTLE_WEB_URL: 'http://localhost:5180/' })).toEqual([
      'http://127.0.0.1:5180',
      'http://localhost:5180',
    ])
  })

  test('a deployed web app is trusted on its own origin only', () => {
    expect(trustedWebOrigins({ SHUTTLE_WEB_URL: 'https://shuttle.example.com' })).toEqual([
      'https://shuttle.example.com',
    ])
  })
})

async function signUpFrom(origin: string): Promise<number> {
  const auth = createAuth(TEST_AUTH_ENV, await migratedD1())

  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      // A browser sends its cookies along, which is what makes Better Auth check the origin.
      headers: { 'content-type': 'application/json', origin, cookie: 'theme=dark' },
      body: JSON.stringify({
        email: 'dev@example.com',
        password: 'correct horse battery staple',
        name: 'Dev',
      }),
    }),
  )

  return response.status
}

describe('sign-up origin check', () => {
  test('the app opened as localhost can create an account', async () => {
    expect(await signUpFrom('http://localhost:5180')).toBe(200)
    expect(await signUpFrom('http://127.0.0.1:5180')).toBe(200)
  })

  test('another site cannot', async () => {
    expect(await signUpFrom('https://evil.example.com')).toBe(403)
  })
})
