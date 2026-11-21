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
import type { ShuttleHost } from '@shuttle/engine'
import { EventFirehose, SessionSandbox, ShuttleRun } from '@shuttle/engine/worker'

export { EventFirehose }

export class LoomsRun extends ShuttleRun<HostEnv> {
  protected override host(env: HostEnv): ShuttleHost {
    return { env, ports: {/* what this host replaces */} }
  }
}

// A host that replaces nothing the sandbox uses exports `SessionSandbox` as it is.
export class Sandbox extends SessionSandbox<HostEnv> {
  protected override environment(env: HostEnv) {
    return { ...env, GIT_ACCESS: hostGit(env) }
  }
}
```

`ShuttleRun` is the Durable Object every Shuttle run lives in. It registers `shuttleModules(host, …)`
with Looms and answers the calls the engine makes from one run to another (`LoomsRunStub`: who may
open a session, where its sandbox is, its agents and models). A host overrides `configure` only to
add to what it returns, as `apps/worker/src/index.ts` adds its timing observer.

The sandbox is a Durable Object of its own, so it does not see the run's ports. It clones and
pushes with what `environment` returns: a host that supplies the `git` port gives the same
`GitAccess` there as `GIT_ACCESS`, or the sandbox asks for Shuttle's own GitHub App key.

The host binds `LOOMS_RUN` to its subclass, `SANDBOX` to `SessionSandbox` or its subclass of it, and
`EVENT_FIREHOSE` to `EventFirehose`, as `apps/worker/wrangler.jsonc` does. Those three classes load only in a Worker,
which is why they have an entry point of their own. `@shuttle/engine` itself loads anywhere, so a
host's other code and its tests can import the ports and the headless API under Bun or Node.

## From npm

A host outside this repository installs `@swirls/shuttle-engine`, which carries the same packages built to
JavaScript with their types:

| In this repository          | From npm                                  |
| --------------------------- | ----------------------------------------- |
| `@shuttle/engine`           | `@swirls/shuttle-engine`                  |
| `@shuttle/engine/worker`    | `@swirls/shuttle-engine/worker`           |
| `@shuttle/engine/<module>`  | `@swirls/shuttle-engine/<module>`         |
| `@shuttle/git/<module>`     | `@swirls/shuttle-engine/git/<module>`     |
| `@shuttle/sandbox/<module>` | `@swirls/shuttle-engine/sandbox/<module>` |

The host's `@swirls/looms` and `effect` versions have to be the ones `@swirls/shuttle-engine` depends on,
so it installs one copy of each. Its `tsconfig` has `@cloudflare/workers-types` in `types`, for the
bindings the engine's types name, and `skipLibCheck` on.

The sandbox's container image is not in the npm package. A host that runs sandboxes in containers
or on Daytona builds it from `packages/sandbox/Dockerfile` in this repository; one that runs them
in memory or on people's own machines needs no image.

## Serving the API

A page that shows a session (the parts in `@swirls/shuttle/react`) talks to Shuttle's HTTP API. The
engine serves it in modules, and a host mounts the ones it wants:

```ts
import { serveShuttle } from '@swirls/shuttle-engine'
import { shuttleApiModules } from '@swirls/shuttle-engine/worker'

