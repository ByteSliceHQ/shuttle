import { jsonFields, jsonText } from '../../lib/json'
import type { ToolCallItem } from '../sessions/session-feed'

const MAX_PORTS = 3
const HOST_PORT = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g
/** "port 3000", also when the number is bold or in code, as agents tend to write it. */
const NAMED_PORT = /\bport\s+(?:\*\*|`)?(\d{4,5})\b/gi

/**
 * The preview ports an agent's message points at, in the order it mentions them. An agent says
 * where its app is running in prose, so this reads the prose: a local address with a port, or
 * the word "port" followed by one.
 */
export function previewPorts(text: string): string[] {
  const found: { index: number; port: string }[] = []

  for (const pattern of [HOST_PORT, NAMED_PORT]) {
    for (const match of text.matchAll(pattern)) {
      const port = match[1]

      if (port && Number(port) > 0 && Number(port) <= 65535) {
        found.push({ index: match.index, port })
      }
    }
  }

  const ordered = found.toSorted((left, right) => left.index - right.index).map((hit) => hit.port)

  return [...new Set(ordered)].slice(0, MAX_PORTS)
}

const WRITING_TOOLS = new Set(['write_file', 'edit_file'])

/** The files a burst of tool calls wrote or edited, each once, in the order first touched. */
export function changedPaths(calls: readonly ToolCallItem[]): string[] {
  const paths = new Set<string>()

  for (const call of calls) {
    if (call.status !== 'ok' || !WRITING_TOOLS.has(call.name)) {
      continue
    }

    const path = jsonText(jsonFields(call.args).path)

    if (path) {
      paths.add(path)
    }
  }

  return [...paths]
}
