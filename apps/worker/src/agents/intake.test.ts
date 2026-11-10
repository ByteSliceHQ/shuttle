import { describe, expect, test } from 'bun:test'

import { intake } from './intake'

describe('intake heuristics', () => {
  test('classifies questions', () => {
    const skipped = intake.skipModel?.({
      text: 'What is worker 2 doing?',
      activeWorkers: ['w2'],
      hasConductor: true,
    })

    expect(skipped?.route).toBe('question')
  })

  test('classifies ideas', () => {
    const skipped = intake.skipModel?.({
      text: 'Also use zod for validation',
      activeWorkers: [],
      hasConductor: true,
    })

    expect(skipped?.route).toBe('idea')
  })

  test('classifies corrections', () => {
    const skipped = intake.skipModel?.({
      text: 'Actually, do not edit package.json',
      activeWorkers: ['w1'],
      hasConductor: true,
    })

    expect(skipped?.route).toBe('correction')
  })

  test('classifies stop', () => {
    const skipped = intake.skipModel?.({
      text: 'stop',
      activeWorkers: ['w1'],
      hasConductor: true,
    })

    expect(skipped?.route).toBe('stop')
  })
})
