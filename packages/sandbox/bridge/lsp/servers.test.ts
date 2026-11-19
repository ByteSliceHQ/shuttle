import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveServer, SERVERS, type ServerDefinition } from './registry'
import { ServerPool } from './servers'

/** The TypeScript this repository installs. It is its own language server. */
const TSC = join(import.meta.dir, '../../node_modules/typescript/bin/tsc')

const typescript: ServerDefinition = {
  ...SERVERS.find((server) => server.id === 'typescript')!,
  launch: () => ({ command: process.execPath, args: [TSC, '--lsp', '--stdio'] }),
}

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shuttle-lsp-')))

  mkdirSync(join(root, 'src'))

  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }),
  )

  writeFileSync(
    join(root, 'src/math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b\n}\n',
  )

  writeFileSync(
    join(root, 'src/main.ts'),
    'import { add } from "./math"\n\nexport const total: string = add(1, 2)\n',
  )

  return root
}

describe('resolveServer', () => {
  const root = project()

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('finds the project a file belongs to', () => {
    const resolved = resolveServer(join(root, 'src/main.ts'))

    expect(resolved?.definition.id).toBe('typescript')
    expect(resolved?.languageId).toBe('typescript')
    expect(resolved?.root).toBe(root)
  })

  test('has no server for a file no language covers', () => {
    expect(resolveServer(join(root, 'README.md'))).toBeNull()
  })
})

describe.skipIf(!existsSync(TSC))('ServerPool with TypeScript', () => {
  const root = project()
  const pool = new ServerPool([typescript])
  const main = join(root, 'src/main.ts')

  afterAll(() => {
    pool.stop()
    rmSync(root, { recursive: true, force: true })
  })

  test('reports a type error where it is', async () => {
    const reply = await pool.diagnostics(main, 30_000)

    expect(reply).toMatchObject({
      status: 'ok',
      server: 'typescript',
      diagnostics: [{ line: 3, column: 14, severity: 'error', code: '2322' }],
    })
  }, 40_000)

  test('sees a fix written to the file on disk', async () => {
    writeFileSync(main, 'import { add } from "./math"\n\nexport const total: number = add(1, 2)\n')

    expect(await pool.diagnostics(main, 30_000)).toMatchObject({ status: 'ok', diagnostics: [] })
  }, 40_000)

  test('sees a change to a file it never opened', async () => {
    writeFileSync(
      join(root, 'src/math.ts'),
      'export function add(a: number, b: number): string {\n  return String(a + b)\n}\n',
    )

    // The watcher hears of a write a moment after it lands. Tool calls are further apart than
    // this in a session; a test asking in the same tick is not.
    await new Promise((wake) => setTimeout(wake, 250))

    const reply = await pool.diagnostics(main, 30_000)

    expect(reply).toMatchObject({ status: 'ok', diagnostics: [{ line: 3, code: '2322' }] })
  }, 40_000)

  test('checks an unsaved edit in place of the file, then forgets it', async () => {
    const other = join(root, 'src/math.ts')
    const draft = 'export function add(a: number, b: number): string {\n  return a + b\n}\n'

    expect(await pool.diagnostics(other, 30_000, draft)).toMatchObject({
      status: 'ok',
      diagnostics: [{ line: 2, column: 3, endLine: 2, endColumn: 9, code: '2322' }],
    })

    // Asked about the file as saved, the edit that was never saved is gone.
    expect(await pool.diagnostics(other, 30_000)).toMatchObject({ status: 'ok', diagnostics: [] })
  }, 40_000)

  test('answers unavailable when the server cannot run here', async () => {
    const missing = new ServerPool([
      { ...typescript, launch: () => ({ unavailable: 'not installed' }) },
    ])

    expect(await missing.diagnostics(main)).toEqual({
      status: 'unavailable',
      reason: 'not installed',
    })
  })
})
