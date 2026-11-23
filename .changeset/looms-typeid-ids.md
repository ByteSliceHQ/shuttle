---
'@swirls/shuttle': minor
---

Run on `@swirls/looms` 0.26.0, where ids are TypeIDs by default and a host can supply its own id format.

The engine names a session's child threads (the conductor, narrators, reviewers and intake) through the format the run was started with, `ctx.ids`, instead of Looms's default. A host that passes `ids` to Looms now gets every Shuttle thread in its own format.

Breaking: Looms 0.26.0 gives every derived child thread a new name, so a session in flight across the upgrade will not replay. Let running sessions finish, or stop them, before upgrading.
