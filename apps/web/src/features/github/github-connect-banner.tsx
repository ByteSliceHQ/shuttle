import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button, cn } from '@shuttle/react/ui'

/** The signed-in layout, which is where the `github` search param is declared and checked. */
const appRoute = getRouteApi('/_app')

/** How connecting GitHub went, as GitHub's way back to the app says it in the address. */
function useGithubSearchParam() {
  return appRoute.useSearch({ select: (search) => search.github })
}

type GithubConnectResult = NonNullable<ReturnType<typeof useGithubSearchParam>>

function messageFor(result: GithubConnectResult): string {
  switch (result) {
    case 'connected':
      return 'GitHub connected. You can link repositories to folders from the sidebar.'
    case 'requested':
      return 'Install request sent to the GitHub organization’s owners. Once they approve it, choose Connect GitHub again to link it.'
    case 'already_connected':
      return 'That GitHub installation is already connected to another Shuttle organization.'
    case 'missing_installation':
      return 'GitHub did not return an installation. Try Connect GitHub again.'
    case 'invalid_state':
      return 'GitHub connect link expired or was tampered with. Try again.'
    case 'not_found':
      return 'That GitHub App installation was not found. Reinstall the app and try again.'
    case 'error':
      return 'GitHub connect failed. Check worker logs and App credentials, then try again.'

    default: {
      const exhaustive: never = result
      return exhaustive
    }
  }
}

export function GithubConnectBanner() {
  const github = useGithubSearchParam()
  const navigate = useNavigate()
  // Kept apart from the address, so the banner outlives the param being taken out of it.
  const [result, setResult] = useState<GithubConnectResult | null>(github ?? null)

  // The answer is shown once. Left in the address, a reload or a shared link would show it again.
  useEffect(() => {
    if (github !== undefined) {
      void navigate({ to: '.', search: (prev) => ({ ...prev, github: undefined }), replace: true })
    }
  }, [github, navigate])

  if (result === null) {
    return null
  }

  const ok = result === 'connected' || result === 'requested'

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 border-b px-4 py-2.5 text-xs leading-relaxed',
        ok
          ? 'border-status-completed/30 bg-status-completed/10 text-status-completed'
          : 'border-status-failed/30 bg-status-failed/10 text-status-failed',
      )}
    >
      {ok ? (
        <Check className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <X className="mt-0.5 size-3.5 shrink-0" />
      )}
      <p className="min-w-0 flex-1 text-pretty">{messageFor(result)}</p>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        className="text-inherit hover:bg-transparent hover:text-inherit"
        onClick={() => setResult(null)}
      >
        <X />
      </Button>
    </div>
  )
}
