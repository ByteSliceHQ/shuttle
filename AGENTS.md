# Agent instructions

## Commits

Every commit must follow the [Conventional Commits](https://www.conventionalcommits.org/)
specification:

```text
<type>(optional-scope): <imperative summary>
```

Use one of these types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`,
`refactor`, `revert`, `style`, or `test`.

- Keep the summary concise, lowercase, and free of a trailing period.
- Use `feat` for new user-facing behavior and `fix` for user-facing bug fixes.
- Run `bun run verify` before committing.

## Architecture

Shuttle is a Looms application, not a Looms package.

- `packages/engine` (`@shuttle/engine`) owns the custom Looms modules (`session`, `pulls`, `reflect`, `workspace`) and `shuttleModules(host, …)`; `packages/sandbox` and `packages/git` sit under it. `apps/worker` is a host of them: Cloudflare hosting, auth and the HTTP API. The run's Durable Object is the engine's `ShuttleRun` (`@shuttle/engine/worker`), which a host subclasses. See `docs/hosting.md`.
- `apps/web` is the session UI, assembled from `packages/react`.
- `packages/react` is the UI as parts (`@shuttle/react`), for this app and for other hosts.
- `packages/core` (`@shuttle/core`) holds what the runs say: the workspace and pulls runs'
  event catalogues and schemas, which the Worker registers and the UI reads.
- `apps/desktop` hosts that UI in Electron and starts `apps/runner`, which keeps a sandbox on the machine.
- Sandbox providers live in `packages/sandbox/src/providers`; nothing outside it names one. See `docs/sandboxes.md`.
- Depend on published `@swirls/looms`. Link a local Looms build only when developing SDK changes.

## HTTP API

Every JSON route is declared once, in `packages/api` (`@shuttle/api`), as an
[oRPC](https://orpc.dev) contract: method, path, and zod schemas for input and output.

- **Where routes live:** what any host serves (a session, its sandbox, assets, the terminal, the
  firehose, a run's log) is in `packages/engine/src/api`, grouped into the `ApiModule`s that
  `serveShuttle` mounts. What only Shuttle's own app serves (the workspace, connections, runners,
  GitHub, the tenant) is in `apps/worker/src/api`, mounted as one more module.
- **Adding a route:** declare it in `packages/api/src/<domain>.ts` and implement it with
  `api.<domain>.<name>.handler(...)` in whichever of the two it belongs to. Input and output are
  validated against the contract; throw `ORPCError` (or `badRequest`/`forbidden`/`notFound`) for
  failures. Never parse a body by hand or cast it.
- **Not on the contract:** WebSocket upgrades, redirects and binary bodies stay plain handlers.
  Looms' own routes (`/runs/…`) are forwarded to the run by `runsApi`.
- Types shared by the Worker and the web app come from the contract's schemas (`z.infer`), not
  from hand-written interfaces.

## Web app

`apps/web` is TanStack Router + TanStack Query over the typed client in `src/api/client.ts`.
Its pages are put together from the parts in `packages/react` (see "React parts").

- **Reads:** `api.<domain>.<name>.queryOptions(...)`. A page's `loader` awaits
  `queryClient.query({ ...options, staleTime: 'static' })` for what it needs to render (cached
  data is used as it is; the component refreshes it) and the component reads it with
  `useSuspenseQuery`. Secondary data is started, not awaited, with
  `void queryClient.query(options).catch(noop)` and read with `useQuery`. Never fetch in
  `useEffect`. (`ensureQueryData`, `prefetchQuery` and `fetchQuery` are deprecated.)
- **Writes:** `useMutation(api.<domain>.<name>.mutationOptions(...))`, updating or invalidating
  the query cache in `onSuccess`.
- **Navigation:** `<Link>` preloads a page's loaders on intent. A page change waits for its
  loaders with the old page on screen and `NavigationProgress` showing.
- **Search params:** declared with a zod `validateSearch` on the route, read with `useSearch`.
- **Live data** (a run's events) comes through `@swirls/looms/react`, not through queries. A
  page drawn from a run's log awaits `whenRunSynced(runId, userId)` (`src/lib/run-stores.ts`) in
  its route's `beforeLoad`, guarded by `!preload`. It goes in `beforeLoad`, not the loader: a
  loader's result is kept from when the link was hovered and the router shows the page from it
  without waiting, while `beforeLoad` is awaited on every way in.
- **No loading states in pages.** Everything a page shows on arrival is awaited before it
  renders (required data throws to the route's error component; optional data is awaited with
  `.catch(noop)` and read with `useQuery`). The only loading indicator is `NavigationProgress`.
  Data behind an interaction (a popover, a tab, a picker) loads when it is opened.
- **Layout:** `src/routes` holds thin route files that assemble parts from `@shuttle/react`.
  What is left in `src/features` is this app's own: `auth` (sign-in), `desktop` (the desktop
  app's bridge) and `github`. `src/host.ts` makes the app's `ShuttleHost`, `src/shuttle-router.tsx`
  says where each of Shuttle's destinations is, and `routes/_app.tsx` gives both, with who is
  signed in, to `<Shuttle.Provider>`.

## React parts

`packages/react` (`@shuttle/react`) is Shuttle as parts that any host puts together: this
repository's web and desktop apps, and other products. It has three entry points: `.` (the
`Shuttle` parts, hooks and `createShuttleHost`), `./ui` (the plain controls) and `./theme.css`.

- **Host boundary:** nothing in the package knows where it is running. It reaches the backend,
  the host's router, who is signed in and the machine through `src/shuttle`: `useApi()`,
  `useShuttleHost()`, `useTenant()`, `useDevice()`, `Link`, `useNavigate()`, `useLocation()`.
  Links name a destination (`{ page: 'session', sessionId }`), never a path. A function that
  is not a hook takes the `ShuttleHost` as its first argument. It never imports a router, a
  sign-in client, `window.shuttleDesktop`, or anything from `apps/`, other than types from
  the Worker's source through `@worker/*` (until those live in a package of their own).
- **Imports are relative** inside the package, so it resolves the same under any bundler.
- **Parts:** `src/parts` is `Shuttle`. `<Shuttle.Session>` follows one session and folds its
  run once; the parts inside (`SessionHeader`, `Agents`, `Conversation`, `Composer`,
  `Artifacts`, `Events`, `Palette`) read it with `useSession()` and take no session props.
  `Shuttle.SessionLayout` is Shuttle's own arrangement of them, and `Shuttle.Shell` the frame
  with the sidebar, which takes the host's own pieces as slots. Session logic goes in
  `features/sessions/session.tsx` or a part, never in a host's route.
- **Artifact types:** a kind of tab in the artifacts pane is an `ArtifactType` in
  `features/artifacts/artifact-types.tsx` (label, icon, launcher, `render`). The pane, the tab
  strip and the command palette read that list and name no kind themselves.
  A host's own type names its kind `<namespace>:<name>` (`acme:designs`), which the contract
  (`CustomArtifactTabKind` in `@shuttle/api`) and the workspace run (`TabKindSchema`) both
  accept; the two patterns must stay the same. The run keeps such a tab without reading it.
- **No assumptions about the host:** a part works with nothing above it but the provider. In
  particular a session works with no workspace (no `Shuttle.Shell`): read the workspace with
  `useOptionalWorkspace()` or `useWorkspaceSessions()`, never `useWorkspace()`, in anything a
  session part draws. The package reads no `import.meta.env`; what differs by environment is
  an option of `createShuttleHost`. `examples/custom-ade` is a host with no workspace, and is
  the place to try a part on its own.
- **Outside this repository** the parts are `@swirls/shuttle`, the only package published from
  here. `@shuttle/api`, `@shuttle/core` and `@shuttle/react` stay private and are what the apps
  use; `packages/shuttle` puts their compiled output together under `@swirls/shuttle/api`,
  `/core/…` and `/react`. The engine goes out the same way, from `@shuttle/engine`,
  `@shuttle/sandbox`, `@shuttle/git` and `@shuttle/runner-protocol`, under
  `@swirls/shuttle/engine`, `/sandbox/…` and `/git/…`. A dependency added to any of them is
  added to `packages/shuttle/package.json` too, as a dependency, or as an optional peer when
  only a host that runs the engine needs it (as `ai` is); `bun run check:package` fails until
  it is. A type
  that is exported has to be nameable in a declaration file, so give a query's options an
  explicit type where the inferred one carries the query library's tags.
- **Changesets:** a pull request that changes `packages/api`, `core`, `react` or `shuttle` in a
  way someone installing `@swirls/shuttle` would see adds one with `bun run changeset`. See
  `RELEASE.md`.
- **Exports:** `src/index.ts` and `src/ui.ts` list what hosts may use. Add to them when a host
  needs something; a host never reaches into `src`.
- **Styles:** `src/theme.css` holds the tokens and the classes the parts use. It tells Tailwind
  to read the package's files, so a host only imports it after `tailwindcss`.
- **Layout:** `src/features/<name>` holds a feature's components, logic and tests;
  `src/components` and `src/lib` hold only what features share.

## TypeScript lint

`bun run lint` runs oxlint type-aware with the anti-slop rules in `tools/oxlint/anti-slop` (ported from swirlsv2).

- Decode external data (JSON, fetch bodies, storage, messages, rows) with zod at the boundary. Never cast `any`/`unknown` to a shape; no `!`, identity helpers or bare disables.
- `typeof` only inside type-guard functions. Write explicit comparisons, not truthiness, on strings and numbers.
- `apps/worker/bridge` ships without `node_modules`, so it decodes with `bridge/json.ts` guards, not zod.
- A truly unavoidable cast gets one line: `// oxlint-disable-next-line <rule> -- SAFETY: <invariant>`.
