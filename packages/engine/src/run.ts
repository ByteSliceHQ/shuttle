import { z } from 'zod'

import { orgOfRun } from '@shuttle/api'
import {
  durableObjectLauncher,
  LoomsDurableObject,
  type LoomsDurableObjectConfig,
} from '@swirls/looms/cloudflare'
import { forwardedActorAuth } from '@swirls/looms/runtime'

import { shuttleAttributes } from './attributes'
import {
  readStoredLlmModel,
  resolveProjectors,
  workspaceRunId,
  writeStoredLlmModel,
} from './config'
import {
  createCredentialStore,
  type CredentialPayload,
  type CredentialStore,
  type CredentialSummary,
} from './credentials/store'
import type { EngineEnv } from './env'
import {
  DEFAULT_HARNESS,
  readPinnedHarness,
  writeStoredHarness,
  type HarnessId,
  type VendorHarnessId,
} from './harness'
import { loomsStub, type LoomsRunStub } from './looms-stub'
import { shuttleModules } from './modules'
import { projectorsFor, type ShuttleHost } from './ports/host'
import {
  readSandboxBinding,
  readSandboxPlacement,
  sandboxNameForSession,
  writeSandboxPlacement,
  type SandboxBinding,
  type SandboxPlacement,
} from './session/bind-sandbox'
import { readDigestSource, type DigestSource } from './session/digest-source'
import {
  LAST_MOVE_KEY,
  PENDING_PLACEMENT_KEY,
  prepareSessionSandbox,
  SANDBOX_HOME_KEY,
  type PendingPlacement,
  type SessionMove,
} from './session/handoff'
import { readSessionStacks } from './session/session-stacks'
import type { SessionStacks } from './session/stack-state'
import { DEFAULT_TEAM, readPinnedTeam, writeStoredTeam, type Team, type TeamInput } from './team'
import { readSessionAccess, writeSessionAccess, type SessionAccess } from './tenancy/access'
import { CONNECTABLE_HARNESSES } from './vendor/harnesses'
import {
  readVendorCatalogue,
  readVendorModelChoice,
  writeVendorCatalogue,
  writeVendorModelChoice,
  type VendorCatalogue,
  type VendorModel,
  type VendorModelChoice,
  type VendorModelChoiceInput,
  type VendorModelChoices,
} from './vendor/models'
import { deriveActivityFromRunState } from './workspace/activity-state'
import type { SessionActivity } from './workspace/module'

const TailRowSchema = z.object({ tail: z.number() })

/**
 * The Durable Object every Shuttle run lives in: Looms' run, plus what Shuttle keeps beside it
 * (who may open a session, where its sandbox is, its agents and models, stored sign-ins). The
 * engine reaches other runs through these methods (`LoomsRunStub`), so a host binds a subclass of
 * this as `LOOMS_RUN` and says only who it is:
 *
 * ```ts
 * export class LoomsRun extends ShuttleRun<HostEnv> {
 *   protected override host(env: HostEnv): ShuttleHost {
 *     return { env, ports: {} }
 *   }
 * }
 * ```
 */
