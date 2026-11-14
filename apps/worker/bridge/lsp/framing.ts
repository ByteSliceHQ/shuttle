import type { ChildProcessWithoutNullStreams } from 'node:child_process'

type Json = unknown

interface Pending {
  readonly resolve: (value: Json) => void
  readonly reject: (error: Error) => void
}

export interface LspHandlers {
  onNotification(method: string, params: Json): void
  /** A request from the server. The returned value is sent back as the result. */
  onRequest(method: string, params: Json): Json
}

/**
 * A JSON-RPC peer over a language server's stdio. Unlike the agents' line-per-message framing
 * in `../jsonrpc.ts`, LSP puts a `Content-Length` header before each message.
 */
export class LspConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private buffer: Buffer = Buffer.alloc(0)
  /** Resolves with the exit code once the server has exited. */
  readonly exited: Promise<number | null>

  // Fields, not constructor parameter properties: Node runs this file by stripping types.
  private readonly child: ChildProcessWithoutNullStreams
  private readonly handlers: LspHandlers

  constructor(child: ChildProcessWithoutNullStreams, handlers: LspHandlers) {
    this.child = child
    this.handlers = handlers

    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
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
    if (!this.child.stdin.writable) {
      return
    }

    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8')
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.child.stdin.write(body)
  }

  private drain(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')

      if (headerEnd < 0) {
        return
      }

      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1])

      if (!Number.isFinite(length)) {
        // Not a frame. Drop the header and look for the next one.
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }

      const start = headerEnd + 4

      if (this.buffer.length < start + length) {
        return
      }

      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      this.receive(body)
    }
  }

  private receive(body: string): void {
    let message: {
      id?: number | string
      method?: string
      params?: Json
      result?: Json
      error?: { message?: string }
    }

    try {
      message = JSON.parse(body)
    } catch {
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

      let result: Json = null

      try {
        result = this.handlers.onRequest(message.method, message.params) ?? null
      } catch {
        // Answer null rather than leave the server waiting.
      }

      this.send({ id: message.id, result })
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
      waiter.reject(new Error(message.error.message ?? 'language server returned an error'))
      return
    }

    waiter.resolve(message.result)
  }
}
