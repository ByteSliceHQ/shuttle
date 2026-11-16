# Agent instructions

## Commits

Every commit must follow the [Conventional Commits](https://www.conventionalcommits.org/)
specification:

```text
<type>(optional-scope): <imperative summary>
```

Use one of these types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`,
`refactor`, `revert`, `style`, or `test`.

- Keep the summary concise, lowercase, and free of a trailing period.
- Use `feat` for new user-facing behavior and `fix` for user-facing bug fixes.
- Run `bun run verify` before committing.

## Architecture

Shuttle is a Looms application, not a Looms package.

- `apps/worker` owns custom Looms modules (`session`, `reflect`) and Cloudflare hosting.
- `apps/web` is the session UI.
- `apps/desktop` hosts that UI in Electron and starts `apps/runner`, which keeps a sandbox on the machine.
- Sandbox providers live in `apps/worker/src/sandbox/providers`; nothing outside it names one. See `docs/sandboxes.md`.
- Depend on published `@swirls/looms`. Link a local Looms build only when developing SDK changes.
