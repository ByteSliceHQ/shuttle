---
'@swirls/shuttle': minor
---

The React parts work against a host that mounts only some of the backend. `createShuttleHost` takes `headers`, added to every request that can carry one, and asks for the backend's cookie when it is on another origin. The parts read `GET /capabilities` and leave out artifact types whose `needs` the backend does not serve. `<Shuttle.Session readOnly>` shows a session without the means to change it. `Tenant.runs.pulls` may be `null` for a host with no pull request inbox. The parts read a run's log with the same credentials, and across origins open its live socket with a read grant they ask the backend for. `@swirls/looms` moves to 0.22.0; a host installs the same version.
