import { api } from '@/api/client'
import { deviceContext } from '@/features/desktop/desktop'

/**
 * The viewer's connections. From the desktop app the listing covers this machine as well as
 * the cloud. Everything that shows connections reads this one query.
 */
export function connectionsQuery() {
  return api.connections.list.queryOptions({ context: deviceContext() })
}
