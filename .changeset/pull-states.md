---
'@swirls/shuttle': patch
---

A pull request a session publishes no longer says its checks are running before anything has been heard about them, which never cleared in a repository with no checks. The Workspace tab no longer says "Not pushed" for a branch that is: a published branch is compared with GitHub by the tree it holds rather than by its commit, which GitHub makes under another name. The sandbox API's `workspace` reports each commit's `tree` and what the session last `published` of each branch.
