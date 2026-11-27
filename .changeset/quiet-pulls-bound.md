---
'@swirls/shuttle': patch
---

Record only the pull requests that changed during an inbox sync, and keep at most the newest 100 closed pull records, so a pulls object no longer grows with every pull it ever saw.
