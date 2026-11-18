---
'@swirls/shuttle': patch
---

Depends on `@swirls/looms` 0.18.1, whose wakes no longer stop for good after 100 steps. Long
sessions stalled there until someone sent a message. Looms 0.18 expects
`@cloudflare/workers-types` 5 when it is installed.
