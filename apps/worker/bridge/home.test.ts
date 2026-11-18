import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectHomeFiles, resolveHomePath, seedHomeFiles } from './home'

describe('home files', () => {
  test('seeds files owner-only and collects them back', () => {
    const home = mkdtempSync(join(tmpdir(), 'shuttle-home-'))
    const auth = btoa('{"token":"abc"}')

    seedHomeFiles(home, { '.codex/auth.json': auth })

    expect(readFileSync(join(home, '.codex/auth.json'), 'utf8')).toBe('{"token":"abc"}')
    expect(statSync(join(home, '.codex/auth.json')).mode & 0o777).toBe(0o600)

    expect(collectHomeFiles(home, ['.codex/auth.json', '.codex/missing.json'])).toEqual({
      '.codex/auth.json': auth,
    })
  })

  test('refuses paths that leave the home directory', () => {
    expect(() => resolveHomePath('/root', '../etc/passwd')).toThrow('outside')
    expect(() => resolveHomePath('/root', '.codex/../../etc/passwd')).toThrow('outside')
    expect(() => resolveHomePath('/root', '/etc/passwd')).toThrow('outside')
    expect(() => resolveHomePath('/root', '')).toThrow('outside')
    expect(resolveHomePath('/root', '.codex/auth.json')).toBe('/root/.codex/auth.json')
  })
})