export default {
  async fetch(request: Request, env: HostEnv, ctx: ExecutionContext) {
    const shuttle = serveShuttle(host(env), {
      modules: shuttleApiModules,
      origins: ['https://app.example'],
      grantSecret: env.SHUTTLE_GRANT_SECRET,
    })

    return (await shuttle(request, ctx)) ?? theHostsOwnRoutes(request, env)
  },
}
```

| Module        | Serves                                                                      | Needs               |
| ------------- | --------------------------------------------------------------------------- | ------------------- |
| `runsApi`     | A run's log, live, and the signals a browser may send it. `/runs/:id/…`     | A Worker            |
| `sessionApi`  | A session, its playbook and its sandbox's files. `/sessions/…`, `/playbook` |                     |
| `assetsApi`   | Attachments and the media agents make. `/sessions/:id/assets`               | The `ASSETS` bucket |
| `terminalApi` | A session's terminal. `/sessions/:id/sandbox/terminal`                      | A container sandbox |
| `firehoseApi` | The organization's stream of what its public sessions do. `/firehose`       |                     |

`shuttleApiModules` is all of them. `runsApi` forwards to Durable Objects, so it is exported from
`@swirls/shuttle-engine/worker`; the others, in `portableApiModules`, load anywhere. Every module
shows what `runsApi` streams, so a host that mounts any of them mounts it. A module is an object
(`ApiModule`: a name, the paths it claims, a handler), so a host adds its own beside these, as
Shuttle's app does for its workspace routes.

`serveShuttle` answers `null` for a path no mounted module claims, which is how a host puts it in
front of routes of its own. For a path it does claim it asks the `identity` port who the request
acts for (401 for nobody), checks that they may open the run the path names (404 otherwise), and
only then offers the request to the modules. `GET /capabilities` says which modules are mounted,
so a page can leave out what the host does not serve.

A page on the host's own origin needs nothing more. For a page on another origin:

- `origins` lists the pages' origins, and answers to them carry the headers a browser needs.
- `grantSecret` lets the page read a run's log over a WebSocket, which cannot carry a sign-in:
  `POST /runs/:id/grant` gives someone who may open the run a short-lived read grant, and the run's
  log accepts it in place of a sign-in (`grant` on `LoomsProvider`, in `@swirls/looms/react`).

Two more ports feed the API: `people` says who is in an organization, which sharing a session is
checked against, and `previews` keeps the keys of preview hostnames. Without them a session is
shared with no one and has no preview.

## Showing a session

The page is built from the parts in `@swirls/shuttle/react`, pointed at the Worker that serves the
API:

```tsx
import { createShuttleHost, Shuttle } from '@swirls/shuttle/react'

const host = createShuttleHost({
  baseUrl: 'https://engine.example',
  headers: () => ({ authorization: `Bearer ${token()}` }),
})

<Shuttle.Provider host={host} router={router} identity={identity}>
  <Suspense>
    <Shuttle.Session id={runId} readOnly>
      <Shuttle.SessionHeader />
      <Shuttle.Conversation />
      <Shuttle.Artifacts />
    </Shuttle.Session>
  </Suspense>
