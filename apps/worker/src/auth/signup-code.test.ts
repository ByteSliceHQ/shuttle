import { describe, expect, test } from 'bun:test'

import { refuseSignUp, signUpCodeRequired, SIGNUP_CODE_HEADER } from './signup-code'

const signUp = (code?: string, path = '/api/auth/sign-up/email') =>
  new Request(`https://shuttle.example${path}`, {
    method: 'POST',
    headers: code === undefined ? {} : { [SIGNUP_CODE_HEADER]: code },
  })

describe('the sign-up code', () => {
  test('a deployment with a code refuses sign-up without it, or with the wrong one', async () => {
    const env = { SHUTTLE_SIGNUP_CODE: 'loom-and-shuttle' }

    expect(signUpCodeRequired(env)).toBe(true)
    expect(refuseSignUp(signUp(), env)?.status).toBe(403)
    expect(refuseSignUp(signUp('loom-and-shuttl'), env)?.status).toBe(403)
    expect(refuseSignUp(signUp('loom-and-shuttle-and-more'), env)?.status).toBe(403)
    expect(refuseSignUp(signUp(' loom-and-shuttle '), env)).toBeNull()
  })

  test('signing in never needs it', () => {
    const env = { SHUTTLE_SIGNUP_CODE: 'loom-and-shuttle' }

    expect(refuseSignUp(signUp(undefined, '/api/auth/sign-in/email'), env)).toBeNull()
    expect(refuseSignUp(signUp(undefined, '/api/auth/get-session'), env)).toBeNull()
  })

  test('without a code set, sign-up is open', () => {
    expect(signUpCodeRequired({})).toBe(false)
    expect(signUpCodeRequired({ SHUTTLE_SIGNUP_CODE: '  ' })).toBe(false)
    expect(refuseSignUp(signUp(), {})).toBeNull()
  })
})
