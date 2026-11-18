import type { CSSProperties } from 'react'

declare module 'react' {
  interface CSSProperties {
    '--diffs-font-family'?: string
    '--diffs-font-size'?: string
    '--diffs-line-height'?: string
    '--diffs-tab-size'?: string
  }
}

/** How Pierre's Diffs is drawn wherever the app shows code: the file pane and the review tab. */

const THEME = 'github-dark-default'

/**
 * The theme sets its own background on the code. This puts the app's surface there instead, so
 * the code sits on the same colour as everything around it.
 */
const ON_APP_SURFACE = ':host, pre { --diffs-bg: var(--background) !important; }'

export const FILE_OPTIONS = {
  theme: THEME,
  themeType: 'dark',
  disableFileHeader: true,
  overflow: 'scroll',
  unsafeCSS: ON_APP_SURFACE,
} as const

/** Diffs draws inside a shadow root, so it is styled through its own variables, not classes. */
export const SURFACE_STYLE: CSSProperties = {
  '--diffs-font-family': 'var(--font-mono)',
  '--diffs-font-size': '12px',
  '--diffs-line-height': '19px',
  '--diffs-tab-size': '2',
}
