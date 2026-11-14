#!/usr/bin/env bun
/**
 * Idempotent local-dev bootstrap run before `turbo run dev`.
 * Creates `.dev.vars` from the example and fills empty webhook/state secrets.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  fillEmptyGithubToken,
  ensureAuthSecretLine,
  ensureCredentialsKeyLine,
  fillEmptySecrets,
  randomHexSecret,
} from '../apps/worker/scripts/dev-tunnel-lib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const examplePath = join(root, 'apps/worker/.dev.vars.example')
const varsPath = join(root, 'apps/worker/.dev.vars')

const notes: string[] = []

if (!existsSync(varsPath)) {
  mkdirSync(dirname(varsPath), { recursive: true })
  copyFileSync(examplePath, varsPath)
  notes.push('created apps/worker/.dev.vars from .dev.vars.example')
}

let text = ensureAuthSecretLine(ensureCredentialsKeyLine(readFileSync(varsPath, 'utf8')))
const { text: withSecrets, filled } = fillEmptySecrets(text, () => randomHexSecret())
text = withSecrets

if (filled.length > 0) {
  notes.push(`filled ${filled.join(', ')}`)
}

const ghToken = await readGhAuthToken()
const withGithub = fillEmptyGithubToken(text, ghToken)

if (withGithub.filled) {
  text = withGithub.text
  notes.push('filled GITHUB_TOKEN from gh auth')
}

if (text !== readFileSync(varsPath, 'utf8')) {
  writeFileSync(varsPath, text)
}

// Accounts and organizations live in a local D1 database. Applying migrations is idempotent.
const migrated = Bun.spawnSync(
  ['bun', 'x', 'wrangler', 'd1', 'migrations', 'apply', 'AUTH_DB', '--local'],
  {
    cwd: join(root, 'apps/worker'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '1' },
  },
)

if (migrated.exitCode !== 0) {
  console.error(
    `[dev-setup] could not apply auth database migrations:\n${new TextDecoder().decode(migrated.stderr)}`,
  )

  process.exit(1)
}

if (notes.length > 0) {
  console.log(`[dev-setup] ${notes.join('; ')}`)
}

async function readGhAuthToken(): Promise<string | null> {
  try {
    const result = Bun.spawnSync(['gh', 'auth', 'token'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (result.exitCode !== 0) {
      return null
    }

    const token = new TextDecoder().decode(result.stdout).trim()
    return token || null
  } catch {
    return null
  }
}
