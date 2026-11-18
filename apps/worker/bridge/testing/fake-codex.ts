#!/usr/bin/env bun
import { createInterface } from 'node:readline'

import {
  definedFields,
  isJsonObject,
  numberField,
  objectField,
  parseJson,
  stringField,
  type JsonValue,
} from '../json.ts'

/**
 * A stand-in for `codex app-server` that speaks just enough of the protocol for the bridge tests.
 * FAKE_CODEX_MODE picks the behaviour: `turn` (default), `hang`, `crash` or `login`.
 */

const mode = process.env.FAKE_CODEX_MODE ?? 'turn'
const send = (message: JsonValue) => process.stdout.write(`${JSON.stringify(message)}\n`)
const note = (method: string, params: JsonValue) => send({ method, params })

const turn = (status: string) => ({ id: 'turn_1', status, error: null, items: [] })

function playTurn(): void {
  note('item/reasoning/summaryTextDelta', { delta: 'Checking the tests.' })

  note('item/completed', {
    item: { type: 'reasoning', id: 'item_think', summary: ['Checking the tests.'], content: [] },
  })

  const search = { type: 'webSearch', id: 'item_web', query: 'bun test docs' }

  note('item/started', { item: search })
  note('item/completed', { item: search })

  const command = {
    type: 'commandExecution',
    id: 'item_cmd',
    command: "/bin/bash -lc 'bun test'",
    status: 'inProgress',
  }

  note('item/started', { item: command })

  note('item/completed', {
    item: { ...command, status: 'completed', aggregatedOutput: '3 pass', exitCode: 0 },
  })

  const change = {
    type: 'fileChange',
    id: 'item_patch',
    changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    status: 'inProgress',
  }

  note('item/started', { item: change })
  note('item/completed', { item: { ...change, status: 'failed' } })
  note('item/agentMessage/delta', { delta: 'All ' })
  note('item/agentMessage/delta', { delta: 'done.' })
  note('item/completed', { item: { type: 'agentMessage', id: 'item_msg', text: 'All done.' } })

  note('thread/tokenUsage/updated', {
    tokenUsage: { last: { inputTokens: 120, outputTokens: 30 }, modelContextWindow: 400_000 },
  })

  note('turn/completed', { turn: turn('completed') })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = parseJson(line)

  if (!isJsonObject(message)) {
    return
  }

  const id = numberField(message, 'id')
  const params = objectField(message, 'params') ?? {}
  const reply = (result: JsonValue) => send(definedFields({ id, result }))

  switch (stringField(message, 'method')) {
    case 'initialize': {
      reply({ userAgent: 'fake-codex' })
      break
    }

    case 'thread/start': {
      reply({ thread: { id: 'thr_new' }, model: 'gpt-test' })
      break
    }

    case 'thread/resume': {
      reply({ thread: { id: stringField(params, 'threadId') ?? null } })
      break
    }

    case 'turn/start': {
      reply({ turn: turn('inProgress') })

      if (mode === 'crash') {
        process.exit(7)
      }

      if (mode === 'turn') {
        // A server request the bridge must refuse rather than leave hanging.
        send({ id: 'srv_1', method: 'item/commandExecution/requestApproval', params: {} })
        playTurn()
      }

      break
    }

    case 'model/list': {
      reply({
        data: [
          {
            id: 'gpt-test',
            model: 'gpt-test',
            displayName: 'GPT Test',
            description: 'The workhorse.',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
          },
          { id: 'gpt-secret', displayName: 'Hidden', hidden: true },
        ],
        nextCursor: null,
      })

      break
    }

    case 'turn/interrupt': {
      reply({})
      note('turn/completed', { turn: turn('interrupted') })
      break
    }

    case 'account/login/start': {
      reply({
        type: 'chatgptDeviceCode',
        loginId: 'login_1',
        verificationUrl: 'https://example.test/device',
        userCode: 'ABCD-1234',
      })

      if (mode === 'login') {
        note('account/login/completed', { loginId: 'login_1', success: true, error: null })
      }

      break
    }

    case undefined:

    default: {
      break
    }
  }
})
