import type { AnchorHTMLAttributes, ComponentType, Ref } from 'react'

/**
 * A place Shuttle's components link to. They name the place and never an address, so each host
 * decides where it lives: Shuttle's own app has a page for each, another product may have a
 * session inside one of its own views and no playbook page at all.
 */
export type ShuttleDestination =
  /** Where a new session is started. */
  | { readonly page: 'home' }
  /** One session. `thread` is the agent thread to bring forward when it opens. */
  | { readonly page: 'session'; readonly sessionId: string; readonly thread?: string | undefined }
  | { readonly page: 'folder'; readonly folderId: string }
  | { readonly page: 'playbook' }
  | { readonly page: 'events' }
  | { readonly page: 'connections' }

export interface ShuttleLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  readonly to: ShuttleDestination
  readonly ref?: Ref<HTMLAnchorElement>
}

/**
 * How Shuttle's components move around inside whatever is hosting them. The host supplies one,
 * built on its own router. `Link` and `navigate` should stay the same from one render to the
 * next; `location` changes as the host moves, and only what reads it renders again.
 */
export interface ShuttleRouter {
  /** An anchor to a destination. It passes every other prop on, so it works under `asChild`. */
  readonly Link: ComponentType<ShuttleLinkProps>
  /** Goes to a destination. */
  readonly navigate: (to: ShuttleDestination) => void
  /** The destination now on screen, or null when it is none of Shuttle's. */
  readonly location: ShuttleDestination | null
}
