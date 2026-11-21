# @swirls/shuttle

## 0.7.0

### Minor Changes

- ba65e8f: A host can copy each run's events somewhere of its own: `ShuttleHost` takes `projectors`, a function from a run's id to Looms projectors, which run after Shuttle's own. It is asked once for each run, when the run's object is configured. A host that supplies none gets what it got before.

## 0.6.0

### Minor Changes

- 41c7bc9: `serveShuttle` takes `basePath`, such as `'/shuttle'`, for a host whose own routes sit beside Shuttle's: it answers only paths under it, takes it off before a module sees the path (`/capabilities` and read grants included), and answers a path under it that no module claims with a 404 a listed origin can read. `sessionTenant({ user, orgId, role?, runNames? })` in `@swirls/shuttle/api` builds the `Tenant` for `<Shuttle.Provider>` with `pulls: null`, for a host that serves sessions without `GET /me`. How run ids are made and read (`scopedRunId`, `personalRunId`, `parseRunId` and the rest) moves from `@swirls/shuttle/engine/tenancy/run-id` to `@swirls/shuttle/api`, beside `tenantRunIds` and `DEFAULT_RUN_NAMES`; the engine's `runNames(env)` is in `@swirls/shuttle/engine/tenancy/run-names`.

### Patch Changes

- f04cdde: Depends on `@swirls/looms` 0.23.0, whose NATS projector can reach a stream through a transport the host supplies and can put a run's attributes in its subjects. Nothing in Shuttle's own behaviour changes. A host has to be on the same Looms version as Shuttle, so move both together.
- 8b82997: Back off the wait page for a preview port and stop its poll while the tab is hidden, so a preview whose port never comes up no longer spends the Worker's request budget or its error signal.

## 0.5.1

### Patch Changes

- 61c0e58: Depends on `@swirls/looms` 0.22.1, which fixes a Durable Object that was rebuilt before its alarm fired dropping the wake that alarm was holding. A host has to be on the same Looms version as Shuttle, so move both together.

## 0.5.0

### Minor Changes

- b73e904: What only the engine needs is no longer installed with the package: `ai`, `@cloudflare/sandbox` and `@daytona/sdk` are optional peer dependencies, which a host that runs `@swirls/shuttle/engine` installs beside it. A page that uses the React parts does not carry them.
- b73e904: The engine serves Shuttle's HTTP API in modules a host mounts: `serveShuttle(host, { modules })` from `@swirls/shuttle/engine`, with `sessionApi`, `assetsApi`, `terminalApi` and `firehoseApi` there and `runsApi` and `shuttleApiModules` in `@swirls/shuttle/engine/worker`. It asks the host's identity port who a request acts for, checks who may open the run a path names, answers pages on other origins (`origins`), and gives read grants for a run's log (`grantSecret`). Two new ports, `people` and `previews`, replace what those routes read from Shuttle's own database. See `docs/hosting.md`.
- b73e904: The React parts work against a host that mounts only some of the backend. `createShuttleHost` takes `headers`, added to every request that can carry one, and asks for the backend's cookie when it is on another origin. The parts read `GET /capabilities` and leave out artifact types whose `needs` the backend does not serve. `<Shuttle.Session readOnly>` shows a session without the means to change it. `Tenant.runs.pulls` may be `null` for a host with no pull request inbox. The parts read a run's log with the same credentials, and across origins open its live socket with a read grant they ask the backend for. `@swirls/looms` moves to 0.22.0; a host installs the same version.

## 0.4.0

### Minor Changes

- 61c3527: The engine a host runs Shuttle's sessions on is now in the package: `@swirls/shuttle/engine` (host ports and headless sessions), `@swirls/shuttle/engine/worker` (the Durable Objects a host's Worker binds), and the modules under `@swirls/shuttle/engine/*`, `@swirls/shuttle/git/*` and `@swirls/shuttle/sandbox/*`. See `docs/hosting.md`.

## 0.3.0

### Minor Changes

