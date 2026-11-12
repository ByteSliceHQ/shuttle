import { isJsonObject, type JsonObject } from '@swirls/looms/core'

/** The value as a JSON object, or an empty object when it is anything else. */
export function jsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {}
}

/** True for a plain, non-array object. Its values stay `unknown` until each is checked. */
export function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
