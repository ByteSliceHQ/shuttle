---
'@swirls/shuttle': minor
---

Run on `@swirls/looms` 0.28.0. Shuttle now requires Looms 0.28.0 exactly, so a host that embeds Shuttle must move its own `@swirls/looms` to 0.28.0 in the same change.

The model adapter hands the run a model call is made for to Looms when it reads attached files, as Looms 0.27.0 requires. Attachments are still read from the session's asset store.

Since Looms 0.27.1, projectors on a Durable Object, including any a host adds through `projectors`, are delivered from the object's alarm instead of under the request that appended the events. A host whose `ShuttleRun` subclass overrides `alarm()` must call `super.alarm()`.
