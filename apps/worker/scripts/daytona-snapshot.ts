#!/usr/bin/env bun
/**
 * Builds the Daytona snapshot that vendor agent turns need: the image from `Dockerfile`, with the
 * Codex and Claude Code CLIs and the agent bridge. Run it after changing the Dockerfile or the
 * bridge, then set DAYTONA_SNAPSHOT to the name it prints.
 *
 *   bun --env-file=.dev.vars scripts/daytona-snapshot.ts [name]
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Daytona, Image } from '@daytona/sdk'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const name = process.argv[2] ?? `shuttle-agents-${new Date().toISOString().slice(0, 10)}`

if (!process.env.DAYTONA_API_KEY) {
  console.error('DAYTONA_API_KEY is not set')
  process.exit(1)
}

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })

console.log(`Building Daytona snapshot "${name}" from ${join(root, 'Dockerfile')}`)

await daytona.snapshot.create(
  {
    name,
    image: Image.fromDockerfile(join(root, 'Dockerfile')),
    // The CLIs and a cloned repository do not fit the default disk.
    resources: { cpu: 2, memory: 4, disk: 10 },
  },
  { onLogs: (chunk) => process.stdout.write(chunk), timeout: 0 },
)

console.log(`\nDone. Set DAYTONA_SNAPSHOT=${name}`)
