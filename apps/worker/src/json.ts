import { isJsonObject, type JsonObject, type JsonValue } from '@swirls/looms/core'

/** The value as a JSON object, or an empty object when it is anything else. */
export function jsonObject(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {}
}

/** True for a plain, non-array object, read as the JSON object Looms events carry. */
export function isRecord(value: unknown): value is JsonObject {
  return isJsonObject(value)
}
