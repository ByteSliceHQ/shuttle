import { z } from 'zod'

import { defineTool } from '@swirls/looms/agent'
import type { JsonValue } from '@swirls/looms/core'

import type { ShuttleEnv } from '../env'

function asJson(value: HistoryQueryResult): JsonValue {
  return {
    available: value.available,
    rows: value.rows as JsonValue[],
    ...(value.note ? { note: value.note } : {}),
  }
}

export interface HistoryQueryResult {
  readonly available: boolean
  readonly rows: readonly Record<string, unknown>[]
  readonly note?: string
}

export async function queryReplica(
  env: ShuttleEnv,
  sql: string,
  params: unknown[] = [],
): Promise<HistoryQueryResult> {
  if (!env.REPLICA) {
    return {
      available: false,
      rows: [],
      note: 'D1 REPLICA binding is not configured; history tools are degraded for this deploy.',
    }
  }

  const statement = env.REPLICA.prepare(sql)
  const bound = params.length > 0 ? statement.bind(...params) : statement
  const result = await bound.all()
  return {
    available: true,
    rows: (result.results ?? []) as Record<string, unknown>[],
  }
}

export function createHistoryTools(env: ShuttleEnv, runId: string) {
  const queryEvents = defineTool({
    name: 'query_events',
    description: 'Query recent events for this session (or a child run) from the D1 replica',
    input: z.object({
      runId: z.string().optional(),
      typePrefix: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    handler: async (input) => {
      const targetRunId = input.runId ?? runId
      const limit = input.limit ?? 40

      if (input.typePrefix) {
        return asJson(
          await queryReplica(
            env,
            `SELECT run_id, seq, type, ts, payload_json
             FROM looms_run_events
             WHERE run_id = ? AND type LIKE ?
             ORDER BY seq DESC
             LIMIT ?`,
            [targetRunId, `${input.typePrefix}%`, limit],
          ),
        )
      }

      return asJson(
        await queryReplica(
          env,
          `SELECT run_id, seq, type, ts, payload_json
           FROM looms_run_events
           WHERE run_id = ?
           ORDER BY seq DESC
           LIMIT ?`,
          [targetRunId, limit],
        ),
      )
    },
  })

  const runTree = defineTool({
    name: 'run_tree',
    description: 'List runs that share this session correlation id',
    input: z.object({
      correlationId: z.string().optional(),
    }),
    handler: async (input) => {
      const correlationId = input.correlationId ?? runId
      return asJson(
        await queryReplica(
          env,
          `SELECT run_id, kind, definition_name, status, parent_run_id, correlation_id, updated_at
           FROM looms_run_index
           WHERE correlation_id = ? OR run_id = ?
           ORDER BY updated_at DESC
           LIMIT 50`,
          [correlationId, correlationId],
        ),
      )
    },
  })

  const friction = defineTool({
    name: 'friction',
    description: 'Read friction entries projected from agent corrections and tool failures',
    input: z.object({
      runId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    handler: async (input) => {
      const targetRunId = input.runId ?? runId
      const limit = input.limit ?? 40

      return asJson(
        await queryReplica(
          env,
          `SELECT run_id, seq, type, ts, payload_json
           FROM looms_run_events
           WHERE run_id = ?
             AND (
               type = 'agent.steered'
               OR type = 'agent.turn.stopped'
               OR type = 'agent.tool.result'
               OR type = 'reflect.friction.recorded'
             )
           ORDER BY seq DESC
           LIMIT ?`,
          [targetRunId, limit],
        ),
      )
    },
  })

  return { queryEvents, runTree, friction }
}
