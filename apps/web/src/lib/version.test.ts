import { describe, expect, test } from 'bun:test'

import { versionReport, webVersion, type ShuttleVersion } from './version'

const released: ShuttleVersion = {
  release: '0.1.150',
  commit: 'e4cb471',
  builtAt: '2026-11-22T10:00:00.000Z',
  desktop: null,
}

describe('webVersion', () => {
  test('names the release and its commit once deployed', () => {
    expect(webVersion(released)).toBe('0.1.150 · e4cb471')
  })

  test('names the commit alone for a local build', () => {
    expect(webVersion({ ...released, release: '' })).toBe('e4cb471')
  })

  test('says so when it knows neither', () => {
    expect(webVersion({ ...released, release: '', commit: '' })).toBe('unknown')
  })
})

describe('versionReport', () => {
  test('lists both apps, when it was built and the browser', () => {
    expect(versionReport({ ...released, desktop: '0.1.142' }, 'UA')).toBe(
      [
        'Shuttle web 0.1.150 · e4cb471',
        'Built 2026-11-22T10:00:00.000Z',
        'Shuttle desktop 0.1.142',
        'UA',
      ].join('\n'),
    )
  })

  test('leaves out a desktop app it is not running in', () => {
    expect(versionReport({ ...released, release: '' }, 'UA')).toBe(
      ['Shuttle web e4cb471', 'Built 2026-11-22T10:00:00.000Z', 'UA'].join('\n'),
    )
  })
})
