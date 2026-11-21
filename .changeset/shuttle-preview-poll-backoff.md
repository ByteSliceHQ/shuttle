---
'@swirls/shuttle': patch
---

Back off the wait page for a preview port and stop its poll while the tab is hidden, so a preview whose port never comes up no longer spends the Worker's request budget or its error signal.
