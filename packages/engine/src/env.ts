import type { SandboxEnv } from '@shuttle/sandbox/env'
import type { SandboxBindingEnv } from '@shuttle/sandbox/stub'
import type { DurableObjectNamespaceLike } from '@swirls/looms/cloudflare'

import type { EventFirehose } from './firehose/durable-object'
import type { LoomsRunStub } from './looms-stub'

export { sandboxStub, type SandboxBindingEnv, type SessionSandboxStub } from '@shuttle/sandbox/stub'

/**
 * What the session, pulls, reflect, workspace and sandbox modules read from the host they run in.
 * `ShuttleHost.env` is one of these. Nothing about sign-in or the HTTP edge is here: a host that
 * does not serve Shuttle's own web app never has to supply it.
 */
export interface EngineEnv extends SandboxEnv, SandboxBindingEnv {
  /**
   * Typed by the RPC surface Shuttle calls, not by the class: Cloudflare's stub types cannot
   * expand a class whose methods take recursive JSON.
   */
  readonly LOOMS_RUN: DurableObjectNamespaceLike<LoomsRunStub>
  readonly EVENT_FIREHOSE: DurableObjectNamespace<EventFirehose>
  /** Where uploaded and agent-made media is stored. Without it, attachments are unavailable. */
  readonly ASSETS?: R2Bucket
  readonly REPLICA?: D1Database
  readonly OPENROUTER_API_KEY?: string
  readonly LOOMS_MODEL?: string
  /** TypeSafe API key for Jev evaluator decisions (`TYPESAFE_AI_API_KEY`). */
  readonly TYPESAFE_AI_API_KEY?: string
  /** Optional Jev model id; defaults to `jev-latest`. */
  readonly JEV_MODEL?: string
  readonly SHUTTLE_PLAYBOOK_RUN_ID?: string
  readonly SHUTTLE_WORKSPACE_RUN_ID?: string
  readonly SHUTTLE_PULLS_RUN_ID?: string
  readonly SHUTTLE_WEB_URL?: string
  /** Long random secret that encrypts stored vendor agent credentials. */
  readonly SHUTTLE_CREDENTIALS_KEY?: string
}