- 4485f41: Typing `@` in the message box opens a menu of what the message can point at: team members to hand it to, the workspace's other sessions, and the files in the session's repositories. Files are read once from the new `sandbox.paths` route (`GET /sessions/{id}/sandbox/paths`) and searched in the browser as you type. `sessions.say` takes `references`, and the session records them on `shuttle.user.said`: a file by its worktree path, a session with a short digest the Worker reads when the message is sent. Agents get both listed under the message. Mentions are highlighted in the message box as they are picked, and in the conversation, where a file opens in the artifacts pane and a session links to it. `OpenArtifact` accepts `'file'` with a worktree path. A session reference can carry a `label`, the text it is written as: two sessions with the same title are written `@title` and `@title (2)`, so each mention links to its own session. Sessions in the menu show their folder and how recently they changed. A message's mentions survive copy and paste: each message has a Copy button, copying from the message box keeps the mentions in the selection, and pasting either into the message box brings the mentions back as picks. `sandbox.paths` takes and returns an `etag`, so a list that has not changed is not sent again; the menu reads it again only when the session's event log shows something that may have made, deleted or moved files, and adds files agents write in place. Sessions in the menu are ordered by how well they match.
- 9f2ce8b: `@swirls/looms` moves to 0.20.0 and `effect` to 4.1.4; a host installs the same versions. The workspace run's `session.requested` event can carry `hostMetadata`, a string map a host attaches to a session it starts, which the parts keep and do not read.
- 8ac48b8: Start a session with files. `createSession` takes optional `files`, sent as multipart form data,
  and the workspace's `session.requested` event carries them as `attachments`. `StartAttachments`
  and `useStartAttachments` add pasted screenshots to a composer, keeping any text that was copied
  with them.
- e112375: Markdown in the conversation, pull requests and reviews is rendered with `@pierre/words` instead of `react-markdown`. While a reply streams, unfinished bold, code and links show as they will end up, new text fades in, and the caret follows the text into lists and code blocks. Code blocks are highlighted with `@pierre/highlights` in the diff viewer's theme and have a Copy button. `theme.css` styles the markdown through its `data-markdown` elements, and the `.caret` class is gone. `@pierre/diffs` moves to 1.7.0-beta.4, the release that shares `@pierre/highlights` 0.5.1.

### Patch Changes

- f7c8678: A pull request a session publishes no longer says its checks are running before anything has been heard about them, which never cleared in a repository with no checks. The Workspace tab no longer says "Not pushed" for a branch that is: a published branch is compared with GitHub by the tree it holds rather than by its commit, which GitHub makes under another name. The sandbox API's `workspace` reports each commit's `tree` and what the session last `published` of each branch.
- b27f5d4: Tightens the parts' types as part of a stricter lint. `useWidthBucket` no longer takes a type argument. `ShuttleHost.signalRun` takes its input as a JSON object. `ShuttleRouter.navigate` and the identity's `listPeople` and `connectGithub` are function properties, so they can be passed on without binding. Data read from storage and from the sandbox is checked before it is used.

## 0.2.0

### Minor Changes

- 90e4169: The Workspace tab can compare each repository's changes with something other than where the session started: only uncommitted work, one of the session's pull requests, everything since a commit, or any branch. The pull requests a session opened are shown at the top of the tab with their checks, review and whether everything is pushed, and the session's commits are drawn as a line with each pull request over its own. The sandbox API takes an `against` comparison on `workspace`, `file` and `diff`, reports each repository's head, commits and how its changes were measured, and lists branches with `branches`.

### Patch Changes

- 6ed464e: Depends on `@swirls/looms` 0.18.1, whose wakes no longer stop for good after 100 steps. Long
  sessions stalled there until someone sent a message. Looms 0.18 expects
  `@cloudflare/workers-types` 5 when it is installed.
- 6ed464e: The publish card says when it will push to a pull request the layer already has: it is titled
  "Update owner/repo#13", links to that pull request, and offers "Push update" instead of
  "Publish as draft" and "Publish", which did nothing different for an existing pull request.
  After publishing it says "Updated #13" rather than "Opened 1 pull request". `PublishedPull`
  gains an optional `outcome` (`opened`, `updated` or `unchanged`).

## 0.1.1

### Patch Changes

- 1c169a0: A tab whose artifact type is not registered now says so instead of showing an empty pane. This
  happens when a session's tab was opened by a host that has a type of its own and is then viewed
  in one that does not.

## 0.1.0

### Minor Changes

- b6ff58e: First release. Shuttle's UI as React parts (`@swirls/shuttle/react`): a provider, a session and
  its panes, artifact types a host can add to, the plain controls and the theme. With them, the
  backend's API contract (`@swirls/shuttle/api`) and the workspace and pulls runs' events
  (`@swirls/shuttle/core/workspace`, `@swirls/shuttle/core/pulls`).
