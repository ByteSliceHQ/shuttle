import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

type GithubConnectResult =
  | 'connected'
  | 'requested'
  | 'already_connected'
  | 'missing_installation'
  | 'invalid_state'
  | 'not_found'
  | 'error'

function parseGithubConnectResult(value: string | null): GithubConnectResult | null {
  switch (value) {
    case 'connected':
    case 'requested':
    case 'already_connected':
    case 'missing_installation':
    case 'invalid_state':
    case 'not_found':
    case 'error':
      return value
    default:
      return null
  }
}

function messageFor(result: GithubConnectResult): string {
  switch (result) {
    case 'connected':
      return 'GitHub connected. You can link repos to folders from the sidebar.'
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

function stripGithubQueryParam(): void {
  const url = new URL(window.location.href)

  if (!url.searchParams.has('github')) {
    return
  }

  url.searchParams.delete('github')
  const search = url.searchParams.toString()
  const next = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`

  window.history.replaceState(window.history.state, '', next)
}

export function GithubConnectBanner() {
  const [result, setResult] = useState(() =>
    parseGithubConnectResult(new URLSearchParams(window.location.search).get('github')),
  )

  useEffect(() => {
    stripGithubQueryParam()
  }, [])

  if (!result) {
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
