import type { CredentialPayload } from '../credentials/store'
import type { VendorHarnessId } from '../harness'

/**
 * Whose credential a vendor agent turn runs on: the host port for credentials.
 *
 * A standalone Shuttle runs a turn on the sign-in of the person it is working for, kept in the
 * organization's workspace run. A host may run turns on an organization's credential, or on one it
 * keeps itself, and says where that credential is read from and written back to.
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
  /** Whose credential the turn runs on. Null: nobody's, and the turn runs without one. */
  ownerOf(request: TurnCredentialRequest): CredentialOwner | null
  get(access: CredentialAccess): Promise<CredentialPayload | null>
  /** Stores what a turn learned, such as a refreshed sign-in. */
  put(access: CredentialAccess, payload: CredentialPayload): Promise<void>
}

/** The key a store files an owner's credentials under. Letters, digits, `_` and `-`. */
export function credentialKey(owner: CredentialOwner): string {
  return owner.kind === 'person' ? owner.userId : `org_${owner.orgId}`
}

/** Who the turn is shown as billed to. */
export function billedToLabel(owner: CredentialOwner): string {
  return owner.kind === 'person' ? owner.userId : `org:${owner.orgId}`
}
