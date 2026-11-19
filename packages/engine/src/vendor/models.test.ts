import { describe, expect, test } from 'bun:test'

import { memoryStorage } from '../testing/memory-storage'
import {
  builtInVendorModels,
  parseVendorModelChoice,
  parseVendorModels,
  readVendorCatalogue,
  readVendorModelChoice,
  writeVendorCatalogue,
  writeVendorModelChoice,
} from './models'

describe('vendor model choice', () => {
  test('keeps a model and an effort, and drops blank parts', () => {
    expect(parseVendorModelChoice({ model: ' gpt-6.1-sol ', effort: 'high' })).toEqual({
      model: 'gpt-6.1-sol',
      effort: 'high',
    })

    expect(parseVendorModelChoice({ model: '', effort: '' })).toEqual({})

    expect(parseVendorModelChoice({ model: 'claude-opus-5-5[1m]' })).toEqual({
      model: 'claude-opus-5-5[1m]',
    })
  })

  test('rejects anything that could not be a model or an effort', () => {
    expect(parseVendorModelChoice(null)).toBeNull()
    expect(parseVendorModelChoice({ model: '--dangerously-skip' })).toBeNull()
    expect(parseVendorModelChoice({ model: 'gpt 6' })).toBeNull()
    expect(parseVendorModelChoice({ effort: 'High!' })).toBeNull()
  })

  test('is stored per agent', async () => {
    const storage = memoryStorage()

    await writeVendorModelChoice(storage, 'codex', { model: 'gpt-6-astra', effort: 'medium' })

    expect(await readVendorModelChoice(storage, 'codex')).toEqual({
      model: 'gpt-6-astra',
      effort: 'medium',
    })

    expect(await readVendorModelChoice(storage, 'claude-code')).toBeNull()
    expect(writeVendorModelChoice(storage, 'codex', { model: 'a b' })).rejects.toThrow()
  })
})

describe('vendor model lists', () => {
  test('keeps only well-formed models from an agent', () => {
    expect(
      parseVendorModels({
        models: [
          { id: 'gpt-test', label: 'GPT Test', efforts: ['low', 'HIGH'], defaultEffort: 'high' },
          { id: 'bad id' },
          'nonsense',
        ],
      }),
    ).toEqual([{ id: 'gpt-test', label: 'GPT Test', description: '', efforts: ['low'] }])
  })

  test('an agent list is stored with the time it was fetched', async () => {
    const storage = memoryStorage()

    expect(await readVendorCatalogue(storage, 'codex')).toBeNull()

    await writeVendorCatalogue(storage, 'codex', builtInVendorModels('codex'), 1234)

    expect(await readVendorCatalogue(storage, 'codex')).toEqual({
      models: [...builtInVendorModels('codex')],
      fetchedAt: 1234,
    })
  })

  test('every supported agent has a built-in list', () => {
    expect(builtInVendorModels('codex').length).toBeGreaterThan(0)
    expect(builtInVendorModels('claude-code').map((model) => model.id)).toContain('opus')
    expect(builtInVendorModels('cursor').map((model) => model.id)).toContain('composer-2.5')
  })
})
