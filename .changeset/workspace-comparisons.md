---
'@swirls/shuttle': minor
---

The Workspace tab can compare each repository's changes with something other than where the session started: only uncommitted work, one of the session's pull requests, everything since a commit, or any branch. The pull requests a session opened are shown at the top of the tab with their checks, review and whether everything is pushed, and the session's commits are drawn as a line with each pull request over its own. The sandbox API takes an `against` comparison on `workspace`, `file` and `diff`, reports each repository's head, commits and how its changes were measured, and lists branches with `branches`.
