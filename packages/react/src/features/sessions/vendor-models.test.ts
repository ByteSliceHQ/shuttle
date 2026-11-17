import { describe, expect, test } from 'bun:test'

import type { Team, VendorModel } from '@shuttle/api'

import {
  chosenVendorModel,
  effortLabel,
  modelSections,
  sectionLabel,
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

describe('sectionLabel', () => {
  test('names the built-in agents, and an ACP agent by its deployment name', () => {
    expect(sectionLabel('openrouter')).toBe('Shuttle')
    expect(sectionLabel('claude-code')).toBe('Claude Code')
    expect(sectionLabel('acp:gemini')).toBe('gemini')
  })
})

describe('modelSections', () => {
  test('an ACP session offers only that agent', () => {
    expect(modelSections('acp:gemini', team({ codex: true }))).toEqual(['acp:gemini'])
  })

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
