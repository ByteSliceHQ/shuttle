import { describe, expect, test } from 'bun:test'

import { changedPaths, previewPorts } from './artifact-links'
import type { ToolCallItem } from './session-feed'

function call(name: string, path: string, status: ToolCallItem['status'] = 'ok'): ToolCallItem {
  return { toolCallId: `${name}:${path}:${status}`, name, args: { path }, seq: 1, status }
}

describe('previewPorts', () => {
  test('reads local addresses and named ports, once each, in order', () => {
    expect(previewPorts('Preview: Shuttle Browser port **3000**')).toEqual(['3000'])

    expect(previewPorts('Running at http://localhost:5173/app and on port 3000.')).toEqual([
      '5173',
      '3000',
    ])

    expect(previewPorts('localhost:3000, then 127.0.0.1:3000 again')).toEqual(['3000'])
  })

  test('ignores numbers that are not preview ports', () => {
    expect(previewPorts('bash exited with code 128')).toEqual([])
    expect(previewPorts('port 80 is closed, and so is port 99999')).toEqual([])
    expect(previewPorts('Committed as ee4c9e4.')).toEqual([])
  })

  test('stops at three', () => {
    expect(
      previewPorts('ports: localhost:3000 localhost:3001 localhost:3002 localhost:3003'),
    ).toEqual(['3000', '3001', '3002'])
  })
})

describe('changedPaths', () => {
  test('lists each written or edited file once', () => {
    expect(
      changedPaths([
        call('read_file', 'README.md'),
        call('write_file', 'app.js'),
        call('edit_file', 'app.js'),
        call('edit_file', 'style.css'),
      ]),
    ).toEqual(['app.js', 'style.css'])
  })

  test('leaves out writes that failed or have not finished', () => {
    expect(
      changedPaths([call('write_file', 'a.js', 'error'), call('edit_file', 'b.js', 'running')]),
    ).toEqual([])
  })
})
