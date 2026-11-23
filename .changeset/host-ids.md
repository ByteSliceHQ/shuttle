---
'@swirls/shuttle': minor
---

A host can say how a run's ids are written. `ShuttleHost` takes `ids`, Looms's `LoomsIds`, and gives it to every run's object and to the routes that reach one, so a session's threads, events and waits come out in the host's own format. Left out, they are Looms's TypeIDs, as before.
