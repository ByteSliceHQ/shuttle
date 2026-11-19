import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

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
} from './json'

interface Pending {
  readonly resolve: (value: JsonValue) => void
  readonly reject: (error: Error) => void
}

export interface JsonRpcHandlers {
  onNotification(method: string, params: JsonValue | undefined): void
  /** A request from the peer. The returned value is sent back as the result; a throw as an error. */
  onRequest(
    method: string,
    params: JsonValue | undefined,
  ): JsonValue | undefined | Promise<JsonValue | undefined>
}

/**
 * A JSON-RPC peer over a child process's stdio, one JSON message per line. Both the Codex app
 * server and ACP agents speak this framing.
 */
export class JsonRpcPeer {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  /** Resolves with the exit code once the child has exited. */
  readonly exited: Promise<number | null>

  // Declared as fields, not constructor parameter properties: Node runs this file by stripping
  // types, which cannot erase parameter properties.
  private readonly child: ChildProcessWithoutNullStreams
  private readonly handlers: JsonRpcHandlers
  private readonly header: { jsonrpc?: '2.0' }

  constructor(
    child: ChildProcessWithoutNullStreams,
    handlers: JsonRpcHandlers,
    /** Codex omits the `jsonrpc` member on the wire; ACP agents require it. */
    options: { readonly jsonrpcHeader?: boolean } = {},
  ) {
    this.child = child
    this.handlers = handlers
    this.header = options.jsonrpcHeader ? { jsonrpc: '2.0' } : {}

    createInterface({ input: child.stdout }).on('line', (line) => this.receive(line))

    this.exited = new Promise((resolve) => {
      child.once('error', () => resolve(null))
      child.once('exit', (code) => resolve(code))
    })

    void this.exited.then((code) => {
      const error = new Error(`agent process exited (code ${code ?? 'unknown'})`)

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
    if (this.child.stdin.writable) {
      this.child.stdin.write(`${JSON.stringify({ ...this.header, ...message })}\n`)
    }
  }

  private receive(line: string): void {
    // Agents sometimes print plain log lines on stdout. They are not protocol messages.
    const message = parseJson(line)

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

      void this.answer(id, method, field(message, 'params'))
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
      waiter.reject(new Error(stringField(error, 'message') ?? 'agent returned an error'))
      return
    }

    waiter.resolve(field(message, 'result') ?? null)
  }

  private async answer(
    id: number | string,
    method: string,
    params: JsonValue | undefined,
  ): Promise<void> {
    try {
      this.send({ id, result: (await this.handlers.onRequest(method, params)) ?? {} })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.send({ id, error: { code: -32601, message } })
    }
  }
}
