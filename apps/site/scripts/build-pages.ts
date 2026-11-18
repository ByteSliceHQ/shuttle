/**
 * Writes the pages in `pages/` into `public/`, with their code highlighted by Shiki.
 *
 * A code block is `<pre><code class="language-<lang>">…</code></pre>`, escaped as HTML. Wrangler
 * runs this before `dev` and `deploy` (see `build` in wrangler.jsonc). What it writes into
 * `public/` is not edited by hand and not checked in.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { createHighlighter } from 'shiki'

const root = join(import.meta.dir, '..')
const pagesDir = join(root, 'pages')
const publicDir = join(root, 'public')

const langs = ['tsx', 'bash', 'css'] as const
const theme = 'github-dark-default'

const highlighter = await createHighlighter({ themes: [theme], langs: [...langs] })

const CODE_BLOCK = /<pre><code class="language-([a-z]+)">([\s\S]*?)<\/code><\/pre>/g

function unescapeHtml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

function isLang(lang: string): lang is (typeof langs)[number] {
  return langs.some((known) => known === lang)
}

export function highlight(html: string): string {
  return html.replace(CODE_BLOCK, (_, lang: string, code: string) => {
    if (!isLang(lang)) {
      throw new Error(`No highlighting loaded for "${lang}". Add it to langs in build-pages.ts.`)
    }

    return highlighter.codeToHtml(unescapeHtml(code), { lang, theme })
  })
}

async function pages(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath, entry.name))
}

for (const source of await pages(pagesDir)) {
  const target = join(publicDir, relative(pagesDir, source))

  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, highlight(await readFile(source, 'utf8')))
  console.log(`pages: ${relative(root, target)}`)
}
