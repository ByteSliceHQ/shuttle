import { createAuth, type Auth } from '../auth/auth'
import { migratedD1 } from './fake-d1'

export const TEST_WEB_ORIGIN = 'http://127.0.0.1:5180'

export const TEST_AUTH_ENV = {
  BETTER_AUTH_SECRET: 'test-only-secret-0123456789abcdef0123456789',
  SHUTTLE_WEB_URL: TEST_WEB_ORIGIN,
}

/** A working auth instance over an in-memory database with the committed schema. */
export async function testAuth(): Promise<{ auth: Auth; database: D1Database }> {
  const database = await migratedD1()

  return { auth: createAuth(TEST_AUTH_ENV, database), database }
}

/** Creates an account and returns the headers a browser signed in to it would send. */
export async function signUp(auth: Auth, name: string): Promise<Headers> {
  const response = await auth.handler(
    new Request(`${TEST_WEB_ORIGIN}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: TEST_WEB_ORIGIN },
      body: JSON.stringify({
        email: `${name.toLowerCase()}@example.com`,
        password: 'correct horse battery staple',
        name,
      }),
    }),
  )

  if (!response.ok) {
    throw new Error(`sign-up failed: ${response.status} ${await response.text()}`)
  }

  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')

  return new Headers({ cookie, origin: TEST_WEB_ORIGIN })
}
