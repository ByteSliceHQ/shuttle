import { Option, Schema } from 'effect'

/**
 * What a projection response held: its value, none at all, or a body that is not the envelope its
 * reader expects. A caller keeps the two apart so a bad body is not mistaken for an empty one.
 */
export type ProjectionRead<A> =
  | { readonly kind: 'value'; readonly value: A }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unreadable' }

/**
 * Reads the `{ value }` envelope every projection answers with. The value is absent or null while
 * nothing has been projected, and a response that fails to decode is reported as unreadable.
 */
export const readProjected = async <A>(
  // `decodeUnknownOption` takes a schema that needs no services to decode; without it the
  // envelope's decoded type widens to unknown.
  value: Schema.Schema<A> & { readonly DecodingServices: never },
  response: Response,
): Promise<ProjectionRead<A>> => {
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({ value: Schema.optional(Schema.NullOr(value)) }),
  )(await response.json().catch(() => undefined))

  if (Option.isNone(decoded)) {
    return { kind: 'unreadable' }
  }

  return decoded.value.value === null || decoded.value.value === undefined
    ? { kind: 'empty' }
    : { kind: 'value', value: decoded.value.value }
}
