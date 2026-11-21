import { createTypeSafeAi } from '@ai-sdk/typesafe-ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

import { isLocalSandbox, sandboxIsPersonal } from '@shuttle/sandbox/names'
import { sessionWorkDir } from '@shuttle/sandbox/workspace'
import type { LlmAdapter, LlmCompleteArgs } from '@swirls/looms/agent'
import { vercelEvaluator, type AttachmentResolver } from '@swirls/looms/ai-vercel'
import type {
  EvaluatorAdapter,
  EvaluatorEvaluateArgs,
  StubEvaluatorPolicy,
} from '@swirls/looms/evaluator'
import type { Projector } from '@swirls/looms/projectors'
import { d1ReplicaDatabase, sqliteReplica } from '@swirls/looms/projectors/replica/sqlite'

import { classifyHeuristic, parseIntakeMessage } from './agents/intake'
import { vendorHarnessOfModel } from './agents/vendor-member'
import { collectSharedFiles, shareInstructions, stageAttachments } from './assets/sandbox'
import { getAsset } from './assets/store'
import { shuttleAttributes } from './attributes'
import { sandboxStub, type EngineEnv } from './env'
import { createFirehoseProjector } from './firehose/projector'
import { isVendorHarness, readPinnedHarness, writeStoredHarness } from './harness'
import { createReasoningLlm, createStubThinkingLlm, getTurnThread, reasoningEffortFor } from './llm'
import { loomsStub } from './looms-stub'
import { billedToLabel, turnCredentials, type CredentialPort } from './ports/credentials'
import { present } from './present'
import { readSandboxBinding, sandboxNameForSession } from './session/bind-sandbox'
import { prepareSessionSandbox } from './session/handoff'
import { resolveSponsor } from './session/sponsor'
import { onTeam, readPinnedTeam, writeStoredTeam, type Team } from './team'
import { orgOfRun, personalRunId, scopedRunId } from './tenancy/run-id'
import { signInFilesPresent, vendorHarnessInfo } from './vendor/harnesses'
import { readVendorModelChoice } from './vendor/models'
import { runVendorTurn } from './vendor/turn'
import { createWorkspaceActivityProjector } from './workspace/activity'

/** Largest image and document sent to a model itself. Larger ones are named with their path. */
const MAX_MODEL_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_MODEL_DOCUMENT_BYTES = 20 * 1024 * 1024
const MODEL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * Reads an attached file for a model call: images and PDFs within the size models accept.
 * Anything else is left to its sandbox path, which the message text names.
 */
function modelAttachmentResolver(bucket: R2Bucket, runId: string): AttachmentResolver {
  return async (attachment) => {
    const limit = MODEL_IMAGE_TYPES.has(attachment.mediaType)
      ? MAX_MODEL_IMAGE_BYTES
      : attachment.mediaType === 'application/pdf'
        ? MAX_MODEL_DOCUMENT_BYTES
        : 0

    if (limit === 0 || (attachment.size ?? 0) > limit) {
      return null
    }

    const found = await getAsset(bucket, runId, attachment.id)

    return found && found.ref.size <= limit
      ? new Uint8Array(await found.object.arrayBuffer())
      : null
  }
}

/** Copies the files attached to `messages` into the session's sandbox. Never fails a turn. */
async function stageMessageAttachments(
  env: EngineEnv,
  storage: DurableObjectStorage,
  runId: string,
  boundSandboxName: string,
  messages: LlmCompleteArgs['messages'],
): Promise<void> {
  const attachments = messages.flatMap((message) =>
    (message.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name ?? attachment.id,
    })),
  )

  if (!env.ASSETS || attachments.length === 0) {
    return
  }

  try {
    const sandboxName = await sandboxNameForSession(env, storage, runId, boundSandboxName)

    await stageAttachments({
      bucket: env.ASSETS,
      sandbox: sandboxStub(env, sandboxName),
      sandboxName,
      storage,
      runId,
      attachments,
    })
  } catch {
    // The turn still runs; the agent finds the path missing and says so.
  }
}

export const DEFAULT_LLM_MODEL = 'anthropic/claude-sonnet-5.5'
export const DEFAULT_JEV_MODEL = 'jev-latest'
export const LLM_MODEL_STORAGE_KEY = 'shuttle:llmModel'

