import { describe, expect, test } from 'bun:test'

import { LSP_MAX_TOOL_DIAGNOSTICS, toolDiagnostics, type LspDiagnostic } from './protocol'

const error = (line: number): LspDiagnostic => ({
  line,
  column: 7,
  endLine: line,
  endColumn: 12,
  severity: 'error',
  message: "Type 'number' is not assignable to type 'string'.",
  code: '2322',
  source: 'ts',
})

const reply = (diagnostics: readonly LspDiagnostic[]) =>
  `${JSON.stringify({ status: 'ok', server: 'typescript', diagnostics })}\n`

describe('toolDiagnostics', () => {
  test('lists errors and warnings one per line and leaves hints out', () => {
    const hint: LspDiagnostic = {
      line: 9,
      column: 1,
      endLine: 9,
      endColumn: 4,
      severity: 'hint',
      message: 'unused',
    }

    expect(toolDiagnostics(reply([error(3), hint]))).toEqual({
      diagnostics: ["3:7 error TS2322: Type 'number' is not assignable to type 'string'."],
    })
  })

  test('says a clean file is clean', () => {
    expect(toolDiagnostics(reply([]))).toEqual({ diagnostics: [] })
  })

  test('counts the problems it leaves out', () => {
    const many = Array.from({ length: LSP_MAX_TOOL_DIAGNOSTICS + 5 }, (_, index) =>
      error(index + 1),
    )

    const result = toolDiagnostics(reply(many))

    expect(result.diagnostics).toHaveLength(LSP_MAX_TOOL_DIAGNOSTICS)
    expect(result.diagnostics_omitted).toBe(5)
  })

  test('marks a server that has not answered yet', () => {
    expect(toolDiagnostics('{"status":"pending","server":"typescript"}')).toEqual({
      diagnostics_pending: true,
    })
  })

  test('adds nothing when there is no server or no shuttle-lsp', () => {
    expect(toolDiagnostics('{"status":"unsupported"}')).toEqual({})
    expect(toolDiagnostics('{"status":"unavailable","reason":"not installed"}')).toEqual({})
    expect(toolDiagnostics('')).toEqual({})
    expect(toolDiagnostics('bash: node: command not found')).toEqual({})
    expect(toolDiagnostics('null')).toEqual({})
  })
})
