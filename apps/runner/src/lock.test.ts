import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { takeLock } from './lock'

const home = () => mkdtempSync(join(tmpdir(), 'shuttle-runner-'))

describe('the runner lock', () => {
  test('is held by one runner at a time, and can be taken again once given back', () => {
    const dir = home()
    const release = takeLock('abc', dir)

    expect(release).not.toBeNull()
    // Held by this very process, which a second runner would not be. Its parent stands in.
    writeFileSync(join(dir, 'abc.lock'), String(process.ppid))
    expect(takeLock('abc', dir)).toBeNull()

    writeFileSync(join(dir, 'abc.lock'), String(process.pid))
    release?.()
    expect(takeLock('abc', dir)).not.toBeNull()
  })

  test('a lock left by a runner that died is taken over', () => {
    const dir = home()

    // Far above any pid the system hands out.
    writeFileSync(join(dir, 'abc.lock'), '2147483646')

    expect(takeLock('abc', dir)).not.toBeNull()
  })

  test('each sandbox has its own lock', () => {
    const dir = home()

    writeFileSync(join(dir, 'abc.lock'), String(process.ppid))

    expect(takeLock('abc', dir)).toBeNull()
    expect(takeLock('xyz', dir)).not.toBeNull()
  })
})
