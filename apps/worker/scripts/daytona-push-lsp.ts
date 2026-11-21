#!/usr/bin/env bun
/**
 * Copies `packages/sandbox/bridge/lsp` into a Daytona sandbox that already exists, at /opt/shuttle-bridge/lsp where
 * the image puts it, and installs the TypeScript language servers there if they are missing.
 *
 * A sandbox keeps the image it was created from, so one made before shuttle-lsp existed has no
 * language server, and one made since has the daemon as it was when its snapshot was built. This
 * brings either up to date without recreating it, which would lose what its person signed in to.
 *
 *   bun --env-file=.dev.vars scripts/daytona-push-lsp.ts <sandbox>
 *
 * `<sandbox>` is the Shuttle name (`user:<org>:<user>`) or the Daytona one (`shuttle-user-…`).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Daytona } from '@daytona/sdk'

import { daytonaSandboxName } from '@shuttle/sandbox/daytona'

const source = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/sandbox/bridge/lsp')
const target = '/opt/shuttle-bridge/lsp'
const asked = process.argv[2]

if (!process.env.DAYTONA_API_KEY || !asked) {
  console.error('usage: bun --env-file=.dev.vars scripts/daytona-push-lsp.ts <sandbox>')
  process.exit(1)
}

const name = asked.startsWith('shuttle-') ? asked : daytonaSandboxName(asked)
const sandbox = await new Daytona({ apiKey: process.env.DAYTONA_API_KEY }).get(name)

if (sandbox.state !== 'started') {
  console.error(`${name} is ${sandbox.state}. Open a session in it first, so it is running.`)
  process.exit(1)
}

async function run(command: string, timeoutSeconds = 300): Promise<string> {
  const response = await sandbox.process.executeCommand(
    command,
    undefined,
    undefined,
    timeoutSeconds,
  )

  if (response.exitCode !== 0) {
    throw new Error(`\`${command}\` exited ${response.exitCode}: ${response.result.trim()}`)
  }

  return response.result.trim()
}

// A running daemon holds the old code. The next request starts the new one.
await run(
  `[ -f ${target}/cli.ts ] && node ${target}/cli.ts stop >/dev/null 2>&1; mkdir -p ${target} || sudo -n mkdir -p ${target}`,
)

for (const file of readdirSync(source)) {
  if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
    await sandbox.fs.uploadFile(readFileSync(join(source, file)), `${target}/${file}`)
    console.log(`copied ${file}`)
  }
}

console.log(
  await run(
    'command -v tsc >/dev/null && command -v typescript-language-server >/dev/null || npm install -g --no-fund --no-audit typescript@7.0.2 typescript-language-server@6.1.0 2>&1 | tail -1; echo "tsc $(tsc --version)"',
  ),
)

console.log(`\n${name} has shuttle-lsp at ${target}`)

// The Daytona client keeps connections open, which would keep this running.
process.exit(0)
