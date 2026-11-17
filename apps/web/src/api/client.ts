import { host } from '@/host'

export { isSignedOut, statusOf, type CallContext } from '@/shuttle'

/**
 * The Worker's API for the app's own code: route loaders, sign-in, the pages. Components under
 * `src/features` that other hosts can use ask `useApi()` instead, so they follow whichever
 * backend they were given.
 */
export const client = host.client

/** The same API as TanStack Query options, for loaders and pages. */
export const api = host.api
