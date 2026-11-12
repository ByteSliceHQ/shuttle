import { describe, expect, test } from 'bun:test'

import type { ShuttleEnv } from '../env'
import { createConductorAgent } from './conductor'

const conductor = createConductorAgent({} as ShuttleEnv, 'run_1')

async function toolNames(input: { text: string; repos?: string[] }): Promise<string[]> {
  const resolved = (await conductor.resolveTools?.({ threadId: 'thr_c', turn: 1, input })) ?? []
  return [...(conductor.tools ?? []), ...resolved].map((tool) => tool.name)
}

describe('conductor tools', () => {
  test('offers PR tools when repositories are linked', async () => {
    expect(await toolNames({ text: 'Fix login', repos: ['acme/glue'] })).toEqual([
      'delegate',
      'ask_user',
      'stack_layer',
      'propose_pull_request',
    ])
  })

  test('hides PR tools when no repositories are linked', async () => {
    expect(await toolNames({ text: 'Build a todo app', repos: [] })).toEqual([
      'delegate',
      'ask_user',
    ])
  })
})
