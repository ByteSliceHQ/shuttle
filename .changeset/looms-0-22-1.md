---
'@swirls/shuttle': patch
---

Depends on `@swirls/looms` 0.22.1, which fixes a Durable Object that was rebuilt before its alarm fired dropping the wake that alarm was holding. A host has to be on the same Looms version as Shuttle, so move both together.
