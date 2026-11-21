---
'@swirls/shuttle': minor
---

A host can copy each run's events somewhere of its own: `ShuttleHost` takes `projectors`, a function from a run's id to Looms projectors, which run after Shuttle's own. It is asked once for each run, when the run's object is configured. A host that supplies none gets what it got before.
