import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import {
  BRIDGE_PROPOSALS_DIR,
  BRIDGE_REQUEST_FILE,
  SHUTTLE_PROPOSE_PULL_REQUEST,
  type BridgePullProposal,
  type BridgeTurnRequest,
} from './protocol.ts'

/**
 * Shuttle's own tools for a vendor coding agent, as a stdio MCP server the agent starts:
 *
 *   node main.ts mcp --dir <run dir>
 *
 * The agent runs it for one turn. A tool call is written into the run directory, where the
 * bridge driving the turn picks it up and reports it to the Worker as an event. Nothing here
 * talks to GitHub: Shuttle publishes after a person approves, with its own GitHub App.
 */

export const SHUTTLE_MCP_SERVER = 'shuttle'
export const PROPOSE_PULL_REQUEST = SHUTTLE_PROPOSE_PULL_REQUEST

const PROTOCOL_VERSION = '2025-06-18'

const PROPOSE_DESCRIPTION = [
  'Propose a GitHub pull request of the work in this session. Use it whenever the user asks for a PR, or when the work is done and they want it shipped.',
  'Shuttle commits anything uncommitted, pushes, and opens or updates the pull request itself, with its own GitHub access, after the user approves it in Shuttle. You do not need git credentials, gh, or a token, and you must not push or try to open a PR any other way.',
  'Commit on the branch you are on, or leave the changes uncommitted; do not create or switch branches.',
  'Write the title like a commit subject and the body as a short summary of what changed, how it was tested, and any risks.',
].join(' ')

export const PROPOSE_PULL_REQUEST_TOOL = {
  name: PROPOSE_PULL_REQUEST,
  title: 'Propose a pull request',
  description: PROPOSE_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Pull request title, like a commit subject.' },
      body: {
        type: 'string',
        description: 'Pull request description: what changed, how it was tested, risks.',
      },
      draft: { type: 'boolean', description: 'Open it as a draft. Defaults to true.' },
      repo: {
        type: 'string',
        description: 'Only for a session with several repositories: the one this PR is for.',
      },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
} as const

/** What the agent is told once its proposal is on its way. */
export const PROPOSAL_RECEIVED = [
  'Proposed. When your turn ends, Shuttle shows the user a card to review and publish this pull request; Shuttle then pushes and opens it.',
  'Do not push, run gh, or look for GitHub credentials. Finish your turn with a short summary for the user and say the pull request is waiting for their approval in Shuttle.',
].join(' ')

type JsonRpcId = string | number | null

interface JsonRpcMessage {
  readonly jsonrpc?: string
  readonly id?: JsonRpcId
  readonly method?: string
  readonly params?: Record<string, unknown>
}

/** Writes one proposal into the run directory, whole: a reader never sees half a file. */
export function writeProposal(dir: string, proposal: BridgePullProposal): string {
  const proposals = join(dir, BRIDGE_PROPOSALS_DIR)

  mkdirSync(proposals, { recursive: true })

  const name = `${Date.now()}-${proposal.id}.json`
  const path = join(proposals, name)

  writeFileSync(`${path}.tmp`, JSON.stringify(proposal))
  renameSync(`${path}.tmp`, path)

  return path
}

/** Proposals written since the last call, oldest first. Each is returned once. */
export function takeProposals(dir: string): BridgePullProposal[] {
  const proposals = join(dir, BRIDGE_PROPOSALS_DIR)

  if (!existsSync(proposals)) {
    return []
  }

  return readdirSync(proposals)
    .filter((name) => name.endsWith('.json'))
    .toSorted()
    .flatMap((name) => {
      const path = join(proposals, name)

      try {
        const proposal = JSON.parse(readFileSync(path, 'utf8')) as BridgePullProposal

        renameSync(path, `${path}.taken`)
        return [proposal]
      } catch {
        return []
      }
    })
}

/** Whether this turn may propose pull requests, as the Worker said in its request. */
function mayPropose(dir: string): boolean {
  if (!dir) {
    return false
  }

  try {
    const request = JSON.parse(
      readFileSync(join(dir, BRIDGE_REQUEST_FILE), 'utf8'),
    ) as BridgeTurnRequest

    return request.shuttleTools?.proposePullRequest === true
  } catch {
    return false
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Answers one MCP request. Returns null for a notification, which gets no reply. */
export function handleMcpMessage(dir: string, message: JsonRpcMessage): unknown {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id ?? null, result })

  const fail = (code: number, error: string) => ({
    jsonrpc: '2.0',
    id: message.id ?? null,
    error: { code, message: error },
  })

  if (message.id === undefined) {
    return null
  }

  switch (message.method) {
    case 'initialize': {
      const asked = text(message.params?.protocolVersion)

      return reply({
        protocolVersion: asked || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SHUTTLE_MCP_SERVER, title: 'Shuttle', version: '1.0.0' },
        instructions:
          'Shuttle runs this session. To ship the work as a GitHub pull request, call propose_pull_request; never push or use gh yourself.',
      })
    }

    case 'ping': {
      return reply({})
    }

    case 'tools/list': {
      return reply({ tools: mayPropose(dir) ? [PROPOSE_PULL_REQUEST_TOOL] : [] })
    }

    case 'tools/call': {
      const name = text(message.params?.name)
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>

      if (name !== PROPOSE_PULL_REQUEST || !mayPropose(dir)) {
        return reply({
          isError: true,
          content: [
            {
              type: 'text',
              text: 'This session cannot open pull requests: it has no linked GitHub repository.',
            },
          ],
        })
      }

      const title = text(args.title)

      if (!title) {
        return reply({
          isError: true,
          content: [{ type: 'text', text: 'A pull request needs a title.' }],
        })
      }

      const repo = text(args.repo)

      writeProposal(dir, {
        id: crypto.randomUUID(),
        title: title.slice(0, 300),
        body: text(args.body).slice(0, 20_000),
        draft: args.draft !== false,
        ...(repo ? { repo } : {}),
      })

      return reply({ content: [{ type: 'text', text: PROPOSAL_RECEIVED }] })
    }

    default: {
      return fail(-32601, `Method not found: ${message.method ?? ''}`)
    }
  }
}

/** Serves MCP over stdin and stdout until the agent closes it. */
export async function serveMcp(dir: string): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

  for await (const line of lines) {
    if (!line.trim()) {
      continue
    }

    let message: JsonRpcMessage

    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      )

      continue
    }

    const response = handleMcpMessage(dir, message)

    if (response) {
      process.stdout.write(`${JSON.stringify(response)}\n`)
    }
  }
}

/** How a vendor agent starts this server for the run in `dir`. */
export function shuttleMcpCommand(dir: string): { command: string; args: string[] } {
  // The same runtime and flags as this bridge, such as Node's type stripping.
  return {
    command: process.execPath,
    args: [...process.execArgv, resolve(process.argv[1] ?? 'main.ts'), 'mcp', '--dir', dir],
  }
}
