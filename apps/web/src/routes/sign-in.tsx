import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { z } from 'zod'

import { api } from '@/api/client'
import { SignInScreen } from '@/features/auth/sign-in-screen'
import { tenantQuery } from '@/features/auth/tenant'

const SignInSearch = z.object({
  /** The invitation the page was opened from, accepted once the person is signed in. */
  invite: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional()
    .catch(undefined),
})

export const Route = createFileRoute('/sign-in')({
  validateSearch: SignInSearch,
  beforeLoad: async ({ context, search }) => {
    // Coming back from GitHub lands here already signed in, so always ask the Worker.
    const tenant = await context.queryClient.query({ ...tenantQuery, staleTime: 0 })

    if (tenant) {
      throw redirect({ to: '/', search })
    }
  },
  loader: ({ context }) =>
    context.queryClient.query({ ...api.auth.providers.queryOptions(), staleTime: 'static' }),
  component: SignInPage,
})

function SignInPage() {
  const { invite } = Route.useSearch()
  const router = useRouter()

  // Running the route again finds the sign-in and sends the person on into the app.
  return <SignInScreen invited={invite !== undefined} onSignedIn={() => router.invalidate()} />
}
