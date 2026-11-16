import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { claudeMcpArgs } from './claude'
import { codexMcpOverrides } from './codex'
import { installCursorMcp } from './cursor'
import { withProposals } from './main'
import {
  handleMcpMessage,
  PROPOSAL_RECEIVED,
  PROPOSE_PULL_REQUEST,
  takeProposals,
  writeProposal,
} from './mcp'
import { BRIDGE_REQUEST_FILE, type BridgeEventBody } from './protocol'

function runDir(proposePullRequest: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'shuttle-mcp-'))

  writeFileSync(
    join(dir, BRIDGE_REQUEST_FILE),
    JSON.stringify({
      harness: 'codex',
      prompt: 'p',
      cwd: '/w',
      ...(proposePullRequest ? { shuttleTools: { proposePullRequest: true } } : {}),
    }),
  )

  return dir
}

const call = (dir: string, args: Record<string, unknown>) =>
  handleMcpMessage(dir, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: PROPOSE_PULL_REQUEST, arguments: args },
  }) as { result: { isError?: boolean; content: { text: string }[] } }

function listTools(dir: string): string[] {
  return (
    handleMcpMessage(dir, { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as {
      result: { tools: { name: string }[] }
    }
  ).result.tools.map((tool) => tool.name)
}

describe("Shuttle's MCP server", () => {
  test('introduces itself in the protocol version the agent asks for', () => {
    const reply = handleMcpMessage(runDir(true), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    }) as { result: { protocolVersion: string; serverInfo: { name: string } } }

    expect(reply.result.protocolVersion).toBe('2025-03-26')
    expect(reply.result.serverInfo.name).toBe('shuttle')
  })

  test('offers propose_pull_request only to a turn the Worker allowed it', () => {
    expect(listTools(runDir(true))).toEqual([PROPOSE_PULL_REQUEST])
    expect(listTools(runDir(false))).toEqual([])
    expect(listTools('')).toEqual([])
  })

  test('a proposal is left for the bridge, once, and the agent is told what happens next', () => {
    const dir = runDir(true)
    const reply = call(dir, { title: 'Add attachments', body: 'Tested.', draft: false })

    expect(reply.result.isError).toBeUndefined()
    expect(reply.result.content[0]?.text).toBe(PROPOSAL_RECEIVED)

    const taken = takeProposals(dir)

    expect(taken).toHaveLength(1)
    expect(taken[0]).toMatchObject({ title: 'Add attachments', body: 'Tested.', draft: false })
    expect(takeProposals(dir)).toEqual([])
  })

  test('refuses a proposal without a title, or from a turn that may not propose', () => {
    expect(call(runDir(true), { body: 'no title' }).result.isError).toBe(true)
    expect(call(runDir(false), { title: 'x', body: '' }).result.isError).toBe(true)
  })

  test('answers notifications with nothing and unknown methods with an error', () => {
    const dir = runDir(true)

    expect(handleMcpMessage(dir, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(
      null,
    )

    expect(handleMcpMessage(dir, { jsonrpc: '2.0', id: 9, method: 'resources/list' })).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32601, message: 'Method not found: resources/list' },
    })
  })

  test('speaks MCP over stdio end to end', async () => {
    const dir = runDir(true)

    const child = spawn(process.execPath, [
      resolve(import.meta.dir, 'main.ts'),
      'mcp',
      '--dir',
      dir,
    ])

    const lines: string[] = []
    let buffer = ''

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      lines.push(...parts.filter(Boolean))
    })

    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: PROPOSE_PULL_REQUEST, arguments: { title: 'T', body: 'B' } },
    })

    for (let tries = 0; tries < 100 && lines.length < 3; tries += 1) {
      await new Promise((done) => setTimeout(done, 20))
    }

    child.stdin.end()

    const replies = lines.map((line) => JSON.parse(line) as { id: number; result: unknown })

    expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3])
    expect(JSON.stringify(replies[1]?.result)).toContain(PROPOSE_PULL_REQUEST)
    expect(takeProposals(dir)[0]).toMatchObject({ title: 'T', body: 'B', draft: true })
  })
})

describe('proposals during a turn', () => {
  test('are reported as events, and the last ones before the turn ends are not lost', () => {
    const dir = runDir(true)
    const events: BridgeEventBody[] = []
    const { emit, stop } = withProposals(dir, (event) => events.push(event))

    writeProposal(dir, { id: 'p1', title: 'Late', body: '', draft: true })
    emit({ type: 'turn_done', status: 'completed', text: 'done' })
    stop()

    expect(events.map((event) => event.type)).toEqual(['pr_proposed', 'turn_done'])
    expect(events[0]).toMatchObject({ type: 'pr_proposed', id: 'p1', title: 'Late' })
  })
})

describe('giving each agent the server', () => {
  const mcp = {
    command: '/usr/bin/node',
    args: ['/opt/shuttle-bridge/main.ts', 'mcp', '--dir', '/r'],
  }

  test('Codex, through config overrides that approve its tools', () => {
    expect(codexMcpOverrides(mcp)).toEqual([
      '-c',
      'mcp_servers.shuttle.command="/usr/bin/node"',
      '-c',
      'mcp_servers.shuttle.args=["/opt/shuttle-bridge/main.ts","mcp","--dir","/r"]',
      '-c',
      'mcp_servers.shuttle.default_tools_approval_mode="approve"',
    ])

    expect(codexMcpOverrides(undefined)).toEqual([])
  })

  test('Claude Code, through --mcp-config', () => {
    const [flag, config] = claudeMcpArgs(mcp)

    expect(flag).toBe('--mcp-config')

    expect(JSON.parse(config ?? '')).toEqual({
      mcpServers: { shuttle: { type: 'stdio', ...mcp } },
    })

    expect(claudeMcpArgs(undefined)).toEqual([])
  })

  test("Cursor, in its user config beside the user's servers, naming no turn", () => {
    const home = mkdtempSync(join(tmpdir(), 'shuttle-cursor-'))

    expect(installCursorMcp(home, mcp)).toBe(true)

    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { linear: { url: 'https://example.test' } } }),
    )

    expect(installCursorMcp(home, mcp)).toBe(true)

    expect(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        linear: { url: 'https://example.test' },
        shuttle: { command: '/usr/bin/node', args: ['/opt/shuttle-bridge/main.ts', 'mcp'] },
      },
    })
  })
})