export abstract class ShuttleRun<Env extends EngineEnv = EngineEnv>
  extends LoomsDurableObject<Env>
  implements LoomsRunStub
{
  /** The host this run works for: its environment and the ports it replaces. */
  protected abstract host(env: Env): ShuttleHost

  override configure(env: Env): LoomsDurableObjectConfig {
    const runId = this.ctx.id.name

    if (runId === undefined || runId === '') {
      throw new Error('a Shuttle run requires a named Durable Object id')
    }

    const host = this.host(env)

    return {
      modules: shuttleModules(host, runId, { storage: this.ctx.storage }),
      launcher: durableObjectLauncher(env.LOOMS_RUN),
      attributes: shuttleAttributes,
      ids: host.ids,
      projectors: projectorsFor(
        host,
        runId,
        resolveProjectors(env, { runId, storage: this.ctx.storage }),
      ),
      // Only the Worker reaches this object, and it has already decided the request. It says who
      // the request acts as, and that is recorded on the events the request sends.
      authorize: forwardedActorAuth(),
    }
  }

  /** OpenRouter model id used by agent LLM turns for this run. */
  async getLlmModel(): Promise<{ model: string }> {
    return { model: await readStoredLlmModel(this.ctx.storage, this.env) }
  }

  async setLlmModel(model: string): Promise<{ model: string }> {
    return { model: await writeStoredLlmModel(this.ctx.storage, model) }
  }

  /** The workspace run of this run's organization, which holds the organization's defaults. */
  private workspaceRun(): string {
    return workspaceRunId(this.env, orgOfRun(this.ctx.id.name ?? ''))
  }

  /** Who may open this session. Null when no one has been recorded, see `tenancy/access.ts`. */
  async getAccess(): Promise<SessionAccess | null> {
    return readSessionAccess(this.ctx.storage)
  }

  async setAccess(access: SessionAccess): Promise<SessionAccess> {
    return writeSessionAccess(this.ctx.storage, access)
  }

  /**
   * The sandbox that holds this session's files, or null when it has not bound one yet. That is
   * where it last worked. Before it has worked anywhere, it is where its next turn will run.
   */
  async getSandboxName(): Promise<string | null> {
    const runId = this.ctx.id.name ?? ''
    const binding = await readSandboxBinding(this.ctx.storage, runId)

    if (!binding) {
      return null
    }

    return (
      (await this.ctx.storage.get<string>(SANDBOX_HOME_KEY)) ??
      sandboxNameForSession(this.env, this.ctx.storage, runId, binding.sandboxName)
    )
  }

  /** The machine a person asked for this session to run on, or null for the cloud. */
  async getSandboxPlacement(): Promise<SandboxPlacement | null> {
    return readSandboxPlacement(this.ctx.storage)
  }

  /**
   * Moves this session to one of a person's own machines, or back to the cloud with null. A
   * session that has already worked somewhere is moved now, files and all, so the person sees
   * it arrive; one that has not simply starts there. If the move fails the session stays where
   * it was. `moved` says what was carried, when anything was.
   */
  async placeSandbox(
    placement: SandboxPlacement | null,
  ): Promise<{ sandboxName: string | null; moved: SessionMove | null }> {
    const runId = this.ctx.id.name ?? ''
    const before = await readSandboxPlacement(this.ctx.storage)
    const binding = await readSandboxBinding(this.ctx.storage, runId)
    const lastMove = await this.ctx.storage.get<SessionMove>(LAST_MOVE_KEY)

    await this.ctx.storage.delete(PENDING_PLACEMENT_KEY)
    await writeSandboxPlacement(this.ctx.storage, placement)

    if (!binding) {
      return { sandboxName: null, moved: null }
    }

    try {
      await prepareSessionSandbox(this.env, this.ctx.storage, runId, binding)
    } catch (cause) {
      await writeSandboxPlacement(this.ctx.storage, before)

      throw cause
    }

    const move = await this.ctx.storage.get<SessionMove>(LAST_MOVE_KEY)

    return {
      sandboxName: await this.getSandboxName(),
      moved: move && move.at !== lastMove?.at ? move : null,
    }
  }

  /** Asks for a move that happens when the session next stops working. */
  async placeSandboxLater(placement: SandboxPlacement | null): Promise<{ ok: true }> {
    await this.ctx.storage.put(PENDING_PLACEMENT_KEY, { placement } satisfies PendingPlacement)

    return { ok: true }
  }

  /** What is known about where this session is going and where it last came from. */
  async getSandboxMoves(): Promise<{
    pending: PendingPlacement | null
    last: SessionMove | null
  }> {
    return {
      pending: (await this.ctx.storage.get<PendingPlacement>(PENDING_PLACEMENT_KEY)) ?? null,
      last: (await this.ctx.storage.get<SessionMove>(LAST_MOVE_KEY)) ?? null,
    }
  }

  /**
   * What another session's message quotes when it points at this one: the brief and the latest
   * agent messages, cut down here so the whole transcript never leaves this object.
   */
  async getDigestSource(): Promise<DigestSource> {
    const runId = this.ctx.id.name ?? ''

    return readDigestSource((name) =>
      this.fetch(new Request(`https://shuttle.internal/runs/${runId}/projections/${name}`)),
    )
  }

  /** The repositories this session works in. Empty before it binds a sandbox, or with none linked. */
  async getSessionRepos(): Promise<SandboxBinding['repos']> {
    return (await readSandboxBinding(this.ctx.storage, this.ctx.id.name ?? ''))?.repos ?? []
  }

  /** What this session has published of each stack it keeps. Empty before it publishes anything. */
  async getSessionStacks(): Promise<SessionStacks> {
    return readSessionStacks(this.ctx.storage, this.ctx.id.name ?? '')
  }

  /** Which agent runs this session: Shuttle's own loop or a vendor agent in the sandbox. */
  async getHarness(): Promise<{ harness: HarnessId }> {
    const pinned = await readPinnedHarness(this.ctx.storage)
    const workspace = this.workspaceRun()

    // A session that has not run a turn yet will take the workspace default when it does.
    if (pinned !== null || this.ctx.id.name === workspace) {
      return { harness: pinned ?? DEFAULT_HARNESS }
    }

    return loomsStub(this.env.LOOMS_RUN, workspace).getHarness()
  }

  async setHarness(harness: string): Promise<{ harness: HarnessId }> {
    return { harness: await writeStoredHarness(this.ctx.storage, harness) }
  }

  /** Who the conductor may delegate to in this session. The workspace run holds the default. */
  async getTeam(): Promise<{ team: Team }> {
    const pinned = await readPinnedTeam(this.ctx.storage)
    const workspace = this.workspaceRun()

    if (pinned !== null || this.ctx.id.name === workspace) {
      return { team: pinned ?? DEFAULT_TEAM }
    }

    return loomsStub(this.env.LOOMS_RUN, workspace).getTeam()
  }

  async setTeam(team: TeamInput | null): Promise<{ team: Team }> {
    return { team: await writeStoredTeam(this.ctx.storage, team) }
  }

  /**
   * The model and effort chosen for each vendor agent on this run. The workspace run holds the
   * most recent choice, which sessions without one of their own fall back to.
   */
  async getVendorModelChoices(): Promise<{ choices: VendorModelChoices }> {
    const choices: VendorModelChoices = {}

    for (const harness of CONNECTABLE_HARNESSES) {
      const choice = await readVendorModelChoice(this.ctx.storage, harness)

      if (choice) {
        choices[harness] = choice
      }
    }

    return { choices }
  }

  async setVendorModelChoice(
    harness: VendorHarnessId,
    choice: VendorModelChoiceInput | null,
  ): Promise<{ choice: VendorModelChoice }> {
    return { choice: await writeVendorModelChoice(this.ctx.storage, harness, choice) }
  }

  /** An agent's own model list, kept on the workspace run so it is not fetched on every open. */
  async getVendorCatalogue(harness: VendorHarnessId): Promise<VendorCatalogue | null> {
    return readVendorCatalogue(this.ctx.storage, harness)
  }

  async putVendorCatalogue(
    harness: VendorHarnessId,
    models: readonly VendorModel[],
  ): Promise<VendorCatalogue> {
    return writeVendorCatalogue(this.ctx.storage, harness, models)
  }

  /**
   * Stored vendor agent sign-ins, kept per person. Only the workspace run holds them, so callers
   * reach these through the workspace run's stub and say whose sign-in they mean.
   */
  private credentialStore(): CredentialStore {
    return createCredentialStore({
      storage: this.ctx.storage,
      secret: this.env.SHUTTLE_CREDENTIALS_KEY,
    })
  }

  async getCredential(userId: string, harness: VendorHarnessId): Promise<CredentialPayload | null> {
    return this.credentialStore().get(userId, harness)
  }

  async putCredential(
    userId: string,
    harness: VendorHarnessId,
    payload: CredentialPayload,
  ): Promise<void> {
    await this.credentialStore().put(userId, harness, payload)
  }

  async removeCredential(userId: string, harness: VendorHarnessId): Promise<boolean> {
    return this.credentialStore().remove(userId, harness)
  }

  async listCredentials(userId: string): Promise<CredentialSummary[]> {
    return this.credentialStore().list(userId)
  }

  /** Authoritative log tail for this run. */
  async getStreamTail(): Promise<number> {
    const runId = this.ctx.id.name

    if (runId === undefined || runId === '') {
      return 0
    }

    const [row] = [
      ...this.ctx.storage.sql.exec('SELECT tail FROM looms_streams WHERE run_id = ?', runId),
    ]

    return TailRowSchema.safeParse(row).data?.tail ?? 0
  }

  /** Authoritative session activity + committed log tail for workspace reconciliation. */
  async getSessionActivitySnapshot(): Promise<{
    activity: SessionActivity
    tail: number
  } | null> {
    const runId = this.ctx.id.name

    if (runId === undefined || runId === '') {
      return null
    }

    const run = await this.getRun()

    if (run.rootThreadId === null || run.rootThreadId === '') {
      return null
    }

    return {
      activity: deriveActivityFromRunState(run),
      tail: await this.getStreamTail(),
    }
  }
}
