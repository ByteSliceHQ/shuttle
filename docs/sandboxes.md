# Sandboxes: providers, local machines, and moving between them

A session works in a sandbox. Where that sandbox runs is a provider's business, and a session can
move between sandboxes, and so between providers, with its work intact.

## The layers

```text
session (LoomsRun DO)          decides which sandbox a turn runs in, and moves the work
  └─ SessionSandbox DO          one per sandbox; the same class for every provider
       └─ SandboxProvider       memory | cloudflare | daytona | local
            └─ SandboxHost      exec + files: all a workspace, agent run or stack op needs
```

- `apps/worker/src/sandbox/providers/` holds one file per provider and `registry.ts`. Nothing
  outside that folder names a provider. Adding one is a file there and a line in the registry.
- A sandbox's **name** says where it runs. `local:<org>:<user>:<device>` is a person's own
  machine; every other name runs on the deployment's provider (`SHUTTLE_WORKSPACE_MODE`).
- `session/handoff.ts` moves a session whenever the sandbox it should run in is not the one that
  holds its files. The work travels through Code Storage as git refs: the session's branches plus
  a snapshot commit of the uncommitted and untracked files. Ignored files are rebuilt on arrival.

## Local sandboxes

The desktop app (`apps/desktop`, Electron) starts a runner (`apps/runner`) beside its window. The
runner keeps a sandbox on the machine and dials **out** to its `SessionSandbox` Durable Object
over one WebSocket (`packages/runner-protocol`). Requests come down the socket; nothing listens
on the machine, so it works the same against `wrangler dev` and a deployed Worker.

The runner picks a backend by what the machine has (`apps/runner/src/detect.ts`):

| Backend               | Isolation                                      | Status                    |
| --------------------- | ---------------------------------------------- | ------------------------- |
| `microsandbox`        | one microVM per sandbox                        | works (Apple Silicon Mac) |
| `docker`              | Linux VM on macOS/Windows; namespaces on Linux | works                     |
| `podman`              | same                                           | same code, untested       |
| Apple `container`     | one microVM per sandbox (macOS 26, arm64)      | not written yet           |
| Seatbelt / bubblewrap | OS policy on a host process                    | not written yet           |

They are tried in that order. `SHUTTLE_LOCAL_BACKEND` names one to use instead.

