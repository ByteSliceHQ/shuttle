---
'@swirls/shuttle': patch
---

A browser tab opened on a port no longer loads `http://<port>` (or the viewer's own `localhost`) while the session's preview address is still loading; it waits for the sandbox's preview, and says so when the sandbox serves none.
