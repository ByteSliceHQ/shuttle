import { Session } from '../features/sessions/session'
import { SessionHeader } from '../features/sessions/session-header'
import { SessionLayout } from '../features/sessions/session-layout'
/**
 * Shuttle, as parts. A host puts them together however it likes:
 *
 *     <Shuttle.Provider host={host} router={router} identity={identity}>
 *       <Shuttle.Session id={sessionId}>
 *         <Shuttle.SessionHeader />
 *         <Shuttle.Conversation />
 *         <Shuttle.Composer />
 *         <Shuttle.Artifacts />
 *       </Shuttle.Session>
 *     </Shuttle.Provider>
 *
 * `Shuttle.SessionLayout` is Shuttle's own arrangement of the session's parts, for a host that
 * wants the whole thing. A part reads the session from `useSession()`, so anything a host
 * writes itself can sit beside them and read the same.
 */
import {
  SessionAgents,
  SessionArtifacts,
  SessionComposer,
  SessionConversation,
  SessionEvents,
  SessionPalette,
} from '../features/sessions/session-parts'
import { AppSidebarShell } from '../features/workspace/app-sidebar'
import { ShuttleProvider } from '../shuttle'

export const Shuttle = {
  Provider: ShuttleProvider,
  /**
   * The frame Shuttle's pages sit in: folders and sessions down the side, the page beside
   * them. A host with its own navigation leaves it out.
   */
  Shell: AppSidebarShell,
  /** Follows one session and gives it to the parts inside. */
  Session,
  /** Shuttle's own arrangement of everything below. */
  SessionLayout,
  SessionHeader,
  Agents: SessionAgents,
  Conversation: SessionConversation,
  Composer: SessionComposer,
  Artifacts: SessionArtifacts,
  Events: SessionEvents,
  Palette: SessionPalette,
}

export {
  defaultArtifactTypes,
  type ArtifactType,
  type ArtifactViewProps,
} from '../features/artifacts/artifact-types'
export { useSession, type SessionProps, type SessionValue } from '../features/sessions/session'
