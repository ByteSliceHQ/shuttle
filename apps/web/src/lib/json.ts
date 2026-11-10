import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from '@swirls/looms/core'

export type JsonNode =
  | { readonly kind: 'object'; readonly value: JsonObject }
  | { readonly kind: 'array'; readonly value: readonly JsonValue[] }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }

export function jsonNode(value: JsonValue): JsonNode {
  if (value === null) {
    return { kind: 'null' }
  }

  if (Array.isArray(value)) {
    return { kind: 'array', value }
  }

  if (isJsonString(value)) {
    return { kind: 'string', value }
  }

  if (isJsonNumber(value)) {
    return { kind: 'number', value }
  }

  if (value === true || value === false) {
    return { kind: 'boolean', value }
  }

  return { kind: 'object', value: isJsonObject(value) ? value : {} }
}

/** Fields of a JSON object, or no fields for any other value. */
export function jsonFields(value: JsonValue | null | undefined): JsonObject {
  return isJsonObject(value) ? value : {}
}

export function jsonText(value: JsonValue | undefined): string | undefined {
  return isJsonString(value) ? value : undefined
}

export function jsonNumber(value: JsonValue | undefined): number | undefined {
  return isJsonNumber(value) ? value : undefined
}

/** Parses text that holds a JSON object or array; plain strings and scalars stay text. */
export function parseStructuredJson(text: string): JsonObject | readonly JsonValue[] | undefined {
  const trimmed = text.trimStart()

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined
  }

  let value: JsonValue

  try {
    value = JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }

  return Array.isArray(value) || isJsonObject(value) ? value : undefined
}

export function jsonEntries(node: JsonNode): readonly (readonly [string, JsonValue])[] {
  switch (node.kind) {
    case 'object':
      return Object.entries(node.value)
    case 'array':
      return node.value.map((item, index) => [String(index), item] as const)
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
      return []

    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }
}

function scalarPreview(value: JsonValue): string {
  const node = jsonNode(value)

  switch (node.kind) {
    case 'object':
      return Object.keys(node.value).length === 0 ? '{}' : '{…}'
    case 'array':
      return `[${node.value.length}]`
    case 'string':
      return JSON.stringify(node.value.length > 24 ? `${node.value.slice(0, 24)}…` : node.value)
    case 'number':
    case 'boolean':
      return String(node.value)
    case 'null':
      return 'null'

    default: {
      const exhaustive: never = node
      return exhaustive
    }
  }
}

/** One-line summary shown beside a collapsed object or array. */
export function jsonPreview(node: JsonNode, budget = 72): string {
  const entries = jsonEntries(node)
  const open = node.kind === 'array' ? '[' : '{'
  const close = node.kind === 'array' ? ']' : '}'
  let text = ''

  for (const [key, value] of entries) {
    const part = node.kind === 'array' ? scalarPreview(value) : `${key}: ${scalarPreview(value)}`
    const next = text ? `${text}, ${part}` : part

    if (next.length > budget) {
      return `${open} ${text ? `${text}, ` : ''}… ${close}`
    }

    text = next
  }

  return text ? `${open} ${text} ${close}` : `${open}${close}`
}
