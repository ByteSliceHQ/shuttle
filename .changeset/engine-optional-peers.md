---
'@swirls/shuttle': minor
---

What only the engine needs is no longer installed with the package: `ai`, `@cloudflare/sandbox` and `@daytona/sdk` are optional peer dependencies, which a host that runs `@swirls/shuttle/engine` installs beside it. A page that uses the React parts does not carry them.
