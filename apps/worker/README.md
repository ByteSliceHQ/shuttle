# `@shuttle/worker`

Cloudflare Worker that hosts Shuttle sessions on Looms Durable Objects.

## Modes

- `SHUTTLE_WORKSPACE_MODE=memory` (default) — in-DO filesystem, no Docker
- `SHUTTLE_WORKSPACE_MODE=container` — real Linux via Durable Object containers

## Bring your own Cloudflare

1. Create the D1 database that holds accounts and organizations, paste its id into the
   `AUTH_DB` entry in `wrangler.jsonc`, and create its tables:

   ```bash
   wrangler d1 create shuttle-auth
   wrangler d1 migrations apply AUTH_DB --remote
   wrangler secret put BETTER_AUTH_SECRET   # at least 32 random characters
   ```

   Locally, `bun run dev` does all of this for you.

2. Optionally create a second D1 database for cross-run session lists and history tools
   (`wrangler d1 create looms-shuttle-replica`), and uncomment the `REPLICA` entry in
   `wrangler.jsonc` with its id.

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

5. (Optional) Create a **personal** GitHub App for folder repo linking and PRs
   (do not share a production App — local `bun run dev` overwrites its webhook
   URL every start):

   - Permissions: Contents (read/write), Metadata (read), Pull requests
     (read/write), Checks (read), Commit statuses (read)
   - Webhook events: `pull_request`, `pull_request_review`,
     `pull_request_review_comment`, `check_suite`, `installation_repositories`
     (prefer `check_suite` over `check_run` to keep volume down)
   - Tick **Active** on the webhook. Any placeholder webhook URL is fine;
     `bun run dev` starts a Cloudflare quick tunnel and
     `PATCH`es `/app/hook/config` to
     `https://<random>.trycloudflare.com/github/webhooks` with the local
     `GITHUB_WEBHOOK_SECRET` (auto-generated when empty).
   - Setup URL must be the **worker** origin (not the Vite UI):
     `https://<worker-host>/github/setup` (local:
     `http://127.0.0.1:8790/github/setup`). GitHub redirects the browser
     here after install, so localhost works — no tunnel needed for Connect.
   - After `bun run dev`, the tunnel pane prints
     `webhooks live https://….trycloudflare.com/github/webhooks`. Click
     **Connect GitHub** in the web UI (`http://127.0.0.1:5180`). Vite proxies
     `/github/*` to the worker; you can also open
     `http://127.0.0.1:8790/github/install` directly.
   - Opt out with `SHUTTLE_TUNNEL=off` (inbox **Sync** still works without a
     tunnel).
   - Convert the private key to PKCS#8:

     ```bash
     openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem
     ```

   - Put `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` in
     `.dev.vars` (or as Wrangler secrets). Leave `GITHUB_STATE_SECRET` and
     `GITHUB_WEBHOOK_SECRET` blank to let `bun run dev` fill them. Keep
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
