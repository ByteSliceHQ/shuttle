import { describe, expect, test } from 'bun:test'

import { migratedD1 } from '../testing/fake-d1'
import { bindInstallation, orgOfInstallation, unbindInstallation } from './installations'

describe('GitHub installations', () => {
  test('an installation belongs to the first organization that connects it', async () => {
    const db = await migratedD1()

    expect(await orgOfInstallation(db, 42)).toBeNull()
    expect(await bindInstallation(db, 42, 'orgA')).toBe('orgA')
    // Connecting again is harmless; another organization cannot take it over.
    expect(await bindInstallation(db, 42, 'orgA')).toBe('orgA')
    expect(await bindInstallation(db, 42, 'orgB')).toBe('orgA')
    expect(await orgOfInstallation(db, 42)).toBe('orgA')
  })

  test('only the owning organization can disconnect an installation', async () => {
    const db = await migratedD1()
    await bindInstallation(db, 42, 'orgA')

    await unbindInstallation(db, 42, 'orgB')
    expect(await orgOfInstallation(db, 42)).toBe('orgA')

    await unbindInstallation(db, 42, 'orgA')
    expect(await orgOfInstallation(db, 42)).toBeNull()
    expect(await bindInstallation(db, 42, 'orgB')).toBe('orgB')
  })
})