</Shuttle.Provider>
```

- **Credentials.** `headers` is asked before every request that can carry one (the API, signals,
  a run's log, an upload) and added to it. When the backend is on another origin the parts also ask the browser
  to send its cookie. An image, a download and a terminal are addresses the browser opens by
  itself: they carry no header, so they need the cookie.
- **A live log across origins.** A run's live log is a WebSocket, which carries no header. When
  the backend is on another origin the parts ask it for a read grant for each run
  (`POST /runs/:id/grant`), open the log with it, and renew it before it runs out. The backend
  gives grants when it is served with a `grantSecret`. `grants` on `createShuttleHost` turns
  this on or off by hand.
- **What is mounted.** The parts read `GET /capabilities` once and leave out what the backend does
  not serve: no Terminal tab without `terminalApi`, no Media tab without `assetsApi`, no Browser
  tab without the `previews` port. An artifact type of the host's own says what it needs with
  `needs: ['<module name>']`, and is left out the same way until the host mounts that module.
- **Watching only.** `readOnly` on `Shuttle.Session` shows a session without the means to change
  it: `Shuttle.Composer` draws nothing, and questions and proposals are shown and cannot be
  answered.
- **No pull request inbox.** A host that keeps none gives `identity.tenant.runs.pulls` as `null`,
  and the parts that read it show nothing from it.

## Host ports

A port is a small interface. Leave it out and Shuttle does what it does standalone.

| Port           | Decides                                                                              | Standalone                                     |
| -------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `identity`     | Who a request acts for: a named person, or an organization acting through a service. | The signed-in person.                          |
| `sessionStart` | Whether a session may start, for a person's start, an automatic review, or a host's. | Every start is allowed.                        |
| `credentials`  | Whose credential a vendor agent turn runs on, and the API keys the host holds.       | The person it works for, on their own sign-in. |
| `approvals`    | How long an approval waits before a decision is refused.                             | Forever.                                       |
| `git`          | Installation tokens and the user token for GitHub.                                   | Shuttle's own GitHub App, from `env`.          |

`serviceIdentity({ token, service })` is a ready identity for a host calling over HTTP: it presents
a shared secret and names who it acts for in `x-shuttle-org` (and `x-shuttle-user` for a person).

`sessionStart` is asked before every session: one a person starts in the app (`person`), a review
Shuttle opens by itself (`auto-review`), and a host's own (`host`, with the metadata it gave). A
host's start repeated with the same `idempotencyKey` is the same session and is not asked again, so
a port that counts starts counts each session once.

A turn runs on the credential of the person it is working for, and never on another person's. The
`credentials` port says whose that is (that person, an organization, or nobody) and may supply API
keys for them as environment variables (`apiKeys`). A person's sign-in with a vendor stays in
Shuttle's own encrypted store, in the organization's workspace run, and is only ever placed in that
person's turns: a port cannot read it, hold it, or supply one. An organization has API keys or
nothing. `modelKey` is the same for Shuttle's own agent loop: the OpenRouter key a run's model calls
use, so the organization it works for pays; without one the run uses the deployment's
`OPENROUTER_API_KEY`.

Approval expiry covers the pull request publish gate. A decision after the expiry is refused and the
agent is told the proposal expired. Nothing wakes the session when the time passes; the gate is
settled by the late decision, or by the session moving on. A host that wants a decision made by a
rule reads the question from `headlessOutcome` and answers it with `answerHeadlessQuestion`.

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
// { state: 'blocked', question: { approvalId, title, description, kind, expiresAt }, pullRequests }
// { state: 'failed', error, pullRequests }

await answerHeadlessQuestion(
  host,
  runId,
  outcome.question.approvalId,
  { text: 'Use Postgres' },
  acting,
)
```

A headless session has no folder (`NO_FOLDER`) and a sandbox of its own, `session:<runId>`.
`harness` picks the agent that works it (`claude-code`, `codex`, …); left out, it runs on the
deployment's default. A vendor harness runs on the credential the `credentials` port names, so a
host paying with an organization's own API key picks the vendor that key is for. A
person's session is private to them; an organization's is open to the organization. `metadata` is a
string map Shuttle carries on the session (`hostMetadata` in the session input) and never reads.

A session is `blocked` while it has a question open, whatever else is running. `question.kind` says
how to answer: a `question` (an agent's `ask_user`) takes `{ text }`, or `null` for the agent's own
judgment; a `publish-pull-request` proposal, or a `submit-review` (a pull request review an agent
has drafted), takes `{ decision: 'approve' | 'reject' }`. `expiresAt` is when the host's approval
policy stops accepting a decision on a proposal. An answer of the wrong shape for the question, or
for one the session does not have open, is refused with `HeadlessRequestError` and decides nothing.
The decision is recorded as made by whoever `acting` is. `question.approvalId` is null in the rare
case that the run is waiting on a person and does not say for which approval.

`answerHeadlessQuestion` refuses an `acting` that could not open the session: another
organization, or anyone but the owner and the people it is shared with for a person's private
session. `headlessOutcome` takes no `acting` and answers for any run id, so a host that serves it
to callers checks first that the session is the caller's to read.

`headlessSessions(host)` gives the same three calls bound to a host (`start`, `outcome`, `answer`),
for whatever launches its sessions.

The headless API calls `env.LOOMS_RUN`, so it runs in the host's Worker or anywhere that holds that
binding. `serviceIdentity` is there for a host that puts these calls behind HTTP for a caller
elsewhere; Shuttle's own Worker serves no such route.
