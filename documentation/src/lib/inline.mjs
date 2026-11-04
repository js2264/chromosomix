/**
 * The little inline Markdown the generated data is written in — code, bold,
 * italics and links, as the reference pages for models write them
 * (`src/llms/markdown.ts`) — as HTML, for a component's `set:html`. Escaped
 * first, so nothing in a hint can be read as a tag.
 */

import { withBase } from './site.mjs'

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function inline(markdown) {
  const codes = []
  let html = escape(markdown).replace(/``\s?(.+?)\s?``|`([^`]+)`/g, (_match, double, single) => {
    codes.push(`<code>${double ?? single}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, text, href) => `<a href="${withBase(href)}">${text}</a>`)
  return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => codes[Number(index)])
}
