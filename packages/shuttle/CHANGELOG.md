# @swirls/shuttle

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
