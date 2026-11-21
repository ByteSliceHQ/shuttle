---
'@swirls/shuttle': patch
---

Depends on `@swirls/looms` 0.23.0, whose NATS projector can reach a stream through a transport the host supplies and can put a run's attributes in its subjects. Nothing in Shuttle's own behaviour changes. A host has to be on the same Looms version as Shuttle, so move both together.
