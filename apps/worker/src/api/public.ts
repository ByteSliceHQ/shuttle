import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { implement } from '@orpc/server'

import { publicContract } from '@shuttle/api'

import { githubSignInEnabled } from '../auth/auth'
import { signUpCodeRequired } from '../auth/signup-code'
import type { ShuttleEnv } from '../env'

const open = implement(publicContract).$context<{ readonly env: ShuttleEnv }>()

const handler = new OpenAPIHandler(
  open.router({
    auth: {
      providers: open.auth.providers.handler(({ context: { env } }) => ({
        emailAndPassword: true,
        github: githubSignInEnabled(env),
        signUpCode: signUpCodeRequired(env),
      })),
    },
  }),
)

/** Answers a request for a route that needs no sign-in, or null when it is for something else. */
export async function handlePublicApi(request: Request, env: ShuttleEnv): Promise<Response | null> {
  const { matched, response } = await handler.handle(request, { context: { env } })

  return matched ? response : null
}
