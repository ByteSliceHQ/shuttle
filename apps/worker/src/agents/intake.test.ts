import { describe, expect, test } from 'bun:test'

import { classifyHeuristic, intake } from './intake'

describe('intake heuristics', () => {
  test('classifies questions', () => {
    expect(classifyHeuristic('What is worker 2 doing?')).toBe('question')
  })

  test('classifies ideas', () => {
    expect(classifyHeuristic('Also use zod for validation')).toBe('idea')
  })

  test('classifies corrections', () => {
    expect(classifyHeuristic('Actually, do not edit package.json')).toBe('correction')
  })

  test('classifies stop', () => {
    expect(classifyHeuristic('stop')).toBe('stop')
  })

  test('skipModel only fast-paths stop', () => {
    expect(
      intake.skipModel?.({
        text: 'stop',
        activeWorkers: ['w1'],
        hasConductor: true,
      })?.route,
    ).toBe('stop')

    expect(
      intake.skipModel?.({
        text: 'What is worker 2 doing?',
        activeWorkers: ['w2'],
        hasConductor: true,
      }),
    ).toBeUndefined()
  })
})