function reasoningSettingsFor(modelId: string) {
  return { effort: reasoningEffortFor(modelId) }
}

function rejectsReasoningParams(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /reasoning|effort|unsupported|invalid.*param/i.test(message)
}

export function defaultLlmModel(env: EngineEnv): string {
  return present(env.LOOMS_MODEL?.trim()) ?? DEFAULT_LLM_MODEL
}

/**
 * The team for a session. One with no team of its own takes the workspace default on first use
 * and keeps it, like its harness.
 */
export async function resolveTeam(
  env: EngineEnv,
  storage: DurableObjectStorage,
  runId: string,
): Promise<Team> {
  const pinned = await readPinnedTeam(storage)

  if (pinned) {
    return pinned
  }

  const preferred = await loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgOfRun(runId))).getTeam()

  // The developer may have set this session's team while the default was being fetched. Their
  // choice wins over the default.
  return (await readPinnedTeam(storage)) ?? writeStoredTeam(storage, preferred.team)
}

/**
 * The model adapter for a run. A session set to a vendor harness (Codex, Claude Code) runs each
 * turn on that agent in the sandbox container; every other session uses OpenRouter.
 */
export function resolveLlm(
  env: EngineEnv,
  credentialPort: CredentialPort,
  storage?: DurableObjectStorage,
  runId?: string,
): LlmAdapter {
  const openRouter = resolveOpenRouterLlm(env, credentialPort, storage, runId)

  if (storage === undefined || runId === undefined || runId === '') {
    return openRouter
  }

  return {
    complete: async (args: LlmCompleteArgs) => {
      // Only a coding session, which has a sandbox bound to it, runs on a vendor agent. Side
      // runs such as reflection have none: they must not spend the developer's subscription or
      // start a container of their own.
      const binding = await readSandboxBinding(storage, runId)

      if (!binding) {
        return openRouter.complete(args)
      }

      // Every agent can open an attached file by path, so the files are in the sandbox before
      // the turn that first mentions them.
      await stageMessageAttachments(env, storage, runId, binding.sandboxName, args.messages)

      // Worked out on every turn, including the ones OpenRouter runs: a conductor on OpenRouter
      // may hand its work to a vendor agent, which then runs on this person's sign-in.
      const sponsorId = await resolveSponsor(storage, args.messages)

      // A session with no harness of its own takes the workspace default on its first turn and
      // keeps it, so changing the default later does not switch a session that is under way.
      let sessionHarness = await readPinnedHarness(storage)

      if (sessionHarness === null) {
        const preferred = await loomsStub(
          env.LOOMS_RUN,
          workspaceRunId(env, orgOfRun(runId)),
        ).getHarness()

        // A harness the developer picked while the default was being fetched wins over it.
        sessionHarness =
          (await readPinnedHarness(storage)) ??
          (await writeStoredHarness(storage, preferred.harness))
      }

      // In a hybrid session the conductor delegates to vendor agents on its team. Such an agent
      // names its harness as its model, whatever the session itself runs on.
      const memberHarness = vendorHarnessOfModel(args.model)
      const harness = memberHarness ?? sessionHarness

      if (!isVendorHarness(harness)) {
        return openRouter.complete(args)
      }

      const label = vendorHarnessInfo(harness).label

      if (
        memberHarness !== null &&
        !onTeam(await resolveTeam(env, storage, runId), memberHarness)
      ) {
        return {
          message: {
            role: 'assistant',
            content: `${label} is not on this session's team. Add it from the agent picker to delegate to it.`,
          },
          usage: { input: 0, output: 0 },
        }
      }

      const sandboxName = await sandboxNameForSession(env, storage, runId, binding.sandboxName)
      const sandbox = sandboxStub(env, sandboxName)

      if ((await sandbox.getMode()).mode !== 'container') {
        return {
          message: {
            role: 'assistant',
            content: `${label} sessions need the container sandbox. Set SHUTTLE_WORKSPACE_MODE=container and restart Shuttle.`,
          },
          usage: { input: 0, output: 0 },
        }
      }

      // Sets the sandbox up, and first moves the session into it if it was working elsewhere.
      await prepareSessionSandbox(env, storage, runId, binding)

      const orgId = orgOfRun(runId)
      const credentials = loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgId))

      // Whose credential this turn runs on is the port's to say. A standalone Shuttle says: the
      // person it is working for, and nobody's when no one has asked for anything.
      const turn = turnCredentials(credentialPort, credentials, {
        runId,
        orgId,
        harness,
        sponsorId,
      })

      // Read last, so a model picked while the sandbox was being prepared still applies. A
      // session with no choice of its own uses the most recent one made anywhere.
      const choice =
        (await readVendorModelChoice(storage, harness)) ??
        (await credentials.getVendorModelChoices()).choices[harness]

      return runVendorTurn(
        {
          harness,
          runId,
          cwd: sessionWorkDir(runId, binding.repos),
          sandbox,
          storage,
          choice: choice ?? undefined,
          member:
            memberHarness === null
              ? undefined
              : { threadId: getTurnThread(args.signal) ?? crypto.randomUUID() },
          // The turn runs on the sign-in of the person it is working for, and on no one else's.
          // A session Shuttle started itself, which nobody has spoken in, has no one's.
          billedTo: turn.owner === null ? undefined : billedToLabel(turn.owner),
          signInStaysInSandbox: sandboxIsPersonal(sandboxName, env),
          signInPresent: async () =>
            (await sandbox.exec(signInFilesPresent(vendorHarnessInfo(harness).credentialFiles)))
              .exitCode === 0,
          onMachine: isLocalSandbox(sandboxName),
          shareInstructions: shareInstructions(runId),
          collectShared: () =>
            collectSharedFiles({
              bucket: env.ASSETS,
              sandbox,
              runId,
              sharedBy: getTurnThread(args.signal) ?? harness,
            }),
          credentials: turn,
        },
        args,
      )
    },
  }
}

