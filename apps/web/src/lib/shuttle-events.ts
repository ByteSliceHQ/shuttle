// Type-only: the worker owns the event catalogs, and these imports are erased at build time.
import type { pullsCatalog } from '@worker/pulls/scope'
import type { workspaceCatalog } from '@worker/workspace/scope'

import type { EventsOfCatalog, ProtocolEvents } from '@swirls/looms/core'

/** Every event the workspace run can carry: the runtime's own plus the workspace catalog. */
export type WorkspaceEvent = ProtocolEvents | EventsOfCatalog<typeof workspaceCatalog>

/** Every event the pulls run can carry. */
export type PullsEvent = ProtocolEvents | EventsOfCatalog<typeof pullsCatalog>
