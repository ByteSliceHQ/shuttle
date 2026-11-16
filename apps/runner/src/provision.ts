import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * What a sandbox needs beyond a plain Linux image, for a backend that starts from one.
 *
 * Cloud sandboxes get all of this from the image built from `apps/worker/Dockerfile`. That
 * image is not something Shuttle may hand out: it holds the vendors' agent command lines, and
 * only Codex's licence lets anyone redistribute it. So a sandbox on a person's machine starts
 * from a public base image and fetches the tools from the vendors itself, the first time it
 * comes up, the way that person would by hand. They stay on the sandbox's own disk after that.
 */

/** A public image with Node, which the agent bridge and two of the agents run on. */
export const BASE_IMAGE = 'node:24-bookworm-slim'

/** Kept equal to the `ARG`s in `apps/worker/Dockerfile`; `provision.test.ts` checks it. */
export const TOOL_VERSIONS = {
  CODEX_VERSION: '0.169.0',
  CLAUDE_CODE_VERSION: '2.1.323',
  TYPESCRIPT_VERSION: '7.0.2',
  TYPESCRIPT_LANGUAGE_SERVER_VERSION: '6.1.0',
} as const

/** Where the agent bridge lives in every sandbox. */
export const BRIDGE_PATH = '/opt/shuttle-bridge'

/** Installs what the Dockerfile installs. Safe to run again: each step settles where it left off. */
export const TOOLS_SCRIPT = `set -eu
export DEBIAN_FRONTEND=noninteractive
mkdir -p /workspace
apt-get update
apt-get install -y --no-install-recommends bash git ripgrep curl ca-certificates python3
rm -rf /var/lib/apt/lists/*
npm install -g --no-fund --no-audit \\
  @openai/codex@${TOOL_VERSIONS.CODEX_VERSION} \\
  @anthropic-ai/claude-code@${TOOL_VERSIONS.CLAUDE_CODE_VERSION} \\
  typescript@${TOOL_VERSIONS.TYPESCRIPT_VERSION} \\
  typescript-language-server@${TOOL_VERSIONS.TYPESCRIPT_LANGUAGE_SERVER_VERSION}
npm cache clean --force
curl -fsS https://cursor.com/install | bash
ln -sf /root/.local/bin/agent /usr/local/bin/agent
ln -sf /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent
agent --version
`

export function toolsDigest(): string {
  return createHash('sha256').update(TOOLS_SCRIPT).digest('hex').slice(0, 16)
}

/** The bridge's files as the image carries them: no tests, no test fixtures. */
function bridgeFiles(dir: string): string[] {
  const found: string[] = []

  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      const name = relative(dir, path)

      if (entry.isDirectory()) {
        if (name !== 'testing' && entry.name !== 'node_modules') {
          walk(path)
        }
      } else if (!entry.name.endsWith('.test.ts')) {
        found.push(name)
      }
    }
  }

  walk(dir)

  return found.toSorted()
}

export function bridgeDigest(dir: string): string {
  const hash = createHash('sha256')

  for (const name of bridgeFiles(dir)) {
    hash
      .update(name)
      .update('\0')
      .update(readFileSync(join(dir, name)))
      .update('\0')
  }

  return hash.digest('hex').slice(0, 16)
}

/** Copies the bridge's files to a fresh folder and hands back its path and a way to remove it. */
export function stageBridge(dir: string): { readonly path: string; readonly discard: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'shuttle-bridge-'))

  for (const name of bridgeFiles(dir)) {
    cpSync(join(dir, name), join(path, name), { recursive: true })
  }

  return { path, discard: () => rmSync(path, { recursive: true, force: true }) }
}

/**
 * Where this runner's copy of the agent bridge is: `SHUTTLE_BRIDGE_DIR`, else beside the
 * runner in a packaged app, else in this repository.
 */
export function findBridge(): string | null {
  const candidates = [
    process.env.SHUTTLE_BRIDGE_DIR,
    join(dirname(process.execPath), 'bridge'),
    resolve(import.meta.dir, '../../worker/bridge'),
  ]

  return candidates.find((path) => path && existsSync(join(path, 'main.ts'))) ?? null
}
