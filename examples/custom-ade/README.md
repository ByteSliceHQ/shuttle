# A custom ADE

One file, [`src/main.tsx`](src/main.tsx), that puts a development environment together from
Shuttle's parts instead of using Shuttle's own app:

- its own layout (a grid) around `Shuttle.SessionHeader`, `Conversation`, `Composer` and
  `Artifacts`, with no sidebar and no folders
- a part of its own, `StatusStrip`, that reads the session with `useSession()` like the stock
  parts do
- an artifact type of its own, `acme:notes`, offered in the artifacts pane's menu
- a router adapter for a host with a single page

It talks to a Shuttle Worker on this machine and is signed in as whoever is signed in to
Shuttle's own app there.

```bash
bun run dev                             # in the repository root: the Worker, on 8790
bun run --cwd examples/custom-ade start
```

Then open `http://127.0.0.1:5190/?session=<a session's run id>`.

Here it uses `@shuttle/react`, the source in this repository. Anywhere else it is the same file
with `@swirls/shuttle/react` in its place, installed from npm.
