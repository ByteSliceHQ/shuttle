# @swirls/shuttle-engine

What a host runs Shuttle's coding sessions on, inside its own Cloudflare Worker: the run and
sandbox Durable Objects, the ports a host replaces, headless sessions, and Shuttle's HTTP API in
modules to mount.

```sh
bun add @swirls/shuttle-engine
```

```ts
import { serveShuttle, type ShuttleHost } from '@swirls/shuttle-engine'
import {
  EventFirehose,
  SessionSandbox,
  ShuttleRun,
  shuttleApiModules,
} from '@swirls/shuttle-engine/worker'

export { EventFirehose, SessionSandbox }

export class LoomsRun extends ShuttleRun<Env> {
  protected override host(env: Env): ShuttleHost {
    return { env, ports: {} }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const shuttle = serveShuttle({ env, ports: {} }, { modules: shuttleApiModules })

    return (await shuttle(request, ctx)) ?? new Response('Not Found', { status: 404 })
  },
}
```

| Import                                    | What it is                                                     |
| ----------------------------------------- | -------------------------------------------------------------- |
| `@swirls/shuttle-engine`                  | Host ports, headless sessions, `serveShuttle`, the API modules |
| `@swirls/shuttle-engine/worker`           | The Durable Objects a Worker binds, and the run log module     |
| `@swirls/shuttle-engine/<module>`         | The engine's own modules, such as `harness`                    |
| `@swirls/shuttle-engine/sandbox/<module>` | Sandbox providers and names                                    |
| `@swirls/shuttle-engine/git/<module>`     | GitHub access and Code Storage                                 |

The pages that show a session are built from `@swirls/shuttle/react`, which this package depends
on for the API contract and the run events. See
[Hosting Shuttle](https://github.com/ByteSliceHQ/shuttle/blob/main/docs/hosting.md).

A host's `tsconfig` has `@cloudflare/workers-types` in `types` and `skipLibCheck` on.

Release notes are in [`CHANGELOG.md`](./CHANGELOG.md).
