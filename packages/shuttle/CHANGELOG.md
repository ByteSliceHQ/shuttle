# @swirls/shuttle

## 0.2.0

### Minor Changes

- 90e4169: The Workspace tab can compare each repository's changes with something other than where the session started: only uncommitted work, one of the session's pull requests, everything since a commit, or any branch. The pull requests a session opened are shown at the top of the tab with their checks, review and whether everything is pushed, and the session's commits are drawn as a line with each pull request over its own. The sandbox API takes an `against` comparison on `workspace`, `file` and `diff`, reports each repository's head, commits and how its changes were measured, and lists branches with `branches`.

### Patch Changes

- 6ed464e: Depends on `@swirls/looms` 0.18.1, whose wakes no longer stop for good after 100 steps. Long
  sessions stalled there until someone sent a message. Looms 0.18 expects
  `@cloudflare/workers-types` 5 when it is installed.
- 6ed464e: The publish card says when it will push to a pull request the layer already has: it is titled
  "Update owner/repo#13", links to that pull request, and offers "Push update" instead of
  "Publish as draft" and "Publish", which did nothing different for an existing pull request.
  After publishing it says "Updated #13" rather than "Opened 1 pull request". `PublishedPull`
  gains an optional `outcome` (`opened`, `updated` or `unchanged`).

## 0.1.1

### Patch Changes

- 1c169a0: A tab whose artifact type is not registered now says so instead of showing an empty pane. This
  happens when a session's tab was opened by a host that has a type of its own and is then viewed
  in one that does not.

## 0.1.0

### Minor Changes

- b6ff58e: First release. Shuttle's UI as React parts (`@swirls/shuttle/react`): a provider, a session and
  its panes, artifact types a host can add to, the plain controls and the theme. With them, the
  backend's API contract (`@swirls/shuttle/api`) and the workspace and pulls runs' events
  (`@swirls/shuttle/core/workspace`, `@swirls/shuttle/core/pulls`).
