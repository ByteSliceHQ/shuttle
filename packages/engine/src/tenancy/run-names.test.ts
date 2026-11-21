import { describe, expect, test } from 'bun:test'

import { sessionTenant } from '@shuttle/api'

import { personalWorkspaceRunId, playbookRunId, workspaceRunId } from '../config'
import { fakeEnv } from '../testing/fake-env'
import { runNames } from './run-names'

describe("a page's own tenant", () => {
  test('names the runs the engine keeps, renamed or not', () => {
    for (const overrides of [
      {},
      { SHUTTLE_WORKSPACE_RUN_ID: 'ws', SHUTTLE_PLAYBOOK_RUN_ID: 'pb', SHUTTLE_PULLS_RUN_ID: 'pr' },
    ]) {
      const env = fakeEnv(overrides)
      const user = { id: 'u1', name: 'Ada', email: 'ada@example.com' }
      const { runs } = sessionTenant({ user, orgId: 'org1', runNames: runNames(env) })

      expect(runs).toEqual({
        workspace: workspaceRunId(env, 'org1'),
        personal: personalWorkspaceRunId(env, 'org1', 'u1'),
        pulls: null,
        playbook: playbookRunId(env, 'org1'),
      })
    }
  })
})
