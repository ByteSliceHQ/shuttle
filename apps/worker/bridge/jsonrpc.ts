import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

type Json = unknown

interface Pending {
  readonly resolve: (value: Json) => void
  readonly reject: (error: Error) => void
}

export interface JsonRpcHandlers {
  onNotification(method: string, params: Json): void
  /** A request from the peer. The returned value is sent back as the result; a throw as an error. */
  onRequest(method: string, params: Json): Json | Promise<Json>
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

  request<T = Json>(method: string, params?: Json): Promise<T> {
    const id = this.nextId
    this.nextId += 1

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: Json) => void, reject })
      this.send({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: Json): void {
    this.send({ method, ...(params === undefined ? {} : { params }) })
  }

  kill(): void {
    this.child.kill('SIGTERM')
  }

  private send(message: Record<string, Json>): void {
    if (this.child.stdin.writable) {
      this.child.stdin.write(`${JSON.stringify({ ...this.header, ...message })}\n`)
    }
  }

  private receive(line: string): void {
    let message: {
      id?: number | string
      method?: string
      params?: Json
      result?: Json
      error?: { message?: string }
    }

    try {
      message = JSON.parse(line)
    } catch {
      // Agents sometimes print plain log lines on stdout. They are not protocol messages.
      return
    }

    if (typeof message !== 'object' || message === null) {
      return
    }

    if (typeof message.method === 'string') {
      if (message.id === undefined) {
        this.handlers.onNotification(message.method, message.params)
        return
      }

      void this.answer(message.id, message.method, message.params)
      return
    }

    if (typeof message.id !== 'number') {
      return
    }

    const waiter = this.pending.get(message.id)

    if (!waiter) {
      return
    }

    this.pending.delete(message.id)

    if (message.error) {
      waiter.reject(new Error(message.error.message ?? 'agent returned an error'))
      return
    }

    waiter.resolve(message.result)
  }

  private async answer(id: number | string, method: string, params: Json): Promise<void> {
    try {
      this.send({ id, result: (await this.handlers.onRequest(method, params)) ?? {} })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.send({ id, error: { code: -32601, message } })
    }
  }
}
