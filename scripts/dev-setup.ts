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

let text = readFileSync(varsPath, 'utf8')
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
