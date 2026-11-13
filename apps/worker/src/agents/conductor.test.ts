import { describe, expect, test } from 'bun:test'

import { DEFAULT_TEAM } from '../team'
import { fakeEnv } from '../testing/fake-env'
import { createConductorAgent, delegateTools } from './conductor'
import { createWorkerAgent } from './worker'

const conductor = createConductorAgent(fakeEnv(), 'run_1')

async function toolNames(input: { text: string; repos?: string[] }): Promise<string[]> {
  const resolved = (await conductor.resolveTools?.({ threadId: 'thr_c', turn: 1, input })) ?? []
  return [...(conductor.tools ?? []), ...resolved].map((tool) => tool.name)
}

describe('conductor tools', () => {
  test('offers PR tools when repositories are linked', async () => {
    expect(await toolNames({ text: 'Fix login', repos: ['acme/glue'] })).toEqual([
      'ask_user',
      'delegate',
      'stack_layer',
      'propose_pull_request',
    ])
  })

  test('hides PR tools when no repositories are linked', async () => {
    expect(await toolNames({ text: 'Build a todo app', repos: [] })).toEqual([
      'ask_user',
      'delegate',
    ])
  })
})

describe('delegate tools', () => {
  const worker = createWorkerAgent(fakeEnv(), 'run_1')

  function tools(team: Partial<typeof DEFAULT_TEAM>) {
    return delegateTools({ ...DEFAULT_TEAM, ...team }, { worker })
  }

  test('one tool per team member', () => {
    expect(tools({}).map((tool) => tool.name)).toEqual(['delegate'])

    expect(tools({ codex: true, claudeCode: true }).map((tool) => tool.name)).toEqual([
      'delegate',
      'delegate_codex',
      'delegate_claude',
    ])

    expect(tools({ workers: false, codex: true }).map((tool) => tool.name)).toEqual([
      'delegate_codex',
    ])
  })

  test('each tool spawns its own agent', () => {
    expect(
      tools({ codex: true, claudeCode: true }).map((tool) => `${tool.childKind}:${tool.childName}`),
    ).toEqual(['agent:worker', 'agent:codex', 'agent:claude-code'])
  })

  test("a preset puts each agent's role on its tool", () => {
    const [, codex, claude] = tools({
      codex: true,
      claudeCode: true,
      preset: 'codex-builds-claude-reviews',
    })

    expect(codex?.description).toContain('Codex builds')
    expect(claude?.description).toContain('Claude Code reviews')
    expect(tools({ codex: true })[1]?.description).not.toContain('Role this session')
  })

  test('review and plan modes frame the task; build passes it through', () => {
    const [delegate] = tools({})

    expect(delegate?.mapInput?.({ text: 'Add a README' })).toEqual({ text: 'Add a README' })

    const review = delegate?.mapInput?.({ text: 'Check it', mode: 'review' })

    expect(JSON.stringify(review)).toContain('Do not modify any files')
  })
})
