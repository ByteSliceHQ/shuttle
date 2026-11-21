---
'@swirls/shuttle': minor
'@swirls/shuttle-engine': minor
---

The engine is its own package, `@swirls/shuttle-engine`: `@swirls/shuttle/engine` is now `@swirls/shuttle-engine`, `@swirls/shuttle/engine/<module>` is `@swirls/shuttle-engine/<module>`, and the git and sandbox modules are under `@swirls/shuttle-engine/git` and `@swirls/shuttle-engine/sandbox`. `@swirls/shuttle` is the React parts, the API contract and the run events again, without the engine's dependencies.
