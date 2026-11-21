# Shuttle

A cloud-native coding agent harness powered by [Looms](https://looms.sh).

Each coding session is a Durable Object run with Cloudflare Sandbox hands,
interruptible multi-agent steering, and a custom `reflect` module that proposes
playbook lessons from event history.

## Quick start

```bash
# enter the flox env (bun, node for wrangler)
flox activate

bun install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# optional: set OPENROUTER_API_KEY and TYPESAFE_AI_API_KEY in apps/worker/.dev.vars

bun run dev
```

That one command starts:

- Worker API at http://127.0.0.1:8790
- Web UI at http://127.0.0.1:5180
- When a GitHub App is configured in `.dev.vars`, a Cloudflare quick tunnel
  that rewrites the App webhook URL so PR events reach your laptop live

Default `SHUTTLE_WORKSPACE_MODE=memory` needs no Docker. Set
`SHUTTLE_TUNNEL=off` (or leave GitHub App vars blank) to skip the tunnel.

## What you get

1. **Steering without derailment** — questions go to a narrator, ideas amend the
   brief, corrections interrupt the right worker.
2. **Custom Looms modules** — `shuttleSession`, `reflect`, and `workspace` sit
   beside native `agent`, `evaluator`, and `approval`.
3. **Folders + GitHub** — organize sessions in folders, connect a GitHub App,
   and link repos so every agent in that folder gets worktrees.
4. **Bring your own Cloudflare** — Durable Objects, optional D1, optional
   Sandbox containers. See [apps/worker/README.md](apps/worker/README.md).

## Repo layout

```text
apps/worker              Cloudflare Worker + Durable Objects + custom Looms modules
apps/web                 Vite + React session UI
apps/desktop             Electron app: the session UI plus a sandbox on this machine
apps/runner              Keeps that local sandbox and connects it to Shuttle
packages/react           The UI as React parts (@shuttle/react), which apps/web assembles
packages/core            The runs' event catalogues, shared by the Worker and the UI
packages/api             The Worker's HTTP API as a zod contract
packages/shuttle         @swirls/shuttle, published: the parts, put together from api, core and react
packages/shuttle-engine  @swirls/shuttle-engine, published: what a host runs sessions on, from engine, sandbox and git
examples/custom-ade      A development environment put together from the parts, in one file
packages/runner-protocol What the worker and a runner say to each other
```

Sandboxes are pluggable (memory, Cloudflare, Daytona, a person's own machine) and a session
moves between them with its work. See [docs/sandboxes.md](docs/sandboxes.md).

## Local Looms development

Shuttle depends on the published `@swirls/looms` package. To work against a
local Looms checkout:

```bash
# in the looms repo
bunx turbo run build --filter=@swirls/looms...
cd packages/looms && bun link

# in this repo
bun link @swirls/looms
```

## Scripts

| Command               | What it does                    |
| --------------------- | ------------------------------- |
| `bun run dev`         | Worker + web (+ webhook tunnel) |
| `bun run desktop`     | Desktop app against the dev UI  |
| `bun run check-types` | Typecheck both apps             |
| `bun run test`        | Worker unit/integration tests   |
| `bun run verify`      | Types + tests                   |

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
