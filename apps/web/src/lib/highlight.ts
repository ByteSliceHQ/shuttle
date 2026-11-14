import type { HighlighterCore, ThemedToken } from 'shiki/core'

/**
 * Syntax highlighting for the file viewer, with Shiki: the grammars and theme VS Code uses.
 *
 * Nothing here loads until a file is first opened, and each language's grammar loads the first
 * time a file in that language is. Files too large to colour quickly are left as plain text.
 */

export type HighlightedLine = readonly ThemedToken[]

const THEME = 'github-dark-default'

/** Past this many characters a file is shown uncoloured; tokenizing it would stall the tab. */
const MAX_HIGHLIGHT_CHARS = 400_000

/** File names that say more about the language than their extension does. */
const BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: 'docker',
  makefile: 'make',
  '.gitignore': 'ini',
  '.dockerignore': 'ini',
  '.env': 'dotenv',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
  'bun.lock': 'jsonc',
  'tsconfig.json': 'jsonc',
}

/** Extensions Shiki does not list as a language name or alias. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  htm: 'html',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  conf: 'ini',
  lock: 'yaml',
  svg: 'xml',
  plist: 'xml',
  txt: '',
  log: '',
}

interface Loaded {
  readonly highlighter: HighlighterCore
  /** Loads a language's grammar by its Shiki id. */
  readonly languages: Readonly<Record<string, () => Promise<unknown>>>
  /** Shiki ids by every name and alias a language goes by. */
  readonly ids: ReadonlyMap<string, string>
}

let loading: Promise<Loaded> | null = null

function load(): Promise<Loaded> {
  loading ??= (async () => {
    const [core, engine, langs, theme] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/langs'),
      import('shiki/themes/github-dark-default.mjs'),
    ])

    const ids = new Map<string, string>()

    for (const info of langs.bundledLanguagesInfo) {
      ids.set(info.id, info.id)

      for (const alias of info.aliases ?? []) {
        ids.set(alias, info.id)
      }
    }

    return {
      highlighter: await core.createHighlighterCore({
        themes: [theme.default],
        langs: [],
        engine: engine.createJavaScriptRegexEngine(),
      }),
      languages: langs.bundledLanguages,
      ids,
    }
  })()

  return loading
}

/** The name a file's language goes by, from its path. Empty when it is plain text. */
export function languageHint(path: string): string {
  const name = (path.split('/').pop() ?? '').toLowerCase()

  if (name in BY_NAME) {
    return BY_NAME[name] ?? ''
  }

  if (name.startsWith('.env')) {
    return 'dotenv'
  }

  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''

  return extension in BY_EXTENSION ? (BY_EXTENSION[extension] ?? '') : extension
}

/**
 * `code` as coloured tokens, one array per line. Null when the file is plain text, is in a
 * language Shiki does not know, or is too large: the caller shows it uncoloured.
 */
export async function highlight(code: string, path: string): Promise<HighlightedLine[] | null> {
  const hint = languageHint(path)

  if (!hint || code.length > MAX_HIGHLIGHT_CHARS) {
    return null
  }

  try {
    const { highlighter, languages, ids } = await load()
    const id = ids.get(hint)
    const grammar = id ? languages[id] : undefined

    if (!id || !grammar) {
      return null
    }

    if (!highlighter.getLoadedLanguages().includes(id)) {
      await highlighter.loadLanguage(grammar as Parameters<HighlighterCore['loadLanguage']>[0])
    }

    return highlighter.codeToTokens(code, { lang: id, theme: THEME }).tokens
  } catch {
    // A grammar that fails to load or run costs the colours, not the file.
    return null
  }
}

/** Inline style for one token: its colour, and italic, bold or underline where the theme asks. */
export function tokenStyle(token: ThemedToken): React.CSSProperties {
  const style = token.fontStyle ?? 0

  return {
    color: token.color,
    ...(style & 1 ? { fontStyle: 'italic' } : {}),
    ...(style & 2 ? { fontWeight: 600 } : {}),
    ...(style & 4 ? { textDecoration: 'underline' } : {}),
  }
}
