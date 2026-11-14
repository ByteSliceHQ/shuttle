import { describe, expect, test } from 'bun:test'

import { migratedD1 } from '../testing/fake-d1'
import {
  claimInstallation,
  connectInstallation,
  disconnectInstallation,
  installationConnected,
  orgsOfInstallation,
} from './installations'

describe('installation connections', () => {
  test('one installation can be connected to several organizations', async () => {
    const db = await migratedD1()

    expect(await orgsOfInstallation(db, 42)).toEqual([])

    await connectInstallation(db, 42, 'orgA', 1)
    await connectInstallation(db, 42, 'orgB', 2)
    // Connecting again changes nothing.
    await connectInstallation(db, 42, 'orgA', 3)

    expect(await orgsOfInstallation(db, 42)).toEqual(['orgA', 'orgB'])
    expect(await installationConnected(db, 42, 'orgA')).toBe(true)
    expect(await installationConnected(db, 42, 'orgB')).toBe(true)
  })

  test('an organization may use only the installations it connected', async () => {
    const db = await migratedD1()

    await connectInstallation(db, 42, 'orgA')

    expect(await installationConnected(db, 42, 'orgC')).toBe(false)
    expect(await installationConnected(db, 7, 'orgA')).toBe(false)
  })

  test('disconnecting in one organization leaves the others connected', async () => {
    const db = await migratedD1()

    await connectInstallation(db, 42, 'orgA')
    await connectInstallation(db, 42, 'orgB')
    await disconnectInstallation(db, 42, 'orgA')

    expect(await orgsOfInstallation(db, 42)).toEqual(['orgB'])
  })

  test('without proof of access, only an unclaimed installation can be taken', async () => {
    const db = await migratedD1()

    expect(await claimInstallation(db, 42, 'orgA')).toBe(true)
    // Its owner claiming it again is fine; someone else is refused.
    expect(await claimInstallation(db, 42, 'orgA')).toBe(true)
    expect(await claimInstallation(db, 42, 'orgB')).toBe(false)
    expect(await orgsOfInstallation(db, 42)).toEqual(['orgA'])
  })
})
