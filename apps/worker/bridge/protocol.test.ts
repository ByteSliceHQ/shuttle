import { describe, expect, test } from 'bun:test'

import { BRIDGE_MAX_TOOL_OUTPUT, clipToolOutput, parseBridgeEvents } from './protocol'

const encode = (text: string) => new TextEncoder().encode(text)

describe('parseBridgeEvents', () => {
  test('returns whole events and leaves a partial line for the next read', () => {
    const first = '{"type":"text_delta","delta":"hé","seq":1,"at":1}\n'
    const chunk = encode(`${first}{"type":"text_del`)
    const parsed = parseBridgeEvents(chunk)

    expect(parsed.events).toEqual([{ type: 'text_delta', delta: 'hé', seq: 1, at: 1 }])
    expect(parsed.consumed).toBe(encode(first).length)
  })

  test('consumes nothing until a line is complete', () => {
    expect(parseBridgeEvents(encode('{"type":"mess'))).toEqual({ events: [], consumed: 0 })
    expect(parseBridgeEvents(new Uint8Array())).toEqual({ events: [], consumed: 0 })
  })
})

describe('clipToolOutput', () => {
  test('keeps short output and cuts the middle of long output', () => {
    expect(clipToolOutput('ok')).toBe('ok')

    const clipped = clipToolOutput(`START${'x'.repeat(BRIDGE_MAX_TOOL_OUTPUT * 2)}END`)

    expect(clipped.startsWith('START')).toBe(true)
    expect(clipped.endsWith('END')).toBe(true)
    expect(clipped.length).toBeLessThan(BRIDGE_MAX_TOOL_OUTPUT + 100)
  })
})
