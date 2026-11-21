import { tenantRunIds } from '@shuttle/api'
import { runNames } from '@shuttle/engine/tenancy/run-names'

import { api } from './base'

export const tenantRouter = {
  me: api.tenant.me.handler(({ context: { env, actor } }) => ({
    user: { id: actor.userId, name: actor.name, email: actor.email },
    org: { id: actor.orgId, role: actor.role },
    runs: tenantRunIds(actor.orgId, actor.userId, runNames(env)),
  })),
}
