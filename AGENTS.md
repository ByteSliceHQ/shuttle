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

- `apps/worker` owns custom Looms modules (`session`, `reflect`) and Cloudflare hosting.
- `apps/web` is the session UI.
- `apps/desktop` hosts that UI in Electron and starts `apps/runner`, which keeps a sandbox on the machine.
- Sandbox providers live in `apps/worker/src/sandbox/providers`; nothing outside it names one. See `docs/sandboxes.md`.
- Depend on published `@swirls/looms`. Link a local Looms build only when developing SDK changes.

## HTTP API

Every JSON route the Worker serves is declared once, in `packages/api` (`@shuttle/api`), as an
[oRPC](https://orpc.dev) contract: method, path, and zod schemas for input and output.

- **Adding a route:** declare it in `packages/api/src/<domain>.ts`, implement it in
  `apps/worker/src/api/<domain>.ts` with `api.<domain>.<name>.handler(...)`. Input and output are
  validated against the contract; throw `ORPCError` (or `badRequest`/`forbidden`/`notFound`) for
  failures. Never parse a body by hand or cast it.
- **Not on the contract:** WebSocket upgrades, redirects and binary bodies stay as plain handlers
  in `apps/worker/src/routes`. Looms' own routes (`/runs/…`) are forwarded to the run.
- Types shared by the Worker and the web app come from the contract's schemas (`z.infer`), not
  from hand-written interfaces.

## Web app

`apps/web` is TanStack Router + TanStack Query over the typed client in `src/api/client.ts`.

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
- **Host boundary:** Shuttle's components are meant to be put together by other hosts too, so
  nothing under `src/features` (other than `auth`, `desktop` and `github`, which belong to this
  app) imports the app's router, `@/api/client`, `@/host`, the sign-in client or
  `window.shuttleDesktop`. They ask `@/shuttle` instead: `useApi()`, `useShuttleHost()`,
  `useTenant()`, `useDevice()`, `Link`, `useNavigate()`, `useLocation()`. Links name a
  destination (`{ page: 'session', sessionId }`), never a path. A function that is not a hook
  takes the `ShuttleHost` as its first argument. Routes and loaders use `@/host` and
  `@/api/client`, and `routes/_app.tsx` gives all of it to `<Shuttle.Provider>`.
- **Layout:** `src/routes` holds thin route files; `src/features/<name>` holds a feature's
  components, logic and tests; `src/components` and `src/lib` hold only what features share.
