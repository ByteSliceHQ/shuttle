import { desktop } from '@/features/desktop/desktop'

/**
 * Which Shuttle this is. The web app's release is stamped in when it is built (`vite.config.ts`):
 * the deploy workflow gives the web app and the desktop app it builds the same one, so a person
 * sees one "Shuttle 0.1.N" either way. A build made anywhere else has no release, only a commit.
 *
 * The desktop app loads the web app from the deployment, so the two can differ: an app installed
 * last week shows this week's web app until it updates.
 */
export interface ShuttleVersion {
  /** The web app's release, such as `0.1.150`. Empty for a build the deploy workflow did not make. */
  readonly release: string
  /** The commit the web app was built from, seven characters, or empty when unknown. */
  readonly commit: string
  readonly builtAt: string
  /** The desktop app's own release, when the page is running in one that says. */
  readonly desktop: string | null
}

export function shuttleVersion(): ShuttleVersion {
  const app = desktop()

  return {
    release: import.meta.env.VITE_SHUTTLE_VERSION,
    commit: import.meta.env.VITE_SHUTTLE_COMMIT,
    builtAt: import.meta.env.VITE_SHUTTLE_BUILT_AT,
    desktop: app?.version !== undefined && app.version !== '' ? app.version : null,
  }
}

/**
 * The web app as a person reads it: its release once deployed, the commit for a local build,
 * which has no release, and `unknown` when it has neither.
 */
export function webVersion(version: ShuttleVersion): string {
  if (version.release !== '') {
    return version.release
  }

  return version.commit !== '' ? version.commit : 'unknown'
}

/**
 * The lines the account menu shows. One release describes both apps when they match, so it is
 * one line; a desktop app behind the web app it shows gets a line of its own.
 */
export function versionLines(version: ShuttleVersion): string[] {
  const web = webVersion(version)

  return version.desktop !== null && version.desktop !== web
    ? [`Shuttle ${web}`, `Desktop ${version.desktop}`]
    : [`Shuttle ${web}`]
}

/** What a click on the version puts on the clipboard, for a bug report. */
export function versionReport(version: ShuttleVersion, userAgent: string): string {
  const commit = version.release !== '' && version.commit !== '' ? ` (${version.commit})` : ''

  return [
    `Shuttle web ${webVersion(version)}${commit}`,
    `Built ${version.builtAt}`,
    ...(version.desktop !== null ? [`Shuttle desktop ${version.desktop}`] : []),
    userAgent,
  ].join('\n')
}
