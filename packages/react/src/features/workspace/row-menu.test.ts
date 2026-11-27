import { describe, expect, test } from 'bun:test'

import { folderMenuEntries, sessionMenuEntries } from './row-menu'

function rename() {
  return undefined
}

function archive() {
  return undefined
}

function link() {
  return undefined
}

describe('sessionMenuEntries', () => {
  test('lists only the actions the row can do', () => {
    expect(sessionMenuEntries(rename, archive)).toEqual([
      { kind: 'action', label: 'Rename', onSelect: rename },
      { kind: 'action', label: 'Archive', onSelect: archive },
    ])

    expect(sessionMenuEntries(undefined, archive)).toEqual([
      { kind: 'action', label: 'Archive', onSelect: archive },
    ])

    expect(sessionMenuEntries(undefined, undefined)).toEqual([])
  })
})

describe('folderMenuEntries', () => {
  test('matches the folder menu, and drops archive actions once archived', () => {
    expect(folderMenuEntries(false, rename, link, archive)).toEqual([
      { kind: 'action', label: 'Rename', onSelect: rename },
      { kind: 'action', label: 'Link repositories', onSelect: link },
      { kind: 'separator' },
      { kind: 'action', label: 'Archive', onSelect: archive },
    ])

    expect(folderMenuEntries(true, rename, link, archive)).toEqual([
      { kind: 'action', label: 'Rename', onSelect: rename },
    ])
  })
})
