import { oc } from '@orpc/contract'
import { z } from 'zod'

/** The ways this deployment lets someone sign in. */
export const SignInProviders = z.object({
  emailAndPassword: z.boolean(),
  github: z.boolean(),
  /** Whether creating an account needs the deployment's sign-up code. */
  signUpCode: z.boolean(),
})
export type SignInProviders = z.infer<typeof SignInProviders>

/** Routes that answer before anyone has signed in. */
export const publicContract = {
  auth: {
    providers: oc.route({ method: 'GET', path: '/auth/providers' }).output(SignInProviders),
  },
}
