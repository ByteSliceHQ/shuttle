---
'@swirls/shuttle': minor
---

A host can decide an approval by policy when its gate opens. The `approvals` port takes an optional `decide`, asked once for a pull request proposal (`publish-pull-request`) or a review an agent asks to submit (`submit-review`) with the session's organization, owner, `hostMetadata` and the proposal. `approve` and `reject` settle the gate at once, recorded as decided by `host-policy` (`POLICY_DECIDER`), and the session is never blocked on it; `undecided`, no `decide`, or a `decide` that throws leaves the gate waiting for an answer, as before.

The headless API gains `sendHeadlessMessage` and `stopHeadlessSession`, also on `headlessSessions(host)` as `message` and `stop`: a message to a session as a person would type it, and a stop of the turns its agents are in. Both refuse an `acting` that could not open the session.

`ApprovalKind` now includes `submit-review`.
