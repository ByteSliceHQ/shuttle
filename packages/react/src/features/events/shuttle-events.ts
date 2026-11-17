// Type-only: the runs' event catalogs live in `@shuttle/core`, which the Worker registers.
import type { pullsCatalog } from '@shuttle/core/pulls'
import type { workspaceCatalog } from '@shuttle/core/workspace'
import type { EventsOfCatalog, ProtocolEvents } from '@swirls/looms/core'

/** Every event the workspace run can carry: the runtime's own plus the workspace catalog. */
export type WorkspaceEvent = ProtocolEvents | EventsOfCatalog<typeof workspaceCatalog>

/** Every event the pulls run can carry. */
export type PullsEvent = ProtocolEvents | EventsOfCatalog<typeof pullsCatalog>
