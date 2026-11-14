import { describe, expect, test } from 'bun:test'

import { explainDeadRun, removeSignInFiles, signInFilesPresent } from './connections'

describe('explainDeadRun', () => {
  test('a sandbox without the bridge says what to do about it', () => {
    const log = [
      'node:internal/modules/cjs/loader:1564',
      "Error: Cannot find module '/opt/shuttle-bridge/main.ts'",
      '    at Module._load (node:internal/modules/cjs/loader:1341:5)',
    ].join('\n')

    const message = explainDeadRun('Codex', log)

    expect(message).toContain('no agent bridge')
    expect(message).toContain('DAYTONA_SNAPSHOT')
  })

  test('any other death quotes the last thing the process said', () => {
    expect(explainDeadRun('Codex', 'starting\nfatal: out of memory\n\n')).toBe(
      'Codex sign-in stopped before it started: fatal: out of memory',
    )

    expect(explainDeadRun('Codex', '')).toContain('left no explanation')
  })
})

describe('sign-in files in the sandbox', () => {
  test('are checked for and removed without being read', () => {
    expect(signInFilesPresent(['.codex/auth.json'])).toBe(`test -s "$HOME"/'.codex/auth.json'`)
    expect(removeSignInFiles(['.codex/auth.json'])).toBe(`rm -f "$HOME"/'.codex/auth.json'`)
  })

  test('an agent with no sign-in file is never reported as signed in', () => {
    expect(signInFilesPresent([])).toBe('false')
  })
})
