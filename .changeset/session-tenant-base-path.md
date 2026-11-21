---
'@swirls/shuttle': minor
---

`serveShuttle` takes `basePath`, such as `'/shuttle'`, for a host whose own routes sit beside Shuttle's: it answers only paths under it, takes it off before a module sees the path (`/capabilities` and read grants included), and answers a path under it that no module claims with a 404 a listed origin can read. `sessionTenant({ user, orgId, role?, runNames? })` in `@swirls/shuttle/api` builds the `Tenant` for `<Shuttle.Provider>` with `pulls: null`, for a host that serves sessions without `GET /me`. How run ids are made and read (`scopedRunId`, `personalRunId`, `parseRunId` and the rest) moves from `@swirls/shuttle/engine/tenancy/run-id` to `@swirls/shuttle/api`, beside `tenantRunIds` and `DEFAULT_RUN_NAMES`; the engine's `runNames(env)` is in `@swirls/shuttle/engine/tenancy/run-names`.
