import {
  personalWorkspaceRunId,
  playbookRunId,
  pullsRunId,
  workspaceRunId,
} from '@shuttle/engine/config'

import { api } from './base'

export const tenantRouter = {
  me: api.tenant.me.handler(({ context: { env, actor } }) => ({
    user: { id: actor.userId, name: actor.name, email: actor.email },
    org: { id: actor.orgId, role: actor.role },
    runs: {
      workspace: workspaceRunId(env, actor.orgId),
      personal: personalWorkspaceRunId(env, actor.orgId, actor.userId),
      pulls: pullsRunId(env, actor.orgId),
      playbook: playbookRunId(env, actor.orgId),
    },
  })),
}
