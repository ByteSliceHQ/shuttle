# `@shuttle/worker`

Cloudflare Worker that hosts Shuttle sessions on Looms Durable Objects.

## Modes

- `SHUTTLE_WORKSPACE_MODE=memory` (default) — in-DO filesystem, no Docker
- `SHUTTLE_WORKSPACE_MODE=container` — real Linux via Durable Object containers

## Bring your own Cloudflare

1. Create a D1 database:

   ```bash
   wrangler d1 create looms-shuttle-replica
   ```

2. Uncomment the `d1_databases` block in `wrangler.jsonc` and paste the id.

3. For real Linux sandboxes, install Docker, set
   `SHUTTLE_WORKSPACE_MODE=container`, and uncomment the `containers` block.

4. Set secrets:

   ```bash
   wrangler secret put OPENROUTER_API_KEY
   ```

5. (Optional) Create a GitHub App for folder repo linking:

   - Permissions: Contents (read/write), Metadata (read)
   - Setup URL: `https://<worker-host>/github/setup` (local: `http://127.0.0.1:8790/github/setup`)
   - Convert the private key to PKCS#8:

     ```bash
     openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem
     ```

   - Put `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, and
     `GITHUB_STATE_SECRET` in `.dev.vars` (or as Wrangler secrets).

6. Deploy:

   ```bash
   bun run deploy
   ```

Point the web app at the Worker URL (Vite proxy for local, or your static host).

## Demo script

1. Start a session with a small goal.
2. Ask “what is the conductor doing?” — narrator answers without interrupting.
3. Send “also use zod for validation” — brief advances; workers see it next turn.
4. Send a correction — interrupt appears in the event inspector.
5. Reload the tab — the Durable Object session is still there.
6. After workers settle, a reflection run proposes a lesson. Approve it in
   Playbook, start a new session, and see the lesson loaded into instructions.
