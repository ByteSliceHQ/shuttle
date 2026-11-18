import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from './store'

function storeWith(contents: string): Store {
  const file = join(mkdtempSync(join(tmpdir(), 'shuttle-store-')), 'state.json')

  writeFileSync(file, contents)

  return new Store(file)
}

describe('Store', () => {
  test('keeps what can be read when one key cannot', () => {
    const store = storeWith(
      JSON.stringify({
        deviceId: 'device-1',
        window: { width: 800 },
        machines: {
          'https://a.example': { userId: 'u', orgId: 'o', token: 't', encrypted: true },
          'https://b.example': { userId: 'u' },
        },
      }),
    )

    expect(store.get('deviceId')).toBe('device-1')
    expect(store.get('window')).toBeUndefined()

    expect(store.get('machines')).toEqual({
      'https://a.example': { userId: 'u', orgId: 'o', token: 't', encrypted: true },
    })
  })

  test('starts empty when the file is not an object or not JSON', () => {
    expect(storeWith('[1]').get('deviceId')).toBeUndefined()
    expect(storeWith('nope').get('deviceId')).toBeUndefined()
  })
})
