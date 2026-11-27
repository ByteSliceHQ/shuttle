---
'@swirls/shuttle': patch
---

The repositories button under a session's composer lists the repositories the session started with, where it used to list its folder's as they are now. A session keeps the ones it started with, so the two differ once a repository is linked to or unlinked from the folder.

- `SessionFeed` gains `repos`, read from the session's start.
- The popover no longer has "Manage repos". The folder's name in its header links to the folder, where repositories are linked.
- It shows for a session whose host keeps no folders, too.
- Linking reads "Link repositories" everywhere, and the dialog says that only new sessions get what is linked.