/**
 * The OpenRouter adapter for a run. When the host's credentials port names a model key for the
 * run's organization, its model calls are made with that key, asked for on each call so a key
 * the organization changes is taken up; otherwise with the deployment's `OPENROUTER_API_KEY`.
 * With neither, the run answers from a stub.
 */
function resolveOpenRouterLlm(
  env: EngineEnv,
  credentialPort: CredentialPort,
  storage?: DurableObjectStorage,
  runId?: string,
): LlmAdapter {
  if (credentialPort.modelKey === undefined || runId === undefined || runId === '') {
    return openRouterLlm(env, env.OPENROUTER_API_KEY, storage, runId)
  }

  // One adapter per key, so a run keeps the models it learned reject reasoning settings.
  const adapters = new Map<string, LlmAdapter>()

  return {
    complete: async (args: LlmCompleteArgs) => {
      const key =
        (await credentialPort.modelKey?.({ orgId: orgOfRun(runId), runId })) ??
        env.OPENROUTER_API_KEY ??
        ''

      const adapter = adapters.get(key) ?? openRouterLlm(env, key, storage, runId)

      adapters.set(key, adapter)

      return adapter.complete(args)
    },
  }
}

function openRouterLlm(
  env: EngineEnv,
  apiKey: string | undefined,
  storage?: DurableObjectStorage,
  runId?: string,
): LlmAdapter {
  if (apiKey === undefined || apiKey === '') {
    return createStubThinkingLlm()
  }

  const openrouter = createOpenRouter({ apiKey })
  const fallback = defaultLlmModel(env)
  /** Models that rejected OpenRouter reasoning params stay on the plain chat path. */
  const plainChatModels = new Set<string>()

  const resolveAttachment =
    env.ASSETS !== undefined && runId !== undefined && runId !== ''
      ? modelAttachmentResolver(env.ASSETS, runId)
      : undefined

  return {
    complete: async (args: LlmCompleteArgs) => {
      const stored = storage ? await storage.get<string>(LLM_MODEL_STORAGE_KEY) : undefined
      const modelId = present(stored?.trim()) ?? fallback

      const withReasoning = !plainChatModels.has(modelId)

      const model = withReasoning
        ? openrouter.chat(modelId, {
            reasoning: reasoningSettingsFor(modelId),
            usage: { include: true },
          })
        : openrouter.chat(modelId, {
            usage: { include: true },
          })

      const llm = createReasoningLlm({ model, stream: true, resolveAttachment })

      try {
        return await llm.complete(args)
      } catch (cause) {
        if (!withReasoning || !rejectsReasoningParams(cause)) {
          throw cause
        }

        plainChatModels.add(modelId)

        return createReasoningLlm({
          model: openrouter.chat(modelId, { usage: { include: true } }),
          stream: true,
          resolveAttachment,
        }).complete(args)
      }
    },
  }
}

