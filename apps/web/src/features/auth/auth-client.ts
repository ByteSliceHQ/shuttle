import { organizationClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/** Talks to Better Auth on the Worker, which the web app reaches on its own origin. */
export const authClient = createAuthClient({
  plugins: [organizationClient()],
})
