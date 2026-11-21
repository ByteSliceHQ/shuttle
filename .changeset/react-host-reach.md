---
'@swirls/shuttle': minor
'@swirls/shuttle-engine': minor
---

The React parts work against a host that mounts only some of the backend. `createShuttleHost` takes `headers`, added to every request that can carry one, and asks for the backend's cookie when it is on another origin. The parts read `GET /capabilities` and leave out artifact types whose `needs` the backend does not serve. `<Shuttle.Session readOnly>` shows a session without the means to change it. `Tenant.runs.pulls` may be `null` for a host with no pull request inbox.
