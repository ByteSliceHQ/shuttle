import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import {
  definedFields,
  field,
  isJsonObject,
  isNumber,
  isString,
  parseJson,
  stringField,
  type JsonObject,
  type JsonValue,
} from './json.ts'

interface Pending {
  readonly resolve: (value: JsonValue) => void
  readonly reject: (error: Error) => void
}

export interface LspHandlers {
  onNotification(method: string, params: JsonValue | undefined): void
  /** A request from the server. The returned value is sent back as the result. */
  onRequest(method: string, params: JsonValue | undefined): JsonValue | undefined
}

const CR = 0x0d
const LF = 0x0a

/** Where the blank line that ends a header sits in `bytes`, or -1. */
function headerEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (
      bytes[index] === CR &&
      bytes[index + 1] === LF &&
      bytes[index + 2] === CR &&
      bytes[index + 3] === LF
    ) {
      return index
    }
  }

  return -1
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.length + second.length)

  joined.set(first)
  joined.set(second, first.length)

  return joined
}

/**
 * A JSON-RPC peer over a language server's stdio. Unlike the agents' line-per-message framing
 * in `../jsonrpc.ts`, LSP puts a `Content-Length` header before each message.
 */
export class LspConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private buffer: Uint8Array = new Uint8Array(0)
  /** Resolves with the exit code once the server has exited. */
  readonly exited: Promise<number | null>

  // Fields, not constructor parameter properties: Node runs this file by stripping types.
  private readonly child: ChildProcessWithoutNullStreams
  private readonly handlers: LspHandlers

  constructor(child: ChildProcessWithoutNullStreams, handlers: LspHandlers) {
    this.child = child
    this.handlers = handlers

    child.stdout.on('data', (chunk: Uint8Array) => {
      this.buffer = concat(this.buffer, chunk)
      this.drain()
    })

    // A server that dies mid-write must not take the daemon down with EPIPE.
    child.stdin.on('error', () => {})

    this.exited = new Promise((resolve) => {
      child.once('error', () => resolve(null))
      child.once('exit', (code) => resolve(code))
    })

    void this.exited.then((code) => {
      const error = new Error(`language server exited (code ${code ?? 'unknown'})`)

      for (const waiter of this.pending.values()) {
        waiter.reject(error)
      }

      this.pending.clear()
    })
  }

  request(method: string, params?: JsonValue): Promise<JsonValue> {
    const id = this.nextId
    this.nextId += 1

    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send(definedFields({ id, method, params }))
    })
  }

  notify(method: string, params?: JsonValue): void {
    this.send(definedFields({ method, params }))
  }

  kill(): void {
    this.child.kill('SIGTERM')
  }

  private send(message: JsonObject): void {
    if (!this.child.stdin.writable) {
      return
    }

    const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', ...message }))
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.child.stdin.write(body)
  }

  private drain(): void {
    for (;;) {
      const end = headerEnd(this.buffer)

      if (end < 0) {
        return
      }

      const header = new TextDecoder().decode(this.buffer.subarray(0, end))
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1])

      if (!Number.isFinite(length)) {
        // Not a frame. Drop the header and look for the next one.
        this.buffer = this.buffer.subarray(end + 4)
        continue
      }

      const start = end + 4

      if (this.buffer.length < start + length) {
        return
      }

      const body = new TextDecoder().decode(this.buffer.subarray(start, start + length))
      this.buffer = this.buffer.subarray(start + length)
      this.receive(body)
    }
  }

  private receive(body: string): void {
    const message = parseJson(body)

    if (!isJsonObject(message)) {
      return
    }

    const method = stringField(message, 'method')
    const rawId = field(message, 'id')
    const id = isString(rawId) || isNumber(rawId) ? rawId : undefined

    if (method !== undefined) {
      if (id === undefined) {
        this.handlers.onNotification(method, field(message, 'params'))
        return
      }

      let result: JsonValue = null

      try {
        result = this.handlers.onRequest(method, field(message, 'params')) ?? null
      } catch {
        // Answer null rather than leave the server waiting.
      }

      this.send({ id, result })
      return
    }

    if (!isNumber(id)) {
      return
    }

    const waiter = this.pending.get(id)

    if (!waiter) {
      return
    }

    this.pending.delete(id)

    const error = field(message, 'error')

    if (isJsonObject(error)) {
      waiter.reject(new Error(stringField(error, 'message') ?? 'language server returned an error'))
      return
    }

    waiter.resolve(field(message, 'result') ?? null)
  }
}
