import type { ShuttleEnv } from '../env'
import { AUTH_BASE_PATH } from './auth'

/**
 * The sign-up code: a shared word a deployment can require before anyone may create an account.
 *
 * A deployment is on the public internet and every session spends its keys, so being able to
 * reach the sign-up form must not be enough to get an account. With `SHUTTLE_SIGNUP_CODE` set,
 * creating an account by email needs the code, and signing in with GitHub only works for people
 * who already have an account (see `auth.ts`). Signing in is unaffected. Without the variable,
 * as in local development, sign-up is open.
 */

export const SIGNUP_CODE_HEADER = 'x-shuttle-signup-code'

export function signUpCodeRequired(env: Pick<ShuttleEnv, 'SHUTTLE_SIGNUP_CODE'>): boolean {
  return Boolean(env.SHUTTLE_SIGNUP_CODE?.trim())
}

/** Compares without stopping at the first difference, so timing says nothing about the code. */
function same(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  let difference = a.length ^ b.length

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }

  return difference === 0
}

/**
 * The answer to a request that tries to create an account without the code, or null when the
 * request may go on to sign-in as usual.
 */
export function refuseSignUp(
  request: Request,
  env: Pick<ShuttleEnv, 'SHUTTLE_SIGNUP_CODE'>,
): Response | null {
  const code = env.SHUTTLE_SIGNUP_CODE?.trim()

  if (
    code === undefined ||
    code === '' ||
    !new URL(request.url).pathname.startsWith(`${AUTH_BASE_PATH}/sign-up`)
  ) {
    return null
  }

  return same(request.headers.get(SIGNUP_CODE_HEADER)?.trim() ?? '', code)
    ? null
    : Response.json(
        { code: 'SIGNUP_CODE_REQUIRED', message: 'That sign-up code is not right.' },
        { status: 403 },
      )
}
