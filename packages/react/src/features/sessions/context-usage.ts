import type { ProjectionDefinition } from '@swirls/looms/core'

import { jsonFields, jsonNumber } from '../../lib/json'
import type { SessionEvent } from '../events/event-catalog'
import type { SessionFeed } from './session-feed'
import { currentBrief } from './session-feed'

export interface TurnUsage {
  readonly threadId: string | null
  readonly turn: number
  readonly input: number
  readonly output: number
  readonly ts: number
}

export interface ContextUsageState {
  /** Most recent `agent.turn.usage` across the run. */
  readonly lastTurn: TurnUsage | null
  /** Cumulative totals folded from `agent.turn.usage` only. */
  readonly totals: { readonly input: number; readonly output: number }
}

export type ContextCategoryId = 'brief' | 'playbook' | 'tools' | 'conversation' | 'other'

export interface ContextSegment {
  readonly id: ContextCategoryId
  readonly label: string
  readonly tokens: number
  readonly color: string
}

export interface ContextUsageReport {
  /** Tokens attributed to the current context window fill. */
  readonly used: number
  readonly window: number
  /** 0–100, capped. */
  readonly percent: number
  /** True when `used` comes from char estimates rather than billed input. */
  readonly estimated: boolean
  readonly segments: readonly ContextSegment[]
  readonly lastTurn: TurnUsage | null
  readonly totals: { readonly input: number; readonly output: number }
}

const CATEGORY_META: Record<ContextCategoryId, { readonly label: string; readonly color: string }> =
  {
    brief: { label: 'Brief', color: 'oklch(0.72 0.04 265)' },
    playbook: { label: 'Playbook', color: 'oklch(0.76 0.13 155)' },
    tools: { label: 'Tool activity', color: 'oklch(0.74 0.12 300)' },
    conversation: { label: 'Conversation', color: 'oklch(0.7 0.16 25)' },
    other: { label: 'System & tools', color: 'oklch(0.74 0.13 245)' },
  }

const initialUsage: ContextUsageState = {
  lastTurn: null,
  totals: { input: 0, output: 0 },
}

/** ~4 chars per token — good enough for relative segment sizing. */
export function estimateTokens(text: string): number {
  const trimmed = text.trim()

  if (!trimmed) {
    return 0
  }

  return Math.max(1, Math.ceil(trimmed.length / 4))
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) {
    return String(Math.round(tokens))
  }

  if (tokens < 1_000_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  }

  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function formatTokenTotal(tokens: number): string {
  if (tokens < 1_000) {
    return String(Math.round(tokens))
  }

  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1_000)}K`
  }

  const millions = tokens / 1_000_000
  return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`
}

function estimateFromFeed(feed: SessionFeed): Record<ContextCategoryId, number> {
  const brief = currentBrief(feed)
  const briefTokens = brief ? estimateTokens(brief.text) : 0

  const playbookTokens = estimateTokens(
    feed.playbook.lessons.map((lesson) => lesson.text).join('\n'),
  )

  let conversationTokens = 0
  let toolTokens = 0

  for (const item of feed.items) {
    switch (item.kind) {
      case 'user': {
        // Goal text is already counted under Brief.
        if (!item.goal) {
          conversationTokens += estimateTokens(item.text)
        }

        break
      }

      case 'agent': {
        conversationTokens += estimateTokens(item.text)

        if (item.thought) {
          conversationTokens += estimateTokens(item.thought.text)
        }

        break
      }

      case 'thought': {
        conversationTokens += estimateTokens(item.text)
        break
      }

      case 'tools': {
        for (const thought of item.thoughts) {
          conversationTokens += estimateTokens(thought.text)
        }

        for (const call of item.calls) {
          toolTokens += estimateTokens(JSON.stringify(call.args ?? null))

          if (call.result !== undefined) {
            toolTokens += estimateTokens(JSON.stringify(call.result))
          }

          if (call.error) {
            toolTokens += estimateTokens(call.error)
          }
        }

        break
      }

      case 'question': {
        conversationTokens += estimateTokens(item.title)

        if (item.thought) {
          conversationTokens += estimateTokens(item.thought.text)
        }

        if (item.decision?.answer) {
          conversationTokens += estimateTokens(item.decision.answer)
        }

        break
      }

      case 'media':

      case 'notice': {
        break
      }

      default: {
        const exhaustive: never = item
        return exhaustive
      }
    }
  }

  return {
    brief: briefTokens,
    playbook: playbookTokens,
    tools: toolTokens,
    conversation: conversationTokens,
    other: 0,
  }
}

