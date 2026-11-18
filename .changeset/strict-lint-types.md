---
'@swirls/shuttle': patch
---

Tightens the parts' types as part of a stricter lint. `useWidthBucket` no longer takes a type argument. `ShuttleHost.signalRun` takes its input as a JSON object. `ShuttleRouter.navigate` and the identity's `listPeople` and `connectGithub` are function properties, so they can be passed on without binding. Data read from storage and from the sandbox is checked before it is used.