**The built-in sandbox** ([microsandbox](https://github.com/superradcompany/microsandbox)) is
the one that needs nothing installed. Its runtime is two files, `msb` and `libkrunfw`, which the
packaged app carries and the repository gets as an optional dependency of `apps/runner`. Each
sandbox is a Linux guest with its own kernel, started as a child process on the Mac's
hypervisor. The runtime keeps its images, disks and volumes in `~/.shuttle/msb`
(`SHUTTLE_MSB_HOME`; the path has to be short, because Unix sockets live under it). The sandbox
is stopped when the runner stops and started again when it is next needed, which takes a
fraction of a second.

It does not use the cloud image. That image holds the vendors' agent command lines, and of
those only Codex's licence allows redistribution, so Shuttle cannot hand it to people. The
built-in sandbox starts from the public `node:24-bookworm-slim` image instead and, the first
time it comes up, installs the same tools from the vendors and copies in the agent bridge
(`apps/runner/src/provision.ts`; about half a minute on a good connection). They stay on its
disk. A change to the tool versions or the bridge is applied the next time the runner starts.
The versions are kept equal to the `ARG`s in `apps/worker/Dockerfile` by a test.

A container backend runs the same image as the cloud sandboxes, with the session's files at
`/workspace`, in volumes the engine keeps. Nothing from the host is mounted. Either way the
session sees the same Linux and the same `/workspace`, and that sameness is what makes a move
invisible to it. A process backend (Seatbelt, bubblewrap) cannot give
a process a `/workspace` of its own on macOS, so it needs the workspace root to stop being a
constant first.

## Where a session runs

- A session started in the desktop app starts on that machine when its sandbox is up. The app's
  Sandbox menu turns that off.
- The pill in the session's title bar moves it: `POST /sessions/:id/sandbox/place` with
  `{ "to": "cloud" }` or `{ "to": "local", "deviceId": "…" }`. Asked for while a command is
  running in the sandbox, the move waits and happens when the session stops working.
- A move made from the pill is recorded in the session as `shuttle.sandbox.moved`.
- A machine only runs its owner's turns. When someone else gives the session work, that turn
  runs in the cloud and the work follows.
- Work is saved to Code Storage every time a session stops working. A session can therefore
  leave a machine that is closed or offline: the cloud sandbox is rebuilt from the last save.
  Whatever changed on the machine after that save stays there, and the pill says so.

## Machines and their tokens

A runner does not carry a person's sign-in. The desktop app registers the machine
(`POST /runners`, as the signed-in person) and gets a token that can do one thing: connect that
machine's runner as that person in that organization. Only the token's hash is stored
(`shuttle_runner_device`, migration `0005`). The app keeps the token encrypted with the
operating system's keychain. `GET /runners` lists a person's machines; `DELETE /runners/<id>`
forgets one, which ends its token and cuts its runner off.

Vendor agent sign-ins (Claude Code, Codex, Cursor) are per sandbox. In the desktop app the
Connections page has a This machine / Cloud switch; a sign-in made on the machine stays in its
sandbox there.

## Running it

```bash
bun run dev        # worker + web, as before
bun run desktop    # the desktop app, against http://127.0.0.1:5180
```

`SHUTTLE_DESKTOP_URL` points the app at another Shuttle. With the Docker or Podman backend the
first launch builds the sandbox image from `apps/worker/Dockerfile` if the machine does not have
`shuttle-sandbox:dev`.
`SHUTTLE_SANDBOX_CPUS` and `SHUTTLE_SANDBOX_MEMORY_MB` cap what a new sandbox may use. Moving
needs Code Storage (`PIERRE_ORG`, `PIERRE_PRIVATE_KEY`) and a cloud provider with a machine
behind it (`container` or `daytona`, not `memory`).

The runner on its own: `SHUTTLE_URL=… SHUTTLE_RUNNER_TOKEN=… bun apps/runner/src/main.ts`, or
the single binary from `bun run --cwd apps/runner build`. `--remove` deletes the machine's
sandbox.

## Remaining gaps

As of 2026-11-16. Tested: macOS on Apple Silicon with the built-in sandbox and with Docker
Desktop, against `wrangler dev`, with Daytona as the cloud provider.

### Local backends

- The built-in sandbox depends on microsandbox, which calls itself beta. Its version is pinned
  in `apps/runner/package.json`. It has been run on one Apple Silicon Mac; its Linux (KVM) and
  Windows runtimes are not bundled or tried, and it does not support Intel Macs at all.
- The built-in sandbox's first start downloads the tools from the vendors and Debian. With no
  network, or with one of those sources down, the sandbox does not come up.
- The built-in sandbox's root disk is capped at 32 GB and nothing reports how full it is.
- Apple `container` (one microVM per sandbox) is not written. With the built-in sandbox in
  place it is no longer needed for isolation.
- Podman shares the Docker code path and has never been run.
- No process-level backend (Seatbelt on macOS, bubblewrap on Linux). It is blocked on
  `/workspace` being a constant in about 30 files: a host process on macOS cannot be given a
  `/workspace` of its own, so the workspace root has to become a property of the host first.
- Linux and Windows are untested. Windows will most likely mean running the Linux path in WSL2.
- Sandboxes have open network access. There is no egress allowlist. microsandbox has network
  rules (`--net-rule`, `--net-default-egress`) that the built-in backend does not set yet.
- The Docker and Podman backends need the image built from `apps/worker/Dockerfile`, which a
  machine without this repository can only get from a registry. None is published, on purpose:
  see the licence note above.

### Moving between local and cloud

- Edits left on an offline machine are flagged but not reconciled when it reconnects.
- Only a move made from the pill is recorded as an event. A move that happens on its own (a
  queued move at the end of a turn, or a turn for someone else) is not.
- A queued move has unit tests but was not seen end to end: the session's activity snapshot
  read `idle` throughout a running turn, so the guard that matters is the sandbox's own "a
  command is running" check. That snapshot being wrong is worth its own look; other routes
  rely on it.
- Ignored files (dependencies, build output) are not carried, and nothing reinstalls them on
  arrival. Running dev servers and background processes are not carried either.
- Moving needs Code Storage. There is no other transport for deployments without it, and a
  `memory` cloud provider cannot take part at all.
- Large moves are untested: big repositories, many repositories, large untracked files.

### Runner and protocol

- Everything is one JSON frame with base64 bytes. Large files and command output are held whole
  in memory on both sides, and are bounded by the WebSocket message limit. There is no streaming.
- Previews are plain HTTP, one request at a time, each through an `exec` into the sandbox: no WebSockets
  (so no hot reload), no streaming responses, and slow for pages with many assets.
- Machines can be listed and removed through the API. There is no page for it yet.
- A machine removed from Shuttle registers itself again the next time its app is launched by
  the same signed-in person.

### Desktop app

- Packaged for Apple Silicon Macs only (see "Packaging the desktop app"), with an ad hoc
  signature unless a Developer ID is given. No notarization has been run, and there is no
  deep link for signing in through the system browser.
- GitHub sign-in happens inside the app window. It should hand off to the system browser and
  come back through a deep link.
- The window loads the UI from a Shuttle deployment. Nothing works offline.
- Electron's install script did not run on the first `bun install`. `electron` is now in
  `trustedDependencies`; a fresh clone has not been tried.

### Verification

- The desktop update flow has automated state tests. Installing a signed Mac update still needs
  release testing. The runner has tests for its link and its lock; the container backend is
  exercised by hand.
- Never run against a deployed Worker, where the runner's socket hibernates for real.
- A vendor agent turn on a local sandbox has not been run: the sign-in switch and listing work,
  but no subscription was signed in there.

## Packaging the desktop app

From `apps/desktop`:

```bash
SHUTTLE_DESKTOP_URL=https://shuttle.example.com \
SHUTTLE_SANDBOX_IMAGE=registry.example.com/shuttle-sandbox:latest \
bun run package
```

This writes `release/Shuttle-<version>-<arch>.dmg`, the update `.zip`, and `latest-mac.yml` for the architecture of the Mac it runs on.
The app holds the compiled runner, the built-in sandbox runtime, the agent bridge, and one small
file, `desktop.config.json`, naming the deployment its window opens and, when given, the image
a Docker or Podman fallback pulls. `SHUTTLE_SANDBOX_IMAGE` is optional. `SHUTTLE_DESKTOP_URL` and
`SHUTTLE_SANDBOX_IMAGE` in the environment still win over that file when the app is started.

No secret goes into the build. Models, GitHub, cloud sandboxes and Code Storage are used by the
deployment; a person signs in to it in the app's window, and the only credential the app then
keeps is that machine's own token, encrypted with the Keychain.

The app is signed with the hypervisor entitlement (`entitlements.mac.plist`), which the sandbox
runtime needs to start a virtual machine.

Set `CSC_NAME` to a Developer ID Application identity to sign with it; electron-builder then
notarizes when it finds Apple credentials in the environment. Otherwise the signature is ad
hoc: the app runs, but a Mac that downloaded it refuses to open it until its owner chooses
Open Anyway under System Settings, Privacy & Security.

### Desktop updates

Developer ID builds check `https://shuttle.codes/download/latest-mac.yml` shortly after launch and every
four hours. The bottom-left sidebar also offers a manual check. People choose when to download
and when to restart; the app never installs an update on quit automatically. Development builds
do not check for updates.

The release workflow builds a new Apple Silicon version for each push to `main`, then
uploads it to the existing `shuttle-releases` R2 bucket. Builds are ad hoc by default, with a
manual download link in the sidebar and no automatic installation. Once Apple credentials exist,
set `SHUTTLE_SIGN_DESKTOP=true` to enable signed releases and the automatic updater.
The ZIP and DMG are uploaded before the
update manifest, so an available update always points to uploaded binaries. The public feed works
without giving desktop apps credentials for the private source repository. See
[deployment setup](deployments.md) for required GitHub variables and secrets.

For a manual release, package with a stable Developer ID signing identity and notarization
credentials, then upload the generated DMG, ZIP, blockmaps, and `latest-mac.yml` to R2, publishing
the manifest last. Packaging uses `--publish never`; the workflow performs publication. macOS
requires signed apps for automatic installation. An older build without the update bridge or
with the previous GitHub feed needs one manual upgrade first.
