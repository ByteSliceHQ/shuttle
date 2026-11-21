---
'@swirls/shuttle': patch
---

Depends on `@swirls/looms` 0.24.0, whose NATS projector can leave ephemeral events out of a stream. Nothing in Shuttle's own behaviour changes. A host has to be on the same Looms version as Shuttle, so move both together.
