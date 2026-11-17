import { type ShuttleHost } from '@/shuttle'

/**
 * The viewer's connections. From a host with a machine the listing covers this machine as well as
 * the cloud. Everything that shows connections reads this one query.
 */
export function connectionsQuery(host: ShuttleHost) {
  return host.api.connections.list.queryOptions({ context: host.deviceContext() })
}