function toSegments(counts: Record<ContextCategoryId, number>): ContextSegment[] {
  const order: ContextCategoryId[] = ['other', 'brief', 'playbook', 'tools', 'conversation']

  return order
    .filter((id) => counts[id] > 0)
    .map((id) => ({
      id,
      label: CATEGORY_META[id].label,
      tokens: counts[id],
      color: CATEGORY_META[id].color,
    }))
}

/**
 * Build a Cursor-style context report.
 *
 * Prefers billed last-turn input when present; otherwise falls back to char-based
 * estimates from the session feed so the meter still works while streaming usage
 * reports `input: 0`.
 */
export function buildContextUsageReport(
  usage: ContextUsageState,
  feed: SessionFeed,
  window: number,
): ContextUsageReport {
  const estimates = estimateFromFeed(feed)

  const estimatedSum =
    estimates.brief + estimates.playbook + estimates.tools + estimates.conversation

  const billedInput = usage.lastTurn?.input ?? 0

  let counts: Record<ContextCategoryId, number>
  let used: number
  let estimated: boolean

  if (billedInput > 0) {
    estimated = false
    used = billedInput

    if (estimatedSum === 0) {
      counts = { brief: 0, playbook: 0, tools: 0, conversation: 0, other: billedInput }
    } else if (estimatedSum <= billedInput) {
      counts = { ...estimates, other: billedInput - estimatedSum }
    } else {
      const scale = billedInput / estimatedSum

      counts = {
        brief: Math.round(estimates.brief * scale),
        playbook: Math.round(estimates.playbook * scale),
        tools: Math.round(estimates.tools * scale),
        conversation: Math.round(estimates.conversation * scale),
        other: 0,
      }

      const scaledSum = counts.brief + counts.playbook + counts.tools + counts.conversation
      const drift = billedInput - scaledSum

      if (drift !== 0) {
        const anchor: ContextCategoryId =
          counts.conversation > 0 ? 'conversation' : counts.tools > 0 ? 'tools' : 'other'

        counts = { ...counts, [anchor]: counts[anchor] + drift }
      }
    }
  } else {
    estimated = estimatedSum > 0
    used = estimatedSum
    counts = estimates
  }

  const safeWindow = Math.max(1, window)
  const percent = Math.min(100, Math.round((used / safeWindow) * 100))

  return {
    used,
    window: safeWindow,
    percent,
    estimated,
    segments: toSegments(counts),
    lastTurn: usage.lastTurn,
    totals: usage.totals,
  }
}

function reduceUsage(state: ContextUsageState, event: SessionEvent): ContextUsageState {
  if (event.type !== 'agent.turn.usage') {
    return state
  }

  const payload = jsonFields(event.payload)
  const input = jsonNumber(payload.input) ?? 0
  const output = jsonNumber(payload.output) ?? 0
  const turn = jsonNumber(payload.turn) ?? 0

  const lastTurn: TurnUsage = {
    threadId: event.threadId,
    turn,
    input,
    output,
    ts: event.ts,
  }

  return {
    lastTurn,
    totals: {
      input: state.totals.input + input,
      output: state.totals.output + output,
    },
  }
}

/** Client-side fold of `agent.turn.usage` for the context meter. */
export const contextUsage: ProjectionDefinition<ContextUsageState> = {
  name: 'shuttleContextUsage',
  initialState: initialUsage,
  reduce: reduceUsage,
}
