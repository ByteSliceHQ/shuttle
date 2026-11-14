import { describe, expect, test } from 'bun:test'

import { sandboxNameForSession } from '../session/bind-sandbox'
import { SPONSOR_STORAGE_KEY } from '../session/sponsor'
import { ACCESS_STORAGE_KEY } from '../tenancy/access'
import { scopedRunId } from '../tenancy/run-id'
import { daytonaSandboxName } from './daytona'
import { orgOfSandbox, sandboxesArePersonal, userSandboxName } from './names'

const ORG = 'orgA0000000000000000000000000000'
const session = scopedRunId(ORG, 'session_1')

function storageWith(values: Record<string, unknown>): DurableObjectStorage {
  const map = new Map(Object.entries(values))

  return {
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value)
    },
  } as unknown as DurableObjectStorage
}

const ownedByAlice = {
  [ACCESS_STORAGE_KEY]: { ownerId: 'alice', memberIds: ['bob'], visibility: 'private' },
}

describe('sandbox names', () => {
  test("a person's sandbox names its organization", () => {
    const name = userSandboxName(ORG, 'alice')

    expect(name).toBe(`user:${ORG}:alice`)
    expect(orgOfSandbox(name)).toBe(ORG)
    expect(orgOfSandbox('folder:f1')).toBeNull()
    expect(orgOfSandbox('connections:alice')).toBeNull()
  })

  test('the Daytona name keeps only characters Daytona accepts', () => {
    expect(daytonaSandboxName(`user:${ORG}:alice`)).toBe(`shuttle-user-${ORG}-alice`)
    expect(daytonaSandboxName('folder:a/b c')).toBe('shuttle-folder-a-b-c')
  })

  test('sandboxes are personal only on Daytona', () => {
    expect(sandboxesArePersonal({ SHUTTLE_WORKSPACE_MODE: 'daytona' })).toBe(true)
    expect(sandboxesArePersonal({ SHUTTLE_WORKSPACE_MODE: 'container' })).toBe(false)
    expect(sandboxesArePersonal({})).toBe(false)
  })
})

describe('sandboxNameForSession', () => {
  const daytona = { SHUTTLE_WORKSPACE_MODE: 'daytona' }

  test('elsewhere a session runs in the sandbox it was bound to', async () => {
    const storage = storageWith(ownedByAlice)

    expect(await sandboxNameForSession({}, storage, session, 'folder:f1')).toBe('folder:f1')

    expect(
      await sandboxNameForSession(
        { SHUTTLE_WORKSPACE_MODE: 'container' },
        storage,
        session,
        'folder:f1',
      ),
    ).toBe('folder:f1')
  })

  test("on Daytona a session runs in its owner's sandbox until someone else asks for work", async () => {
    expect(
      await sandboxNameForSession(daytona, storageWith(ownedByAlice), session, 'folder:f1'),
    ).toBe(userSandboxName(ORG, 'alice'))

    expect(
      await sandboxNameForSession(
        daytona,
        storageWith({ ...ownedByAlice, [SPONSOR_STORAGE_KEY]: 'bob' }),
        session,
        'folder:f1',
      ),
    ).toBe(userSandboxName(ORG, 'bob'))
  })

  test('a session with nobody to work for keeps the sandbox it was bound to', async () => {
    expect(await sandboxNameForSession(daytona, storageWith({}), session, 'folder:f1')).toBe(
      'folder:f1',
    )

    // A run with no organization has no person's sandbox to use either.
    expect(
      await sandboxNameForSession(daytona, storageWith(ownedByAlice), 'session_1', 'folder:f1'),
    ).toBe('folder:f1')
  })
})
