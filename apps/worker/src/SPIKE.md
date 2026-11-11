# Shuttle spike notes

Validated against Looms + Cloudflare before the vertical slice:

## 1. Sandbox exec from a DO-local effect, with abort

- Coding tools are Looms `defineTool` handlers (`placement` implied local via agent `executeTool`).
- Handlers receive `ToolContext.signal` and race it against the SessionSandbox RPC.
- On abort, the tool calls `sandbox.kill()` so container processes (or memory workspace ops) stop.
- SessionSandbox is a **separate** Durable Object named by the Looms `runId`, so the Looms DO stays the single writer for the event log while the sandbox owns the filesystem/container.

## 2. Parallel child threads in one Durable Object

- The conductor uses `asAgentTool(worker)`. Multiple tool calls in one turn spawn child threads in the **same** run.
- Workers share `/workspace/.wt/<runId>/<repo>` so parallel workers see each other's edits; the conductor only parallelizes disjoint files.
- All events still serialize through one Looms DO writer — fine for the demo; scale path is `launch()`ed child runs (already indexed by `correlation_id` in the D1 replica).

## 3. D1 replica lag for history tools

- Projector delivery runs from the Looms DO after append (`waitUntil` + alarms).
- History tools prefer D1 (`REPLICA` binding). When the binding is absent or rows are not yet visible, they fall back to "replica unavailable" and the narrator can still answer from the live conversation projection / steer context.
- For Thursday, default `SHUTTLE_WORKSPACE_MODE=memory` and optional D1 keep local `wrangler dev` free of Docker while the architecture stays cloud-native.
