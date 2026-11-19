# Hosting Shuttle

Shuttle's sessions, pull requests, reflection and workspace run from packages a host can import.
`apps/worker` is one host: Shuttle's own app. Another Worker can run the same engine under a
different product.

## Packages

| Package            | What it holds                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `@shuttle/git`     | GitHub App access and webhooks, Pierre code storage. Env type `GitEnv`.                          |
| `@shuttle/sandbox` | Sandbox providers, the sandbox Durable Object, the bridge and its container image. `SandboxEnv`. |
| `@shuttle/engine`  | Sessions, pulls, reflect, workspace, agents, vendor harnesses, `shuttleModules`. `EngineEnv`.    |
| `@shuttle/core`    | Event and schema definitions shared with the web app.                                            |

Each exports TypeScript source (`"./*": "./src/*.ts"`), so a host in the same Bun workspace imports
them directly. Env types layer: `GitEnv` ← `SandboxEnv` ← `EngineEnv` ← the host's own env. A host
declares the bindings it provides and passes them as `env`.

## Composition root

```ts
import { shuttleModules, type ShuttleHost } from '@shuttle/engine'

export class LoomsRun extends LoomsDurableObject<HostEnv> {
  override configure(env: HostEnv): LoomsDurableObjectConfig {
    const host: ShuttleHost = { env, ports: {/* what this host replaces */} }

    return {
      modules: shuttleModules(host, this.ctx.id.name, { storage: this.ctx.storage }),
      // launcher, attributes, projectors, authorize as `apps/worker/src/index.ts` does
    }
  }
}
```

The host also exports the `SessionSandbox` and `EventFirehose` Durable Object classes and binds
`LOOMS_RUN`, `SANDBOX` and `EVENT_FIREHOSE`, as `apps/worker/wrangler.jsonc` does.

## Host ports

A port is a small interface. Leave it out and Shuttle does what it does standalone.

| Port           | Decides                                                                              | Standalone                                                         |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `identity`     | Who a request acts for: a named person, or an organization acting through a service. | The signed-in person.                                              |
| `sessionStart` | Whether a session may start, for a person's start, an automatic review, or a host's. | Every start is allowed.                                            |
| `credentials`  | Whose credential a vendor agent turn runs on, and where it is stored.                | The person it works for, kept in the organization's workspace run. |
| `approvals`    | How long an approval waits before a decision is refused.                             | Forever.                                                           |
| `git`          | Installation tokens and the user token for GitHub.                                   | Shuttle's own GitHub App, from `env`.                              |

`serviceIdentity({ token, service })` is a ready identity for a host calling over HTTP: it presents
a shared secret and names who it acts for in `x-shuttle-org` (and `x-shuttle-user` for a person).

Approval expiry covers the pull request publish gate. A decision after the expiry is refused and the
agent is told the proposal expired. Nothing wakes the session when the time passes; the gate is
settled by the late decision, or by the session moving on.

## Headless sessions

```ts
import { answerHeadlessQuestion, headlessOutcome, startHeadlessSession } from '@shuttle/engine'

const { runId } = await startHeadlessSession(host, {
  acting: { kind: 'organization', orgId, service: 'build-host' },
  brief: 'Fix the flaky checkout test',
  repositories: [{ installationId, fullName: 'acme/shop', defaultBranch: 'main', private: true }],
  metadata: { workItem: 'WI-7' },
  idempotencyKey: 'wi-7',
})

const outcome = await headlessOutcome(host, runId)
// { state: 'working' }
// { state: 'completed', pullRequests: [{ repo, number, url, draft }] }
// { state: 'blocked', question: { approvalId, title, description }, pullRequests }
// { state: 'failed', error, pullRequests }

await answerHeadlessQuestion(
  host,
  runId,
  outcome.question.approvalId,
  { text: 'Use Postgres' },
  acting,
)
```

A headless session has no folder (`NO_FOLDER`) and a sandbox of its own, `session:<runId>`. A
person's session is private to them; an organization's is open to the organization. `metadata` is a
string map Shuttle carries on the session (`hostMetadata` in the session input) and never reads.
