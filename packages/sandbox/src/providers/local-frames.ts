import { z } from 'zod'

import type {
  RunnerBackendInfo,
  RunnerDevice,
  RunnerHello,
  RunnerResults,
} from '@shuttle/runner-protocol'

/**
 * Decoders for what a runner says (see `@shuttle/runner-protocol`). A runner is a program on
 * someone's machine, so nothing it sends is trusted to have the shape the protocol describes
 * until it has been read through these.
 */

const BASE64_CHUNK = 0x8000

export function base64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''

  for (let at = 0; at < view.length; at += BASE64_CHUNK) {
    binary += String.fromCharCode(...view.subarray(at, at + BASE64_CHUNK))
  }

  return btoa(binary)
}

export function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)

  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.charCodeAt(at)
  }

  return bytes.buffer
}

const device = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  arch: z.string(),
}) satisfies z.ZodType<RunnerDevice>

const backend = z.object({
  id: z.string(),
  label: z.string(),
  isolation: z.enum(['microvm', 'vm', 'container', 'process']),
  version: z.string().optional(),
}) satisfies z.ZodType<RunnerBackendInfo>

export const helloFrame = z.object({
  type: z.literal('hello'),
  protocol: z.number(),
  device,
  backend,
}) satisfies z.ZodType<RunnerHello>

export type HelloFrame = z.infer<typeof helloFrame>

const startedFrame = z.object({ type: z.literal('started'), id: z.string(), pid: z.number() })

const okResponse = z.object({
  type: z.literal('res'),
  id: z.string(),
  ok: z.literal(true),
  result: z.unknown(),
})

const failedResponse = z.object({
  type: z.literal('res'),
  id: z.string(),
  ok: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
})

const termDataFrame = z.object({ type: z.literal('term.data'), term: z.string(), data: z.string() })
const termExitFrame = z.object({ type: z.literal('term.exit'), term: z.string() })

/** Any frame a runner sends. */
export const outboundFrame = z.union([
  helloFrame,
  startedFrame,
  okResponse,
  failedResponse,
  termDataFrame,
  termExitFrame,
])

export type OutboundFrame = z.infer<typeof outboundFrame>

/** An answer to a request, as the runner sent it: a result still to be read, or an error. */
export type ResponseFrame = z.infer<typeof okResponse> | z.infer<typeof failedResponse>

const nothing = z.object({}).transform((): Record<string, never> => ({}))

/** What each request's answer looks like. */
/** A decoder for each request's answer, keyed by the request's `op`. */
export type ResultSchemas = { readonly [Op in keyof RunnerResults]: z.ZodType<RunnerResults[Op]> }

export const resultSchemas: ResultSchemas = {
  exec: z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number() }),
  readBytes: z.object({ data: z.string() }),
  writeBytes: nothing,
  mkdir: nothing,
  http: z.object({
    status: z.number(),
    headers: z.array(z.tuple([z.string(), z.string()])),
    body: z.string(),
  }),
  'term.open': nothing,
}

/** The attachment on a runner's socket: when it connected. */
export const socketAttachment = z.object({ at: z.number() })
