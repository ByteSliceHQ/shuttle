import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { BASE_IMAGE, bridgeDigest, stageBridge, TOOL_VERSIONS, TOOLS_SCRIPT } from './provision'

const dockerfile = readFileSync(
  resolve(import.meta.dir, '../../../packages/sandbox/Dockerfile'),
  'utf8',
)

test('installs the versions the cloud image is built with', () => {
  for (const [name, version] of Object.entries(TOOL_VERSIONS)) {
    expect(dockerfile).toContain(`ARG ${name}=${version}`)
    expect(TOOLS_SCRIPT).toContain(`@${version}`)
  }
})

test('starts from the image the cloud image is built on', () => {
  expect(dockerfile).toContain(`FROM ${BASE_IMAGE}`)
})

test('stages the bridge without its tests, and its digest follows its contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'))

  mkdirSync(join(dir, 'lsp'))
  mkdirSync(join(dir, 'testing'))
  writeFileSync(join(dir, 'main.ts'), 'one')
  writeFileSync(join(dir, 'main.test.ts'), 'test')
  writeFileSync(join(dir, 'lsp', 'server.ts'), 'two')
  writeFileSync(join(dir, 'testing', 'fake.ts'), 'fixture')

  const before = bridgeDigest(dir)
  const staged = stageBridge(dir)

  expect(readdirSync(staged.path).toSorted()).toEqual(['lsp', 'main.ts'])
  expect(readdirSync(join(staged.path, 'lsp'))).toEqual(['server.ts'])
  staged.discard()

  writeFileSync(join(dir, 'main.test.ts'), 'changed test')
  expect(bridgeDigest(dir)).toBe(before)

  writeFileSync(join(dir, 'main.ts'), 'changed')
  expect(bridgeDigest(dir)).not.toBe(before)
})
