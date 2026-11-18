import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'

import { type ShuttleDestination, type ShuttleLinkProps, type ShuttleRouter } from '@shuttle/react'

/**
 * Where each of Shuttle's destinations is in this app. Written out per page so the router
 * checks every address and its parameters.
 */
function HostLink({ to, ...rest }: ShuttleLinkProps) {
  switch (to.page) {
    case 'home':
      return <Link {...rest} to="/" />
    case 'session':
      return (
        <Link
          {...rest}
          to="/sessions/$sessionId"
          params={{ sessionId: to.sessionId }}
          search={to.thread !== undefined && to.thread !== '' ? { thread: to.thread } : {}}
        />
      )
    case 'folder':
      return <Link {...rest} to="/folders/$folderId" params={{ folderId: to.folderId }} />
    case 'playbook':
      return <Link {...rest} to="/playbook" />
    case 'events':
      return <Link {...rest} to="/events" />
    case 'connections':
      return <Link {...rest} to="/connections" />
  }
}

function useHostNavigate(): (to: ShuttleDestination) => void {
  const navigate = useNavigate()

  return useCallback(
    (to) => {
      switch (to.page) {
        case 'home':
          return void navigate({ to: '/' })
        case 'session':
          return void navigate({
            to: '/sessions/$sessionId',
            params: { sessionId: to.sessionId },
            search: to.thread !== undefined && to.thread !== '' ? { thread: to.thread } : {},
          })
        case 'folder':
          return void navigate({ to: '/folders/$folderId', params: { folderId: to.folderId } })
        case 'playbook':
          return void navigate({ to: '/playbook' })
        case 'events':
          return void navigate({ to: '/events' })
        case 'connections':
          return void navigate({ to: '/connections' })
      }
    },
    [navigate],
  )
}

const PAGES = new Map<string, ShuttleDestination>([
  ['/', { page: 'home' }],
  ['/playbook', { page: 'playbook' }],
  ['/events', { page: 'events' }],
  ['/connections', { page: 'connections' }],
])

function destinationAt(pathname: string): ShuttleDestination | null {
  const page = PAGES.get(pathname)

  if (page !== undefined) {
    return page
  }

  const [, kind, id, more] = pathname.split('/')

  if (id === undefined || id === '' || more !== undefined) {
    return null
  }

  if (kind === 'sessions') {
    return { page: 'session', sessionId: decodeURIComponent(id) }
  }

  if (kind === 'folders') {
    return { page: 'folder', folderId: decodeURIComponent(id) }
  }

  return null
}

function useHostLocation(): ShuttleDestination | null {
  return useRouterState({
    select: (state) => destinationAt(state.location.pathname),
    structuralSharing: true,
  })
}

/** Shuttle's components, moved around by this app's TanStack Router. */
export function useShuttleRouter(): ShuttleRouter {
  const navigate = useHostNavigate()
  const location = useHostLocation()

  return useMemo(() => ({ Link: HostLink, navigate, location }), [navigate, location])
}