export interface ResolvedEvaluator {
  readonly evaluator?: EvaluatorAdapter
  readonly evaluatorPolicy?: StubEvaluatorPolicy
}

/**
 * Prefer TypeSafe Jev when `TYPESAFE_AI_API_KEY` is set.
 * Without a key, fall back to local intake heuristics (no network).
 */
export function resolveEvaluator(env: EngineEnv): ResolvedEvaluator {
  const apiKey = present(env.TYPESAFE_AI_API_KEY?.trim())

  if (apiKey === undefined) {
    return {
      evaluatorPolicy: {
        evaluate: heuristicIntakeEvaluate,
      },
    }
  }

  const model = present(env.JEV_MODEL?.trim()) ?? DEFAULT_JEV_MODEL

  return {
    evaluator: vercelEvaluator({
      model,
      provider: createTypeSafeAi({ apiKey }),
    }),
  }
}

/** Offline intake fallback when TYPESAFE_AI_API_KEY is unset. */
async function heuristicIntakeEvaluate(args: EvaluatorEvaluateArgs) {
  const kind = classifyHeuristic(parseIntakeMessage(args.state))

  return {
    answers: {
      kind: { type: 'choice' as const, value: kind },
    },
    usage: { input: 0, output: 0 },
  }
}

export async function readStoredLlmModel(
  storage: DurableObjectStorage,
  env: EngineEnv,
): Promise<string> {
  const stored = await storage.get<string>(LLM_MODEL_STORAGE_KEY)
  return present(stored?.trim()) ?? defaultLlmModel(env)
}

export async function writeStoredLlmModel(
  storage: DurableObjectStorage,
  model: string,
): Promise<string> {
  const trimmed = model.trim()

  if (trimmed === '') {
    throw new Error('model is required')
  }

  await storage.put(LLM_MODEL_STORAGE_KEY, trimmed)
  return trimmed
}

export interface ProjectorContext {
  readonly runId: string
  readonly storage?: DurableObjectStorage
}

export function resolveProjectors(env: EngineEnv, context?: ProjectorContext): Projector[] {
  const projectors: Projector[] = []

  if (env.REPLICA) {
    projectors.push(
      sqliteReplica({
        database: d1ReplicaDatabase(env.REPLICA),
        migrate: 'auto',
        additionalFields: shuttleAttributes,
      }),
    )
  }

  if (context) {
    projectors.push(createFirehoseProjector(env, context.runId, context.storage))
    projectors.push(createWorkspaceActivityProjector(env, context.runId, context.storage))
  }

  return projectors
}

/**
 * Each organization has one playbook, one workspace and one pulls run. `orgId` is null only for
 * a run that belongs to no organization (see `tenancy/run-id.ts`).
 */
export function playbookRunId(env: EngineEnv, orgId: string | null): string {
  return scopedRunId(orgId, env.SHUTTLE_PLAYBOOK_RUN_ID ?? 'shuttle-playbook')
}

export function workspaceRunId(env: EngineEnv, orgId: string | null): string {
  return scopedRunId(orgId, env.SHUTTLE_WORKSPACE_RUN_ID ?? 'shuttle-workspace')
}

/**
 * A person's own workspace run. It lists the sessions that are private to them or shared with
 * them; the organization's workspace run lists the public ones.
 */
export function personalWorkspaceRunId(env: EngineEnv, orgId: string, userId: string): string {
  return personalRunId(orgId, userId, env.SHUTTLE_WORKSPACE_RUN_ID ?? 'shuttle-workspace')
}

export function pullsRunId(env: EngineEnv, orgId: string | null): string {
  return scopedRunId(orgId, env.SHUTTLE_PULLS_RUN_ID ?? 'shuttle-pulls')
}
