import { describe, expect, test } from 'bun:test'

import { parsePersonalRunId } from './run-id'
import { sessionTenant, Tenant } from './tenant'

const user = { id: 'u1', name: 'Ada', email: 'ada@example.com' }

describe('sessionTenant', () => {
  test("gives the organization's runs, the person's own workspace and no pulls", () => {
    const tenant = sessionTenant({ user, orgId: 'org1' })

    expect(tenant).toEqual({
      user,
      org: { id: 'org1', role: 'member' },
      runs: {
        workspace: 'o-org1-shuttle-workspace',
        personal: 'o-org1-member-u1-shuttle-workspace',
        pulls: null,
        playbook: 'o-org1-shuttle-playbook',
      },
    })

    expect(Tenant.parse(tenant)).toEqual(tenant)

    expect(parsePersonalRunId(tenant.runs.personal)).toEqual({
      orgId: 'org1',
      userId: 'u1',
      local: 'shuttle-workspace',
    })
  })

  test("keeps the role it is given and a deployment's names for its runs", () => {
    const tenant = sessionTenant({
      user,
      orgId: 'org1',
      role: 'owner',
      runNames: { workspace: 'ws' },
    })

    expect(tenant.org.role).toBe('owner')

    expect(tenant.runs).toEqual({
      workspace: 'o-org1-ws',
      personal: 'o-org1-member-u1-ws',
      pulls: null,
      playbook: 'o-org1-shuttle-playbook',
    })
  })

  test('refuses an organization or person id a run id cannot carry', () => {
    expect(() => sessionTenant({ user, orgId: 'org-1' })).toThrow('invalid organization id')

    expect(() => sessionTenant({ user: { ...user, id: 'u_1' }, orgId: 'org1' })).toThrow(
      'invalid user id',
    )
  })
})
