import { describe, expect, test } from 'bun:test'

import { classifyHeuristic } from './intake-heuristic'

describe('classifyHeuristic', () => {
  test('matches worker intake heuristics', () => {
    expect(classifyHeuristic('What is the worker doing?')).toBe('question')
    expect(classifyHeuristic('Also use zod')).toBe('idea')
    expect(classifyHeuristic('Actually, do not edit package.json')).toBe('correction')
    expect(classifyHeuristic('stop')).toBe('stop')
    expect(classifyHeuristic('stop using tailwind')).toBe('correction')
    expect(classifyHeuristic('Ship the next task')).toBe('task')
  })
})
