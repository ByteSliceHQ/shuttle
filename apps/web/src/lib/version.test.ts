import { describe, expect, test } from 'bun:test'

import { versionLines, versionReport, webVersion, type ShuttleVersion } from './version'

const released: ShuttleVersion = {
  release: '0.1.150',
  commit: 'e4cb471',
  builtAt: '2026-11-22T10:00:00.000Z',
  desktop: null,
}

describe('webVersion', () => {
  test('names the release once deployed', () => {
    expect(webVersion(released)).toBe('0.1.150')
  })

  test('names the commit for a local build', () => {
    expect(webVersion({ ...released, release: '' })).toBe('e4cb471')
  })

  test('says so when it knows neither', () => {
    expect(webVersion({ ...released, release: '', commit: '' })).toBe('unknown')
  })
})

describe('versionLines', () => {
  test('is one line in a browser', () => {
    expect(versionLines(released)).toEqual(['Shuttle 0.1.150'])
  })

  test('is one line when the desktop app matches the web app', () => {
    expect(versionLines({ ...released, desktop: '0.1.150' })).toEqual(['Shuttle 0.1.150'])
  })

  test('names a desktop app that is behind on a line of its own', () => {
    expect(versionLines({ ...released, desktop: '0.1.142' })).toEqual([
      'Shuttle 0.1.150',
      'Desktop 0.1.142',
    ])
  })
})

describe('versionReport', () => {
  test('lists both apps, the commit, when it was built and the browser', () => {
    expect(versionReport({ ...released, desktop: '0.1.142' }, 'UA')).toBe(
      [
        'Shuttle web 0.1.150 (e4cb471)',
        'Built 2026-11-22T10:00:00.000Z',
        'Shuttle desktop 0.1.142',
        'UA',
      ].join('\n'),
    )
  })

  test('names a local build by its commit once', () => {
    expect(versionReport({ ...released, release: '' }, 'UA')).toBe(
      ['Shuttle web e4cb471', 'Built 2026-11-22T10:00:00.000Z', 'UA'].join('\n'),
    )
  })
})
