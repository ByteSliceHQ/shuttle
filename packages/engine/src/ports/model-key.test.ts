import { describe, expect, test } from 'bun:test'

import { scopedRunId } from '@shuttle/api'
import type { LlmCompleteArgs } from '@swirls/looms/agent'

import { resolveLlm } from '../config'
import { fakeEnv } from '../testing/fake-env'
import { sponsorCredentials, type CredentialPort, type ModelKeyRequest } from './credentials'

const runId = scopedRunId('org1', 'session_a')

const args: LlmCompleteArgs = {
  model: 'any',
  agent: { name: 'conductor', version: '1' },
  turn: 1,
  input: 'hello',
  instructions: '',
  tools: [],
  messages: [{ role: 'user', content: 'hello' }],
  run: { runId, threadId: 'thr_1', attributes: {}, secrets: {} },
}

describe('the model key for Shuttle’s own loop', () => {
  test('is asked of the host for the run and its organization, on each call', async () => {
    const asked: ModelKeyRequest[] = []

    const port: CredentialPort = {
      ...sponsorCredentials,
      modelKey: async (request) => {
        asked.push(request)
        return null
      },
    }

    const llm = resolveLlm(fakeEnv(), port, undefined, runId)

    await llm.complete(args)
    await llm.complete(args)

    expect(asked).toEqual([
      { runId, orgId: 'org1' },
      { runId, orgId: 'org1' },
    ])
  })

  test('with no key from the host or the deployment, the run answers from the stub', async () => {
    const port: CredentialPort = { ...sponsorCredentials, modelKey: async () => null }
    const answered = await resolveLlm(fakeEnv(), port, undefined, runId).complete(args)

    expect(answered.message.content).toContain('[stub]')
  })

  test('a host with no model key leaves the deployment’s key in charge', async () => {
    const answered = await resolveLlm(fakeEnv(), sponsorCredentials, undefined, runId).complete(
      args,
    )

    expect(answered.message.content).toContain('[stub]')
  })
})
