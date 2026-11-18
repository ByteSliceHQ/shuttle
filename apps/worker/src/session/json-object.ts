import type { JsonValue } from '@swirls/looms/core'

/**
 * A JSON object under construction: keys are added only when there is a value for them, so an
 * absent field stays absent on the wire instead of being sent as `undefined`.
 */
export type JsonObjectBuilder = { [key: string]: JsonValue }
