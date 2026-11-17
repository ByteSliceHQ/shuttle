---
'@swirls/shuttle': patch
---

A tab whose artifact type is not registered now says so instead of showing an empty pane. This
happens when a session's tab was opened by a host that has a type of its own and is then viewed
in one that does not.
