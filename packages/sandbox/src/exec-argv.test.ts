import { describe, expect, test } from 'bun:test'

import { shellQuote, timedBashArgv } from './exec-argv'

describe('shellQuote', () => {
  test('keeps $, backticks, and newlines literal', () => {
    expect(shellQuote('a$b`c`\nd')).toBe("'a$b`c`\nd'")
  })

  test('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })
})

describe('timedBashArgv', () => {
  test('preserves real newlines in the script argv (does not JSON-escape them)', () => {
    const script = 'rm -f /workspace/demo/restart.sh\ncat /workspace/demo/vite.config.ts'
    const argv = timedBashArgv(script, 120)

    expect(argv).toEqual(['timeout', '-k', '5', '120', 'bash', '-lc', script])
    expect(argv[6]).toContain('\n')
    expect(argv[6]).not.toContain('\\n')
  })

  test('clamps non-positive timeouts to 1 second', () => {
    expect(timedBashArgv('true', 0)[3]).toBe('1')
    expect(timedBashArgv('true', -5)[3]).toBe('1')
  })
})
