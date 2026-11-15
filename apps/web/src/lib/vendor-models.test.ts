import { describe, expect, test } from 'bun:test'

import type { Team, VendorModel } from './api'
import {
  chosenVendorModel,
  effortLabel,
  modelSections,
  vendorChoiceLabel,
  withVendorModel,
} from './vendor-models'

const team = (change: Partial<Team> = {}): Team => ({
  workers: true,
  codex: false,
  claudeCode: false,
  cursor: false,
  preset: 'none',
  ...change,
})

const sol: VendorModel = {
  id: 'gpt-sol',
  label: 'GPT Sol',
  description: '',
  efforts: ['low', 'high', 'ultra'],
  isDefault: true,
}

const luna: VendorModel = { id: 'gpt-luna', label: 'GPT Luna', description: '', efforts: ['low'] }
const models = [sol, luna]

describe('modelSections', () => {
  test('a vendor session offers only that agent', () => {
    expect(modelSections('codex', team({ claudeCode: true }))).toEqual(['codex'])
  })

  test('a Shuttle session offers its own models, then each vendor agent on the team', () => {
    expect(modelSections('shuttle', team())).toEqual(['openrouter'])

    expect(modelSections('shuttle', team({ codex: true, claudeCode: true, cursor: true }))).toEqual(
      ['openrouter', 'codex', 'claude-code', 'cursor'],
    )
  })
})

describe('vendor choices', () => {
  test('no choice means the agent default', () => {
    expect(chosenVendorModel(undefined, models)).toBe(sol)
    expect(vendorChoiceLabel(undefined, models)).toBe('GPT Sol')
    expect(vendorChoiceLabel(undefined, [])).toBe('Default model')
  })

  test('names the model and the effort', () => {
    expect(vendorChoiceLabel({ model: 'gpt-luna', effort: 'low' }, models)).toBe('GPT Luna · Low')
    expect(vendorChoiceLabel({ model: 'gone', effort: 'xhigh' }, models)).toBe('gone · Extra High')
    expect(effortLabel('turbo')).toBe('Turbo')
  })

  test('switching model keeps the effort only when the new model accepts it', () => {
    expect(withVendorModel({ model: 'gpt-sol', effort: 'low' }, luna, sol)).toEqual({
      model: 'gpt-luna',
      effort: 'low',
    })

    expect(withVendorModel({ model: 'gpt-sol', effort: 'ultra' }, luna, sol)).toEqual({
      model: 'gpt-luna',
    })

    expect(withVendorModel({ model: 'gpt-luna', effort: 'high' }, undefined, sol)).toEqual({
      effort: 'high',
    })
  })
})
