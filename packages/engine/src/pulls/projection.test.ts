import { describe, expect, test } from 'bun:test'

import { Schema } from 'effect'

import { readProjected } from './projection'

const StateSchema = Schema.Struct({ pulls: Schema.Record(Schema.String, Schema.String) })

describe('readProjected', () => {
  test('reads the value out of the envelope', async () => {
    const response = Response.json({ value: { pulls: { 'acme/api#7': 'open' } } })

    expect(await readProjected(StateSchema, response)).toEqual({
      kind: 'value',
      value: { pulls: { 'acme/api#7': 'open' } },
    })
  })

  test('reads nothing while nothing has been projected', async () => {
    expect(await readProjected(StateSchema, Response.json({ value: null }))).toEqual({
      kind: 'empty',
    })

    expect(await readProjected(StateSchema, Response.json({}))).toEqual({ kind: 'empty' })
  })

  test('reports a body that is not the envelope', async () => {
    expect(await readProjected(StateSchema, Response.json({ value: { pulls: 7 } }))).toEqual({
      kind: 'unreadable',
    })

    expect(await readProjected(StateSchema, new Response('not json'))).toEqual({
      kind: 'unreadable',
    })
  })
})
