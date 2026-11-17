import type { InterjectionKind } from './session-feed'

/** Mirrors `isHardStop` in apps/worker/src/agents/intake.ts. */
export function isHardStop(text: string): boolean {
  return /^(stop|cancel|abort|halt)(\s+(it|that|this|now|please|everything|all|the\s+workers?|workers?))*\s*[.!]*$/i.test(
    text.trim(),
  )
}

/** Mirrors apps/worker/src/agents/intake.ts for provisional UI routing. */
export function classifyHeuristic(text: string): InterjectionKind {
  const trimmed = text.trim()

  if (isHardStop(trimmed)) {
    return 'stop'
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
