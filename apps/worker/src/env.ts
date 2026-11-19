import type { EngineEnv } from '@shuttle/engine/env'

export { sandboxStub, type SessionSandboxStub } from '@shuttle/engine/env'

/**
 * Everything the Cloudflare Worker is configured with: what the engine reads (`EngineEnv`) plus
 * sign-in and the HTTP edge, which the engine never sees.
 */
export interface ShuttleEnv extends EngineEnv {
  /** The built web app, in a deployment. Absent in development, where Vite serves it. */
  readonly WEB?: Fetcher
  /** Accounts, organizations and sign-in sessions (Better Auth), plus tenancy tables. */
  readonly AUTH_DB?: D1Database
  /** Signs sign-in sessions. At least 32 random characters. */
  readonly BETTER_AUTH_SECRET?: string
  /** When set, creating an account needs this code. See `auth/signup-code.ts`. */
  readonly SHUTTLE_SIGNUP_CODE?: string
  /** GitHub OAuth client for "Sign in with GitHub". Optional; email and password always work. */
  readonly GITHUB_CLIENT_ID?: string
  readonly GITHUB_CLIENT_SECRET?: string
}
