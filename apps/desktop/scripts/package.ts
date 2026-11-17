/**
 * Packages the desktop app for this Mac's architecture: `release/Shuttle-<version>-<arch>.dmg`.
 *
 *   SHUTTLE_DESKTOP_URL=https://shuttle.example.com \
 *   SHUTTLE_SANDBOX_IMAGE=ghcr.io/example/shuttle-sandbox:latest \
 *   bun run package
 *
 * The app that comes out opens that deployment. It carries the built-in sandbox runtime and
 * the agent bridge, so a machine needs nothing else installed. `SHUTTLE_SANDBOX_IMAGE` is
 * optional: it is the image a machine falls back to through Docker or Podman when it cannot
 * run the built-in sandbox. Nothing secret goes into the build.
 *
 * Signing: with `CSC_NAME` (a Developer ID Application identity in the keychain) the app is
 * signed with it, and notarized when electron-builder finds Apple credentials in the
 * environment. Without it the app is signed ad hoc: it runs, but a Mac that downloaded it will
 * refuse to open it until its owner allows it in Privacy & Security.
 */

import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { stageBridge } from '../../runner/src/provision'

const root = resolve(import.meta.dir, '..')
const runnerRoot = resolve(root, '../runner')
const staging = join(root, 'build')

const url = process.env.SHUTTLE_DESKTOP_URL?.trim().replace(/\/$/, '')
const image = process.env.SHUTTLE_SANDBOX_IMAGE?.trim()
const identity = process.env.CSC_NAME?.trim()

if (!url?.startsWith('https://')) {
  console.error('Set SHUTTLE_DESKTOP_URL to the https address of the Shuttle deployment.')
  process.exit(1)
}

async function run(command: readonly string[], cwd: string, env?: Record<string, string>) {
  console.log(`$ ${command.join(' ')}`)

  const child = Bun.spawn([...command], {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...env },
  })

  if ((await child.exited) !== 0) {
    process.exit(1)
  }
}

mkdirSync(staging, { recursive: true })

writeFileSync(
  join(staging, 'desktop.config.json'),
  `${JSON.stringify({ url, autoUpdate: Boolean(identity && identity !== '-'), ...(image ? { image } : {}) }, null, 2)}\n`,
)

// The agent bridge, which the built-in sandbox copies into itself. Tests stay behind.
const bridge = stageBridge(resolve(root, '../worker/bridge'))

rmSync(join(staging, 'bridge'), { recursive: true, force: true })
cpSync(bridge.path, join(staging, 'bridge'), { recursive: true })
bridge.discard()

await run(['bun', 'run', 'build'], runnerRoot)
await run(['bun', 'run', 'build'], root)

await run(
  [
    'bun',
    'x',
    'electron-builder',
    '--mac',
    'dmg',
    'zip',
    // "-" is an ad hoc signature: enough to run on Apple Silicon, not enough for Gatekeeper.
    `-c.mac.identity=${identity || '-'}`,
    `-c.mac.notarize=${identity ? 'true' : 'false'}`,
    '--publish',
    'never',
  ],
  root,
  identity ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
)
