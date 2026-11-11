import { describe, expect, test } from 'bun:test'

import { classifyHeuristic, intake, isHardStop } from './intake'

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
    expect(classifyHeuristic('Cancel that!')).toBe('stop')
  })

  test('treats "stop doing X" as a correction, not a hard stop', () => {
    expect(isHardStop('stop using tailwind, use css modules')).toBe(false)
    expect(classifyHeuristic('stop using tailwind, use css modules')).toBe('correction')
  })

  test('isHardStop accepts short stop commands only', () => {
    expect(isHardStop('stop')).toBe(true)
    expect(isHardStop('  stop now. ')).toBe(true)
    expect(isHardStop('abort the workers')).toBe(true)
    expect(isHardStop('stop the build from failing')).toBe(false)
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
