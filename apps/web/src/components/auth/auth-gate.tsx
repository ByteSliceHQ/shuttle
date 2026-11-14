import { useCallback, useEffect, useState } from 'react'

import { SignInScreen } from '@/components/auth/sign-in-screen'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'
import { errorMessage } from '@/lib/cn'
import { fetchTenant, pendingInvitationId, TenantContext, type TenantResult } from '@/lib/tenant'

/**
 * Renders the app only for a signed-in browser, and tells it who that is. Everything inside can
 * call `useTenant()`.
 *
 * A page opened from an invitation link joins that organization once the person is signed in.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [result, setResult] = useState<TenantResult | null>(null)
  const [invitationId] = useState(() => pendingInvitationId(window.location.search))
  const [inviteError, setInviteError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetchTenant()
      .then(setResult)
      .catch((cause: unknown) => setResult({ kind: 'unavailable', message: errorMessage(cause) }))
  }, [])

  useEffect(load, [load])

  const signedIn = result?.kind === 'signed-in'

  useEffect(() => {
    if (!signedIn || !invitationId) {
      return
    }

    let cancelled = false

    void (async () => {
      const accepted = await authClient.organization.acceptInvitation({ invitationId })

      if (cancelled) {
        return
      }

      if (accepted.error) {
        setInviteError(
          accepted.error.message ??
            'This invitation could not be accepted. It may be for a different email address.',
        )

        return
      }

      await authClient.organization.setActive({
        organizationId: accepted.data.invitation.organizationId,
      })

      // Everything on the page belongs to the previous organization, so start again in the new one.
      window.location.replace('/')
    })()

    return () => {
      cancelled = true
    }
  }, [signedIn, invitationId])

  if (!result) {
    return null
  }

  if (result.kind === 'signed-out') {
    return <SignInScreen invited={invitationId !== null} onSignedIn={load} />
  }

  if (result.kind === 'unavailable') {
    return (
      <Notice title="Shuttle is not ready for sign-in" detail={result.message}>
        <Button variant="outline" onClick={load}>
          Try again
        </Button>
      </Notice>
    )
  }

  if (invitationId && !inviteError) {
    return <Notice title="Joining the organization…" />
  }

  if (inviteError) {
    return (
      <Notice title="The invitation was not accepted" detail={inviteError}>
        <Button variant="outline" onClick={() => window.location.replace('/')}>
          Continue to Shuttle
        </Button>
      </Notice>
    )
  }

  return <TenantContext.Provider value={result.tenant}>{children}</TenantContext.Provider>
}

function Notice({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-start gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
        {detail ? (
          <p className="text-muted-foreground text-[13px] leading-relaxed text-pretty">{detail}</p>
        ) : null}
        {children}
      </div>
    </div>
  )
}
