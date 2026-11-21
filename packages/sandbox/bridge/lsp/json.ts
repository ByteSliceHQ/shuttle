/**
 * JSON as it arrives from a process, a file or a socket, typed all the way down. Everything
 * the daemon reads off the wire goes through `parseJson` and the guards here, then into a named type.
 *
 * No imports, and no schema library: the bridge image carries no `node_modules`, and Node runs
 * this directory by stripping types. This is the same file as `../json.ts`, kept apart because
 * `bridge/lsp` is copied into sandboxes on its own.
 */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject

export interface JsonObject {
  readonly [key: string]: JsonValue
}

export function isString(value: JsonValue | undefined): value is string {
  return typeof value === 'string'
}

export function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number'
}

export function isBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === 'boolean'
}

export function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value)
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `value` is what `JSON.parse` can produce. The one place an untyped value is probed. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }

  return typeof value === 'object' && Object.values(value).every(isJsonValue)
}

/** The JSON in `text`, or undefined when it is not JSON. */
export function parseJson(text: string): JsonValue | undefined {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }

  return isJsonValue(parsed) ? parsed : undefined
}

export function field(object: JsonObject, key: string): JsonValue | undefined {
  return object[key]
}

export function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key]

  return isString(value) ? value : undefined
}

export function numberField(object: JsonObject, key: string): number | undefined {
  const value = object[key]

  return isNumber(value) ? value : undefined
}

export function booleanField(object: JsonObject, key: string): boolean | undefined {
  const value = object[key]

  return isBoolean(value) ? value : undefined
}

export function objectField(object: JsonObject, key: string): JsonObject | undefined {
  const value = object[key]

  return isJsonObject(value) ? value : undefined
}

export function arrayField(object: JsonObject, key: string): readonly JsonValue[] | undefined {
  const value = object[key]

  return isJsonArray(value) ? value : undefined
}

/** Each item of `value` that `decode` accepts. Anything that is not an array has no items. */
export function decodeEach<T>(
  value: JsonValue | undefined,
  decode: (item: JsonValue) => T | undefined,
): T[] {
  return isJsonArray(value) ? value.flatMap((item) => decode(item) ?? []) : []
}

/** The text, or undefined when it is empty: the way an empty value was always left out. */
export function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/** An object of the fields that have a value. Fields that are undefined are left out. */
export function definedFields(fields: {
  readonly [key: string]: JsonValue | undefined
}): JsonObject {
  const object: { [key: string]: JsonValue } = {}

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      object[key] = value
    }
  }

  return object
}
