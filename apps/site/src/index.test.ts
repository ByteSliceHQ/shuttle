import { expect, test } from 'bun:test'

import { releaseName } from './index'

test('accepts a build file name', () => {
  expect(releaseName('/download/Shuttle-0.0.1-arm64.dmg')).toBe('Shuttle-0.0.1-arm64.dmg')
})

test('refuses anything that is not a plain build file name', () => {
  for (const path of [
    '/download/',
    '/download/../secret.dmg',
    '/download/a/b.dmg',
    '/download/notes.txt',
    '/download/.dmg',
  ]) {
    expect(releaseName(path)).toBeNull()
  }
})
