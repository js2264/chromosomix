/**
 * The little Markdown the pages for language models are written in.
 *
 * Tables and code, and nothing a renderer could read two ways: a cell has its
 * pipes escaped and its line breaks folded, because a table is read by a parser
 * that a stray `|` in a hint would cut a column short for — and a model reading
 * the page as text has the same parser in its head.
 */

/** The site the pages are served from, and every link in them is absolute to. */
export const SITE = 'https://chromosomix.app/'

/** The repository, for the files that are the repository's rather than the site's. */
export const REPOSITORY = 'https://github.com/js2264/chromosomix'

/** One cell's text, safe inside a table row. */
export function cell(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()
}

/** A table, its header first. Every row has as many cells as the header. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.map(cell).join(' | ')} |`
  return [line(header), `|${header.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n')
}

/** `text` in backticks, with a longer fence where it holds one. */
export function code(text: string): string {
  const fence = text.includes('`') ? '``' : '`'
  const pad = fence.length > 1 ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** A fenced block. */
export function block(text: string, language = ''): string {
  return `\`\`\`${language}\n${text.replace(/\n+$/, '')}\n\`\`\``
}

/** `a`, `a or b`, `a, b or c` — each in backticks. */
export function either(values: readonly string[], word = 'or'): string {
  const quoted = values.map(code)
  if (quoted.length <= 1) return quoted[0] ?? ''
  return `${quoted.slice(0, -1).join(', ')} ${word} ${quoted[quoted.length - 1]}`
}

/** A page: its blocks joined by blank lines, ending in one newline. */
export function page(blocks: readonly string[]): string {
  return `${blocks.filter((text) => text !== '').join('\n\n')}\n`
}
