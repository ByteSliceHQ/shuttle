---
'@swirls/shuttle': minor
---

The engine serves Shuttle's HTTP API in modules a host mounts: `serveShuttle(host, { modules })` from `@swirls/shuttle/engine`, with `sessionApi`, `assetsApi`, `terminalApi` and `firehoseApi` there and `runsApi` and `shuttleApiModules` in `@swirls/shuttle/engine/worker`. It asks the host's identity port who a request acts for, checks who may open the run a path names, answers pages on other origins (`origins`), and gives read grants for a run's log (`grantSecret`). Two new ports, `people` and `previews`, replace what those routes read from Shuttle's own database. See `docs/hosting.md`.
