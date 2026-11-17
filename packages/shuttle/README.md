# @swirls/shuttle

Shuttle as parts: React components for a development environment built around coding agents,
with the API contract and run events they speak.

```sh
bun add @swirls/shuttle
```

```tsx
import { createShuttleHost, Shuttle } from '@swirls/shuttle/react'

const host = createShuttleHost({ baseUrl: 'https://your-shuttle-backend.example' })

export function MyCustomADE() {
  return (
    <Shuttle.Provider host={host} router={router} identity={identity}>
      <Shuttle.Session id={sessionId}>
        <Shuttle.SessionHeader />
        <Shuttle.Conversation />
        <Shuttle.Composer />
        <Shuttle.Artifacts />
      </Shuttle.Session>
    </Shuttle.Provider>
  )
}
```

| Import                            | What it is                                               |
| --------------------------------- | -------------------------------------------------------- |
| `@swirls/shuttle/react`           | The `Shuttle` parts, `useSession()`, `createShuttleHost` |
| `@swirls/shuttle/react/ui`        | The plain controls the parts are drawn with              |
| `@swirls/shuttle/react/theme.css` | Tokens and styles. Import it after `tailwindcss`         |
| `@swirls/shuttle/api`             | The backend's HTTP API as a zod contract                 |
| `@swirls/shuttle/core/workspace`  | The workspace run's events and schemas                   |
| `@swirls/shuttle/core/pulls`      | The pulls run's events and schemas                       |

The parts need a Shuttle backend to talk to, React 19, TanStack Query 5 and Tailwind CSS 4. They
are built for a bundler such as Vite. See the
[repository](https://github.com/ByteSliceHQ/shuttle#readme) for the backend and a complete
example in `examples/custom-ade`.

Release notes are in [`CHANGELOG.md`](./CHANGELOG.md).
