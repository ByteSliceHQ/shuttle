import { safeStorage } from 'electron'

import type { Store } from './store'

/**
 * This machine's standing with a Shuttle deployment: registering it for whoever is signed in to
 * the window, and keeping the token that registration returns.
 *
 * The token is the only credential the app holds. It is made by the deployment for this machine,
 * can do nothing but connect this machine's runner, and is stored encrypted with the operating
 * system's keychain. The app ships with no secrets of its own.
 */

export interface MachineIdentity {
  readonly deviceId: string
  readonly deviceName: string
  readonly platform: string
}

async function seal(token: string): Promise<{ token: string; encrypted: boolean }> {
  return (await safeStorage.isAsyncEncryptionAvailable())
    ? { token: (await safeStorage.encryptStringAsync(token)).toString('base64'), encrypted: true }
    : { token, encrypted: false }
}

/**
 * The saved token in the clear, or null when it cannot be read. `resave` says the keychain's
 * key has changed since the token was sealed, so it should be sealed again under the new one.
 */
async function unseal(saved: {
  token: string
  encrypted: boolean
}): Promise<{ token: string; resave: boolean } | null> {
  if (!saved.encrypted) {
    return { token: saved.token, resave: false }
  }

  try {
    const opened = await safeStorage.decryptStringAsync(Buffer.from(saved.token, 'base64'))

    return { token: opened.result, resave: opened.shouldReEncrypt }
  } catch {
    // Encrypted under a keychain entry that is gone. The machine is registered again.
    return null
  }
}

/**
 * The token this machine's runner uses, registering the machine first if it has none for the
 * person signed in. Null when nobody is signed in, or the deployment cannot be reached.
 */
export async function machineToken(
  store: Store,
  appUrl: string,
  cookie: string,
  machine: MachineIdentity,
): Promise<string | null> {
  if (!cookie) {
    return null
  }

  const origin = new URL(appUrl).origin
  const headers = { cookie, origin, 'content-type': 'application/json' }
  const me = await fetch(`${appUrl}/me`, { headers }).catch(() => null)

  if (!me?.ok) {
    return null
  }

  const who = (await me.json()) as { user: { id: string }; org: { id: string } }
  const saved = store.get('machines')?.[origin]

  // A token belongs to the person and organization it was made for, and to no one else who
  // signs in on this machine.
  if (saved && saved.userId === who.user.id && saved.orgId === who.org.id) {
    const opened = await unseal(saved)

    if (opened) {
      if (opened.resave) {
        store.set('machines', {
          ...store.get('machines'),
          [origin]: { ...saved, ...(await seal(opened.token)) },
        })
      }

      return opened.token
    }
  }

  const registered = await fetch(`${appUrl}/runners`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceId: machine.deviceId,
      name: machine.deviceName,
      platform: machine.platform,
    }),
  }).catch(() => null)

  if (!registered?.ok) {
    return null
  }

  const { token } = (await registered.json()) as { token: string }

  store.set('machines', {
    ...store.get('machines'),
    [origin]: { userId: who.user.id, orgId: who.org.id, ...(await seal(token)) },
  })

  return token
}

/** Forgets the token for a deployment, after it stopped being accepted. */
export function forgetMachineToken(store: Store, appUrl: string): void {
  const { [new URL(appUrl).origin]: _gone, ...rest } = store.get('machines') ?? {}

  store.set('machines', rest)
}
