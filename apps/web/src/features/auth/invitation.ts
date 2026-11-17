import { authClient } from './auth-client'

/** The invitation could not be accepted. The app is still usable as whoever is signed in. */
export class InvitationError extends Error {}

/**
 * Joins the organization an invitation link is for, as the signed-in person, and makes it the
 * active one. The caller restarts the app afterwards: everything on the page belongs to the
 * previous organization.
 */
export async function acceptInvitation(invitationId: string): Promise<void> {
  const accepted = await authClient.organization.acceptInvitation({ invitationId })

  if (accepted.error) {
    throw new InvitationError(
      accepted.error.message ??
        'This invitation could not be accepted. It may be for a different email address.',
    )
  }

  await authClient.organization.setActive({
    organizationId: accepted.data.invitation.organizationId,
  })
}
