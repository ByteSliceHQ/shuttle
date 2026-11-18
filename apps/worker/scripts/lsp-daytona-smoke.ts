#!/usr/bin/env bun
/**
 * Runs shuttle-lsp in a throwaway Daytona sandbox, to check it against a real one: copies
 * `bridge/lsp` in, makes a small TypeScript project, asks for diagnostics the way the edit tools
 * do, and deletes the sandbox.
 *
 *   bun --env-file=.dev.vars scripts/lsp-daytona-smoke.ts [snapshot]
 *
 * The sandbox comes from the snapshot named, or DAYTONA_SNAPSHOT. When that image has shuttle-lsp
 * baked in at /opt/shuttle-bridge, that copy is tested, against the TypeScript the image
 * installs. Otherwise `bridge/lsp` is copied to the home directory and the project installs its
 * own TypeScript, so a snapshot built before shuttle-lsp existed can still be used.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Daytona } from '@daytona/sdk'

import { parseJson, type JsonValue } from '../bridge/lsp/json'
import {
  decodeDiagnosticsReply,
  decodeStatusReply,
  type LspDiagnosticsReply,
  type LspStatusReply,
} from '../bridge/lsp/protocol'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'bridge/lsp')

if (!process.env.DAYTONA_API_KEY) {
  console.error('DAYTONA_API_KEY is not set')
  process.exit(1)
}

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
const snapshot = (process.argv[2] ?? process.env.DAYTONA_SNAPSHOT)?.trim()
const name = `shuttle-lsp-smoke-${Date.now().toString(36)}`

console.log(`Creating ${name}${snapshot ? ` from snapshot ${snapshot}` : ''}`)

const sandbox = await daytona.create({
  name,
  labels: { app: 'shuttle', purpose: 'lsp-smoke' },
  autoStopInterval: 15,
  snapshot: snapshot === '' ? undefined : snapshot,
})

let failed = false

async function run(label: string, command: string, timeoutSeconds = 120): Promise<string> {
  const started = Date.now()

  const response = await sandbox.process.executeCommand(
    command,
    undefined,
    undefined,
    timeoutSeconds,
  )

  const output = response.result.trim()

  console.log(`\n$ ${label}  (${Date.now() - started}ms, exit ${response.exitCode})\n${output}`)

  return output
}

/** Passes when `output` decodes to a reply and `check` accepts it. */
function expectReply<Reply>(
  label: string,
  output: string,
  decode: (value: JsonValue | undefined) => Reply | undefined,
  check: (reply: Reply) => boolean,
): void {
  const reply = decode(parseJson(output))
  const ok = reply !== undefined && check(reply)

  failed ||= !ok
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

function expect(
  label: string,
  output: string,
  check: (reply: LspDiagnosticsReply) => boolean,
): void {
  expectReply(label, output, decodeDiagnosticsReply, check)
}

function expectStatus(
  label: string,
  output: string,
  check: (reply: LspStatusReply) => boolean,
): void {
  expectReply(label, output, decodeStatusReply, check)
}

try {
  const home = (await run('environment', 'echo $HOME; whoami; node --version; uname -sm')).split(
    '\n',
  )[0]

  const baked =
    (await run('baked daemon', 'test -f /opt/shuttle-bridge/lsp/cli.ts && echo yes || echo no')) ===
    'yes'

  const lsp = baked ? '/opt/shuttle-bridge/lsp' : `${home}/shuttle-lsp-smoke/lsp`
  const project = '/workspace/smoke'
  const cli = `node ${lsp}/cli.ts`

  await run(
    'directories',
    `mkdir -p ${lsp}; test -w /workspace || { sudo -n mkdir -p /workspace && sudo -n chown "$(id -u):$(id -g)" /workspace; }; mkdir -p ${project}/src`,
  )

  for (const file of baked ? [] : readdirSync(source)) {
    if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
      await sandbox.fs.uploadFile(readFileSync(join(source, file)), `${lsp}/${file}`)
    }
  }

  const files = {
    'package.json': JSON.stringify({ name: 'smoke', private: true, type: 'module' }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ['src'],
    }),
    'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b\n}\n',
    'src/main.ts': 'import { add } from "./math"\n\nexport const total: string = add(1, 2)\n',
  }

  for (const [path, content] of Object.entries(files)) {
    await sandbox.fs.uploadFileStream(new TextEncoder().encode(content), `${project}/${path}`)
  }

  if (baked) {
    await run('typescript in the image', 'which tsc typescript-language-server; tsc --version')
  } else {
    await run(
      'install typescript',
      `cd ${project} && npm install --no-fund --no-audit typescript@7.0.2 2>&1 | tail -2`,
      300,
    )
  }

  // The command the edit tools run, but for where the daemon was copied to.
  const diagnose = (file: string) =>
    `cd ${project} && [ -f ${lsp}/cli.ts ] && ${cli} diagnostics ${file} --wait-ms 8000`

  expect(
    'cold start reports the type error',
    await run('diagnostics (cold)', diagnose('src/main.ts')),
    (reply) =>
      reply.status === 'ok' &&
      reply.diagnostics.length === 1 &&
      reply.diagnostics[0]?.code === '2322',
  )

  expect(
    'warm call answers the same',
    await run('diagnostics (warm)', diagnose('src/main.ts')),
    (reply) => reply.status === 'ok' && reply.diagnostics.length === 1,
  )

  await sandbox.fs.uploadFileStream(
    new TextEncoder().encode(
      'import { add } from "./math"\n\nexport const total: number = add(1, 2)\n',
    ),
    `${project}/src/main.ts`,
  )

  expect(
    'a fix written to disk clears it',
    await run('diagnostics (after fix)', diagnose('src/main.ts')),
    (reply) => reply.status === 'ok' && reply.diagnostics.length === 0,
  )

  await run(
    'shell edit to a file the server never opened',
    `cd ${project} && sed -i 's/): number {/): string {/; s/return a + b/return String(a + b)/' src/math.ts && cat src/math.ts`,
  )

  expect(
    'a shell edit to an unopened dependency shows up',
    await run('diagnostics (after shell edit)', diagnose('src/main.ts')),
    (reply) =>
      reply.status === 'ok' &&
      reply.diagnostics.length === 1 &&
      reply.diagnostics[0]?.code === '2322',
  )

  // An unsaved edit, as the editor sends one: the text arrives in a file that is read once.
  await sandbox.fs.uploadFileStream(
    new TextEncoder().encode(
      'import { add } from "./math"\n\nexport const total: string = add(1, 2)\n',
    ),
    '/tmp/shuttle-lsp-draft-smoke',
  )

  expect(
    'an unsaved edit is checked in place of the file, with the range of the problem',
    await run(
      'diagnostics (unsaved edit)',
      `${diagnose('src/main.ts')} --text-file /tmp/shuttle-lsp-draft-smoke; test -e /tmp/shuttle-lsp-draft-smoke && echo 'draft file left behind'`,
    ),
    (reply) => reply.status === 'ok' && reply.diagnostics.length === 0,
  )

  expect(
    'the unsaved edit is forgotten, and problems carry where they end',
    await run('diagnostics (saved again)', diagnose('src/main.ts')),
    (reply) =>
      reply.status === 'ok' &&
      reply.diagnostics.length === 1 &&
      reply.diagnostics[0]?.endLine === 3 &&
      (reply.diagnostics[0]?.endColumn ?? 0) > (reply.diagnostics[0]?.column ?? 0),
  )

  expect(
    'a file with no server is unsupported',
    await run('diagnostics (package.json)', diagnose('package.json')),
    (reply) => reply.status === 'unsupported',
  )

  expectStatus(
    'one daemon, one server',
    await run('status', `${cli} status`),
    (reply) => reply.servers.length === 1 && reply.servers[0]?.root === project,
  )

  // The image has no `ps`, so running processes are read from /proc.
  const running = `for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case "$c" in *lsp/daemon*|*--lsp*) echo "$(awk '/VmRSS/ {print $2 " kB"}' $p/status) $c";; esac; done`

  const during = await run('processes while running', running)
  const two = during.split('\n').filter(Boolean).length >= 2

  failed ||= !two
  console.log(`${two ? 'PASS' : 'FAIL'}  the daemon and its server are running`)

  const after = await run('processes after stop', `${cli} stop >/dev/null; sleep 1; ${running}`)

  failed ||= after !== ''
  console.log(`${after === '' ? 'PASS' : 'FAIL'}  stop leaves nothing running`)
} catch (cause) {
  failed = true
  console.error(cause)
} finally {
  await daytona.delete(sandbox)
  console.log(`\nDeleted ${name}`)
}

console.log(failed ? '\nFAILED' : '\nAll checks passed')
process.exit(failed ? 1 : 0)
