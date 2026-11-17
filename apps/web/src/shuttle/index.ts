/**
 * What Shuttle's components are built on, and the only way they reach the world outside them.
 *
 * Nothing under `src/features` (other than `auth`, `desktop` and `github`, which belong to
 * Shuttle's own app) may import the app's router, its API client, its sign-in client or
 * `window.shuttleDesktop`. They ask for those here, and whatever is hosting them answers through
 * `<Shuttle.Provider>` (see `src/parts`). That is what lets the same components be put together differently, in
 * Shuttle's app or in someone else's.
 */
export { isolationLabel, type DeviceRunnerStatus, type ShuttleDevice } from './device'
export {
  createShuttleHost,
  isSignedOut,
  SignalError,
  statusOf,
  type CallContext,
  type ShuttleApi,
  type ShuttleClient,
  type ShuttleFetch,
  type ShuttleHost,
  type ShuttleHostOptions,
} from './host'
export { peopleQuery, possessive, type ShuttleIdentity, type ShuttlePerson } from './identity'
export {
  Link,
  ShuttleProvider,
  useApi,
  useDevice,
  useLocation,
  useNavigate,
  useOrgPeople,
  useShuttle,
  useShuttleHost,
  useTenant,
  type ShuttleContextValue,
  type ShuttleProviderProps,
} from './provider'
export type { ShuttleDestination, ShuttleLinkProps, ShuttleRouter } from './router'
