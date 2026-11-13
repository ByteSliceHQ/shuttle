import { describe, expect, test } from 'bun:test'

import { createVendorMemberAgent, vendorHarnessOfModel, vendorModel } from './vendor-member'

describe('vendor member agents', () => {
  test('name their harness as their model, so their turns run on that agent', () => {
    const codex = createVendorMemberAgent('codex')

    expect(codex.name).toBe('codex')
    expect(codex.conversational).toBe(false)
    expect(vendorHarnessOfModel(codex.model)).toBe('codex')
    expect(vendorHarnessOfModel(createVendorMemberAgent('claude-code').model)).toBe('claude-code')
  })

  test('ordinary model ids are not vendor agents', () => {
    expect(vendorHarnessOfModel('anthropic/claude-sonnet-5.5')).toBeNull()
    expect(vendorHarnessOfModel(undefined)).toBeNull()
    expect(vendorHarnessOfModel('vendor:made-up')).toBeNull()
    expect(vendorHarnessOfModel(vendorModel('codex'))).toBe('codex')
  })
})
