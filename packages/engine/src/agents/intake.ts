import { z } from 'zod'

import { defineEvaluator } from '@swirls/looms/evaluator'

import type { InterjectionKind } from '../session/module'

const IntakeInputSchema = z.object({
  text: z.string(),
  activeWorkers: z.array(z.string()).default([]),
  hasConductor: z.boolean().default(true),
})

/**
 * Unambiguous stop commands ("stop", "cancel that", "abort now!") that can skip
 * intake. Anything longer ("stop using tailwind") still goes through intake.
 */
export function isHardStop(text: string): boolean {
  return /^(stop|cancel|abort|halt)(\s+(it|that|this|now|please|everything|all|the\s+workers?|workers?))*\s*[.!]*$/i.test(
    text.trim(),
  )
}

/**
 * "Did you get stuck?", "worker 5 is still going?", "you there?": the user is asking how the
 * work is going. Treating it as a correction interrupts the agent that is busy answering it.
 */
export function isStatusCheck(text: string): boolean {
  const trimmed = text.trim()

  if (trimmed.length > 80) {
    return false
  }

  if (
    /^(hello|hey|hi|ping|you there|are you there|anyone there|status|update)\b[\s?!.]*$/i.test(
      trimmed,
    )
  ) {
    return true
  }

  const stalled =
    /\b(stuck|frozen|hung|hanging|stalled|still (going|working|running|there|alive)|making progress)\b/i

  if (!stalled.test(trimmed)) {
    return false
  }

  // About the agents themselves, or asked as a question: not "the build is stuck on X, fix it".
  return (
    trimmed.endsWith('?') ||
    /^(i think |looks like |seems like )?(you|u|you're|youre|it|they|agents?|workers?|the conductor|conductor|everything|the session)\b/i.test(
      trimmed,
    )
  )
}

/** Local classifier used when Jev is unavailable (no TYPESAFE_AI_API_KEY). */
export function classifyHeuristic(text: string): InterjectionKind {
  const trimmed = text.trim()

  if (isHardStop(trimmed)) {
    return 'stop'
  }

  if (isStatusCheck(trimmed)) {
    return 'question'
  }

  // "stop using tailwind" redirects the work rather than halting it.
  if (/^(stop|cancel|abort|halt)\b/i.test(trimmed)) {
    return 'correction'
  }

  if (
    trimmed.endsWith('?') ||
    /^(what|why|how|where|who|which|is|are|can|could|did|does|do)\b/i.test(trimmed)
  ) {
    return 'question'
  }

  if (
    /^(actually|no[, ]|wrong|don't|do not|instead|fix:|correct)\b/i.test(trimmed) ||
    /\b(not that|you should have)\b/i.test(trimmed)
  ) {
    return 'correction'
  }

  if (
    /^(also|btw|by the way|idea:|consider|prefer|please use|make sure|remember)\b/i.test(trimmed) ||
    /\b(constraint|prefer|use zod|use typescript)\b/i.test(trimmed)
  ) {
    return /^(must|never|always|don't|do not)\b/i.test(trimmed) ? 'constraint' : 'idea'
  }

  return 'task'
}

/** Pull the user message back out of the evaluator state string. */
export function parseIntakeMessage(state: string): string {
  const marker = '\nMessage: '
  const index = state.lastIndexOf(marker)
  return index >= 0 ? state.slice(index + marker.length) : state
}

export const intake = defineEvaluator({
  name: 'intake',
  description: 'Classify a user interjection for the Shuttle session router',
  // TypeSafe Jev via vercelEvaluator; overridden by adapter default / JEV_MODEL.
  model: 'jev-latest',
  input: IntakeInputSchema,
  state: ({ text, activeWorkers }) =>
    [
      'Classify the user message for a coding agent session.',
      'A message asking whether agents are stuck, still working, or there at all is a question about status, even when it is phrased as a statement such as "i think you got stuck". It is never a correction.',
      `Active workers: ${activeWorkers.length}`,
      `Message: ${text}`,
    ].join('\n'),
  questions: {
    kind: {
      type: 'choice',
      instructions: 'What kind of interjection is this?',
      criteria: {
        question:
          'Asking about status (including whether an agent is stuck or still working), code, or intent without changing the plan',
        idea: 'A soft suggestion or preference to fold into the brief',
        constraint: 'A hard requirement the agents must follow',
        correction:
          'The user says what an agent is doing is wrong and how to change it, and wants an interrupt',
        task: 'A new unit of work for the conductor to plan or delegate',
        stop: 'Stop the active agent or cancel work',
      },
    },
  },
  // Fast paths: a stop must not wait on a model round-trip, and a status check must never be
  // read as a correction that interrupts a busy agent. Everything else goes through Jev (or the
  // heuristic stub when there is no API key).
  skipModel: ({ text }) => {
    const kind = isHardStop(text) ? 'stop' : isStatusCheck(text) ? 'question' : null

    if (kind === null) {
      return undefined
    }

    return {
      route: kind,
      reason: 'skipped',
      answers: {
        kind: { type: 'choice', value: kind },
      },
    }
  },
  route: ({ answers }) => {
    const kind = answers.kind
    const value = kind?.type === 'choice' ? kind.value : 'task'
    return { route: value, reason: 'model' }
  },
})
