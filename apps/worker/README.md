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

3. For real Linux sandboxes (terminal + browser preview ports), install Docker,
   set `SHUTTLE_WORKSPACE_MODE=container` in `.dev.vars`, and enable the
   `containers` block in `wrangler.jsonc` (`scheduling_policy: "durable_object"`
   with a named `images.base.dockerfile`). Code starts instances via
   `ctx.container.images.base`. Preview iframes use hostnames of the form
   `p<port>-<folderId>.<SHUTTLE_PREVIEW_HOST>` (default host `localhost`, so
   local previews hit `http://p3000-<folderId>.localhost:8790`). Production
   needs a wildcard DNS record and route for that host.

   The image bakes a coding baseline (`node`/`npm`, `python3`, `git`, `rg`,
   `curl`, `bash`). Agents may install extras via bash (`apk add`, project-local
   `npm install`, etc.). After Dockerfile changes, restart `wrangler` so it
   rebuilds the image — container disk is ephemeral and resets on recreate.

4. Set secrets:

   ```bash
   wrangler secret put OPENROUTER_API_KEY
   wrangler secret put TYPESAFE_AI_API_KEY
   ```

   `OPENROUTER_API_KEY` powers agent LLM turns (model is selectable in the
   session UI; default `LOOMS_MODEL` / `anthropic/claude-sonnet-5.5`).
   `TYPESAFE_AI_API_KEY` powers TypeSafe Jev behind the Looms evaluator
   (intake routing). Without it, intake falls back to local heuristics.
   Optional `JEV_MODEL` (default `jev-latest`) selects the Jev model id.

5. (Optional) Create a GitHub App for folder repo linking:

   - Permissions: Contents (read/write), Metadata (read)
   - Setup URL must be the **worker** origin (not the Vite UI):
     `https://<worker-host>/github/setup` (local:
     `http://127.0.0.1:8790/github/setup`). GitHub redirects the browser
     here after install, so localhost works — no tunnel needed for Connect.
     Use a public worker URL (or a tunnel) only if you add webhooks later.
   - After `bun run dev`, click **Connect GitHub** in the web UI
     (`http://127.0.0.1:5180`). Vite proxies `/github/*` to the worker;
     you can also open `http://127.0.0.1:8790/github/install` directly.
   - Convert the private key to PKCS#8:

     ```bash
     openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem
     ```

   - Put `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, and
     `GITHUB_STATE_SECRET` in `.dev.vars` (or as Wrangler secrets). Keep
     `SHUTTLE_WEB_URL` pointed at the web UI so setup redirects home.

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
