import { useQuery } from '@tanstack/react-query'
import { createContext, useContext, useMemo, type ReactNode } from 'react'

import type { Tenant } from '@shuttle/api'
import { LoomsProvider } from '@swirls/looms/react'

import type { ShuttleDevice } from './device'
import type { ShuttleApi, ShuttleHost } from './host'
import { peopleQuery, type ShuttleIdentity } from './identity'
import type { ShuttleDestination, ShuttleLinkProps, ShuttleRouter } from './router'

export interface ShuttleContextValue {
  readonly host: ShuttleHost
  readonly identity: ShuttleIdentity
  readonly router: Pick<ShuttleRouter, 'Link' | 'navigate'>
}

const ShuttleContext = createContext<ShuttleContextValue | null>(null)

/** Kept apart from the rest, so moving between pages renders only what shows where it is. */
const LocationContext = createContext<ShuttleDestination | null>(null)

export interface ShuttleProviderProps {
  /** How to reach the backend, and the machine this is on. See `createShuttleHost`. */
  readonly host: ShuttleHost
  /** How to move around inside whatever is hosting the components. */
  readonly router: ShuttleRouter
  /** Who is signed in. */
  readonly identity: ShuttleIdentity
  readonly children: ReactNode
}

/**
 * Everything Shuttle's components are given by what hosts them. Every other Shuttle component
 * goes somewhere inside one. It expects a TanStack `QueryClientProvider` above it.
 */
export function ShuttleProvider({ host, router, identity, children }: ShuttleProviderProps) {
  const { Link: HostLink, navigate, location } = router

  const value = useMemo(
    () => ({ host, identity, router: { Link: HostLink, navigate } }),
    [host, identity, HostLink, navigate],
  )

  return (
    <ShuttleContext value={value}>
      <LocationContext value={location}>
        <LoomsProvider {...host.runStoreOptions(identity.tenant.user.id)}>{children}</LoomsProvider>
      </LocationContext>
    </ShuttleContext>
  )
}

export function useShuttle(): ShuttleContextValue {
  const value = useContext(ShuttleContext)

  if (!value) {
    throw new Error('Shuttle components must be used inside <Shuttle.Provider>')
  }

  return value
}

export function useShuttleHost(): ShuttleHost {
  return useShuttle().host
}

/** The backend's API as TanStack Query options. */
export function useApi(): ShuttleApi {
  return useShuttle().host.api
}

/** The machine this is running on, or null when it has none. */
export function useDevice(): ShuttleDevice | null {
  return useShuttle().host.device
}

/** The signed-in person and their organization. */
export function useTenant(): Tenant {
  return useShuttle().identity.tenant
}

const nobody: ReadonlyMap<string, string> = new Map()

/** Names for the people in the signed-in organization, by user id. Empty until they load. */
export function useOrgPeople(): ReadonlyMap<string, string> {
  const { identity } = useShuttle()
  const { data } = useQuery(peopleQuery(identity.tenant.org.id, identity.listPeople))

  return useMemo(
    () =>
      data ? new Map(data.map((person) => [person.userId, person.name || person.email])) : nobody,
    [data],
  )
}

/** An anchor to one of Shuttle's destinations, drawn by the host's router. */
export function Link(props: ShuttleLinkProps) {
  const { Link: HostLink } = useShuttle().router

  return <HostLink {...props} />
}

/** Returns a function that goes to one of Shuttle's destinations. */
export function useNavigate(): (to: ShuttleDestination) => void {
  return useShuttle().router.navigate
}

/** The destination now on screen, or null when the host is showing something else. */
export function useLocation(): ShuttleDestination | null {
  return useContext(LocationContext)
}
