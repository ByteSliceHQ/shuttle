---
'@swirls/shuttle': patch
---

Run on `@swirls/looms` 0.31.0. Pin Looms to `0.31.0` together with this Shuttle release; Shuttle pins Looms exactly.

Looms 0.31.0 changes the swarm module (a failed member activation no longer fails the swarm run; `SwarmMemberStatus` gains `failed` and `lastError`) and adds an opt-in `handlesEffectFailures` flag for threads. Shuttle runs no swarm and defines no thread that uses the flag, so nothing else changes here.
