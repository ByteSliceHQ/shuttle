/**
 * The environment electron-builder runs in.
 *
 * An unsigned build has no Developer ID. The deploy workflow still sets the certificate
 * variables to empty strings so a real certificate is not used. electron-builder treats an
 * empty `CSC_LINK` as a file path, and that path is the desktop directory, so packaging
 * stops. Those blanks are left out. A signed build keeps them.
 */
export function packagerEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  hasIdentity: boolean,
) {
  const child: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      child[key] = value
    }
  }

  if (!hasIdentity) {
    delete child.CSC_LINK
    delete child.CSC_KEY_PASSWORD
    delete child.CSC_NAME
    child.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  }

  return child
}
