---
'@swirls/shuttle': minor
---

Start a session with files. `createSession` takes optional `files`, sent as multipart form data,
and the workspace's `session.requested` event carries them as `attachments`. `StartAttachments`
and `useStartAttachments` add pasted screenshots to a composer, keeping any text that was copied
with them.
