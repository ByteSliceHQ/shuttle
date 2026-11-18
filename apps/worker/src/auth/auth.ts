import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { organization } from 'better-auth/plugins'

import type { ShuttleEnv } from '../env'

/**
 * Accounts, sign-in sessions and organizations, provided by Better Auth and stored in D1.
 *
 * Everything else in Shuttle sees only an `Actor` (see `actor.ts`): the signed-in person and the
 * organization they are working in.
 */

export const AUTH_BASE_PATH = '/api/auth'

export class AuthUnavailableError extends Error {
  constructor(missing: string) {
    super(`${missing} is not configured; sign-in is unavailable`)
    this.name = 'AuthUnavailableError'
  }
}

type AuthEnv = Pick<
  ShuttleEnv,
  | 'BETTER_AUTH_SECRET'
  | 'SHUTTLE_WEB_URL'
  | 'GITHUB_CLIENT_ID'
  | 'GITHUB_CLIENT_SECRET'
  | 'SHUTTLE_SIGNUP_CODE'
>

/** The web app's origin. Sign-in requests reach the Worker through it. */
export function webOrigin(env: Pick<ShuttleEnv, 'SHUTTLE_WEB_URL'>): string {
  return env.SHUTTLE_WEB_URL ?? 'http://127.0.0.1:5180'
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost']

/**
 * The origins sign-in requests may come from: the web app's. In local development the same
 * server answers on both `127.0.0.1` and `localhost`, and a browser may use either, so when the
 * web app is on one loopback name the other is trusted too.
 */
export function trustedWebOrigins(env: Pick<ShuttleEnv, 'SHUTTLE_WEB_URL'>): string[] {
  const origin = new URL(webOrigin(env))

  if (!LOOPBACK_HOSTS.includes(origin.hostname)) {
    return [origin.origin]
  }

  return LOOPBACK_HOSTS.map((host) => {
    const alias = new URL(origin.origin)
    alias.hostname = host

    return alias.origin
  })
}

export function githubSignInEnabled(env: AuthEnv): boolean {
  return (
    (env.GITHUB_CLIENT_ID?.trim() ?? '') !== '' && (env.GITHUB_CLIENT_SECRET?.trim() ?? '') !== ''
  )
}

/**
 * Better Auth's configuration. `database` is the D1 binding in the Worker and a `bun:sqlite`
 * database in tests and in the script that writes the schema migration.
 */
export function authOptions(env: AuthEnv, database: BetterAuthOptions['database']) {
  const secret = env.BETTER_AUTH_SECRET?.trim()

  if (secret === undefined || secret === '') {
    throw new AuthUnavailableError('BETTER_AUTH_SECRET')
  }

  return {
    database,
    secret,
    baseURL: webOrigin(env),
    basePath: AUTH_BASE_PATH,
    trustedOrigins: trustedWebOrigins(env),
    emailAndPassword: { enabled: true },
    // Someone signed in by email can connect their GitHub account, so what they say on a pull
    // request is posted as them. Their GitHub address need not match the one they signed up with.
    // GitHub is trusted because the App's sign-in cannot read a person's email addresses, so
    // GitHub never reports one as verified, and an unverified provider is refused outright.
    account: {
      accountLinking: { enabled: true, allowDifferentEmails: true, trustedProviders: ['github'] },
    },
    socialProviders: githubSignInEnabled(env)
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID ?? '',
            clientSecret: env.GITHUB_CLIENT_SECRET ?? '',
            // Where creating an account needs a code, GitHub cannot be a way around it: it
            // signs in people who already have an account and have connected GitHub to it.
            disableSignUp: Boolean(env.SHUTTLE_SIGNUP_CODE?.trim()),
          },
        }
      : {},
    plugins: [organization()],
    advanced: {
      // Workers requests carry the client address here, not in X-Forwarded-For.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // Stated outright because Better Auth otherwise turns the check off under a test runner,
      // and the tests should see what a browser sees.
      disableOriginCheck: false,
    },
  } satisfies BetterAuthOptions
}

export function createAuth(env: AuthEnv, database: BetterAuthOptions['database']) {
  return betterAuth(authOptions(env, database))
}

export type Auth = ReturnType<typeof createAuth>

const instances = new WeakMap<object, Auth>()

/** The Worker's auth instance, built once per isolate. */
export function getAuth(env: ShuttleEnv): Auth {
  const cached = instances.get(env)

  if (cached) {
    return cached
  }

  if (!env.AUTH_DB) {
    throw new AuthUnavailableError('The AUTH_DB database')
  }

  const auth = createAuth(env, env.AUTH_DB)
  instances.set(env, auth)

  return auth
}
