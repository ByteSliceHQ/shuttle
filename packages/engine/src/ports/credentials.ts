import type { CredentialPayload } from '../credentials/store'
import type { VendorHarnessId } from '../harness'

/**
 * Whose credential a vendor agent turn runs on: the host port for credentials.
 *
 * A turn runs on the credential of the person it is working for and never on another person's.
 * That person's sign-in with a vendor is kept by Shuttle, in the organization's workspace run; no
 * port reads it, holds it or supplies one. What a host adds is API keys: an organization's, for
 * turns nobody asked for, or one a person gave it.
 */
export type CredentialOwner =
  | { readonly kind: 'person'; readonly userId: string }
  | { readonly kind: 'organization'; readonly orgId: string }

/** What a turn is about to run, for the port to decide whose credential it takes. */
export interface TurnCredentialRequest {
  readonly runId: string
  readonly orgId: string | null
  readonly harness: VendorHarnessId
  /** The person the turn is working for, or null when nobody has asked for anything. */
  readonly sponsorId: string | null
}

export interface CredentialAccess {
  readonly owner: CredentialOwner
  readonly harness: VendorHarnessId
  readonly orgId: string | null
}

export interface CredentialPort {
  /**
   * Whose credential the turn runs on: the person it is working for (`sponsorId`), an
   * organization, or null for nobody's. An answer that names any other person counts as nobody.
   */
  ownerOf(request: TurnCredentialRequest): CredentialOwner | null
  /**
   * API keys the host holds for `owner`, as environment variables for the agent process. Null
   * when it holds none, and then a person's turn runs on the sign-in Shuttle keeps for them.
   */
  apiKeys?(access: CredentialAccess): Promise<Readonly<Record<string, string>> | null>
}

/** Shuttle's own behaviour: the person the turn is working for, and nobody when no one asked. */
export const sponsorCredentials: CredentialPort = {
  ownerOf: ({ sponsorId }) => (sponsorId === null ? null : { kind: 'person', userId: sponsorId }),
}

/** Who the turn is shown as billed to. */
export function billedToLabel(owner: CredentialOwner): string {
  return owner.kind === 'person' ? owner.userId : `org:${owner.orgId}`
}

/** Where Shuttle keeps each person's own sign-in: the workspace run of their organization. */
export interface SignInStore {
  getCredential(userId: string, harness: VendorHarnessId): Promise<CredentialPayload | null>
  putCredential(userId: string, harness: VendorHarnessId, payload: CredentialPayload): Promise<void>
}

/** What one turn runs on, and where what it learned is kept. */
export interface TurnCredentials {
  readonly owner: CredentialOwner | null
  get(harness: VendorHarnessId): Promise<CredentialPayload | null>
  /** Stores what a turn learned, such as a refreshed sign-in. */
  put(harness: VendorHarnessId, payload: CredentialPayload): Promise<void>
}

/**
 * The credentials of the turn `request` describes. The host's keys come first. A person without
 * one runs on their own sign-in, which only ever travels between `signIns` and their turns.
 */
export function turnCredentials(
  port: CredentialPort,
  signIns: SignInStore,
  request: TurnCredentialRequest,
): TurnCredentials {
  const named = port.ownerOf(request)

  const owner =
    named !== null && named.kind === 'person' && named.userId !== request.sponsorId ? null : named

  const fromHost = new Set<VendorHarnessId>()

  return {
    owner,
    get: async (harness) => {
      if (owner === null) {
        return null
      }

      const keys = (await port.apiKeys?.({ owner, harness, orgId: request.orgId })) ?? null

      if (keys !== null && Object.keys(keys).length > 0) {
        fromHost.add(harness)

        return { env: keys }
      }

      fromHost.delete(harness)

      return owner.kind === 'person' ? signIns.getCredential(owner.userId, harness) : null
    },
    put: async (harness, payload) => {
      if (owner !== null && owner.kind === 'person' && !fromHost.has(harness)) {
        await signIns.putCredential(owner.userId, harness, payload)
      }
    },
  }
}
